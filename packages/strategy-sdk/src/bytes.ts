/**
 * Fixed-width byte packing, matching Solidity's `abi.encodePacked`.
 *
 * Every value SwapVM reads out of a program is big-endian and fixed-width, and
 * signed fields are two's complement. Getting either wrong produces a number
 * that still looks plausible and fails silently, so each helper range-checks
 * before packing rather than truncating.
 */

export type Hex = `0x${string}`;

/** Strips a leading `0x`, if present. */
function body(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

/** Concatenates hex strings into a single `0x`-prefixed string. */
export function concatHex(...parts: string[]): Hex {
  return `0x${parts.map(body).join("")}`;
}

/** Number of bytes a hex string represents. */
export function byteLength(hex: string): number {
  const b = body(hex);
  if (b.length % 2 !== 0) {
    throw new Error(`hex string has an odd number of digits: ${hex}`);
  }
  return b.length / 2;
}

/**
 * Packs an unsigned integer big-endian into exactly `bytes` bytes.
 *
 * @throws if the value is negative or does not fit.
 */
export function packUint(value: bigint, bytes: number): Hex {
  if (value < 0n) {
    throw new Error(`packUint received a negative value: ${value}`);
  }
  const max = 1n << BigInt(8 * bytes);
  if (value >= max) {
    throw new Error(`value ${value} does not fit in uint${8 * bytes}`);
  }
  return `0x${value.toString(16).padStart(bytes * 2, "0")}`;
}

/**
 * Packs a signed integer big-endian into exactly `bytes` bytes, two's complement.
 *
 * @throws if the value is outside the representable range.
 */
export function packInt(value: bigint, bytes: number): Hex {
  const width = BigInt(8 * bytes);
  const min = -(1n << (width - 1n));
  const max = (1n << (width - 1n)) - 1n;
  if (value < min || value > max) {
    throw new Error(`value ${value} does not fit in int${8 * bytes}`);
  }
  const unsigned = value < 0n ? (1n << width) + value : value;
  return `0x${unsigned.toString(16).padStart(bytes * 2, "0")}`;
}

/** Packs a single byte. */
export function packByte(value: number): Hex {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new Error(`not a byte: ${value}`);
  }
  return `0x${value.toString(16).padStart(2, "0")}`;
}

/** Normalises a 20-byte address to lowercase `0x`-prefixed hex. */
export function packAddress(address: string): Hex {
  const b = body(address).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(b)) {
    throw new Error(`not a 20-byte address: ${address}`);
  }
  return `0x${b}`;
}

/** Parses an address to a bigint, for the `tokenA < tokenB` ordering rule. */
export function addressToBigInt(address: string): bigint {
  return BigInt(packAddress(address));
}
