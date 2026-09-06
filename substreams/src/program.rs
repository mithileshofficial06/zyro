//! Decoding a shipped Zyro position out of Aqua's `Shipped.strategy` blob.
//!
//! Mirrors `subgraph/src/program.ts`. Three things here are easy to get wrong in
//! ways that produce a plausible wrong number rather than an error: the opcode,
//! the program's offset inside `order.data`, and the sign of the parameters.

use num_bigint::BigInt;
use num_traits::Zero;

/// Zyro's opcode in the Aqua instruction set.
///
/// The stock Aqua dispatch table is a **dense array of 34 entries**, so valid
/// opcodes are `0..=33` and this is the next free index.
///
/// It is not `0x92`. SwapVM has no opcode enum and no family-bank address
/// space — `0x92` (146) would be an out-of-bounds panic, not a reserved slot.
/// Confirmed three ways: the Solidity, 1inch's own TypeScript SDK, and a live
/// test against a real `AquaSwapVMRouter`.
pub const ZYRO_OPCODE: u8 = 34;

/// Length of the Zyro instruction's argument block, in bytes.
pub const ZYRO_ARGS_LENGTH: usize = 121;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZyroStrategy {
    pub gamma_wad: BigInt,
    pub sigma_sq_wad: BigInt,
    pub base_spread_wad: BigInt,
    pub target_inventory_wad: BigInt,
    pub bound_wad: BigInt,
    pub horizon_secs: u64,
    pub start_timestamp: u64,
    pub program: Vec<u8>,
}

/// Reads a big-endian **signed** (two's complement) integer.
///
/// Every value in a program is big-endian. Reading these as unsigned would turn
/// a negative `gamma` — the exact value the on-chain `validate` exists to
/// reject — into an enormous positive one, and the published reservation price
/// would then reward drift instead of penalising it.
fn read_int_be(bytes: &[u8]) -> BigInt {
    BigInt::from_signed_bytes_be(bytes)
}

/// Reads a big-endian unsigned integer that is known to fit in a `u64`.
fn read_u64_be(bytes: &[u8]) -> u64 {
    let mut acc: u64 = 0;
    for b in bytes {
        acc = (acc << 8) | (*b as u64);
    }
    acc
}

/// Byte offset at which the VM program begins inside `order.data`.
///
/// `order.data` is `hooksData ++ program`, and `MakerTraits` records the four
/// hook-slice boundaries in bits [160, 224) of the traits word, 16 bits each.
/// The program starts at the last of them, i.e. bits [208, 224).
///
/// **Not a fixed 40-byte offset.** The build spec claims `order.data` is
/// `tokenA(20) ++ tokenB(20) ++ program`; 1inch's own `Order.build()` shows it
/// is `hooksData ++ program` with no token prefix. Slicing at a fixed 40 would
/// read program bytes as two addresses and then mis-parse every instruction
/// after it — silently, because the walk would still find plausible
/// opcode/length pairs.
pub fn program_start_byte(traits: &BigInt) -> usize {
    let shifted = traits >> 208u32;
    let masked = shifted & BigInt::from(0xffffu32);
    let (_, digits) = masked.to_u32_digits();
    if digits.is_empty() {
        0
    } else {
        digits[0] as usize
    }
}

/// Walks a program looking for the Zyro instruction.
///
/// Every instruction is `opcode(1) ++ argsLength(1) ++ args`, so the walk is
/// exact rather than a scan for a magic byte — a `34` appearing inside another
/// instruction's arguments cannot be mistaken for an opcode.
pub fn find_zyro_args(program: &[u8]) -> Option<&[u8]> {
    let mut pc = 0usize;
    while pc + 2 <= program.len() {
        let opcode = program[pc];
        let args_length = program[pc + 1] as usize;
        let args_start = pc + 2;
        let args_end = args_start + args_length;

        if args_end > program.len() {
            // Truncated instruction: the program is not well formed.
            return None;
        }

        if opcode == ZYRO_OPCODE {
            if args_length != ZYRO_ARGS_LENGTH {
                return None;
            }
            return Some(&program[args_start..args_end]);
        }

        pc = args_end;
    }
    None
}

/// Decodes the 121-byte Zyro argument block.
///
/// | Offset | Bytes | Field                | Type     |
/// |--------|-------|----------------------|----------|
/// | 0      | 16    | `gammaWad`           | `int128` |
/// | 16     | 16    | `sigmaSqWad`         | `int128` |
/// | 32     | 16    | `baseSpreadWad`      | `int128` |
/// | 48     | 32    | `targetInventoryWad` | `int256` |
/// | 80     | 32    | `boundWad`           | `int256` |
/// | 112    | 4     | `horizonSecs`        | `uint32` |
/// | 116    | 5     | `startTimestamp`     | `uint40` |
pub fn decode_zyro_args(args: &[u8], program: &[u8]) -> Option<ZyroStrategy> {
    if args.len() != ZYRO_ARGS_LENGTH {
        return None;
    }

    Some(ZyroStrategy {
        gamma_wad: read_int_be(&args[0..16]),
        sigma_sq_wad: read_int_be(&args[16..32]),
        base_spread_wad: read_int_be(&args[32..48]),
        target_inventory_wad: read_int_be(&args[48..80]),
        bound_wad: read_int_be(&args[80..112]),
        horizon_secs: read_u64_be(&args[112..116]),
        start_timestamp: read_u64_be(&args[116..121]),
        program: program.to_vec(),
    })
}

/// Decodes an Aqua `Shipped.strategy` blob into a Zyro position.
///
/// The blob is an ABI-encoded SwapVM `Order` — `(address maker, uint256 traits,
/// bytes data)` — which is why `keccak256(strategy)` is the same number as the
/// order hash, and why `AQUA.safeBalances(maker, app, orderHash, …)` finds the
/// position.
///
/// Returns `None` when the strategy is not a Zyro program, which is legal and
/// common: Aqua carries every app built on it.
pub fn decode_strategy(strategy: &[u8]) -> Option<ZyroStrategy> {
    use ethabi::{decode, ParamType};

    let decoded = decode(
        &[ParamType::Tuple(vec![
            ParamType::Address,
            ParamType::Uint(256),
            ParamType::Bytes,
        ])],
        strategy,
    )
    .ok()?;

    let tuple = decoded.into_iter().next()?.into_tuple()?;
    let traits_token = tuple.get(1)?.clone().into_uint()?;
    let data = tuple.get(2)?.clone().into_bytes()?;

    let mut traits_bytes = [0u8; 32];
    traits_token.to_big_endian(&mut traits_bytes);
    let traits = BigInt::from_bytes_be(num_bigint::Sign::Plus, &traits_bytes);

    let start = program_start_byte(&traits);
    if start > data.len() {
        return None;
    }

    let program = &data[start..];
    let args = find_zyro_args(program)?;
    decode_zyro_args(args, program)
}

/// Formats a `BigInt` as a decimal string, the representation every `uint256`
/// and WAD-scaled value uses on the wire.
pub fn to_decimal(v: &BigInt) -> String {
    if v.is_zero() {
        "0".to_string()
    } else {
        v.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zyro_opcode_is_34_not_0x92() {
        assert_eq!(ZYRO_OPCODE, 34);
        assert_ne!(ZYRO_OPCODE, 0x92);
    }

    #[test]
    fn program_offset_reads_bits_208_to_224() {
        // Only the Aqua flag set (bit 254): no hooks, so the program starts at 0.
        let traits = BigInt::from(1u8) << 254u32;
        assert_eq!(program_start_byte(&traits), 0);

        // A hooks blob ending at byte 40 must be read back as 40.
        let traits = (BigInt::from(1u8) << 254u32) | (BigInt::from(40u32) << 208u32);
        assert_eq!(program_start_byte(&traits), 40);
    }

    #[test]
    fn finds_the_instruction_by_walking_not_scanning() {
        // A salt instruction whose *arguments* contain the byte 34, followed by
        // the real Zyro instruction. A naive scan would stop at the wrong place.
        let mut program = vec![20u8, 4u8, 34u8, 34u8, 34u8, 34u8];
        program.push(ZYRO_OPCODE);
        program.push(ZYRO_ARGS_LENGTH as u8);
        program.extend(std::iter::repeat(0u8).take(ZYRO_ARGS_LENGTH));

        let args = find_zyro_args(&program).expect("should find the Zyro instruction");
        assert_eq!(args.len(), ZYRO_ARGS_LENGTH);
    }

    #[test]
    fn rejects_a_truncated_instruction() {
        let program = vec![ZYRO_OPCODE, ZYRO_ARGS_LENGTH as u8, 0, 0, 0];
        assert!(find_zyro_args(&program).is_none());
    }

    #[test]
    fn negative_parameters_stay_negative() {
        // A negative gamma is representable on the wire and must decode as
        // negative, so downstream can reject it rather than treating it as a
        // huge positive risk aversion.
        let mut args = vec![0xffu8; 16]; // int128 -1
        args.extend(vec![0u8; ZYRO_ARGS_LENGTH - 16]);

        let s = decode_zyro_args(&args, &args).expect("should decode");
        assert_eq!(s.gamma_wad, BigInt::from(-1));
    }

    #[test]
    fn decodes_field_widths_at_their_offsets() {
        let mut args = vec![0u8; ZYRO_ARGS_LENGTH];
        args[115] = 0x2a; // horizonSecs = 42, last byte of the uint32 at [112,116)
        args[120] = 0x07; // startTimestamp = 7, last byte of the uint40 at [116,121)

        let s = decode_zyro_args(&args, &args).expect("should decode");
        assert_eq!(s.horizon_secs, 42);
        assert_eq!(s.start_timestamp, 7);
    }
}
