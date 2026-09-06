// GENERATED FILE — DO NOT EDIT.
//
// Produced by `node scripts/generate-fixtures.mjs` from
// `contracts/test/fixtures/kernel.json`, which is itself written by a live run
// of `KernelFixtures.t.sol`.
//
// The AssemblyScript kernel in `src/avellaneda-stoikov.ts` re-implements
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
    new KernelFixture(
      "at-target",
      B("1000000000000000000000"), B("2000000000000000000000"), B("0"),
      B("100000000000000"), B("50000000000000"), B("1000000000000000"),
      B("3600"), B("0"), B("500000000000000000000"),
      B("3600"), B("18000000000000"), B("2000000000000000000"),
      B("2000000000000000000"), B("1018000000000000"), B("0"),
      B("1000254597196603433909"), B("1999490935213260725526")
    ),
    new KernelFixture(
      "exposed",
      B("1000000000000000000000"), B("2000000000000000000000"), B("500000000000000000000"),
      B("100000000000000"), B("50000000000000"), B("1000000000000000"),
      B("3600"), B("0"), B("500000000000000000000"),
      B("3600"), B("18000000000000"), B("2000000000000000000"),
      B("1991000000000000000"), B("1018000000000000"), B("500"),
      B("1002513948227104216804"), B("1895235476134825838386")
    ),
    new KernelFixture(
      "covered",
      B("1000000000000000000000"), B("2000000000000000000000"), B("-500000000000000000000"),
      B("100000000000000"), B("50000000000000"), B("1000000000000000"),
      B("3600"), B("0"), B("500000000000000000000"),
      B("3600"), B("18000000000000"), B("2000000000000000000"),
      B("2009000000000000000"), B("1018000000000000"), B("500"),
      B("997504869677917374398"), B("2005002743140268125056")
    ),
    new KernelFixture(
      "half-ramp",
      B("1000000000000000000000"), B("2000000000000000000000"), B("250000000000000000000"),
      B("100000000000000"), B("50000000000000"), B("1000000000000000"),
      B("3600"), B("0"), B("500000000000000000000"),
      B("3600"), B("18000000000000"), B("2000000000000000000"),
      B("1995500000000000000"), B("1018000000000000"), B("250"),
      B("1001382361109299530747"), B("1947308116991247998019")
    ),
    new KernelFixture(
      "past-bound",
      B("1000000000000000000000"), B("2000000000000000000000"), B("900000000000000000000"),
      B("100000000000000"), B("50000000000000"), B("1000000000000000"),
      B("3600"), B("0"), B("100000000000000000000"),
      B("3600"), B("18000000000000"), B("2000000000000000000"),
      B("1983800000000000000"), B("1018000000000000"), B("500"),
      B("1004332493986292437581"), B("1891803771536572447374")
    ),
    new KernelFixture(
      "mid-horizon",
      B("1000000000000000000000"), B("2000000000000000000000"), B("500000000000000000000"),
      B("100000000000000"), B("50000000000000"), B("1000000000000000"),
      B("3600"), B("1800"), B("500000000000000000000"),
      B("1800"), B("9000000000000"), B("2000000000000000000"),
      B("1995500000000000000"), B("1009000000000000"), B("500"),
      B("1001380101773103727395"), B("1897381420537262455042")
    ),
    new KernelFixture(
      "expired",
      B("1000000000000000000000"), B("2000000000000000000000"), B("500000000000000000000"),
      B("100000000000000"), B("50000000000000"), B("1000000000000000"),
      B("3600"), B("7200"), B("500000000000000000000"),
      B("0"), B("0"), B("2000000000000000000"),
      B("2000000000000000000"), B("1000000000000000"), B("500"),
      B("1000250093789079597537"), B("1899524940610151609706")
    )
  ];
}
