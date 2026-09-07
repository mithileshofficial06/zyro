import "server-only";

import {readFileSync, existsSync} from "node:fs";
import {join} from "node:path";

import type {Benchmark} from "./types";

/**
 * The competitive routing benchmark, as `CompetitiveFlow.t.sol` wrote it.
 *
 * @dev Read from `contracts/test/fixtures/` rather than from a copy inside the
 *      console, and never transcribed. The build spec's rule for this page is
 *      that every number is generated, and the enforcement is that CI runs
 *      `forge test` — which rewrites this file — and then fails on any diff
 *      under `contracts/test/fixtures/`. A figure edited into the page cannot
 *      survive a commit, and a figure edited into the fixture cannot either.
 *
 *      Same reason `loadDeployment` reads the repository: a second copy is a
 *      second thing to update, and the one nobody updates is the one on the
 *      screen.
 */
export function loadBenchmark(): Benchmark | null {
  // `next dev` and `next build` both run with cwd at apps/console; two levels
  // up is the repository root.
  const path = join(process.cwd(), "..", "..", "contracts", "test", "fixtures", "benchmark.json");
  if (!existsSync(path)) return null;

  try {
    return JSON.parse(readFileSync(path, "utf8")) as Benchmark;
  } catch {
    return null;
  }
}

/** `zyro.valueWad - stock.valueWad`, the headline number, kept exact. */
export function advantageWad(scenario: Benchmark["scenarios"][number]): bigint {
  return BigInt(scenario.zyro.valueWad) - BigInt(scenario.stock.valueWad);
}

/**
 * The advantage as a fraction of the stock position's own final value, in bps.
 *
 * @dev Relative to stock rather than to starting inventory. The positions are
 *      marked at the exogenous price and both have moved, so the honest
 *      denominator is what the alternative was actually worth at the mark —
 *      not what either of them started with.
 */
export function advantageBps(scenario: Benchmark["scenarios"][number]): number {
  const stock = BigInt(scenario.stock.valueWad);
  if (stock === 0n) return 0;
  return Number((advantageWad(scenario) * 1_000_000n) / stock) / 100;
}

/** Fill rate as a percentage of ticks, to one decimal. */
export function fillRate(fills: number, ticks: number): number {
  return ticks === 0 ? 0 : Math.round((fills / ticks) * 1000) / 10;
}
