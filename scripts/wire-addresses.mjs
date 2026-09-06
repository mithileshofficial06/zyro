#!/usr/bin/env node
/**
 * Wires a deployment's addresses into every file that needs them, from the
 * Foundry broadcast artifact.
 *
 * Three files carry the same two addresses, in three different syntaxes:
 *
 *   - `subgraph/networks.json`   — addresses and start blocks
 *   - `subgraph/src/config.ts`   — ZYRO_APP, the Aqua app filter
 *   - `substreams/substreams.yaml` — a module param and initial blocks
 *
 * Updating two of the three and not noticing is a real failure mode, and a
 * quiet one. A stale `ZYRO_APP` does not error: `Bytes.equals` simply returns
 * false for every event, the subgraph syncs to chainhead in perfect health and
 * indexes nothing at all. So this generates all three from one source rather
 * than leaving them to be kept in step by hand.
 *
 * **On `startBlock`.** It defaults to 0 in the committed files, which on Base
 * Sepolia means scanning millions of empty blocks before reaching anything this
 * deployment did — hours of indexing to arrive at the same answer. It must be
 * the deployment block, and the broadcast receipts are the only place that
 * number exists without asking an RPC.
 *
 *   node scripts/wire-addresses.mjs [--network base-sepolia] [--dry-run]
 */

import {readFileSync, writeFileSync, existsSync, mkdirSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/** Chain ids Foundry files broadcasts under, by the name the tooling uses. */
const NETWORKS = {
  "base-sepolia": 84532,
  base: 8453,
  anvil: 31337
};

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const networkArg = args.indexOf("--network");
const network = networkArg === -1 ? "base-sepolia" : args[networkArg + 1];

const chainId = NETWORKS[network];
if (!chainId) {
  fail(`unknown network ${network}; expected one of ${Object.keys(NETWORKS).join(", ")}`);
}

/**
 * Foundry has written this field in both seconds and milliseconds depending on
 * version, and the two are indistinguishable except by magnitude.
 */
function broadcastTimestamp(value) {
  if (typeof value !== "number") return null;
  const ms = value > 1e12 ? value : value * 1000;
  return new Date(ms).toISOString();
}

function fail(message) {
  console.error(`\nwire-addresses: ${message}\n`);
  process.exit(1);
}

function readBroadcast(script) {
  const path = join(root, "contracts/broadcast", script, String(chainId), "run-latest.json");
  if (!existsSync(path)) return null;
  return {path, json: JSON.parse(readFileSync(path, "utf8"))};
}

/**
 * @returns every contract created by a broadcast, as `{name, address, block}`.
 *
 * Transactions and receipts are parallel arrays in the artifact, so the block a
 * contract landed in is the receipt at its own index. Reading `receipts[0]` for
 * everything would put a later deployment's start block before it existed.
 */
function creations(run) {
  const out = [];
  run.transactions.forEach((tx, i) => {
    if (tx.transactionType !== "CREATE" && tx.transactionType !== "CREATE2") return;
    const receipt = run.receipts[i];
    out.push({
      name: tx.contractName,
      address: (tx.contractAddress ?? receipt?.contractAddress ?? "").toLowerCase(),
      block: receipt ? Number(BigInt(receipt.blockNumber)) : null
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Gather
// ---------------------------------------------------------------------------

const deploy = readBroadcast("DeployZyroRouter.s.sol");
if (!deploy) {
  fail(
    `no broadcast for chain ${chainId}. Run:\n\n` +
      `  forge script script/DeployZyroRouter.s.sol \\\n` +
      `    --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast`
  );
}

const created = creations(deploy.json);
const find = (name) => created.find((c) => c.name === name);

const router = find("ZyroRouter");
if (!router) fail(`no ZyroRouter in ${deploy.path}`);

const lens = find("ZyroLens");

// Aqua is only in this broadcast on a network that had none — on a mainnet it
// is the canonical deployment and comes from the environment instead.
let aqua = find("Aqua");
if (!aqua) {
  const fromEnv = process.env.AQUA;
  if (!fromEnv) {
    fail(
      "no Aqua in the broadcast and AQUA is unset. On a network where Aqua\n" +
        "  already exists, pass its address: AQUA=0x... node scripts/wire-addresses.mjs"
    );
  }
  // An existing Aqua predates this deployment, so the router's block is the
  // earliest one this subgraph could have anything to index.
  aqua = {name: "Aqua", address: fromEnv.toLowerCase(), block: router.block};
}

// The earliest block any watched contract existed at. Indexing from before the
// first deployment is wasted sync; indexing from after it misses the ship.
const startBlock = Math.min(aqua.block, router.block);

console.log(`network      ${network} (chain ${chainId})`);
console.log(`Aqua         ${aqua.address}  @ block ${aqua.block}`);
console.log(`ZyroRouter   ${router.address}  @ block ${router.block}`);
if (lens) console.log(`ZyroLens     ${lens.address}  @ block ${lens.block}`);
console.log(`startBlock   ${startBlock}`);

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

const writes = [];

function stage(relativePath, contents) {
  writes.push({path: join(root, relativePath), relativePath, contents});
}

// --- subgraph/networks.json -------------------------------------------------
const networksPath = join(root, "subgraph/networks.json");
const networks = existsSync(networksPath) ? JSON.parse(readFileSync(networksPath, "utf8")) : {};
networks[network] = {
  Aqua: {address: aqua.address, startBlock: aqua.block},
  ZyroRouter: {address: router.address, startBlock: router.block}
};
stage("subgraph/networks.json", `${JSON.stringify(networks, null, 2)}\n`);

// --- subgraph/src/config.ts -------------------------------------------------
stage(
  "subgraph/src/config.ts",
  `import {Address} from "@graphprotocol/graph-ts";

/**
 * The Zyro router's address, as an Aqua "app".
 *
 * Aqua's \`Shipped\`, \`Pushed\`, \`Pulled\` and \`Docked\` fire for **every** app
 * built on Aqua, not just this one. Every handler filters on this address;
 * without it the subgraph would try to decode unrelated protocols' strategies
 * as Zyro programs and publish nonsense for them.
 *
 * \`graph build --network <name>\` substitutes contract addresses in
 * \`subgraph.yaml\` from \`networks.json\`, but it cannot substitute a constant in
 * mapping code — so this is set here per deployment.
 *
 * GENERATED by \`node scripts/wire-addresses.mjs\`. Editing it by hand is how it
 * falls out of step with \`networks.json\`, and a stale value does not error:
 * every event simply fails the filter and the subgraph syncs to chainhead in
 * perfect health having indexed nothing.
 */
export const ZYRO_APP: Address = Address.fromString(
  "${router.address}"
);
`
);

// --- substreams/substreams.yaml ---------------------------------------------
const substreamsPath = join(root, "substreams/substreams.yaml");
if (existsSync(substreamsPath)) {
  let yaml = readFileSync(substreamsPath, "utf8");

  yaml = yaml.replace(/^network:.*$/m, `network: ${network}`);
  yaml = yaml.replace(/^(\s*map_events:\s*)".*"$/m, `$1"${router.address}"`);
  // Both modules, and only the `initialBlock:` keys — a bare number replace
  // would also rewrite anything else that happened to look like one.
  yaml = yaml.replace(/^(\s*initialBlock:\s*)\d+$/gm, `$1${startBlock}`);

  stage("substreams/substreams.yaml", yaml);
}

// --- deployments/<network>.json ---------------------------------------------
//
// One machine-readable record the console and the verification script both read,
// so neither has to parse a broadcast artifact or be passed addresses by hand.
stage(
  `deployments/${network}.json`,
  `${JSON.stringify(
    {
      network,
      chainId,
      aqua: aqua.address,
      zyroRouter: router.address,
      zyroLens: lens ? lens.address : null,
      startBlock,
      deployedAt: broadcastTimestamp(deploy.json.timestamp)
    },
    null,
    2
  )}\n`
);

if (dryRun) {
  console.log("\n--dry-run, nothing written:");
  for (const w of writes) console.log(`  would write ${w.relativePath}`);
  process.exit(0);
}

console.log("");
for (const w of writes) {
  mkdirSync(dirname(w.path), {recursive: true});
  writeFileSync(w.path, w.contents, "utf8");
  console.log(`wrote ${w.relativePath}`);
}

console.log(`
Next:
  cd subgraph && npm run codegen && npm run build
  npx graph deploy --studio <your-subgraph-slug>
`);
