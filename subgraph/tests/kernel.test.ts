import {BigInt} from "@graphprotocol/graph-ts";
import {assert, describe, test} from "matchstick-as";

import {
  Params,
  applyInventorySkew,
  effectivePriceWad,
  halfSpreadWad,
  midFromBalancesWad,
  remaining,
  reservationPriceWad,
  riskTermWad,
  softBoundPenaltyBps,
  sqrt
} from "../src/avellaneda-stoikov";
import {kernelFixtures} from "./kernel-fixtures";

/**
 * The AssemblyScript kernel against the chain's own answers.
 *
 * This is the test that makes the subgraph trustworthy. It re-implements
 * arithmetic that also runs on-chain, and a published reservation price the
 * chain would not quote is worse than no price at all — a solver routes on it
 * and the execution disagrees with the quote.
 *
 * Expectations come from `KernelFixtures.t.sol` via
 * `scripts/generate-fixtures.mjs`; nothing here is hand-typed. Every
 * intermediate is compared, not just the final balance pair, because an
 * implementation with two compensating errors lands on the right endpoint.
 */
describe("kernel parity with the Solidity", () => {
  test("every fixture reproduces exactly", () => {
    let fixtures = kernelFixtures();
    assert.assertTrue(fixtures.length >= 7);

    for (let i = 0; i < fixtures.length; i++) {
      let f = fixtures[i];
      let p = new Params(f.gammaWad, f.sigmaSqWad, f.baseSpreadWad, f.horizonSecs);

      assert.stringEquals(remaining(p, f.elapsed).toString(), f.remaining.toString());
      assert.stringEquals(riskTermWad(p, f.elapsed).toString(), f.riskTermWad.toString());
      assert.stringEquals(
        midFromBalancesWad(f.balanceIn, f.balanceOut).toString(),
        f.midWad.toString()
      );
      assert.stringEquals(
        reservationPriceWad(f.midWad, f.q, p, f.elapsed).toString(),
        f.reservationPriceWad.toString()
      );
      assert.stringEquals(halfSpreadWad(p, f.elapsed).toString(), f.halfSpreadWad.toString());
      assert.stringEquals(
        softBoundPenaltyBps(f.q, f.boundWad).toString(),
        f.penaltyBps.toString()
      );

      let pair = applyInventorySkew(f.balanceIn, f.balanceOut, f.q, p, f.elapsed, f.boundWad);
      assert.stringEquals(pair[0].toString(), f.newBalanceIn.toString());
      assert.stringEquals(pair[1].toString(), f.newBalanceOut.toString());
    }
  });

  test("at target the reservation price is exactly the mid", () => {
    let fixtures = kernelFixtures();
    for (let i = 0; i < fixtures.length; i++) {
      if (fixtures[i].name == "at-target") {
        assert.stringEquals(
          fixtures[i].reservationPriceWad.toString(),
          fixtures[i].midWad.toString()
        );
      }
    }
  });

  test("the exposed side quotes below the mid, the covered side above", () => {
    let fixtures = kernelFixtures();
    let mid = BigInt.zero();
    let exposed = BigInt.zero();
    let covered = BigInt.zero();

    for (let i = 0; i < fixtures.length; i++) {
      if (fixtures[i].name == "exposed") {
        exposed = fixtures[i].reservationPriceWad;
        mid = fixtures[i].midWad;
      }
      if (fixtures[i].name == "covered") covered = fixtures[i].reservationPriceWad;
    }

    assert.assertTrue(exposed.lt(mid));
    assert.assertTrue(covered.gt(mid));
    // Symmetric in the sign of q.
    assert.stringEquals(mid.minus(exposed).toString(), covered.minus(mid).toString());
  });

  test("an expired horizon stops skewing entirely", () => {
    let fixtures = kernelFixtures();
    for (let i = 0; i < fixtures.length; i++) {
      if (fixtures[i].name == "expired") {
        assert.stringEquals(fixtures[i].riskTermWad.toString(), "0");
        assert.stringEquals(
          fixtures[i].reservationPriceWad.toString(),
          fixtures[i].midWad.toString()
        );
        assert.stringEquals(
          fixtures[i].halfSpreadWad.toString(),
          fixtures[i].baseSpreadWad.toString()
        );
      }
    }
  });
});

describe("integer square root", () => {
  test("is the floor, matching OpenZeppelin's Math.sqrt", () => {
    assert.stringEquals(sqrt(BigInt.fromI32(0)).toString(), "0");
    assert.stringEquals(sqrt(BigInt.fromI32(1)).toString(), "1");
    assert.stringEquals(sqrt(BigInt.fromI32(2)).toString(), "1");
    assert.stringEquals(sqrt(BigInt.fromI32(3)).toString(), "1");
    assert.stringEquals(sqrt(BigInt.fromI32(4)).toString(), "2");
    assert.stringEquals(sqrt(BigInt.fromI32(99)).toString(), "9");
    assert.stringEquals(
      sqrt(BigInt.fromString("1000000000000000000000000000000000000")).toString(),
      "1000000000000000000"
    );
  });

  test("never overshoots on large values", () => {
    let n = BigInt.fromString("100000000000000000000000000000000000000000");
    let r = sqrt(n);
    assert.assertTrue(r.times(r).le(n));
    let next = r.plus(BigInt.fromI32(1));
    assert.assertTrue(next.times(next).gt(n));
  });
});

describe("degenerate inputs", () => {
  test("a zero balanceIn implies a zero mid rather than dividing by zero", () => {
    assert.stringEquals(
      midFromBalancesWad(BigInt.zero(), BigInt.fromString("1000000000000000000000")).toString(),
      "0"
    );
  });

  test("an undeclared bound produces no penalty", () => {
    assert.stringEquals(
      softBoundPenaltyBps(BigInt.fromString("1000000000000000000000"), BigInt.zero()).toString(),
      "0"
    );
  });

  test("the effective price never goes non-positive", () => {
    // A runaway skew must floor at 1, not wrap or go negative.
    let p = new Params(
      BigInt.fromString("1000000000000000000"),
      BigInt.fromString("1000000000000000000"),
      BigInt.zero(),
      BigInt.fromI32(31536000)
    );
    let price = effectivePriceWad(
      BigInt.fromString("2000000000000000000"),
      BigInt.fromString("1000000000000000000000000"),
      p,
      BigInt.zero()
    );
    assert.assertTrue(price.ge(BigInt.fromI32(1)));
  });
});
