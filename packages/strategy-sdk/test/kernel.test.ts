/**
 * Checks the TypeScript kernel against reference outputs from the Solidity.
 *
 * The fixtures are produced by a live run of `KernelFixtures.t.sol`, not derived
 * by reading the contract. Every intermediate is compared, not just the final
 * balance pair — an implementation with two compensating errors can land on the
 * right endpoint, and this is exactly the arithmetic where that happens.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  applyInventorySkew,
  effectivePriceWad,
  halfSpreadWad,
  midFromBalancesWad,
  recenterBalances,
  remaining,
  reservationPriceWad,
  riskTermWad,
  softBoundPenaltyBps,
  sqrt,
  type KernelParams,
} from "../src/kernel.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "../../../contracts/test/fixtures/kernel.json");

interface Fixture {
  name: string;
  balanceIn: string;
  balanceOut: string;
  q: string;
  gammaWad: string;
  sigmaSqWad: string;
  baseSpreadWad: string;
  horizonSecs: number;
  elapsed: number;
  boundWad: string;
  remaining: number;
  riskTermWad: string;
  midWad: string;
  reservationPriceWad: string;
  halfSpreadWad: string;
  penaltyBps: number;
  newBalanceIn: string;
  newBalanceOut: string;
}

const fixtures: Fixture[] = JSON.parse(readFileSync(FIXTURES, "utf8"));

function paramsOf(f: Fixture): KernelParams {
  return {
    gammaWad: BigInt(f.gammaWad),
    sigmaSqWad: BigInt(f.sigmaSqWad),
    baseSpreadWad: BigInt(f.baseSpreadWad),
    horizonSecs: BigInt(f.horizonSecs),
  };
}

describe("kernel parity with the Solidity", () => {
  test("the fixture file covers the interesting states", () => {
    const names = fixtures.map((f) => f.name);
    for (const required of ["at-target", "exposed", "covered", "past-bound", "expired"]) {
      assert.ok(names.includes(required), `missing fixture: ${required}`);
    }
  });

  for (const f of fixtures) {
    describe(f.name, () => {
      const p = paramsOf(f);
      const elapsed = BigInt(f.elapsed);
      const q = BigInt(f.q);
      const balanceIn = BigInt(f.balanceIn);
      const balanceOut = BigInt(f.balanceOut);

      test("remaining", () => {
        assert.equal(remaining(p, elapsed), BigInt(f.remaining));
      });

      test("riskTermWad", () => {
        assert.equal(riskTermWad(p, elapsed), BigInt(f.riskTermWad));
      });

      test("midFromBalancesWad", () => {
        assert.equal(midFromBalancesWad(balanceIn, balanceOut), BigInt(f.midWad));
      });

      test("reservationPriceWad", () => {
        assert.equal(
          reservationPriceWad(BigInt(f.midWad), q, p, elapsed),
          BigInt(f.reservationPriceWad),
        );
      });

      test("halfSpreadWad", () => {
        assert.equal(halfSpreadWad(p, elapsed), BigInt(f.halfSpreadWad));
      });

      test("softBoundPenaltyBps", () => {
        assert.equal(softBoundPenaltyBps(q, BigInt(f.boundWad)), BigInt(f.penaltyBps));
      });

      test("applyInventorySkew", () => {
        const [newIn, newOut] = applyInventorySkew(
          balanceIn,
          balanceOut,
          q,
          p,
          elapsed,
          BigInt(f.boundWad),
        );
        assert.equal(newIn, BigInt(f.newBalanceIn), "balanceIn diverged");
        assert.equal(newOut, BigInt(f.newBalanceOut), "balanceOut diverged");
      });
    });
  }
});

describe("the mechanism, read off the fixtures", () => {
  const byName = (n: string) => fixtures.find((f) => f.name === n)!;

  test("at target the reservation price is exactly the mid", () => {
    const f = byName("at-target");
    assert.equal(BigInt(f.reservationPriceWad), BigInt(f.midWad));
  });

  test("exposed quotes below mid and covered above, symmetrically", () => {
    const mid = BigInt(byName("exposed").midWad);
    const exposed = BigInt(byName("exposed").reservationPriceWad);
    const covered = BigInt(byName("covered").reservationPriceWad);

    assert.ok(exposed < mid, "exposed must sit below mid");
    assert.ok(covered > mid, "covered must sit above mid");
    assert.equal(mid - exposed, covered - mid, "skew must be symmetric in the sign of q");
  });

  test("an expired horizon stops skewing and leaves only the base spread", () => {
    const f = byName("expired");
    assert.equal(BigInt(f.riskTermWad), 0n);
    assert.equal(BigInt(f.reservationPriceWad), BigInt(f.midWad));
    assert.equal(BigInt(f.halfSpreadWad), BigInt(f.baseSpreadWad));
  });

  test("half the horizon consumed is half the skew", () => {
    const start = BigInt(byName("exposed").riskTermWad);
    const half = BigInt(byName("mid-horizon").riskTermWad);
    assert.equal(half * 2n, start);
  });

  test("the calibrated skew is a plausible fraction of the mid, not a clamp", () => {
    const f = byName("exposed");
    const mid = BigInt(f.midWad);
    const skew = mid - BigInt(f.reservationPriceWad);
    assert.ok(skew > 0n, "skew should not round to nothing");
    assert.ok(skew < mid / 20n, "skew should be well under 5% of mid");
  });

  test("the effective price is worse than the reservation price when exposed", () => {
    const f = byName("exposed");
    const price = effectivePriceWad(
      BigInt(f.balanceIn),
      BigInt(f.balanceOut),
      BigInt(f.q),
      paramsOf(f),
      BigInt(f.elapsed),
    );
    assert.equal(price, BigInt(f.reservationPriceWad) - BigInt(f.halfSpreadWad));
  });
});

describe("integer square root matches OpenZeppelin's floor semantics", () => {
  test("exact squares", () => {
    for (const n of [0n, 1n, 4n, 9n, 16n, 10n ** 36n]) {
      const r = sqrt(n);
      assert.equal(r * r, n, `sqrt(${n}) should be exact`);
    }
  });

  test("non-squares floor rather than round", () => {
    assert.equal(sqrt(2n), 1n);
    assert.equal(sqrt(3n), 1n);
    assert.equal(sqrt(8n), 2n);
    assert.equal(sqrt(99n), 9n);
    assert.equal(sqrt(10n ** 37n), 3162277660168379331n);
  });

  test("is the true floor for a spread of large values", () => {
    for (const n of [10n ** 40n + 12345n, 2n ** 200n - 1n, 7n ** 47n]) {
      const r = sqrt(n);
      assert.ok(r * r <= n, `sqrt(${n})^2 must not exceed n`);
      assert.ok((r + 1n) * (r + 1n) > n, `sqrt(${n}) must be the largest such root`);
    }
  });

  test("rejects a negative input", () => {
    assert.throws(() => sqrt(-1n), /negative/);
  });
});

describe("degenerate inputs behave as the Solidity does", () => {
  test("a zero balanceIn implies a zero mid rather than dividing by zero", () => {
    assert.equal(midFromBalancesWad(0n, 10n ** 21n), 0n);
  });

  test("re-centring on a non-positive price is a no-op, not a throw", () => {
    assert.deepEqual(recenterBalances(10n ** 21n, 2n * 10n ** 21n, 0n), [
      10n ** 21n,
      2n * 10n ** 21n,
    ]);
    assert.deepEqual(recenterBalances(10n ** 21n, 2n * 10n ** 21n, -1n), [
      10n ** 21n,
      2n * 10n ** 21n,
    ]);
  });

  test("an undeclared bound produces no penalty", () => {
    assert.equal(softBoundPenaltyBps(10n ** 24n, 0n), 0n);
  });

  test("signed division truncates toward zero, as in Solidity", () => {
    // The skew term is signed; a language that floored would be off by one on
    // every negative result. This pins the behaviour rather than assuming it.
    assert.equal(-7n / 2n, -3n);
    const p: KernelParams = {
      gammaWad: 10n ** 18n,
      sigmaSqWad: 10n ** 18n,
      baseSpreadWad: 0n,
      horizonSecs: 1n,
    };
    // q = -3, riskTerm = 1e18 => skew = (-3 * 1e18) / 1e18 = -3 exactly.
    assert.equal(reservationPriceWad(0n, -3n, p, 0n), 3n);
  });
});
