import "server-only";

import type {Comparison, LensState, Position, VerificationResult} from "./types";

/**
 * Reading `ZyroLens` over JSON-RPC.
 *
 * @dev Hand-rolled against one fixed signature rather than pulling in a codec.
 *      The console makes exactly one kind of call, with a known shape, and a
 *      full ABI library would be more surface than the thing it encodes.
 *
 *      Server-only for the same reason as the subgraph client: an RPC URL
 *      commonly carries a provider key, and a `NEXT_PUBLIC_` variable is
 *      compiled into the browser bundle.
 */

const WORD = 64; // hex characters in one 32-byte word

/**
 * `state(address,address,bytes32,address,address,bytes)`.
 *
 * @dev Pinned by `ZyroLensTest.test_StateSelector_MatchesTheConsole`, so a
 *      change to the signature fails in CI rather than here. Without that, a
 *      stale selector produces a call that reverts with no data — which is
 *      indistinguishable from a reverted view, and sends you looking at the
 *      wrong contract.
 */
export const STATE_SELECTOR = "c19f2196";

const strip = (hex: string) => (hex.startsWith("0x") ? hex.slice(2) : hex);
const padLeft = (hex: string) => strip(hex).padStart(WORD, "0");
const word = (n: number | bigint) => BigInt(n).toString(16).padStart(WORD, "0");

function padRight(hex: string): string {
  const s = strip(hex);
  const remainder = s.length % WORD;
  return remainder === 0 ? s : s + "0".repeat(WORD - remainder);
}

/** Two's-complement read of one word as a signed integer. */
function toInt256(hex: string): bigint {
  const value = BigInt(`0x${hex}`);
  return value >> 255n === 1n ? value - (1n << 256n) : value;
}

export function encodeStateCall(args: {
  maker: string;
  app: string;
  strategyHash: string;
  tokenIn: string;
  tokenOut: string;
  program: string;
}): string {
  const head = [
    padLeft(args.maker),
    padLeft(args.app),
    padLeft(args.strategyHash),
    padLeft(args.tokenIn),
    padLeft(args.tokenOut),
    word(6 * 32) // offset to the one dynamic argument
  ].join("");

  const body = strip(args.program);
  const tail = word(body.length / 2) + padRight(body);

  return `0x${STATE_SELECTOR}${head}${tail}`;
}

/** `State`: nine static words, returned inline. */
export function decodeState(returnData: string): LensState {
  const hex = strip(returnData);
  if (hex.length < 9 * WORD) {
    throw new Error(`lens returned ${hex.length / 2} bytes, expected at least 288`);
  }
  const at = (i: number) => hex.slice(i * WORD, (i + 1) * WORD);

  return {
    balanceIn: BigInt(`0x${at(0)}`).toString(),
    balanceOut: BigInt(`0x${at(1)}`).toString(),
    inventoryImbalanceWad: toInt256(at(2)).toString(),
    midWad: toInt256(at(3)).toString(),
    reservationPriceWad: toInt256(at(4)).toString(),
    halfSpreadWad: toInt256(at(5)).toString(),
    penaltyBps: BigInt(`0x${at(6)}`).toString(),
    horizonRemainingSecs: BigInt(`0x${at(7)}`).toString(),
    elapsedSecs: BigInt(`0x${at(8)}`).toString()
  };
}

let rpcId = 0;

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const url = process.env.BASE_SEPOLIA_RPC_URL ?? process.env.RPC_URL;
  if (!url) throw new Error("BASE_SEPOLIA_RPC_URL is not set");

  const response = await fetch(url, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({jsonrpc: "2.0", id: ++rpcId, method, params}),
    cache: "no-store"
  });

  const json = (await response.json()) as {result?: T; error?: {message: string}};
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  if (json.result === undefined) throw new Error(`${method}: no result`);
  return json.result;
}

/**
 * Reads a position's state from the chain at a specific block.
 *
 * @param block The block to pin the call to. **Not optional, and not
 *              "latest".** A subgraph lags chainhead by a few blocks, so
 *              comparing an index at block N against a chain read at N+3
 *              reports a clock as a disagreement — which is worse than no
 *              comparison, because it looks like the bug it is not.
 */
export async function readLensState(
  lensAddress: string,
  position: Position,
  block: number
): Promise<LensState> {
  const [tokenIn, tokenOut] = position.tokens;
  if (!tokenIn || !tokenOut) {
    throw new Error("the position has fewer than two funded tokens, so it has no mid");
  }

  const data = encodeStateCall({
    maker: position.maker,
    app: position.app,
    strategyHash: position.id,
    tokenIn,
    tokenOut,
    program: position.program
  });

  const result = await rpc<string>("eth_call", [
    {to: lensAddress, data},
    `0x${block.toString(16)}`
  ]);

  return decodeState(result);
}

/**
 * Compares what the subgraph published against what the chain says, field for
 * field, at one block.
 *
 * @dev Balances come first deliberately. The mappings reconstruct them from
 *      `Pushed`/`Pulled` while the lens reads `AQUA.safeBalances` directly, so
 *      a disagreement there explains every price disagreement below it — the
 *      arithmetic can be perfect and still produce the wrong number from the
 *      wrong balance. Ordering the rows this way makes the reader diagnose in
 *      the right order.
 */
export async function verifyPosition(
  lensAddress: string,
  position: Position,
  block: number
): Promise<VerificationResult> {
  try {
    const chain = await readLensState(lensAddress, position, block);
    const [tokenIn, tokenOut] = position.tokens;

    const indexedBalance = (token: string) =>
      position.balances.find((b) => b.token.toLowerCase() === token.toLowerCase())?.amount ?? "0";

    const rows: [string, string, string][] = [
      ["balanceIn", indexedBalance(tokenIn), chain.balanceIn],
      ["balanceOut", indexedBalance(tokenOut), chain.balanceOut],
      ["inventoryImbalanceWad", position.inventoryImbalanceWad, chain.inventoryImbalanceWad],
      ["midWad", position.midWad, chain.midWad],
      ["reservationPriceWad", position.reservationPriceWad, chain.reservationPriceWad],
      ["halfSpreadWad", position.halfSpreadWad, chain.halfSpreadWad],
      ["penaltyBps", position.penaltyBps, chain.penaltyBps],
      ["horizonRemainingSecs", position.horizonRemainingSecs, chain.horizonRemainingSecs]
    ];

    const comparisons: Comparison[] = rows.map(([field, indexed, onChain]) => ({
      field,
      indexed,
      onChain,
      // Compared as bigints, not as strings: "0" and "-0" and "00" are the
      // same number and a string compare would call two of those a mismatch.
      agrees: BigInt(indexed) === BigInt(onChain)
    }));

    return {
      ok: comparisons.every((c) => c.agrees),
      block,
      comparisons,
      error: null
    };
  } catch (error) {
    return {
      ok: false,
      block,
      comparisons: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
