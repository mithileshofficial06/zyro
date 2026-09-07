# Querying Zyro from an agent

The Graph publishes a hosted MCP server that lets an agent discover a subgraph
and query it without being handed the schema first. Pointing an agent at Zyro
through it is the **Composable-track** qualification path, and it is also the
strongest single argument for why this data belongs in a subgraph at all:
the reservation price a position is quoting is only useful if something that
is not a human can find it.

## Configuration

`mcp.config.json` in this directory. It expects one environment variable:

```
THEGRAPH_GATEWAY_API_KEY=<from thegraph.com/studio → API Keys>
```

**Treat that key like a password.** Anyone holding it queries the gateway on
your behalf and is billed for it, so it stays in the environment and never in
the committed file.

The server is remote and speaks SSE, which most MCP clients reach through
`mcp-remote` rather than connecting to directly — that is why the config is a
`command` with arguments rather than a `url`. Register it with:

```bash
claude mcp add-json subgraph "$(cat subgraph/mcp/mcp.config.json | jq -c '.mcpServers.subgraph')"
```

…or paste the file's contents into the `mcpServers` block of whichever client
you are using.

## `graph deploy` is not enough — the subgraph has to be published

**This is the step that catches people, and it fails silently.** The MCP server
queries The Graph Network through the gateway, and the gateway routes to
Indexers. An Indexer only picks a subgraph up once it has been **published to
the decentralised network** — a transaction on Arbitrum One, from the Publish
button on the subgraph's Studio page.

A subgraph that has only been `graph deploy`d is queryable at its Studio
endpoint and nowhere else. Point an agent at it and the gateway answers **HTTP
200** with `{"errors":[{"message":"subgraph not found: Qm…"}]}` — which looks
exactly like a wrong id or a bad key, and is neither.

Run the check rather than guessing which of the three it is:

```bash
THEGRAPH_GATEWAY_API_KEY=... ZYRO_SUBGRAPH_DEPLOYMENT_ID=Qm...   node subgraph/mcp/check.mjs
```

It tests the key against a subgraph known to be published, decodes the
deployment id, and only then tries yours — so a failure names one cause
instead of three. Nothing else in this repository needs publishing: the
console and `scripts/verify-subgraph.mjs` run against the Studio endpoint.

## The deployment id, and its two forms

After `graph deploy`, Studio shows both a **subgraph id** (stable across
versions) and a **deployment id** (the hash of one specific version).

Prefer the **deployment id** for anything being demonstrated. A subgraph id
resolves to whatever version is current, so a redeploy silently changes what an
agent is querying; a deployment id is pinned to the exact mappings that were
verified.

It has two encodings of the same hash, and they are not interchangeable at the
call site:

| | |
|---|---|
| `Qm…`, 46 chars | CIDv0, base58. What `graph deploy` prints and Studio shows. |
| `0x…`, 66 chars | The same 32-byte sha2-256 digest, hex. What the MCP tools' *by deployment id* calls take. |

Handing a tool the wrong one reads as "not found", not as a format error.
`check.mjs` prints the conversion.

Record it in the environment alongside the key:

```
ZYRO_SUBGRAPH_DEPLOYMENT_ID=Qm...
```

## What an agent should ask for

The point is not that the subgraph can be queried — every subgraph can. It is
that a solver-shaped question has a direct answer:

> Which Zyro positions are currently quoting below their mid, and by how much?

```graphql
{
  positions(where: {active: true}, orderBy: createdAtBlock, orderDirection: desc) {
    id
    maker
    tokens
    midWad
    reservationPriceWad
    inventoryImbalanceWad
    halfSpreadWad
    penaltyBps
    horizonRemainingSecs
  }
}
```

`reservationPriceWad` is the number that does not exist anywhere else. A pool
AMM exposes a reserve ratio and nothing about whose inventory is behind it;
recovering an order-based maker's reservation price otherwise means
re-implementing Avellaneda–Stoikov and re-deriving the maker's parameters from
raw calldata. Here it is a field.

Two things to read alongside it:

- **`horizonRemainingSecs = 0`** means the position has stopped defending
  itself and is quoting as an ordinary constant-product AMM. Routing to it as
  though it were still inventory-aware is wrong.
- **`penaltyBps`** applies to the exposed side only. A position past its soft
  bound is paying to shed inventory, which is an opportunity for flow going the
  other way.

## Verifying what the agent is told

An agent querying a subgraph has no way to know whether the numbers are right.
Neither does the subgraph. Run

```bash
SUBGRAPH_URL=<query endpoint> BASE_SEPOLIA_RPC_URL=<rpc> \
  node scripts/verify-subgraph.mjs
```

which compares every published field against `ZyroLens` on-chain at the block
each position's numbers were computed at — `lastUpdatedBlock`, not chainhead
and not the index head. See [docs/EVENT-ORDER.md](../../docs/EVENT-ORDER.md)
for two bugs this repository shipped that produced a perfectly healthy subgraph
returning wrong data, and the README for a third that lived in the checker
itself.
