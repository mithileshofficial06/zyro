/**
 * SwapVM order construction.
 *
 * Mirrors `MakerTraits.encode` and `Order.build` from 1inch's own SwapVM SDK
 * (`1inch/sdks`, `typescript/swap-vm`), and `MakerTraitsLib.build` in the
 * Solidity. Checked against `contracts/test/OrderFixtures.t.sol`, which builds
 * real orders with the on-chain library and emits the packed traits, the order
 * bytes and the hash for this module to reproduce.
 */

import { concatHex, packAddress, packUint, addressToBigInt, type Hex } from "./bytes.ts";
import { keccak256 } from "./keccak.ts";

/**
 * Bit positions in the packed `traits` word.
 *
 * ```
 * 255                                                          0
 * +------------+----------------------------+------------------+
 * | Flags      | Hook offsets (4 x uint16)  | Receiver address |
 * | [255-245]  | [223-160]                  | [159-0]          |
 * +------------+----------------------------+------------------+
 * ```
 */
export const MakerTraitsBits = {
  SHOULD_UNWRAP: 255n,
  USE_AQUA_INSTEAD_OF_SIGNATURE: 254n,
  ALLOW_ZERO_AMOUNT_IN: 253n,
  HAS_PRE_TRANSFER_IN_HOOK: 252n,
  HAS_POST_TRANSFER_IN_HOOK: 251n,
  HAS_PRE_TRANSFER_OUT_HOOK: 250n,
  HAS_POST_TRANSFER_OUT_HOOK: 249n,
} as const;

/** Bit offset at which the four `uint16` hook-data offsets begin. */
export const HOOKS_DATA_OFFSETS_BIT = 160n;

export interface BuildOrderParams {
  /** The maker's address. */
  maker: string;
  /** The VM program — see `buildZyroProgram`. */
  program: Hex;
  /** Use Aqua balances instead of an ECDSA signature. Defaults to `true`. */
  useAquaInsteadOfSignature?: boolean;
  /** Allow `amountIn == 0`. Defaults to `false`. */
  allowZeroAmountIn?: boolean;
  /** Unwrap WETH proceeds to native. Defaults to `false`. */
  shouldUnwrap?: boolean;
  /** Optional custom receiver. Zero or absent means "the maker". */
  receiver?: string;
}

export interface SwapVmOrder {
  maker: Hex;
  traits: bigint;
  /** `hooksData ++ program`. With no hooks configured, this is the program. */
  data: Hex;
}

/**
 * Builds a SwapVM order around a Zyro program.
 *
 * @dev Maker hooks are deliberately unsupported. They require variable-length
 *      slice-index packing, and implementing that without a fixture to verify
 *      against is how you ship an order whose program starts at the wrong
 *      offset. Zyro does not need them: the instruction reads inventory the VM
 *      has already loaded, so there is nothing for a hook to do.
 *
 *      With no hooks, all four `uint16` offsets are zero, so `hooksData` is
 *      empty and the program starts at byte 0 of `data`.
 */
export function buildOrder(params: BuildOrderParams): SwapVmOrder {
  const useAqua = params.useAquaInsteadOfSignature ?? true;

  let traits = 0n;
  if (params.shouldUnwrap) traits |= 1n << MakerTraitsBits.SHOULD_UNWRAP;
  if (useAqua) traits |= 1n << MakerTraitsBits.USE_AQUA_INSTEAD_OF_SIGNATURE;
  if (params.allowZeroAmountIn) traits |= 1n << MakerTraitsBits.ALLOW_ZERO_AMOUNT_IN;

  // Receiver occupies the low 160 bits; zero means "the maker".
  if (params.receiver) traits |= addressToBigInt(params.receiver);

  // Hook offsets stay zero: no hooks, so hooksData is empty.

  return {
    maker: packAddress(params.maker),
    traits,
    data: params.program,
  };
}

/**
 * Byte offset at which the program begins inside `order.data`.
 *
 * The last of the four `uint16` hook offsets, i.e. bits [208, 224).
 *
 * @dev The build spec claims `order.data` is `tokenA(20) ++ tokenB(20) ++
 *      program`. It is not — it is `hooksData ++ program`. Anything decoding a
 *      shipped position must slice here rather than at a fixed 40.
 */
export function programStartByte(traits: bigint): number {
  return Number((traits >> (HOOKS_DATA_OFFSETS_BIT + 48n)) & 0xffffn);
}

/**
 * ABI-encodes the order as the tuple `(address maker, uint256 traits, bytes data)`.
 *
 * This is exactly the blob Aqua's `ship()` takes as its `strategy` argument, and
 * exactly what `Shipped.strategy` carries.
 *
 * @dev The leading `0x20` word is not decoration. `abi.encode(order)` treats the
 *      struct as a **dynamic** type — because `data` is dynamic — so the
 *      encoding is an offset to the tuple followed by the tuple itself. Omitting
 *      it produces bytes that decode to nothing and a `strategyHash` that
 *      matches no position on-chain.
 */
export function encodeOrder(order: SwapVmOrder): Hex {
  const dataBody = order.data.startsWith("0x") ? order.data.slice(2) : order.data;
  const dataBytes = dataBody.length / 2;

  // Tuple head: maker, traits, then the offset to the dynamic `bytes` member
  // measured from the start of the tuple.
  const tupleHead = concatHex(
    packUint(addressToBigInt(order.maker), 32),
    packUint(order.traits, 32),
    packUint(96n, 32),
  );

  // Tuple tail: length, then the payload right-padded to a 32-byte boundary.
  const padding = dataBytes % 32 === 0 ? 0 : 32 - (dataBytes % 32);
  const tupleTail = concatHex(packUint(BigInt(dataBytes), 32), dataBody, "00".repeat(padding));

  return concatHex(packUint(32n, 32), tupleHead, tupleTail);
}

/**
 * The order hash, which in Aqua mode is also the `strategyHash`.
 *
 * `SwapVM.hash()` returns `keccak256(abi.encode(order))` for Aqua orders, and
 * `AquaProtocolContract.calculateStrategyHash` is `keccak256(strategy)` over the
 * same bytes. They are the same number — which is why
 * `AQUA.safeBalances(maker, app, orderHash, …)` finds the position.
 *
 * @dev Only valid for Aqua orders. A signature-mode order hashes via EIP-712
 *      over a domain separator, so this would return a value nothing on-chain
 *      agrees with.
 */
export function orderHash(order: SwapVmOrder): Hex {
  if ((order.traits & (1n << MakerTraitsBits.USE_AQUA_INSTEAD_OF_SIGNATURE)) === 0n) {
    throw new Error(
      "orderHash is only valid for Aqua orders; a signature-mode order hashes via EIP-712",
    );
  }
  return keccak256(encodeOrder(order));
}
