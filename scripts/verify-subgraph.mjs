#!/usr/bin/env node
/**
 * Checks that the deployed subgraph returns the same numbers the chain does.
 *
 * "Live and indexing" is easy and most projects stop there. The requirement is
 * that it *returns real, correct data*, and correctness is not a property a
 * subgraph can demonstrate about itself — it needs a second opinion computed
 * somewhere else.
 *
 * There are three implementations of the Zyro kernel in this repository:
 *
 *   1. the Solidity instruction that actually prices swaps
 *   2. `packages/strategy-sdk`, the TypeScript port
 *   3. `subgraph/src`, the AssemblyScript port that publishes the index
 *
 * This queries (3), calls (1) through `ZyroLens` at **the block each position's
 * numbers were computed at**, and recomputes with (2) from the balances the
 * chain reports. All three must agree exactly. Any disagreement localises:
 *
 *   - balances differ            → the Pushed/Pulled reconstruction is wrong
 *   - balances agree, price does not, and the SDK sides with the chain
 *                                 → the AssemblyScript kernel is wrong
 *   - both ports differ from the chain in the same direction
 *                                 → the shared reading of the spec is wrong
 *
 * Pinning the block is what makes this a comparison rather than a race, and
 * the block to pin to is `position.lastUpdatedBlock` - not chainhead, and not
 * the index head either.
 *
 * Calling at "latest" against an index that has reached block N-3 compares two
 * different states and reports a lagging subgraph as a bug. But the index head
 * is wrong too, and less obviously so: a subgraph recomputes only when an event
 * touches a position, so `reservationPriceWad`, `halfSpreadWad` and
 * `horizonRemainingSecs` are snapshots taken at the *last event*, and they
 * decay continuously afterwards. A position that has sat idle for ten minutes
 * publishes a ten-minute-old reservation price and is entirely correct to. Pin
 * to the index head and those three disagree by more the longer nothing
 * trades, which is a real deployment reporting a correct subgraph as broken.
 *
 * Balances, `q`, `midWad` and `penaltyBps` do not decay, so they agree at any
 * block between the last event and now. Only the time-dependent trio needs the
 * exact block, and all six are pinned to it for one comparison rather than two.
 *
 *   SUBGRAPH_URL=https://... BASE_SEPOLIA_RPC_URL=https://... \
 *     node scripts/verify-subgraph.mjs [--network base-sepolia]
 */

import {readFileSync, existsSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

import {
  halfSpreadWad,
  keccak256,
  midFromBalancesWad,
  remaining,
  reservationPriceWad,
  softBoundPenaltyBps
} from "../packages/strategy-sdk/src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const args = process.argv.slice(2);
const networkArg = args.indexOf("--network");
const network = networkArg === -1 ? "base-sepolia" : args[networkArg + 1];

const SUBGRAPH_URL = process.env.SUBGRAPH_URL;
const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL ?? process.env.RPC_URL;

if (!SUBGRAPH_URL) die("set SUBGRAPH_URL to the deployed subgraph's query endpoint");
if (!RPC_URL) die("set BASE_SEPOLIA_RPC_URL (or RPC_URL)");

const deploymentPath = join(root, `deployments/${network}.json`);
if (!existsSync(deploymentPath)) {
  die(`no ${deploymentPath}. Run: node scripts/wire-addresses.mjs --network ${network}`);
}
const deployment = JSON.parse(readFileSync(deploymentPath, "utf8"));
if (!deployment.zyroLens) {
  die("this deployment has no ZyroLens; redeploy with the current DeployZyroRouter script");
}

function die(message) {
  console.error(`\nverify-subgraph: ${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Minimal ABI codec
//
// Only one function is ever called, with a fixed shape, so a full ABI library
// would be more surface than the thing it encodes.
// ---------------------------------------------------------------------------

const WORD = 64; // hex chars in one 32-byte word

const strip = (hex) => (hex.startsWith("0x") ? hex.slice(2) : hex);
const padLeft = (hex) => strip(hex).padStart(WORD, "0");
const padRight = (hex) => {
  const s = strip(hex);
  const remainder = s.length % WORD;
  return remainder === 0 ? s : s + "0".repeat(WORD - remainder);
};
const word = (n) => BigInt(n).toString(16).padStart(WORD, "0");

/** Two's-complement read of a 32-byte word as a signed integer. */
function toInt256(hex) {
  const value = BigInt(`0x${hex}`);
  return value >> 255n === 1n ? value - (1n << 256n) : value;
}

/**
 * `state(address,address,bytes32,address,address,bytes)`.
 *
 * @dev Derived rather than pasted, using the same keccak the SDK is
 *      byte-verified against in `EncodingFixtures.t.sol`. A pasted selector for
 *      a signature that has since changed does not error — the call reverts
 *      with no data, which reads exactly like a reverted view and sends you
 *      looking at the wrong contract.
 */
const STATE_SELECTOR = keccak256(
  `0x${Buffer.from("state(address,address,bytes32,address,address,bytes)", "utf8").toString("hex")}`
).slice(2, 10);

function encodeStateCall({maker, app, strategyHash, tokenIn, tokenOut, program}) {
  const head = [
    padLeft(maker),
    padLeft(app),
    padLeft(strategyHash),
    padLeft(tokenIn),
    padLeft(tokenOut),
    word(6 * 32) // offset to the bytes tail
  ].join("");

  const body = strip(program);
  const tail = word(body.length / 2) + padRight(body);

  return `0x${STATE_SELECTOR}${head}${tail}`;
}

/** The `State` struct: nine static words, returned inline. */
function decodeState(hex) {
  const w = (i) => strip(hex).slice(i * WORD, (i + 1) * WORD);
  return {
    balanceIn: BigInt(`0x${w(0)}`),
    balanceOut: BigInt(`0x${w(1)}`),
    inventoryImbalanceWad: toInt256(w(2)),
    midWad: toInt256(w(3)),
    reservationPriceWad: toInt256(w(4)),
    halfSpreadWad: toInt256(w(5)),
    penaltyBps: BigInt(`0x${w(6)}`),
    horizonRemainingSecs: BigInt(`0x${w(7)}`),
    elapsedSecs: BigInt(`0x${w(8)}`)
  };
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

let rpcId = 0;

async function rpc(method, params) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({jsonrpc: "2.0", id: ++rpcId, method, params})
  });
  const json = await response.json();
  if (json.error) die(`${method}: ${json.error.message}`);
  return json.result;
}

async function query(document, variables = {}) {
  const response = await fetch(SUBGRAPH_URL, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({query: document, variables})
  });
  const json = await response.json();
  if (json.errors) die(`subgraph: ${JSON.stringify(json.errors)}`);
  return json.data;
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

const POSITIONS = `
  query Positions {
    _meta { block { number } hasIndexingErrors }
    positions(first: 10, orderBy: createdAtBlock, orderDirection: desc) {
      id
      maker
      app
      active
      tokens
      gammaWad
      sigmaSqWad
      baseSpreadWad
      targetInventoryWad
      boundWad
      horizonSecs
      startTimestamp
      program
      inventoryImbalanceWad
      midWad
      reservationPriceWad
      halfSpreadWad
      penaltyBps
      horizonRemainingSecs
      lastUpdatedBlock
      balances { token amount }
      fills(first: 100, orderBy: timestamp) {
        blockNumber
        amountIn
        amountOut
        midWadAtFill
        reservationPriceWadAtFill
        inventoryImbalanceWadAtFill
        exposed
      }
    }
  }
`;

let failures = 0;

function check(label, expected, actual) {
  const ok = expected === actual;
  if (!ok) failures++;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${label.padEnd(26)} ${ok ? expected : `${actual} != ${expected}`}`);
}

const data = await query(POSITIONS);
const indexedBlock = data._meta.block.number;

console.log(`network        ${network}`);
console.log(`subgraph head  block ${indexedBlock}`);
console.log(`indexing errors ${data._meta.hasIndexingErrors}`);
console.log(`positions      ${data.positions.length}`);

if (data._meta.hasIndexingErrors) {
  console.error("\nthe subgraph reports indexing errors; nothing below is trustworthy\n");
  failures++;
}

// The most common outcome of a wrong ZYRO_APP or a wrong program offset is not
// an error but an empty index, so an empty result is a failure rather than a
// vacuous pass.
if (data.positions.length === 0) {
  die(
    "the subgraph indexed no positions.\n" +
      "  Both silent failure modes look exactly like this: a ZYRO_APP that does not\n" +
      "  match the deployed router, or a decodeStrategy that finds no Zyro\n" +
      "  instruction. Check src/config.ts against deployments/, then re-run the\n" +
      "  program.test.ts fixture against the shipped program."
  );
}

for (const position of data.positions) {
  console.log(`\nposition ${position.id}`);
  console.log(`  active ${position.active}, ${position.fills.length} fills`);

  // Per position, not once per run: two positions last traded at different
  // blocks, and one shared tag would be right for at most one of them.
  const snapshotBlock = Number(position.lastUpdatedBlock);
  const blockTag = `0x${snapshotBlock.toString(16)}`;
  const lag = indexedBlock - snapshotBlock;
  console.log(
    `  snapshot  block ${snapshotBlock}` + (lag === 0 ? "" : `, ${lag} behind the index head`)
  );

  if (position.tokens.length < 2) {
    console.log("  SKIP  fewer than two funded tokens, so there is no mid to compare");
    continue;
  }

  const [tokenIn, tokenOut] = position.tokens;

  const raw = await rpc("eth_call", [
    {
      to: deployment.zyroLens,
      data: encodeStateCall({
        maker: position.maker,
        app: position.app,
        strategyHash: position.id,
        tokenIn,
        tokenOut,
        program: position.program
      })
    },
    blockTag
  ]);

  const chain = decodeState(raw);

  // --- 1. balances, against Aqua's own ledger ------------------------------
  //
  // The subgraph reconstructs these from Pushed/Pulled. The lens reads
  // safeBalances directly. A disagreement here means the event reconstruction
  // has drifted, and every price below it is derived from a balance that does
  // not exist.
  const indexedBalance = (token) => {
    const entry = position.balances.find((b) => b.token.toLowerCase() === token.toLowerCase());
    return entry ? BigInt(entry.amount) : 0n;
  };

  console.log("  balances (subgraph vs AQUA.safeBalances)");
  check("balanceIn", chain.balanceIn.toString(), indexedBalance(tokenIn).toString());
  check("balanceOut", chain.balanceOut.toString(), indexedBalance(tokenOut).toString());

  // --- 2. the published price, against the chain's own kernel --------------
  console.log("  pricing (subgraph vs ZyroLens)");
  check("inventoryImbalanceWad", chain.inventoryImbalanceWad.toString(), position.inventoryImbalanceWad);
  check("midWad", chain.midWad.toString(), position.midWad);
  check("reservationPriceWad", chain.reservationPriceWad.toString(), position.reservationPriceWad);
  check("halfSpreadWad", chain.halfSpreadWad.toString(), position.halfSpreadWad);
  check("penaltyBps", chain.penaltyBps.toString(), position.penaltyBps);
  check("horizonRemainingSecs", chain.horizonRemainingSecs.toString(), position.horizonRemainingSecs);

  // --- 3. the TypeScript port, as a third opinion --------------------------
  //
  // Recomputed from the chain's balances rather than the subgraph's, so this
  // isolates the kernel from the event reconstruction: if balances already
  // failed above, this still says whether the arithmetic is sound.
  const params = {
    gammaWad: BigInt(position.gammaWad),
    sigmaSqWad: BigInt(position.sigmaSqWad),
    baseSpreadWad: BigInt(position.baseSpreadWad),
    horizonSecs: BigInt(position.horizonSecs)
  };
  const elapsed = chain.elapsedSecs;
  const q = chain.balanceIn - BigInt(position.targetInventoryWad);
  const sdkMid = midFromBalancesWad(chain.balanceIn, chain.balanceOut);

  console.log("  kernel (strategy-sdk vs ZyroLens)");
  check("sdk midWad", chain.midWad.toString(), sdkMid.toString());
  check(
    "sdk reservationPriceWad",
    chain.reservationPriceWad.toString(),
    reservationPriceWad(sdkMid, q, params, elapsed).toString()
  );
  check("sdk halfSpreadWad", chain.halfSpreadWad.toString(), halfSpreadWad(params, elapsed).toString());
  check(
    "sdk penaltyBps",
    chain.penaltyBps.toString(),
    (q >= 0n ? softBoundPenaltyBps(q, BigInt(position.boundWad)) : 0n).toString()
  );
  check(
    "sdk horizonRemaining",
    chain.horizonRemainingSecs.toString(),
    remaining(params, elapsed).toString()
  );

  // --- 4. the fill series is a series ---------------------------------------
  //
  // The headline chart claims the reservation price walks away from the mid as
  // inventory accumulates. One point cannot show that, and neither can many
  // points that all sit at the same inventory.
  if (position.fills.length > 1) {
    const first = position.fills[0];
    const last = position.fills[position.fills.length - 1];
    const drifted = BigInt(last.inventoryImbalanceWadAtFill) !== BigInt(first.inventoryImbalanceWadAtFill);

    console.log("  fill series");
    console.log(`  ${drifted ? "OK  " : "FAIL"} inventory drifts across fills`);
    if (!drifted) failures++;

    // Snapshots are captured before settlement is applied. If they were read
    // after, the first fill of a balanced position would already show drift.
    const firstAtTarget = BigInt(first.inventoryImbalanceWadAtFill) === 0n;
    console.log(
      `  ${firstAtTarget ? "OK  " : "WARN"} first fill snapshot is pre-settlement` +
        `${firstAtTarget ? "" : " (only meaningful if the position shipped balanced)"}`
    );

    const separated = position.fills.filter(
      (f) => BigInt(f.reservationPriceWadAtFill) !== BigInt(f.midWadAtFill)
    ).length;
    console.log(`  INFO ${separated}/${position.fills.length} fills priced away from the mid`);
  } else {
    console.log(`  INFO ${position.fills.length} fill(s) — run SwapSeries for a plottable series`);
  }
}

console.log("");
if (failures > 0) {
  console.error(`${failures} check(s) failed.\n`);
  process.exit(1);
}
console.log("Every check passed: the subgraph agrees with the chain, field for field.\n");
