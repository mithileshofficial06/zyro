#!/usr/bin/env node
/**
 * A stand-in subgraph, for developing the console without a deployment.
 *
 * @dev **The numbers are not invented.** They are produced by
 *      `packages/strategy-sdk`, the same kernel the Solidity instruction and
 *      the AssemblyScript mappings implement, walked through the exact series
 *      `script/SwapSeries.s.sol` executes on-chain: ship 1000/2000 at target,
 *      then ten 50-token fills in one direction.
 *
 *      That matters more than convenience. A mock filled with plausible-looking
 *      numbers would let the chart be tuned against a separation that the real
 *      mechanism does not produce — and the y-domain, which is the whole design
 *      problem in that chart, would then be calibrated to fiction.
 *
 *      Serves the subset of the schema `lib/subgraph.ts` queries. It is a
 *      development aid, not a second implementation: nothing verifies against
 *      it, and `SUBGRAPH_URL` pointed here makes the verification panel fail
 *      loudly rather than agree with itself.
 *
 *   node scripts/mock-subgraph.mjs          # then SUBGRAPH_URL=http://localhost:4444
 */

import {createServer} from "node:http";

import {
  halfSpreadWad,
  midFromBalancesWad,
  remaining,
  reservationPriceWad,
  softBoundPenaltyBps
} from "../../../packages/strategy-sdk/src/index.ts";

const PORT = Number(process.env.PORT ?? 4444);

// Exactly SwapSeries.s.sol's calibration.
const PARAMS = {
  gammaWad: 100_000_000_000_000n, // 1e14
  sigmaSqWad: 50_000_000_000_000n, // 5e13
  baseSpreadWad: 1_000_000_000_000_000n, // 1e15
  horizonSecs: 21_600n // 6 hours
};

const TARGET = 1_000_000_000_000_000_000_000n; // 1000e18
const BOUND = 500_000_000_000_000_000_000n; // 500e18
const SHIP_IN = TARGET;
const SHIP_OUT = 2_000_000_000_000_000_000_000n;
const STEP = 50_000_000_000_000_000_000n; // 50e18

const START = 1_770_000_000n;
const STEPS = 10;
const BLOCK_TIME = 2n;
const START_BLOCK = 21_000_000;

const MAKER = "0x00000000000000000000000000000000000000a1";
const APP = "0x00000000000000000000000000000000000000b2";
const TOKEN_IN = "0x00000000000000000000000000000000000000c3";
const TOKEN_OUT = "0x00000000000000000000000000000000000000d4";
const STRATEGY_HASH = "0x60fb59a0887bfb827f0a7d7f7a05b1eeb335319fb88175ac383ebf4e07e69ae9";

/** The constant-product fill the XYCSwap instruction performs, after the skew. */
function xycOut(balanceIn, balanceOut, amountIn) {
  return (balanceOut * amountIn) / (balanceIn + amountIn);
}

function buildSeries() {
  let balanceIn = SHIP_IN;
  let balanceOut = SHIP_OUT;
  const fills = [];

  for (let i = 0; i < STEPS; i++) {
    const timestamp = START + BigInt(i + 1) * 30n;
    const elapsed = timestamp - START;

    // Captured before the fill settles — the same ordering the mappings had to
    // be corrected to, and the reason this mock walks state explicitly rather
    // than reading it back after applying the deltas.
    const q = balanceIn - TARGET;
    const mid = midFromBalancesWad(balanceIn, balanceOut);
    const reservation = reservationPriceWad(mid, q, PARAMS, elapsed);

    // The skew re-centres the pair, so the curve consumes shifted balances.
    // Approximated here by pricing the fill off the reservation price, which
    // is what the re-centring amounts to for a single step.
    const skewedOut = (balanceIn * reservation) / 10n ** 18n;
    const amountOut = xycOut(balanceIn, skewedOut, STEP);

    fills.push({
      id: `0x${(i + 1).toString(16).padStart(64, "0")}`,
      taker: MAKER,
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountIn: STEP.toString(),
      amountOut: amountOut.toString(),
      midWadAtFill: mid.toString(),
      reservationPriceWadAtFill: reservation.toString(),
      inventoryImbalanceWadAtFill: q.toString(),
      exposed: q >= 0n,
      blockNumber: String(START_BLOCK + (i + 1) * 15),
      timestamp: timestamp.toString(),
      transactionHash: `0x${(i + 1).toString(16).padStart(64, "f")}`
    });

    balanceIn += STEP;
    balanceOut -= amountOut;
  }

  const elapsed = START + BigInt(STEPS) * 30n - START;
  const q = balanceIn - TARGET;
  const mid = midFromBalancesWad(balanceIn, balanceOut);

  return {
    fills,
    balanceIn,
    balanceOut,
    current: {
      inventoryImbalanceWad: q.toString(),
      midWad: mid.toString(),
      reservationPriceWad: reservationPriceWad(mid, q, PARAMS, elapsed).toString(),
      halfSpreadWad: halfSpreadWad(PARAMS, elapsed).toString(),
      penaltyBps: (q >= 0n ? softBoundPenaltyBps(q, BOUND) : 0n).toString(),
      horizonRemainingSecs: remaining(PARAMS, elapsed).toString()
    }
  };
}

const series = buildSeries();
const lastTimestamp = START + BigInt(STEPS) * 30n;

const position = {
  id: STRATEGY_HASH,
  maker: MAKER,
  app: APP,
  active: true,
  tokens: [TOKEN_IN, TOKEN_OUT],
  gammaWad: PARAMS.gammaWad.toString(),
  sigmaSqWad: PARAMS.sigmaSqWad.toString(),
  baseSpreadWad: PARAMS.baseSpreadWad.toString(),
  targetInventoryWad: TARGET.toString(),
  boundWad: BOUND.toString(),
  horizonSecs: PARAMS.horizonSecs.toString(),
  startTimestamp: START.toString(),
  program: "0x2279",
  ...series.current,
  createdAtBlock: String(START_BLOCK),
  createdAtTimestamp: START.toString(),
  lastUpdatedTimestamp: lastTimestamp.toString(),
  balances: [
    {
      token: TOKEN_IN,
      amount: series.balanceIn.toString(),
      lastUpdatedTimestamp: lastTimestamp.toString()
    },
    {
      token: TOKEN_OUT,
      amount: series.balanceOut.toString(),
      lastUpdatedTimestamp: lastTimestamp.toString()
    }
  ],
  fills: series.fills
};

const META = {block: {number: START_BLOCK + STEPS * 15}, hasIndexingErrors: false};

const LIST = {
  data: {
    _meta: META,
    protocol: {
      id: "0x7a79726f",
      positionCount: "1",
      activePositionCount: "1",
      fillCount: String(STEPS)
    },
    positions: [position]
  }
};

/**
 * @dev The two queries are distinguished, rather than one payload answering
 *      both. `/position/[hash]` asks for a single `position(id:)` and gets
 *      `null` for any other hash — which is the state that page's whole
 *      diagnostic panel exists for, and a mock that returned this position for
 *      every hash would make that panel unreachable during development.
 */
function answer(body) {
  let query = "";
  let id = "";
  try {
    const parsed = JSON.parse(body);
    query = parsed.query ?? "";
    id = parsed.variables?.id ?? "";
  } catch {
    // A malformed body gets the list, same as an empty one. This is a
    // development aid, not a GraphQL server.
  }

  if (!query.includes("position(id:")) return LIST;

  return {
    data: {
      _meta: META,
      position: id.toLowerCase() === STRATEGY_HASH.toLowerCase() ? position : null
    }
  };
}

createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(answer(body)));
  });
}).listen(PORT, () => {
  const first = series.fills[0];
  const last = series.fills[series.fills.length - 1];
  const bps = (m, r) => Number(((BigInt(r) - BigInt(m)) * 1_000_000n) / BigInt(m)) / 100;

  console.log(`mock subgraph on http://localhost:${PORT}`);
  console.log(`  ${STEPS} fills, from the strategy-sdk kernel`);
  console.log(`  separation at fill 1:  ${bps(first.midWadAtFill, first.reservationPriceWadAtFill).toFixed(2)} bps`);
  console.log(`  separation at fill ${STEPS}: ${bps(last.midWadAtFill, last.reservationPriceWadAtFill).toFixed(2)} bps`);
  console.log(`  one position:          /position/${STRATEGY_HASH}`);
  console.log(`\n  SUBGRAPH_URL=http://localhost:${PORT} npm run dev`);
});
