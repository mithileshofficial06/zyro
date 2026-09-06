import {Address, BigInt, Bytes} from "@graphprotocol/graph-ts";
import {afterEach, assert, clearStore, describe, test} from "matchstick-as";

import {
  handleDocked,
  handlePulled,
  handlePushed,
  handleShipped,
  handleSwapped
} from "../src/mapping";
import {ZYRO_APP} from "../src/config";

import {
  createDocked,
  createPulled,
  createPushed,
  createShipped,
  createSwapped
} from "./helpers/events";
import {
  AMOUNT_IN,
  AMOUNT_OUT,
  STRATEGY,
  STRATEGY_HASH,
  TOKEN_IN,
  TOKEN_OUT
} from "./order-fixture";
import {Position} from "../generated/schema";

/**
 * The handlers, replayed against the log order Aqua and SwapVM actually emit.
 *
 * @dev **The order is the test.** Both contracts were read to establish it, and
 *      both contradict what the mappings originally assumed:
 *
 *      - `Aqua.ship()` emits `Shipped` first and then one `Pushed` per token,
 *        from the funding loop below it. The position therefore has no balances
 *        at all when `handleShipped` runs, so the price has to be published as
 *        the funding lands rather than at ship.
 *      - `SwapVM._swap` settles before it emits. `_transferIn`/`_transferOut`
 *        call `AQUA.push`/`AQUA.pull`, so `Pushed`/`Pulled` precede `Swapped`
 *        within the same transaction and the store already holds post-fill
 *        balances by the time `handleSwapped` runs.
 *
 *      Emitting these in a more convenient order would let both regressions
 *      straight back in with every assertion still green.
 */

const TOKEN_IN_ADDR: Address = Address.fromBytes(TOKEN_IN);
const TOKEN_OUT_ADDR: Address = Address.fromBytes(TOKEN_OUT);

const SHIP_TS: BigInt = BigInt.fromI32(1760000000);
const FILL_TS: BigInt = BigInt.fromI32(1760000600);

const WAD: BigInt = BigInt.fromString("1000000000000000000");
const SWAP_IN: BigInt = BigInt.fromString("10000000000000000000"); // 10e18
const SWAP_OUT: BigInt = BigInt.fromString("19000000000000000000"); // 19e18

/** Ships and funds exactly as `Aqua.ship()` does: Shipped, then the pushes. */
function shipAndFund(): void {
  handleShipped(createShipped(ZYRO_APP, STRATEGY_HASH, STRATEGY, SHIP_TS));
  handlePushed(createPushed(ZYRO_APP, STRATEGY_HASH, TOKEN_IN_ADDR, AMOUNT_IN, SHIP_TS));
  handlePushed(createPushed(ZYRO_APP, STRATEGY_HASH, TOKEN_OUT_ADDR, AMOUNT_OUT, SHIP_TS));
}

/** Settles as `SwapVM._swap` does: push in, pull out, and only then Swapped. */
function settleSwap(amountIn: BigInt, amountOut: BigInt): void {
  handlePushed(createPushed(ZYRO_APP, STRATEGY_HASH, TOKEN_IN_ADDR, amountIn, FILL_TS));
  handlePulled(createPulled(ZYRO_APP, STRATEGY_HASH, TOKEN_OUT_ADDR, amountOut, FILL_TS));
  handleSwapped(createSwapped(STRATEGY_HASH, amountIn, amountOut, FILL_TS));
}

function positionId(): string {
  return STRATEGY_HASH.toHexString();
}

function balanceId(token: Bytes): string {
  return STRATEGY_HASH.concat(token).toHexString();
}

/** The id `handleSwapped` derives, rebuilt from an identical mock event. */
function fillId(amountIn: BigInt, amountOut: BigInt): string {
  let e = createSwapped(STRATEGY_HASH, amountIn, amountOut, FILL_TS);
  return e.transaction.hash.concatI32(e.logIndex.toI32()).toHexString();
}

describe("the position lifecycle", () => {
  afterEach(() => {
    clearStore();
  });

  test("a real strategy blob ships as a Zyro position", () => {
    shipAndFund();

    assert.entityCount("Position", 1);
    assert.fieldEquals("Position", positionId(), "active", "true");
    assert.fieldEquals("Position", positionId(), "targetInventoryWad", "1000000000000000000000");
    assert.fieldEquals("Position", positionId(), "boundWad", "500000000000000000000");
    assert.fieldEquals("Position", positionId(), "horizonSecs", "3600");
  });

  test("funding is reconstructed from Pushed, not read from ship()'s arguments", () => {
    shipAndFund();

    assert.fieldEquals("PositionBalance", balanceId(TOKEN_IN), "amount", AMOUNT_IN.toString());
    assert.fieldEquals("PositionBalance", balanceId(TOKEN_OUT), "amount", AMOUNT_OUT.toString());
  });

  test("a shipped position publishes a price before anyone trades against it", () => {
    // The regression. `Shipped` precedes `Pushed`, so a position priced only at
    // ship time publishes a mid of zero until it happens to be filled, and a
    // solver querying in between routes on that zero. Nothing errors.
    shipAndFund();

    let expectedMid = AMOUNT_OUT.times(WAD).div(AMOUNT_IN);
    assert.fieldEquals("Position", positionId(), "midWad", expectedMid.toString());

    // Shipped balanced: q = balanceIn - target = 0, so there is no skew and the
    // reservation price must be exactly the mid.
    assert.fieldEquals("Position", positionId(), "inventoryImbalanceWad", "0");
    assert.fieldEquals("Position", positionId(), "reservationPriceWad", expectedMid.toString());
  });

  test("a position funded with one token publishes no price yet", () => {
    handleShipped(createShipped(ZYRO_APP, STRATEGY_HASH, STRATEGY, SHIP_TS));
    handlePushed(createPushed(ZYRO_APP, STRATEGY_HASH, TOKEN_IN_ADDR, AMOUNT_IN, SHIP_TS));

    // Halfway through ship()'s funding loop there is no second token, so there
    // is no mid. Publishing balanceOut = 0 as a mid of zero would be worse than
    // publishing nothing.
    assert.fieldEquals("Position", positionId(), "midWad", "0");
  });

  test("the canonical direction is fixed at ship, in push order", () => {
    shipAndFund();
    assert.fieldEquals(
      "Position",
      positionId(),
      "tokens",
      "[" + TOKEN_IN.toHexString() + ", " + TOKEN_OUT.toHexString() + "]"
    );
  });

  test("docking deactivates the position", () => {
    shipAndFund();
    handleDocked(createDocked(ZYRO_APP, STRATEGY_HASH, FILL_TS));

    assert.fieldEquals("Position", positionId(), "active", "false");
    assert.fieldEquals("Protocol", Bytes.fromUTF8("zyro").toHexString(), "activePositionCount", "0");
  });

  test("events from another Aqua app are ignored", () => {
    // Aqua's events fire for every app built on it. Without the filter the
    // subgraph would decode unrelated protocols' strategies as Zyro programs.
    let other = Address.fromString("0x00000000000000000000000000000000000000ee");
    handleShipped(createShipped(other, STRATEGY_HASH, STRATEGY, SHIP_TS));

    assert.entityCount("Position", 0);
  });
});

describe("fills", () => {
  afterEach(() => {
    clearStore();
  });

  test("the fill snapshot is the pre-fill state, not the post-fill state", () => {
    // The other regression. Settlement is indexed before `Swapped`, so reading
    // the store in `handleSwapped` yields post-fill balances and files the
    // post-fill mid under `midWadAtFill` — which is precisely the series the
    // headline chart plots. It renders fine. It is just the wrong number.
    shipAndFund();
    settleSwap(SWAP_IN, SWAP_OUT);

    assert.entityCount("Fill", 1);

    let preFillMid = AMOUNT_OUT.times(WAD).div(AMOUNT_IN);
    let id = fillId(SWAP_IN, SWAP_OUT);

    assert.fieldEquals("Fill", id, "midWadAtFill", preFillMid.toString());
    assert.fieldEquals("Fill", id, "inventoryImbalanceWadAtFill", "0");
    // q = 0 at the fill, so no skew: r must equal the mid exactly.
    assert.fieldEquals("Fill", id, "reservationPriceWadAtFill", preFillMid.toString());
    assert.fieldEquals("Fill", id, "exposed", "true");
  });

  test("balances after a fill come from settlement, and are not double-counted", () => {
    shipAndFund();
    settleSwap(SWAP_IN, SWAP_OUT);

    // Exactly one application of each delta. `handleSwapped` must not touch the
    // ledger that `handlePushed`/`handlePulled` already own.
    assert.fieldEquals(
      "PositionBalance",
      balanceId(TOKEN_IN),
      "amount",
      AMOUNT_IN.plus(SWAP_IN).toString()
    );
    assert.fieldEquals(
      "PositionBalance",
      balanceId(TOKEN_OUT),
      "amount",
      AMOUNT_OUT.minus(SWAP_OUT).toString()
    );
  });

  test("the published price separates from the mid once inventory drifts", () => {
    shipAndFund();
    settleSwap(SWAP_IN, SWAP_OUT);

    let postMid = AMOUNT_OUT.minus(SWAP_OUT).times(WAD).div(AMOUNT_IN.plus(SWAP_IN));
    assert.fieldEquals("Position", positionId(), "midWad", postMid.toString());
    assert.fieldEquals("Position", positionId(), "inventoryImbalanceWad", SWAP_IN.toString());

    // The position took on tokenIn, so q > 0 and the reservation price must sit
    // strictly below the mid. Equal values would mean the skew never applied —
    // the failure that makes the whole mechanism decorative.
    let published = Position.load(STRATEGY_HASH);
    assert.assertNotNull(published);
    assert.assertTrue((published as Position).reservationPriceWad.lt(postMid));
  });

  test("two fills in the same direction push the reservation price further down", () => {
    // One fill is a point. The claim is that the price walks as inventory
    // accumulates, and that needs at least two.
    shipAndFund();
    settleSwap(SWAP_IN, SWAP_OUT);

    let afterFirst = (Position.load(STRATEGY_HASH) as Position).reservationPriceWad;

    handlePushed(createPushed(ZYRO_APP, STRATEGY_HASH, TOKEN_IN_ADDR, SWAP_IN, FILL_TS));
    handlePulled(createPulled(ZYRO_APP, STRATEGY_HASH, TOKEN_OUT_ADDR, SWAP_OUT, FILL_TS));

    let afterSecond = (Position.load(STRATEGY_HASH) as Position).reservationPriceWad;
    assert.assertTrue(afterSecond.lt(afterFirst));
  });

  test("a fill against an unknown position is ignored", () => {
    let unknown = Bytes.fromHexString(
      "0x1111111111111111111111111111111111111111111111111111111111111111"
    );
    handleSwapped(createSwapped(unknown, SWAP_IN, SWAP_OUT, FILL_TS));

    assert.entityCount("Fill", 0);
  });
});
