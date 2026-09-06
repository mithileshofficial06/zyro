import {BigInt, Bytes, log} from "@graphprotocol/graph-ts";

import {Docked, Pulled, Pushed, Shipped} from "../generated/Aqua/Aqua";
import {Swapped} from "../generated/ZyroRouter/ZyroRouter";
import {Fill, PendingPush, Position, PositionBalance, Protocol} from "../generated/schema";

import {
  Params,
  halfSpreadWad,
  midFromBalancesWad,
  remaining,
  reservationPriceWad,
  softBoundPenaltyBps
} from "./avellaneda-stoikov";
import {decodeStrategy} from "./program";
import {ZYRO_APP} from "./config";

const PROTOCOL_ID = Bytes.fromUTF8("zyro");

/**
 * @dev `Bytes` are compared with `.equals`, never `==`. In AssemblyScript `==`
 *      on a reference type compares identity, so an address filter written with
 *      `!=` silently rejects everything and the subgraph indexes nothing.
 */
function isZyroApp(app: Bytes): boolean {
  return app.equals(ZYRO_APP);
}

// ---------------------------------------------------------------------------
// Entity helpers
// ---------------------------------------------------------------------------

function loadProtocol(): Protocol {
  let p = Protocol.load(PROTOCOL_ID);
  if (p == null) {
    p = new Protocol(PROTOCOL_ID);
    p.positionCount = BigInt.zero();
    p.activePositionCount = BigInt.zero();
    p.fillCount = BigInt.zero();
  }
  return p as Protocol;
}

function balanceId(strategyHash: Bytes, token: Bytes): Bytes {
  return strategyHash.concat(token);
}

function loadBalance(strategyHash: Bytes, token: Bytes, timestamp: BigInt): PositionBalance {
  let id = balanceId(strategyHash, token);
  let b = PositionBalance.load(id);
  if (b == null) {
    b = new PositionBalance(id);
    b.position = strategyHash;
    b.token = token;
    b.amount = BigInt.zero();
  }
  b.lastUpdatedTimestamp = timestamp;
  return b as PositionBalance;
}

function balanceOf(strategyHash: Bytes, token: Bytes): BigInt {
  let b = PositionBalance.load(balanceId(strategyHash, token));
  return b == null ? BigInt.zero() : b.amount;
}

function paramsOf(position: Position): Params {
  return new Params(
    position.gammaWad,
    position.sigmaSqWad,
    position.baseSpreadWad,
    position.horizonSecs
  );
}

function elapsedAt(position: Position, timestamp: BigInt): BigInt {
  return timestamp.le(position.startTimestamp)
    ? BigInt.zero()
    : timestamp.minus(position.startTimestamp);
}

/**
 * Recomputes and stores the position's live pricing state.
 *
 * This is the whole point of the subgraph: a solver querying `Position` gets
 * the same reservation price the instruction would compute on-chain, without
 * re-implementing Avellaneda–Stoikov itself.
 *
 * The canonical direction is `tokenIn -> tokenOut` as most recently observed;
 * before any fill it is whichever two tokens were pushed.
 */
function refreshPricing(
  position: Position,
  tokenIn: Bytes,
  tokenOut: Bytes,
  timestamp: BigInt
): void {
  let balanceIn = balanceOf(position.id, tokenIn);
  let balanceOut = balanceOf(position.id, tokenOut);

  let p = paramsOf(position);
  let elapsed = elapsedAt(position, timestamp);

  let q = balanceIn.minus(position.targetInventoryWad);
  let mid = midFromBalancesWad(balanceIn, balanceOut);

  position.inventoryImbalanceWad = q;
  position.midWad = mid;
  position.reservationPriceWad = reservationPriceWad(mid, q, p, elapsed);
  position.halfSpreadWad = halfSpreadWad(p, elapsed);
  position.penaltyBps = q.ge(BigInt.zero())
    ? softBoundPenaltyBps(q, position.boundWad)
    : BigInt.zero();
  position.horizonRemainingSecs = remaining(p, elapsed);
  position.lastUpdatedTimestamp = timestamp;
}

// ---------------------------------------------------------------------------
// Aqua: the position lifecycle
// ---------------------------------------------------------------------------

/**
 * A strategy has been shipped.
 *
 * @dev **Aqua emits `Pushed` before `Shipped` within the same `ship()`
 *      transaction**, so any push that arrived first was buffered in a
 *      `PendingPush` and is drained here. Skipping that leaves the position
 *      looking empty and every price derived from it is computed against a zero
 *      balance.
 */
export function handleShipped(event: Shipped): void {
  if (!isZyroApp(event.params.app)) return;

  let s = decodeStrategy(event.params.strategy);
  if (!s.valid) {
    // Shipped to the Zyro router but not a Zyro program — legal, and not ours.
    return;
  }

  let hash = event.params.strategyHash;
  let position = new Position(hash);

  position.maker = event.params.maker;
  position.app = event.params.app;
  position.active = true;

  position.gammaWad = s.params.gammaWad;
  position.sigmaSqWad = s.params.sigmaSqWad;
  position.baseSpreadWad = s.params.baseSpreadWad;
  position.horizonSecs = s.params.horizonSecs;
  position.targetInventoryWad = s.targetInventoryWad;
  position.boundWad = s.boundWad;
  position.startTimestamp = s.startTimestamp;
  position.program = s.program;

  position.inventoryImbalanceWad = BigInt.zero();
  position.midWad = BigInt.zero();
  position.reservationPriceWad = BigInt.zero();
  position.halfSpreadWad = BigInt.zero();
  position.penaltyBps = BigInt.zero();
  position.horizonRemainingSecs = remaining(paramsOf(position), BigInt.zero());

  position.createdAtBlock = event.block.number;
  position.createdAtTimestamp = event.block.timestamp;
  position.lastUpdatedTimestamp = event.block.timestamp;
  position.save();

  // Draining first, then pricing: a freshly shipped position must publish a
  // real reservation price immediately, not a zero that only becomes correct
  // after somebody happens to trade against it. A solver querying between the
  // ship and the first fill would otherwise route on a mid of zero.
  let funded = drainPendingPushes(hash, event.block.timestamp);
  if (funded.length >= 2) {
    refreshPricing(position, funded[0], funded[1], event.block.timestamp);
    position.save();
  }

  let protocol = loadProtocol();
  protocol.positionCount = protocol.positionCount.plus(BigInt.fromI32(1));
  protocol.activePositionCount = protocol.activePositionCount.plus(BigInt.fromI32(1));
  protocol.save();
}

/**
 * Applies pushes that arrived before the position existed.
 *
 * The buffer holds parallel `tokens`/`amounts` arrays under the strategy hash,
 * because a store cannot be enumerated — the drain has to reach every buffered
 * token knowing only the hash, and a `ship()` funds at least two.
 */
function drainPendingPushes(strategyHash: Bytes, timestamp: BigInt): Bytes[] {
  let pending = PendingPush.load(strategyHash);
  if (pending == null) return [];

  let tokens = pending.tokens;
  let amounts = pending.amounts;

  for (let i = 0; i < tokens.length; i++) {
    let b = loadBalance(strategyHash, tokens[i], timestamp);
    b.amount = b.amount.plus(amounts[i]);
    b.save();

    log.info("zyro: drained buffered push of {} {} into position {}", [
      amounts[i].toString(),
      tokens[i].toHexString(),
      strategyHash.toHexString()
    ]);
  }

  // The buffer has served its purpose; leaving it would double-count if the
  // same hash were ever shipped again after a dock.
  pending.tokens = [];
  pending.amounts = [];
  pending.save();

  return tokens;
}

export function handleDocked(event: Docked): void {
  if (!isZyroApp(event.params.app)) return;

  let position = Position.load(event.params.strategyHash);
  if (position == null) return;

  position.active = false;
  position.lastUpdatedTimestamp = event.block.timestamp;
  position.save();

  let protocol = loadProtocol();
  protocol.activePositionCount = protocol.activePositionCount.minus(BigInt.fromI32(1));
  protocol.save();
}

/**
 * Tokens added to a position's Aqua balance.
 *
 * @dev `Pushed`/`Pulled` are the **authoritative per-strategy balance ledger**.
 *      Balances are reconstructed from them and only them. The obvious
 *      alternative — starting at zero and accumulating `Swapped` deltas — makes
 *      every balance a measure of flow rather than holdings, and therefore makes
 *      every published reservation price wrong. Handling both sources would
 *      double-count.
 */
export function handlePushed(event: Pushed): void {
  if (!isZyroApp(event.params.app)) return;

  let hash = event.params.strategyHash;
  let position = Position.load(hash);

  if (position == null) {
    // Pushed before Shipped, in the same ship() transaction. Buffer it.
    bufferPush(hash, event.params.token, event.params.amount);
    return;
  }

  let b = loadBalance(hash, event.params.token, event.block.timestamp);
  b.amount = b.amount.plus(event.params.amount);
  b.save();
}

/** Accumulates an early push, merging repeats of the same token. */
function bufferPush(strategyHash: Bytes, token: Bytes, amount: BigInt): void {
  let pending = PendingPush.load(strategyHash);
  if (pending == null) {
    pending = new PendingPush(strategyHash);
    pending.tokens = [];
    pending.amounts = [];
  }

  // AssemblyScript array fields have to be reassigned wholesale; mutating the
  // value returned by a getter does not write back to the entity.
  let tokens = pending.tokens;
  let amounts = pending.amounts;

  let found = false;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].equals(token)) {
      amounts[i] = amounts[i].plus(amount);
      found = true;
      break;
    }
  }
  if (!found) {
    tokens.push(token);
    amounts.push(amount);
  }

  pending.tokens = tokens;
  pending.amounts = amounts;
  pending.save();
}

export function handlePulled(event: Pulled): void {
  if (!isZyroApp(event.params.app)) return;

  let position = Position.load(event.params.strategyHash);
  if (position == null) return;

  let b = loadBalance(event.params.strategyHash, event.params.token, event.block.timestamp);
  b.amount = b.amount.minus(event.params.amount);

  // Aqua would have reverted on an over-pull, so a negative here means the
  // reconstruction has drifted from the chain. Surface it rather than
  // publishing a price derived from a balance that cannot exist.
  if (b.amount.lt(BigInt.zero())) {
    log.error("zyro: reconstructed balance went negative for position {} token {}", [
      event.params.strategyHash.toHexString(),
      event.params.token.toHexString()
    ]);
    b.amount = BigInt.zero();
  }
  b.save();
}

// ---------------------------------------------------------------------------
// ZyroRouter: fills
// ---------------------------------------------------------------------------

/**
 * A swap executed against a position.
 *
 * @dev **The mid and reservation price are captured before the fill's deltas
 *      are applied.** Writing them afterwards stores the post-fill mid under a
 *      pre-fill name — and this is the exact series the headline chart plots
 *      (mid and reservation price sitting on top of each other when balanced,
 *      separating as inventory drifts), so getting it wrong is not a subtle
 *      cosmetic issue.
 *
 *      Balances themselves are *not* updated here. Aqua emits `Pushed`/`Pulled`
 *      at settlement and those handlers own the ledger; touching balances here
 *      too would double-count every fill.
 */
export function handleSwapped(event: Swapped): void {
  let position = Position.load(event.params.orderHash);
  if (position == null) return;

  let tokenIn = event.params.tokenIn;
  let tokenOut = event.params.tokenOut;
  let timestamp = event.block.timestamp;

  // --- Pre-fill state, captured first ---------------------------------------
  let balanceIn = balanceOf(position.id, tokenIn);
  let balanceOut = balanceOf(position.id, tokenOut);
  let p = paramsOf(position);
  let elapsed = elapsedAt(position, timestamp);

  let qAtFill = balanceIn.minus(position.targetInventoryWad);
  let midAtFill = midFromBalancesWad(balanceIn, balanceOut);
  let rAtFill = reservationPriceWad(midAtFill, qAtFill, p, elapsed);

  let fill = new Fill(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  fill.position = position.id;
  fill.taker = event.params.taker;
  fill.tokenIn = tokenIn;
  fill.tokenOut = tokenOut;
  fill.amountIn = event.params.amountIn;
  fill.amountOut = event.params.amountOut;
  fill.midWadAtFill = midAtFill;
  fill.reservationPriceWadAtFill = rAtFill;
  fill.inventoryImbalanceWadAtFill = qAtFill;
  fill.exposed = qAtFill.ge(BigInt.zero());
  fill.blockNumber = event.block.number;
  fill.timestamp = timestamp;
  fill.transactionHash = event.transaction.hash;
  fill.save();

  // --- Then refresh the position's published state --------------------------
  refreshPricing(position, tokenIn, tokenOut, timestamp);
  position.save();

  let protocol = loadProtocol();
  protocol.fillCount = protocol.fillCount.plus(BigInt.fromI32(1));
  protocol.save();
}
