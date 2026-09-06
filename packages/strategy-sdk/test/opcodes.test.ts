/**
 * Pins Zyro's opcode bytes to the stock Aqua instruction ordering.
 *
 * The opcode map was derived three independent ways and all three agree:
 *
 *   1. by hand from `AquaOpcodes._opcodes()` in `1inch/swap-vm`, working through
 *      the `mstore`-over-element-0 trick that shifts the table by one;
 *   2. from `aquaInstructions` in 1inch's own SwapVM TypeScript SDK, where the
 *      program builder uses the array index as the opcode byte;
 *   3. empirically, in `ZyroRouter.t.sol`, where opcode 34 panics on a real
 *      stock router and executes on `ZyroRouter`.
 *
 * These tests keep (2) honest. Claiming an occupied slot would silently break a
 * stock instruction rather than fail loudly, which is the single worst failure
 * this project could ship.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { Opcode } from "../src/instructions.ts";
import {
  EMPTY,
  STOCK_AQUA_INSTRUCTIONS,
  ZYRO_OPCODE,
  stockOpcode,
} from "../src/aqua-opcodes.ts";

describe("stock Aqua instruction set", () => {
  test("has exactly 34 entries, matching AquaOpcodes._opcodes()", () => {
    assert.equal(STOCK_AQUA_INSTRUCTIONS.length, 34);
  });

  test("the curve instruction is opcode 17", () => {
    assert.equal(stockOpcode("xycSwap.xycSwapXD"), 17);
    assert.equal(Opcode.XYC_SWAP, 17);
  });

  test("salt is opcode 20", () => {
    assert.equal(stockOpcode("controls.salt"), 20);
    assert.equal(Opcode.SALT, 20);
  });

  test("the last stock instruction sits at index 33", () => {
    assert.equal(stockOpcode("controls.onlyTxOriginTokenBalanceNonZero"), 33);
  });

  test("reserved slots are where upstream leaves them", () => {
    // Debug slots.
    for (let i = 0; i <= 9; i++) {
      assert.equal(STOCK_AQUA_INSTRUCTIONS[i], EMPTY, `index ${i} should be reserved`);
    }
    // The gap between flatFeeAmountIn and the protocol-fee instructions, which
    // exists because the fuller (non-Aqua) opcode set has FeeExperimental
    // entries in those positions.
    for (let i = 22; i <= 26; i++) {
      assert.equal(STOCK_AQUA_INSTRUCTIONS[i], EMPTY, `index ${i} should be reserved`);
    }
  });

  test("an unknown instruction name is rejected rather than defaulting to 0", () => {
    // Opcode 0 is NOT_INSTRUCTION; silently returning it would be a live bug.
    assert.throws(() => stockOpcode("nope.doesNotExist"), /unknown stock Aqua instruction/);
  });
});

describe("Zyro's claimed opcode", () => {
  test("is the next free index after the stock set", () => {
    assert.equal(ZYRO_OPCODE, STOCK_AQUA_INSTRUCTIONS.length);
    assert.equal(Opcode.ZYRO_INVENTORY_SKEW, 34);
  });

  test("does not collide with any stock instruction", () => {
    assert.ok(
      Opcode.ZYRO_INVENTORY_SKEW >= STOCK_AQUA_INSTRUCTIONS.length,
      "Zyro's opcode must sit past the end of the stock dispatch array",
    );
  });

  test("is not 0x92, which the build spec called for", () => {
    // 0x92 is 146. The dispatch array has 34 entries, so 146 is not a reserved
    // slot in a family bank — it is an out-of-bounds panic. See
    // docs/PHASE2-SOURCE-VERIFICATION.md.
    assert.notEqual(Opcode.ZYRO_INVENTORY_SKEW, 0x92);
    assert.ok(0x92 > STOCK_AQUA_INSTRUCTIONS.length);
  });

  test("fits in the single byte the VM reads it from", () => {
    assert.ok(Opcode.ZYRO_INVENTORY_SKEW <= 255);
  });
});
