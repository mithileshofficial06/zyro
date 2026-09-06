import {BigInt, Bytes} from "@graphprotocol/graph-ts";
import {assert, describe, test} from "matchstick-as";

import {
  decodeStrategy,
  findZyroArgs,
  programStartByte,
  ZYRO_ARGS_LENGTH
} from "../src/program";

import {
  EXPECTED_BASE_SPREAD_WAD,
  EXPECTED_BOUND_WAD,
  EXPECTED_GAMMA_WAD,
  EXPECTED_HORIZON_SECS,
  EXPECTED_PROGRAM_OFFSET,
  EXPECTED_SIGMA_SQ_WAD,
  EXPECTED_START_TIMESTAMP,
  EXPECTED_TARGET_INVENTORY_WAD,
  PROGRAM,
  STRATEGY
} from "./order-fixture";

/**
 * `decodeStrategy`, against the bytes a real `ship()` carries.
 *
 * Every failure mode in this file is silent. A wrong program offset still
 * finds plausible opcode/length pairs and walks off the end of a real
 * instruction; a missed byte-order reversal returns a number rather than an
 * error. The subgraph syncs clean either way and publishes nothing, or worse,
 * publishes something. So the expectation is not written here — it is
 * `abi.encode(order)` from a live run of `OrderFixtures.t.sol`.
 */
describe("decodeStrategy, against a real strategy blob", () => {
  test("recovers every parameter the maker shipped", () => {
    let s = decodeStrategy(STRATEGY);

    assert.assertTrue(s.valid);
    assert.bigIntEquals(EXPECTED_GAMMA_WAD, s.params.gammaWad);
    assert.bigIntEquals(EXPECTED_SIGMA_SQ_WAD, s.params.sigmaSqWad);
    assert.bigIntEquals(EXPECTED_BASE_SPREAD_WAD, s.params.baseSpreadWad);
    assert.bigIntEquals(EXPECTED_HORIZON_SECS, s.params.horizonSecs);
    assert.bigIntEquals(EXPECTED_TARGET_INVENTORY_WAD, s.targetInventoryWad);
    assert.bigIntEquals(EXPECTED_BOUND_WAD, s.boundWad);
    assert.bigIntEquals(EXPECTED_START_TIMESTAMP, s.startTimestamp);
  });

  test("the program it keeps is order.data from the traits offset", () => {
    let s = decodeStrategy(STRATEGY);
    assert.bytesEquals(PROGRAM, s.program);
  });

  test("the program offset comes from the traits word, not a fixed 40", () => {
    // The spec claimed `order.data` was `tokenA(20) ++ tokenB(20) ++ program`.
    // It is `hooksData ++ program`, and with no hooks that offset is zero.
    // Slicing at 40 would eat the Zyro instruction's first 38 argument bytes
    // and still find opcode/length pairs in what remained.
    let s = decodeStrategy(STRATEGY);
    assert.i32Equals(EXPECTED_PROGRAM_OFFSET, 0);
    assert.i32Equals(PROGRAM.length, s.program.length);
  });

  test("finds the Zyro instruction inside a multi-instruction program", () => {
    // The fixture's program is Zyro ++ XYCSwap ++ Salt, so this is a real
    // walk, not a lucky read of byte zero.
    let args = findZyroArgs(PROGRAM);
    assert.i32Equals(ZYRO_ARGS_LENGTH, args.length);
  });

  test("a program with no Zyro instruction decodes as not ours", () => {
    // XYCSwap(17, 0 args) ++ Salt(20, 8 args). Legal on the Zyro router, and
    // must not be published as a Zyro position.
    let stockOnly = findZyroArgs(Bytes.fromHexString("0x1100140800000000deadbeef"));
    assert.i32Equals(0, stockOnly.length);
  });

  test("reads the offset out of bits [208, 224) of the traits word", () => {
    // 0x1234 parked in the program-offset slot.
    let traits = BigInt.fromI32(0x1234).times(BigInt.fromI32(2).pow(208 as u8));
    assert.i32Equals(0x1234, programStartByte(traits));

    // Neighbouring hook offsets must not bleed into it.
    let noisy = traits.plus(BigInt.fromI32(0xffff).times(BigInt.fromI32(2).pow(192 as u8)));
    assert.i32Equals(0x1234, programStartByte(noisy));
  });
});
