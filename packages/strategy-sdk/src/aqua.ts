/**
 * Aqua `ship` / `dock` calldata.
 *
 * Mirrors `AquaProtocolContract` from 1inch's Aqua SDK (`1inch/sdks`,
 * `typescript/aqua`).
 *
 * @dev These build **calldata**, not transactions. The 1inch SDK is a stateless
 *      encoder — `buildShipTx` returns `{to, data, value}` for the caller's own
 *      wallet to submit. There is no `.ship()` that sends anything, and nothing
 *      here touches a key or a provider.
 */

import { addressToBigInt, concatHex, packAddress, packUint, type Hex } from "./bytes.ts";
import { keccak256 } from "./keccak.ts";
import { buildOrder, encodeOrder, type BuildOrderParams, type SwapVmOrder } from "./order.ts";
import { buildZyroProgram, type ZyroInventorySkewParams } from "./instructions.ts";

/** A transaction request, matching the shape 1inch's SDK returns. */
export interface CallInfo {
  to: Hex;
  data: Hex;
  value: bigint;
}

export interface TokenAmount {
  token: string;
  amount: bigint;
}

/**
 * Function selectors, derived rather than hardcoded.
 *
 * A mistyped selector produces a transaction that reverts with no reason data,
 * which is a miserable thing to debug — so they are computed from the canonical
 * signatures at module load and asserted in the tests.
 */
export const Selectors = {
  ship: keccak256(utf8Hex("ship(address,bytes,address[],uint256[])")).slice(0, 10) as Hex,
  dock: keccak256(utf8Hex("dock(address,bytes32,address[])")).slice(0, 10) as Hex,
} as const;

function utf8Hex(s: string): Hex {
  let out = "0x";
  for (const byte of new TextEncoder().encode(s)) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out as Hex;
}

/** ABI-encodes a dynamic `address[]` tail (length, then one word per entry). */
function encodeAddressArray(addresses: string[]): string {
  let out = packUint(BigInt(addresses.length), 32).slice(2);
  for (const a of addresses) out += packUint(addressToBigInt(a), 32).slice(2);
  return out;
}

/** ABI-encodes a dynamic `uint256[]` tail. */
function encodeUintArray(values: bigint[]): string {
  let out = packUint(BigInt(values.length), 32).slice(2);
  for (const v of values) out += packUint(v, 32).slice(2);
  return out;
}

/** ABI-encodes a dynamic `bytes` tail (length, then payload padded to 32). */
function encodeBytes(hex: Hex): string {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  const len = body.length / 2;
  const padding = len % 32 === 0 ? 0 : 32 - (len % 32);
  return packUint(BigInt(len), 32).slice(2) + body + "00".repeat(padding);
}

/**
 * Encodes `ship(app, strategy, tokens, amounts)`.
 *
 * Three dynamic arguments, so the head is four words: the static `app`, then an
 * offset for each of `strategy`, `tokens` and `amounts`.
 */
export function encodeShipCalldata(
  app: string,
  strategy: Hex,
  funding: TokenAmount[],
): Hex {
  const strategyTail = encodeBytes(strategy);
  const tokensTail = encodeAddressArray(funding.map((f) => f.token));
  const amountsTail = encodeUintArray(funding.map((f) => f.amount));

  const headWords = 4;
  const strategyOffset = BigInt(headWords * 32);
  const tokensOffset = strategyOffset + BigInt(strategyTail.length / 2);
  const amountsOffset = tokensOffset + BigInt(tokensTail.length / 2);

  return concatHex(
    Selectors.ship,
    packUint(addressToBigInt(app), 32),
    packUint(strategyOffset, 32),
    packUint(tokensOffset, 32),
    packUint(amountsOffset, 32),
    strategyTail,
    tokensTail,
    amountsTail,
  );
}

/** Encodes `dock(app, strategyHash, tokens)`. */
export function encodeDockCalldata(app: string, strategyHash: Hex, tokens: string[]): Hex {
  const tokensTail = encodeAddressArray(tokens);
  const headWords = 3;

  return concatHex(
    Selectors.dock,
    packUint(addressToBigInt(app), 32),
    strategyHash,
    packUint(BigInt(headWords * 32), 32),
    tokensTail,
  );
}

/** The strategy hash Aqua keys balances by: `keccak256(strategy)`. */
export function calculateStrategyHash(strategy: Hex): Hex {
  return keccak256(strategy);
}

export interface ShipZyroStrategyParams {
  /** The Aqua protocol contract. */
  aqua: string;
  /** The Zyro router, which is the Aqua "app". */
  app: string;
  /** The maker shipping the position. */
  maker: string;
  /** Pricing parameters for the instruction. */
  strategy: ZyroInventorySkewParams;
  /** Salt bytes, so identical parameters do not collide on one strategy hash. */
  salt: Hex;
  /** Tokens and amounts to fund the position with. */
  funding: TokenAmount[];
  /** Order-level overrides. Defaults to an Aqua order with no hooks. */
  order?: Omit<BuildOrderParams, "maker" | "program">;
}

export interface ShipZyroStrategyResult {
  tx: CallInfo;
  order: SwapVmOrder;
  program: Hex;
  strategy: Hex;
  /** Also the SwapVM order hash, and the key `safeBalances` is indexed by. */
  strategyHash: Hex;
}

/**
 * Builds everything needed to ship a Zyro position, and the transaction to do it.
 *
 * Returns the strategy hash alongside the calldata because it is needed *before*
 * the transaction lands — to seed a subgraph query, or to dock the position
 * later — and it is fully determined by the bytes being shipped.
 */
export function buildShipZyroStrategyTx(
  params: ShipZyroStrategyParams,
): ShipZyroStrategyResult {
  const program = buildZyroProgram(params.strategy, params.salt);

  const order = buildOrder({
    ...params.order,
    maker: params.maker,
    program,
  });

  const strategy = encodeOrder(order);

  return {
    tx: {
      to: packAddress(params.aqua),
      data: encodeShipCalldata(params.app, strategy, params.funding),
      value: 0n,
    },
    order,
    program,
    strategy,
    strategyHash: calculateStrategyHash(strategy),
  };
}

/** Builds the transaction to dock (withdraw) a shipped position. */
export function buildDockTx(
  aqua: string,
  app: string,
  strategyHash: Hex,
  tokens: string[],
): CallInfo {
  return {
    to: packAddress(aqua),
    data: encodeDockCalldata(app, strategyHash, tokens),
    value: 0n,
  };
}
