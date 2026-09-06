/**
 * Keccak-256, as Ethereum uses it.
 *
 * Needed because the Aqua `strategyHash` is `keccak256(strategy)`, and that hash
 * is also the SwapVM order hash in Aqua mode — the key `AQUA.safeBalances` is
 * indexed by. Deriving a position's identity before shipping it, or to query the
 * subgraph, means hashing off-chain.
 *
 * Implemented here rather than pulled from a library because this package has no
 * dependencies by design. That is only defensible because it is checked against
 * the Solidity: `contracts/test/OrderFixtures.t.sol` emits `keccak256` of real
 * encoded orders and `test/order.test.ts` asserts this implementation
 * reproduces them.
 *
 * @dev This is **Keccak-256**, not SHA3-256. They differ only in the padding
 *      byte — `0x01` here versus `0x06` for SHA3 — which is exactly the kind of
 *      difference that produces a plausible wrong hash rather than an error.
 *      Node's `crypto.createHash("sha3-256")` is *not* a substitute.
 */

const MASK = (1n << 64n) - 1n;

/** Rate for Keccak-256, in bytes: (1600 - 2*256) / 8. */
const RATE = 136;

const ROUND_CONSTANTS: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

/** Rotation offsets, indexed `[x][y]` where the lane index is `x + 5*y`. */
const ROTATION: number[][] = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

function rotl(x: bigint, n: number): bigint {
  if (n === 0) return x;
  const b = BigInt(n);
  return ((x << b) | (x >> (64n - b))) & MASK;
}

/** The Keccak-f[1600] permutation, in place. */
function permute(a: bigint[]): void {
  const c = new Array<bigint>(5);
  const d = new Array<bigint>(5);
  const b = new Array<bigint>(25);

  for (let round = 0; round < 24; round++) {
    // theta
    for (let x = 0; x < 5; x++) {
      c[x] = a[x]! ^ a[x + 5]! ^ a[x + 10]! ^ a[x + 15]! ^ a[x + 20]!;
    }
    for (let x = 0; x < 5; x++) {
      d[x] = c[(x + 4) % 5]! ^ rotl(c[(x + 1) % 5]!, 1);
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        a[x + 5 * y] = a[x + 5 * y]! ^ d[x]!;
      }
    }

    // rho and pi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(a[x + 5 * y]!, ROTATION[x]![y]!);
      }
    }

    // chi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        a[x + 5 * y] = b[x + 5 * y]! ^ (~b[((x + 1) % 5) + 5 * y]! & b[((x + 2) % 5) + 5 * y]!) & MASK;
      }
    }

    // iota
    a[0] = a[0]! ^ ROUND_CONSTANTS[round]!;
  }
}

/** Keccak-256 of a byte array. */
export function keccak256Bytes(input: Uint8Array): Uint8Array {
  const state = new Array<bigint>(25).fill(0n);

  // Pad: message || 0x01 || 0x00* || 0x80, to a multiple of the rate.
  const padded = new Uint8Array(Math.ceil((input.length + 1) / RATE) * RATE);
  padded.set(input);
  padded[input.length] = 0x01;
  padded[padded.length - 1] = (padded[padded.length - 1] ?? 0) | 0x80;

  // Absorb.
  for (let offset = 0; offset < padded.length; offset += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      // Lanes are little-endian.
      for (let j = 7; j >= 0; j--) {
        lane = (lane << 8n) | BigInt(padded[offset + i * 8 + j]!);
      }
      state[i] = state[i]! ^ lane;
    }
    permute(state);
  }

  // Squeeze 32 bytes. The rate exceeds the output size, so one pass suffices.
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = state[i]!;
    for (let j = 0; j < 8; j++) {
      out[i * 8 + j] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}

/** Keccak-256 of a `0x`-prefixed hex string, returned as `0x`-prefixed hex. */
export function keccak256(hex: string): `0x${string}` {
  const body = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (body.length % 2 !== 0) {
    throw new Error(`hex string has an odd number of digits: ${hex}`);
  }

  const bytes = new Uint8Array(body.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const byte = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`not hex: ${hex}`);
    bytes[i] = byte;
  }

  const digest = keccak256Bytes(bytes);
  let out = "0x";
  for (const b of digest) out += b.toString(16).padStart(2, "0");
  return out as `0x${string}`;
}
