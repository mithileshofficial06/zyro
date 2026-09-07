#!/usr/bin/env node
/**
 * Is this subgraph actually reachable by an agent?
 *
 * The MCP server queries The Graph Network through the gateway, and the
 * gateway routes to Indexers. Three things have to be true and they fail
 * identically from a client: the API key has to be valid, the deployment id
 * has to be the right one, and the subgraph has to be **published** so that
 * an Indexer is serving it. All three produce the same symptom — an agent
 * that cannot find your data — and only one of them is a mistake you can fix
 * by editing a config file.
 *
 * So this separates them:
 *
 *   1. the key, against a subgraph known to be published (Uniswap v3). Fails
 *      here and the key is wrong or the account has no query budget; nothing
 *      about Zyro is implicated.
 *   2. the deployment id's *form*, decoded rather than pattern-matched. The
 *      `Qm…` CIDv0 Studio shows and the `0x…` id the MCP tools take are two
 *      encodings of one hash, and handing a tool the wrong one reads as "not
 *      found" rather than as a format error.
 *   3. the deployment itself, through the gateway. Reaching (3) with (1)
 *      passing and (2) well-formed means the subgraph is deployed but not
 *      published, which is an on-chain action on Arbitrum One and not
 *      something any amount of configuration will substitute for.
 *
 *   THEGRAPH_GATEWAY_API_KEY=... ZYRO_SUBGRAPH_DEPLOYMENT_ID=Qm... \
 *     node subgraph/mcp/check.mjs
 */

const KEY = process.env.THEGRAPH_GATEWAY_API_KEY;
const DEPLOYMENT = process.env.ZYRO_SUBGRAPH_DEPLOYMENT_ID;

/**
 * A subgraph that is definitely published, used only as a control.
 *
 * @dev Nothing about Zyro is being tested here — the point is to establish
 *      that the key works at all, so a failure further down is attributable.
 *      Testing a key by using it against the thing you are debugging tells you
 *      only that something is wrong.
 */
const CONTROL = "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

let failed = 0;
const pass = (m) => console.log(`  OK   ${m}`);
const fail = (m) => {
  console.log(`  FAIL ${m}`);
  failed++;
};

/**
 * CIDv0 to the `0x` deployment id the MCP tools take.
 *
 * @dev Decoded properly rather than sliced. A CIDv0 is base58btc over a
 *      multihash — `0x1220` then 32 bytes of sha2-256 — so the id an MCP tool
 *      wants is the digest with the two prefix bytes dropped, and checking
 *      that prefix is what distinguishes a real CIDv0 from a string that
 *      merely starts with "Qm".
 */
function cidToHex(cid) {
  let n = 0n;
  for (const c of cid) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error(`not base58: ${JSON.stringify(c)}`);
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const bytes = Buffer.from(hex, "hex");
  const prefix = bytes.subarray(0, 2).toString("hex");
  if (prefix !== "1220") throw new Error(`multihash prefix ${prefix}, expected 1220 (sha2-256)`);
  if (bytes.length !== 34) throw new Error(`${bytes.length} bytes, expected 34`);
  return `0x${bytes.subarray(2).toString("hex")}`;
}

async function gateway(path) {
  const response = await fetch(`https://gateway.thegraph.com/api/${KEY}/${path}`, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({query: "{_meta{block{number}hasIndexingErrors}}"})
  });
  // The gateway answers 200 with a GraphQL `errors` array for a subgraph it
  // cannot route, so the status alone says nothing.
  const json = await response.json().catch(() => null);
  return {status: response.status, json};
}

console.log("Subgraph MCP readiness\n");

if (!KEY) {
  console.error("THEGRAPH_GATEWAY_API_KEY is not set (Studio -> API Keys)\n");
  process.exit(1);
}
if (!DEPLOYMENT) {
  console.error("ZYRO_SUBGRAPH_DEPLOYMENT_ID is not set (Studio, or `graph deploy` output)\n");
  process.exit(1);
}

// --- 1. the key -------------------------------------------------------------
console.log("gateway api key");
const control = await gateway(`subgraphs/id/${CONTROL}`);
if (control.json?.data?._meta) {
  pass(`valid, and the account can query (control subgraph at block ${control.json.data._meta.block.number})`);
} else {
  fail(`the key could not query a published subgraph: ${describe(control)}`);
  report();
}

// --- 2. the deployment id ---------------------------------------------------
console.log("\ndeployment id");
let hex = null;
try {
  hex = cidToHex(DEPLOYMENT);
  pass(`${DEPLOYMENT}`);
  console.log(`       MCP tools want the 0x form: ${hex}`);
} catch (error) {
  fail(`${DEPLOYMENT} is not a CIDv0: ${error.message}`);
}

// --- 3. the deployment, through the gateway ---------------------------------
console.log("\nthe subgraph, through the gateway");
const mine = await gateway(`deployments/id/${DEPLOYMENT}`);
if (mine.json?.data?._meta) {
  pass(`served at block ${mine.json.data._meta.block.number}, indexing errors ${mine.json.data._meta.hasIndexingErrors}`);
} else if (/not found/i.test(describe(mine))) {
  fail("no Indexer is serving this deployment");
  console.log(`
  The key works and the id is well formed, so this is not configuration. A
  subgraph deployed to Studio is queryable only at its Studio endpoint; the
  gateway routes to Indexers, and an Indexer only picks up a subgraph once it
  has been **published to the decentralised network**. Publishing is a
  transaction on Arbitrum One and needs ETH there.

    Studio -> your subgraph -> Publish

  Until then the console and scripts/verify-subgraph.mjs work fine against the
  Studio endpoint, and only the MCP path is blocked.`);
} else {
  fail(describe(mine));
}

report();

function describe(result) {
  if (!result.json) return `http ${result.status}, unparseable body`;
  if (result.json.errors) return result.json.errors.map((e) => e.message).join("; ");
  return `http ${result.status}, no data`;
}

function report() {
  if (failed === 0) {
    console.log("\nReady: an agent pointed at this deployment id will reach real data.\n");
    process.exit(0);
  }
  console.log(`\n${failed} check(s) failed.\n`);
  process.exit(1);
}
