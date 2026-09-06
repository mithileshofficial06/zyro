import {BigInt, Bytes, ethereum, log} from "@graphprotocol/graph-ts";

import {Params} from "./avellaneda-stoikov";

/**
 * Decoding a shipped Zyro position out of Aqua's `Shipped.strategy` blob.
 *
 * Three things here are easy to get wrong in ways that produce a plausible
 * wrong number rather than an error, so each is called out where it happens:
 * byte order, the program's offset inside `order.data`, and the opcode.
 */

/**
 * Zyro's opcode in the Aqua instruction set.
 *
 * The stock Aqua dispatch table is a **dense array of 34 entries**, so valid
 * opcodes are 0..33 and this is the next free index — claimed by appending to
 * the array `AquaOpcodes._opcodes()` returns.
 *
 * It is not `0x92`. There is no `Opcode` enum and no family-bank address space
 * in SwapVM; `0x92` (146) would be an out-of-bounds panic, not a reserved slot.
 * Confirmed three ways: the Solidity, 1inch's own TypeScript SDK, and a live
 * test against a real `AquaSwapVMRouter`.
 */
export const ZYRO_OPCODE: i32 = 34;

/** Length of the Zyro instruction's argument block, in bytes. */
export const ZYRO_ARGS_LENGTH: i32 = 121;

/**
 * A decoded Zyro position.
 *
 * @dev Carries a `valid` flag rather than being returned as `ZyroStrategy |
 *      null`. AssemblyScript's compiler crashes outright on some nullable
 *      user-class returns ("AssertionError: assertion failed", with no source
 *      location), so nullability is modelled as data throughout this file.
 */
export class ZyroStrategy {
  valid: boolean;
  params: Params;
  targetInventoryWad: BigInt;
  boundWad: BigInt;
  startTimestamp: BigInt;
  program: Bytes;

  constructor(
    valid: boolean,
    params: Params,
    targetInventoryWad: BigInt,
    boundWad: BigInt,
    startTimestamp: BigInt,
    program: Bytes
  ) {
    this.valid = valid;
    this.params = params;
    this.targetInventoryWad = targetInventoryWad;
    this.boundWad = boundWad;
    this.startTimestamp = startTimestamp;
    this.program = program;
  }

  static invalid(): ZyroStrategy {
    return new ZyroStrategy(
      false,
      new Params(BigInt.zero(), BigInt.zero(), BigInt.zero(), BigInt.zero()),
      BigInt.zero(),
      BigInt.zero(),
      BigInt.zero(),
      Bytes.empty()
    );
  }
}

/**
 * Reads a big-endian **unsigned** integer out of `data[start, end)`.
 *
 * @dev `BigInt.fromUnsignedBytes` expects **little-endian** input, and every
 *      value decoded from EVM bytes is big-endian. Skipping the reversal gives
 *      a wrong number that still looks plausible — no error, no warning.
 */
export function readUintBE(data: Bytes, start: i32, end: i32): BigInt {
  let out = new Uint8Array(end - start);
  for (let i = 0; i < end - start; i++) {
    out[i] = data[end - 1 - i];
  }
  return BigInt.fromUnsignedBytes(Bytes.fromUint8Array(out));
}

/**
 * Reads a big-endian **signed** (two's complement) integer out of
 * `data[start, end)`.
 *
 * @dev Same little-endian reversal as {readUintBE}. Using the unsigned reader
 *      here instead would turn every negative `gamma` — the exact value
 *      `validate` exists to reject — into a huge positive one.
 */
export function readIntBE(data: Bytes, start: i32, end: i32): BigInt {
  let out = new Uint8Array(end - start);
  for (let i = 0; i < end - start; i++) {
    out[i] = data[end - 1 - i];
  }
  return BigInt.fromSignedBytes(Bytes.fromUint8Array(out));
}

/** `Bytes` slice helper; `subarray` alone returns a `Uint8Array`. */
export function slice(data: Bytes, start: i32, end: i32): Bytes {
  return Bytes.fromUint8Array(data.subarray(start, end));
}

/**
 * Byte offset at which the VM program begins inside `order.data`.
 *
 * `order.data` is `hooksData ++ program`, and `MakerTraits` records the four
 * hook-slice boundaries in bits [160, 224) of the traits word, 16 bits each.
 * The program starts at the last of them.
 *
 * @dev **Not a fixed 40-byte offset.** The build spec claims `order.data` is
 *      `tokenA(20) ++ tokenB(20) ++ program`; 1inch's own `Order.build()` shows
 *      it is `hooksData ++ program` with no token prefix. Slicing at a fixed 40
 *      would read 40 bytes of program as two addresses and then mis-parse every
 *      instruction after it — silently, since the walk would still find *some*
 *      opcode/length pairs.
 */
export function programStartByte(traits: BigInt): i32 {
  // (traits >> 208) & 0xFFFF, done arithmetically for portability.
  let shift = BigInt.fromI32(2).pow(208 as u8);
  let index3 = traits.div(shift).mod(BigInt.fromI32(65536));
  return index3.toI32();
}

/**
 * Walks a program looking for the Zyro instruction.
 *
 * Every instruction is `opcode(1) ++ argsLength(1) ++ args`, so the walk is
 * exact rather than a scan for a magic byte — a `34` appearing inside another
 * instruction's arguments cannot be mistaken for an opcode.
 *
 * @returns the 121-byte argument block, or an **empty** `Bytes` if this program
 *          is not a Zyro position (most programs on Aqua are not). Empty rather
 *          than `null` for the compiler reason noted on {ZyroStrategy}.
 */
export function findZyroArgs(program: Bytes): Bytes {
  let pc = 0;
  while (pc + 2 <= program.length) {
    let opcode = program[pc] as i32;
    let argsLength = program[pc + 1] as i32;
    let argsStart = pc + 2;
    let argsEnd = argsStart + argsLength;

    if (argsEnd > program.length) {
      log.warning("zyro: truncated instruction at pc {} in program of {} bytes", [
        pc.toString(),
        program.length.toString()
      ]);
      return Bytes.empty();
    }

    if (opcode == ZYRO_OPCODE) {
      if (argsLength != ZYRO_ARGS_LENGTH) {
        log.warning("zyro: opcode 34 with unexpected args length {} (expected {})", [
          argsLength.toString(),
          ZYRO_ARGS_LENGTH.toString()
        ]);
        return Bytes.empty();
      }
      return slice(program, argsStart, argsEnd);
    }

    pc = argsEnd;
  }
  return Bytes.empty();
}

/**
 * Decodes the 121-byte Zyro argument block.
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
 */
export function decodeZyroArgs(args: Bytes, program: Bytes): ZyroStrategy {
  let params = new Params(
    readIntBE(args, 0, 16),
    readIntBE(args, 16, 32),
    readIntBE(args, 32, 48),
    readUintBE(args, 112, 116)
  );

  return new ZyroStrategy(
    true,
    params,
    readIntBE(args, 48, 80),
    readIntBE(args, 80, 112),
    readUintBE(args, 116, 121),
    program
  );
}

/**
 * Decodes an Aqua `Shipped.strategy` blob into a Zyro position, or `null` if
 * the shipped strategy is not one.
 *
 * The blob is an ABI-encoded SwapVM `Order` — `(address maker, uint256 traits,
 * bytes data)` — which is why `keccak256(strategy)` is the same number as the
 * order hash, and why `AQUA.safeBalances(maker, app, orderHash, …)` finds the
 * position.
 */
export function decodeStrategy(strategy: Bytes): ZyroStrategy {
  let decoded = ethereum.decode("(address,uint256,bytes)", strategy);
  if (decoded === null) {
    log.warning("zyro: could not ABI-decode a strategy blob of {} bytes", [
      strategy.length.toString()
    ]);
    return ZyroStrategy.invalid();
  }

  let tuple = decoded.toTuple();
  let traits = tuple[1].toBigInt();
  let data = tuple[2].toBytes();

  let start = programStartByte(traits);
  if (start > data.length) {
    log.warning("zyro: program offset {} beyond order.data length {}", [
      start.toString(),
      data.length.toString()
    ]);
    return ZyroStrategy.invalid();
  }

  let program = slice(data, start, data.length);
  let args = findZyroArgs(program);
  if (args.length == 0) return ZyroStrategy.invalid();

  return decodeZyroArgs(args, program);
}
