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

/**
 * The balance a token held immediately before this fill settled.
 *
 * Settlement has already been indexed, so this subtracts the fill's own
 * deltas back out. Written per-token rather than per-side so it stays correct
 * whichever way round the fill ran relative to the canonical direction.
 */
function preFillBalance(position: Position, token: Bytes, event: Swapped): BigInt {
  let current = balanceOf(position.id, token);
  if (token.equals(event.params.tokenIn)) return current.minus(event.params.amountIn);
  if (token.equals(event.params.tokenOut)) return current.plus(event.params.amountOut);
  return current;
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

/**
 * Records a token as funding this position, preserving first-seen order.
 *
 * `tokens[0]`/`tokens[1]` become the canonical pricing direction and never
 * change afterwards.
 */
function noteToken(position: Position, token: Bytes): void {
  let tokens = position.tokens;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].equals(token)) return;
  }
  // AssemblyScript entity array fields have to be reassigned wholesale;
  // mutating the value a getter returned does not write back.
  tokens.push(token);
  position.tokens = tokens;
}

/**
 * Refreshes pricing in the position's own canonical direction.
 *
 * @dev Used everywhere except the pre-fill snapshot. Taking the direction from
 *      the position rather than from whatever event triggered the refresh is
 *      what keeps a reverse-direction fill from inverting the published series.
 *      A no-op until two tokens are funded — a one-token position has no mid.
 */
function refreshCanonical(position: Position, timestamp: BigInt): boolean {
  let tokens = position.tokens;
  if (tokens.length < 2) return false;
  refreshPricing(position, tokens[0], tokens[1], timestamp);
  return true;
}

// ---------------------------------------------------------------------------
// Aqua: the position lifecycle
// ---------------------------------------------------------------------------

/**
 * A strategy has been shipped.
 *
 * @dev **Aqua emits `Shipped` *before* the `Pushed` events of the same
 *      `ship()`** — `Aqua.sol` emits `Shipped` at the top of `ship()` and then
 *      one `Pushed` per token inside the funding loop. So at this point the
 *      position has no balances at all and there is nothing to price: the
 *      reservation price is published by `handlePushed` as the funding lands,
 *      not here.
 *
 *      The `PendingPush` drain is kept as defence for the reverse order. It
 *      cannot fire against this Aqua — `push()` reverts on a strategy that has
 *      not been shipped — but it costs one store read and it is the difference
 *      between silent zero balances and correct ones if that ever changes.
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
  position.tokens = [];

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

  let funded = drainPendingPushes(hash, event.block.timestamp);
  for (let i = 0; i < funded.length; i++) {
    noteToken(position, funded[i]);
  }
  refreshCanonical(position, event.block.timestamp);
  position.save();

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

  // The funding half of `ship()` lands here, so this is where a new position
  // first becomes priceable. Republishing on every push also keeps the
  // reservation price correct across a swap settlement, which pushes tokenIn.
  noteToken(position, event.params.token);
  refreshCanonical(position, event.block.timestamp);
  position.save();
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

  noteToken(position, event.params.token);
  refreshCanonical(position, event.block.timestamp);
  position.save();
}

// ---------------------------------------------------------------------------
// ZyroRouter: fills
// ---------------------------------------------------------------------------

/**
 * A swap executed against a position.
 *
 * @dev **The fill's deltas have already been applied by the time this runs, so
 *      the pre-fill state has to be reconstructed rather than read.**
 *      `SwapVM._swap` settles first and emits last: `_transferIn`/`_transferOut`
 *      call `AQUA.push`/`AQUA.pull`, whose `Pushed`/`Pulled` logs precede
 *      `Swapped` in the same transaction. Reading the store here therefore
 *      yields post-fill balances, and storing those under `midWadAtFill` puts
 *      the post-fill mid behind a pre-fill name — which is the exact series the
 *      headline chart plots (mid and reservation price on top of each other
 *      when balanced, separating as inventory drifts). Not a cosmetic issue.
 *
 *      The reversal is exact because settlement moves precisely the amounts
 *      this event reports: `+amountIn` to the `tokenIn` balance, `-amountOut`
 *      from the `tokenOut` balance.
 *
 *      Balances themselves are *not* updated here — `handlePushed`/
 *      `handlePulled` own the ledger, and touching it here would double-count.
 */
export function handleSwapped(event: Swapped): void {
  let position = Position.load(event.params.orderHash);
  if (position == null) return;

  let tokenIn = event.params.tokenIn;
  let tokenOut = event.params.tokenOut;
  let timestamp = event.block.timestamp;

  // --- Pre-fill state, reconstructed by undoing settlement ------------------
  // Quoted in the position's own canonical direction, not the fill's: a
  // reverse-direction fill must not invert the published series.
  let canonical = position.tokens;
  let quoteIn = canonical.length >= 2 ? canonical[0] : tokenIn;
  let quoteOut = canonical.length >= 2 ? canonical[1] : tokenOut;

  let balanceIn = preFillBalance(position, quoteIn, event);
  let balanceOut = preFillBalance(position, quoteOut, event);
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
  // Already done by the settlement handlers; repeated here so a fill still
  // republishes if a future Aqua stops emitting Pushed/Pulled at settlement.
  refreshCanonical(position, timestamp);
  position.save();

  let protocol = loadProtocol();
  protocol.fillCount = protocol.fillCount.plus(BigInt.fromI32(1));
  protocol.save();
}
