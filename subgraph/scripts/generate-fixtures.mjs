/**
 * Transcribes the Solidity-generated kernel fixtures into AssemblyScript.
 *
 * Matchstick tests cannot read a JSON file at runtime, but hand-copying the
 * expected values would defeat the entire point of having fixtures — a
 * hand-copied expectation only proves the author read both implementations the
 * same wrong way.
 *
 * So this generates them. The source of truth stays
 * `contracts/test/fixtures/kernel.json`, written by a live run of
 * `KernelFixtures.t.sol`, and CI regenerates this file and fails if it drifts.
 *
 *   node scripts/generate-fixtures.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(here, "../../contracts/test/fixtures/kernel.json");
const OUT = join(here, "../tests/kernel-fixtures.ts");

const fixtures = JSON.parse(readFileSync(SOURCE, "utf8"));

const header = `// GENERATED FILE — DO NOT EDIT.
//
// Produced by \`node scripts/generate-fixtures.mjs\` from
// \`contracts/test/fixtures/kernel.json\`, which is itself written by a live run
// of \`KernelFixtures.t.sol\`.
//
// The AssemblyScript kernel in \`src/avellaneda-stoikov.ts\` re-implements
// arithmetic that also runs on-chain. A subgraph publishing a reservation price
// the chain would not quote is worse than one publishing nothing: a solver
// routes on it and the execution disagrees. These are the chain's answers.

import {BigInt} from "@graphprotocol/graph-ts";

export class KernelFixture {
  name: string;
  balanceIn: BigInt;
  balanceOut: BigInt;
  q: BigInt;
  gammaWad: BigInt;
  sigmaSqWad: BigInt;
  baseSpreadWad: BigInt;
  horizonSecs: BigInt;
  elapsed: BigInt;
  boundWad: BigInt;
  remaining: BigInt;
  riskTermWad: BigInt;
  midWad: BigInt;
  reservationPriceWad: BigInt;
  halfSpreadWad: BigInt;
  penaltyBps: BigInt;
  newBalanceIn: BigInt;
  newBalanceOut: BigInt;

  constructor(
    name: string,
    balanceIn: BigInt,
    balanceOut: BigInt,
    q: BigInt,
    gammaWad: BigInt,
    sigmaSqWad: BigInt,
    baseSpreadWad: BigInt,
    horizonSecs: BigInt,
    elapsed: BigInt,
    boundWad: BigInt,
    remaining: BigInt,
    riskTermWad: BigInt,
    midWad: BigInt,
    reservationPriceWad: BigInt,
    halfSpreadWad: BigInt,
    penaltyBps: BigInt,
    newBalanceIn: BigInt,
    newBalanceOut: BigInt
  ) {
    this.name = name;
    this.balanceIn = balanceIn;
    this.balanceOut = balanceOut;
    this.q = q;
    this.gammaWad = gammaWad;
    this.sigmaSqWad = sigmaSqWad;
    this.baseSpreadWad = baseSpreadWad;
    this.horizonSecs = horizonSecs;
    this.elapsed = elapsed;
    this.boundWad = boundWad;
    this.remaining = remaining;
    this.riskTermWad = riskTermWad;
    this.midWad = midWad;
    this.reservationPriceWad = reservationPriceWad;
    this.halfSpreadWad = halfSpreadWad;
    this.penaltyBps = penaltyBps;
    this.newBalanceIn = newBalanceIn;
    this.newBalanceOut = newBalanceOut;
  }
}

const B = (s: string): BigInt => BigInt.fromString(s);

export function kernelFixtures(): KernelFixture[] {
  return [
`;

const rows = fixtures
  .map(
    (f) => `    new KernelFixture(
      "${f.name}",
      B("${f.balanceIn}"), B("${f.balanceOut}"), B("${f.q}"),
      B("${f.gammaWad}"), B("${f.sigmaSqWad}"), B("${f.baseSpreadWad}"),
      B("${f.horizonSecs}"), B("${f.elapsed}"), B("${f.boundWad}"),
      B("${f.remaining}"), B("${f.riskTermWad}"), B("${f.midWad}"),
      B("${f.reservationPriceWad}"), B("${f.halfSpreadWad}"), B("${f.penaltyBps}"),
      B("${f.newBalanceIn}"), B("${f.newBalanceOut}")
    )`,
  )
  .join(",\n");

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${header}${rows}\n  ];\n}\n`, "utf8");

console.log(`wrote ${OUT} (${fixtures.length} fixtures)`);
