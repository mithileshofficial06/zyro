/**
 * The cross-language correctness check.
 *
 * The fixtures are not written by hand and are not derived from reading the
 * Solidity. They are produced by a live run of `EncodingFixtures.t.sol`, which
 * runs in the same CI job, so the SDK cannot drift from the on-chain encoder
 * without this going red.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  Opcode,
  ZYRO_ARGS_LENGTH,
  buildZyroProgram,
  encodeSalt,
  encodeXYCSwap,
  encodeZyroInventorySkew,
  encodeZyroInventorySkewArgs,
  validateZyroParams,
  type ZyroInventorySkewParams,
} from "../src/instructions.ts";
import { byteLength, packInt, packUint } from "../src/bytes.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "../../../contracts/test/fixtures/encoding.json");

interface Fixture {
  name: string;
  gammaWad: string;
  sigmaSqWad: string;
  baseSpreadWad: string;
  targetInventoryWad: string;
  boundWad: string;
  horizonSecs: number;
  startTimestamp: number;
  opcode: number;
  args: string;
  instruction: string;
}

const fixtures: Fixture[] = JSON.parse(readFileSync(FIXTURES, "utf8"));

function paramsOf(f: Fixture): ZyroInventorySkewParams {
  return {
    gammaWad: BigInt(f.gammaWad),
    sigmaSqWad: BigInt(f.sigmaSqWad),
    baseSpreadWad: BigInt(f.baseSpreadWad),
    targetInventoryWad: BigInt(f.targetInventoryWad),
    boundWad: BigInt(f.boundWad),
    horizonSecs: f.horizonSecs,
    startTimestamp: f.startTimestamp,
  };
}

describe("byte-parity with the Solidity encoder", () => {
  test("the fixture file is present and non-trivial", () => {
    assert.ok(fixtures.length >= 4, "expected at least four fixtures");
  });

  for (const f of fixtures) {
    test(`${f.name}: argument block matches Solidity byte for byte`, () => {
      // `validate: false` — the "maxima" fixture deliberately sits outside the
      // maker-facing parameter bounds in order to pin the field widths.
      const encoded = encodeZyroInventorySkewArgs(paramsOf(f), false);
      assert.equal(encoded, f.args);
      assert.equal(byteLength(encoded), ZYRO_ARGS_LENGTH);
    });

    test(`${f.name}: full instruction matches Solidity byte for byte`, () => {
      const encoded = encodeZyroInventorySkew(paramsOf(f), false);
      assert.equal(encoded, f.instruction);
      assert.equal(byteLength(encoded), ZYRO_ARGS_LENGTH + 2);
    });

    test(`${f.name}: opcode agrees with Solidity`, () => {
      assert.equal(f.opcode, Opcode.ZYRO_INVENTORY_SKEW);
      assert.equal(f.instruction.slice(0, 4), "0x22", "opcode byte must be 0x22 (34)");
      assert.equal(f.instruction.slice(4, 6), "79", "length byte must be 0x79 (121)");
    });
  }
});

describe("instruction framing", () => {
  test("XYCSwap is opcode 17 with no arguments", () => {
    assert.equal(encodeXYCSwap(), "0x1100");
  });

  test("salt carries its payload with a correct length byte", () => {
    assert.equal(encodeSalt("0xdeadbeef"), "0x1404deadbeef");
  });

  test("a program is skew ++ curve ++ salt, in that order", () => {
    const p = paramsOf(fixtures[0]!);
    const program = buildZyroProgram(p, "0xdeadbeef");

    assert.equal(
      program,
      encodeZyroInventorySkew(p) + encodeXYCSwap().slice(2) + encodeSalt("0xdeadbeef").slice(2),
    );
    // 123 (skew) + 2 (curve) + 6 (salt) = 131
    assert.equal(byteLength(program), 131);
  });

  test("arguments longer than 255 bytes are rejected, not truncated", () => {
    assert.throws(() => encodeSalt(`0x${"ab".repeat(256)}`), /255-byte limit/);
  });
});

describe("packing", () => {
  test("negative values are two's complement, big-endian", () => {
    assert.equal(packInt(-1n, 32), `0x${"ff".repeat(32)}`);
    assert.equal(packInt(-1n, 16), `0x${"ff".repeat(16)}`);
    assert.equal(packInt(0n, 4), "0x00000000");
    assert.equal(packInt(1n, 4), "0x00000001");
  });

  test("out-of-range values are rejected rather than silently wrapped", () => {
    assert.throws(() => packUint(256n, 1), /does not fit/);
    assert.throws(() => packUint(-1n, 1), /negative/);
    assert.throws(() => packInt(128n, 1), /does not fit/);
    assert.throws(() => packInt(-129n, 1), /does not fit/);
  });

  test("int128 boundaries are exactly representable", () => {
    const max = (1n << 127n) - 1n;
    assert.equal(packInt(max, 16), `0x7f${"ff".repeat(15)}`);
    assert.equal(packInt(-(1n << 127n), 16), `0x80${"00".repeat(15)}`);
  });
});

describe("parameter validation mirrors AvellanedaStoikov.validate", () => {
  const base: ZyroInventorySkewParams = {
    gammaWad: 10n ** 14n,
    sigmaSqWad: 5n * 10n ** 13n,
    baseSpreadWad: 10n ** 15n,
    targetInventoryWad: 1000n * 10n ** 18n,
    boundWad: 500n * 10n ** 18n,
    horizonSecs: 3600,
    startTimestamp: 1_760_000_000,
  };

  test("accepts a calibrated position", () => {
    validateZyroParams(base);
  });

  // The sign checks are the load-bearing ones: a negative gamma or sigmaSq
  // inverts the skew into a reward for drifting away from target.
  test("rejects a negative gamma", () => {
    assert.throws(() => validateZyroParams({ ...base, gammaWad: -1n }), /must not be negative/);
  });

  test("rejects a negative sigmaSq", () => {
    assert.throws(() => validateZyroParams({ ...base, sigmaSqWad: -1n }), /must not be negative/);
  });

  test("rejects a negative base spread", () => {
    assert.throws(
      () => validateZyroParams({ ...base, baseSpreadWad: -1n }),
      /must not be negative/,
    );
  });

  test("rejects parameters above their caps", () => {
    assert.throws(() => validateZyroParams({ ...base, gammaWad: 10n ** 18n + 1n }), /<= 1e18/);
    assert.throws(() => validateZyroParams({ ...base, sigmaSqWad: 10n ** 18n + 1n }), /<= 1e18/);
    assert.throws(() => validateZyroParams({ ...base, baseSpreadWad: 10n ** 18n + 1n }), /<= 1e18/);
  });

  test("rejects a horizon longer than a year", () => {
    assert.throws(
      () => validateZyroParams({ ...base, horizonSecs: 365 * 24 * 60 * 60 + 1 }),
      /365 days/,
    );
  });

  test("accepts the caps themselves", () => {
    validateZyroParams({
      ...base,
      gammaWad: 10n ** 18n,
      sigmaSqWad: 10n ** 18n,
      baseSpreadWad: 10n ** 18n,
      horizonSecs: 365 * 24 * 60 * 60,
    });
  });

  test("encoding validates by default", () => {
    assert.throws(
      () => encodeZyroInventorySkew({ ...base, gammaWad: -1n }),
      /must not be negative/,
    );
  });
});
