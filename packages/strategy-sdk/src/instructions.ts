/**
 * SwapVM instruction encoders.
 *
 * These must produce **byte-identical** output to the Solidity encoders in
 * `contracts/src/instructions/ZyroInstructions.sol`. That is not asserted by
 * inspection: `contracts/test/EncodingFixtures.t.sol` writes reference bytes
 * from a live run of the Solidity `build()`, and `test/encoding.test.ts`
 * compares against that file.
 */

import { concatHex, packByte, packInt, packUint, byteLength, type Hex } from "./bytes.ts";
import { ZYRO_OPCODE, stockOpcode } from "./aqua-opcodes.ts";

/**
 * Opcode bytes in the Aqua instruction set.
 *
 * These are positions in a **dense** dispatch array, not slots in a sparse
 * address space, so they are *derived* from the instruction ordering in
 * `aqua-opcodes.ts` rather than written down as magic numbers. If 1inch appends
 * an instruction upstream, updating that one list moves Zyro out of the way.
 *
 * @see docs/PHASE2-SOURCE-VERIFICATION.md
 * @see docs/UPSTREAM-SDK-VERIFICATION.md
 */
export const Opcode = {
  /** `XYCSwap._xycSwapXD` — the constant-product curve. Takes no arguments. */
  XYC_SWAP: stockOpcode("xycSwap.xycSwapXD"),
  /** `Controls._salt` — does nothing; exists to make an order hash unique. */
  SALT: stockOpcode("controls.salt"),
  /** `ZyroInventorySkew` — the next free index after the stock set's 34 entries. */
  ZYRO_INVENTORY_SKEW: ZYRO_OPCODE,
} as const;

/** Argument-block length of the Zyro instruction, in bytes. */
export const ZYRO_ARGS_LENGTH = 121;

export interface ZyroInventorySkewParams {
  /** Risk aversion, WAD. Must be in `[0, 1e18]`. */
  gammaWad: bigint;
  /** Variance estimate, WAD. Must be in `[0, 1e18]`. */
  sigmaSqWad: bigint;
  /** Base half-spread, an absolute WAD price offset. Must be in `[0, 1e18]`. */
  baseSpreadWad: bigint;
  /** The maker's desired `balanceIn`. */
  targetInventoryWad: bigint;
  /** Soft bound on `|q|`. */
  boundWad: bigint;
  /** Quoting horizon `T`, in seconds. Must be `<= 365 days`. */
  horizonSecs: number | bigint;
  /** When the horizon began. Must not be in the future at execution time. */
  startTimestamp: number | bigint;
}

const WAD = 10n ** 18n;
const MAX_HORIZON_SECS = 365n * 24n * 60n * 60n;

/**
 * Mirrors `AvellanedaStoikov.validate`, so a maker finds out here rather than
 * from a reverted transaction.
 *
 * The negative checks are the important ones. `gamma` and `sigmaSq` are signed
 * on the wire, and a negative value inverts `r = mid - skew` into
 * `r = mid + skew`: the position then quotes *better* prices the further it
 * drifts from target, paying takers to worsen its own inventory.
 */
export function validateZyroParams(p: ZyroInventorySkewParams): void {
  const horizon = BigInt(p.horizonSecs);

  if (p.gammaWad < 0n) throw new Error(`gammaWad must not be negative: ${p.gammaWad}`);
  if (p.gammaWad > WAD) throw new Error(`gammaWad must be <= 1e18: ${p.gammaWad}`);
  if (p.sigmaSqWad < 0n) throw new Error(`sigmaSqWad must not be negative: ${p.sigmaSqWad}`);
  if (p.sigmaSqWad > WAD) throw new Error(`sigmaSqWad must be <= 1e18: ${p.sigmaSqWad}`);
  if (p.baseSpreadWad < 0n) {
    throw new Error(`baseSpreadWad must not be negative: ${p.baseSpreadWad}`);
  }
  if (p.baseSpreadWad > WAD) throw new Error(`baseSpreadWad must be <= 1e18: ${p.baseSpreadWad}`);
  if (horizon > MAX_HORIZON_SECS) throw new Error(`horizonSecs must be <= 365 days: ${horizon}`);
}

/**
 * Encodes the 121-byte argument block of the Zyro instruction.
 *
 * Layout — offsets in bytes:
 *
 * | Offset | Bytes | Field                | Type     |
 * |--------|-------|----------------------|----------|
 * | 0      | 16    | `gammaWad`           | `int128` |
 * | 16     | 16    | `sigmaSqWad`         | `int128` |
 * | 32     | 16    | `baseSpreadWad`      | `int128` |
 * | 48     | 32    | `targetInventoryWad` | `int256` |
 * | 80     | 32    | `boundWad`           | `int256` |
 * | 112    | 4     | `horizonSecs`        | `uint32` |
 * | 116    | 5     | `startTimestamp`     | `uint40` |
 *
 * @param validate pass `false` only to encode a deliberately invalid block for
 *                 a test; the instruction rejects one on every `exec`.
 */
export function encodeZyroInventorySkewArgs(
  p: ZyroInventorySkewParams,
  validate = true,
): Hex {
  if (validate) validateZyroParams(p);

  const args = concatHex(
    packInt(p.gammaWad, 16),
    packInt(p.sigmaSqWad, 16),
    packInt(p.baseSpreadWad, 16),
    packInt(p.targetInventoryWad, 32),
    packInt(p.boundWad, 32),
    packUint(BigInt(p.horizonSecs), 4),
    packUint(BigInt(p.startTimestamp), 5),
  );

  if (byteLength(args) !== ZYRO_ARGS_LENGTH) {
    throw new Error(`encoded ${byteLength(args)} bytes, expected ${ZYRO_ARGS_LENGTH}`);
  }
  return args;
}

/** Prefixes an argument block with the VM's 2-byte `opcode ++ argsLength` header. */
export function encodeInstruction(opcode: number, args: Hex | "0x"): Hex {
  const len = byteLength(args);
  if (len > 255) {
    throw new Error(`instruction arguments exceed the VM's 255-byte limit: ${len}`);
  }
  return concatHex(packByte(opcode), packByte(len), args);
}

/** The complete Zyro instruction, header included. */
export function encodeZyroInventorySkew(
  p: ZyroInventorySkewParams,
  validate = true,
): Hex {
  return encodeInstruction(
    Opcode.ZYRO_INVENTORY_SKEW,
    encodeZyroInventorySkewArgs(p, validate),
  );
}

/** `XYCSwap` takes no arguments — the curve reads the balance registers. */
export function encodeXYCSwap(): Hex {
  return encodeInstruction(Opcode.XYC_SWAP, "0x");
}

/**
 * A no-op instruction carrying arbitrary bytes.
 *
 * The salt is what stops two positions shipped with identical parameters from
 * colliding on the same `strategyHash`.
 */
export function encodeSalt(salt: Hex): Hex {
  return encodeInstruction(Opcode.SALT, salt);
}

/**
 * A full Zyro program: `InventorySkew ++ XYCSwap ++ Salt`.
 *
 * Order matters. The skew instruction re-centres the balance pair, and the
 * curve instruction then consumes it — running them the other way round would
 * price off an untouched curve and skew a number nothing reads.
 */
export function buildZyroProgram(p: ZyroInventorySkewParams, salt: Hex): Hex {
  return concatHex(encodeZyroInventorySkew(p), encodeXYCSwap(), encodeSalt(salt));
}
