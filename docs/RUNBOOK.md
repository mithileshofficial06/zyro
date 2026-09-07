# Runbook — Base Sepolia to a verified subgraph

Every step that needs a credential is marked **[needs a key]**. Everything else
is already runnable and already checked in CI.

**This has been run.** Steps 1 through 5 are done and the results are in
[`deployments/base-sepolia.json`](../deployments/base-sepolia.json) and the
README's status table; the subgraph is at
`https://api.studio.thegraph.com/query/1758820/zyro/v0.0.2` and
`verify-subgraph.mjs` passes against it. What follows is how to reproduce it,
and steps 6 and 7 are still outstanding.

The Graph's bar is stricter than 1inch's here. 1inch accepts a local fork; a
subgraph indexes a public chain, and Studio cannot index anvil. So the Base
Sepolia deployment is not a nice-to-have on this track — it is the first
domino, and steps 4 through 8 are all downstream of it.

## Before you start

| | |
|---|---|
| Funded key | ~0.05 ETH on Base Sepolia is plenty. [Base's faucet](https://portal.cdp.coinbase.com/products/faucet), or bridge Sepolia ETH. |
| RPC URL | `https://sepolia.base.org` works; a provider endpoint is faster and less likely to rate-limit a 12-transaction series. |
| Studio account | [thegraph.com/studio](https://thegraph.com/studio), connect a wallet. Base Sepolia is a supported network. |

```bash
cp contracts/.env.example contracts/.env   # if present; otherwise export directly
export PRIVATE_KEY=0x...
export BASE_SEPOLIA_RPC_URL=https://...
```

`contracts/.env` and every `.env*` are gitignored. Keep it that way.

---

## 1. Deploy **[needs a key]**

```bash
cd contracts
forge script script/DeployZyroRouter.s.sol \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --private-key $PRIVATE_KEY \
  --broadcast --verify
```

Deploys `Aqua` (1inch publishes no Base Sepolia Aqua, so this is their
unmodified source from `lib/aqua`), then `ZyroRouter`, then `ZyroLens`.

The script prints all three. You do not need to write them down — step 3 reads
them out of the broadcast artifact.

## 2. Drive a series **[needs a key]**

```bash
export AQUA=0x...  ZYRO_ROUTER=0x...  ZYRO_LENS=0x...

forge script script/SwapSeries.s.sol \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --private-key $PRIVATE_KEY \
  --broadcast --slow
```

Ships one position at its inventory target and walks it to the soft bound with
ten same-direction fills.

**`--slow` is not optional.** Without it forge submits the batch at once, the
transactions land in the same block, and every fill gets the same timestamp —
which collapses the series into one point and holds `(T−t)` constant across
what is supposed to be a walk.

Each step quotes, swaps, asserts the two match, and (with `ZYRO_LENS` set)
prints the numbers the subgraph should publish for that block. Compare a couple
against the console later; a mismatch caught here is caught before indexing.

`ShipAndSwap.s.sol` still exists and does a single ship-and-swap with a parity
assertion. Use it if you want the minimal proof; use `SwapSeries` for the demo.

## 3. Wire the addresses

```bash
node scripts/wire-addresses.mjs --network base-sepolia
```

Reads the broadcast receipts and writes all four places the addresses have to
appear:

- `subgraph/networks.json` — addresses **and start blocks**
- `subgraph/src/config.ts` — `ZYRO_APP`
- `substreams/substreams.yaml` — module param and initial blocks
- `deployments/base-sepolia.json` — for the console and the verifier

Generated rather than hand-edited because updating three of four and not
noticing is silent: a stale `ZYRO_APP` makes every event fail the filter, and
the subgraph syncs to chainhead in perfect health having indexed nothing.

`startBlock` matters more than it looks. It defaults to 0, which on Base
Sepolia is hours of scanning empty blocks. The receipts are the only place the
real number exists without asking an RPC.

## 4. Deploy the subgraph **[needs a key]**

Create a subgraph in Studio first (name it `zyro`), then:

```bash
cd subgraph
npx graph auth <deploy key from Studio>

npm run codegen
npm run build
npx graph deploy zyro --version-label v0.0.1
```

Pass `--version-label` or the CLI prompts for one, which a non-interactive
shell cannot answer.

**Do not run `graph init`.** The Studio quickstart tells you to, and it
scaffolds a fresh subgraph into a new directory — the mappings, the matchstick
suite and this manifest are already here, and `graph init` would leave you
deploying an empty scaffold that indexes nothing. For the same reason, do not
`yarn global add @graphprotocol/graph-cli`: `graph-cli` 0.97.1 is already in
`subgraph/node_modules` and this runbook is written against its exact command
forms.

No `--network` flag needed: step 3 wrote the addresses into `subgraph.yaml`
directly. That is deliberate — `graph build --network <name>` substitutes them
by reparsing the manifest and writing it back out, which strips every comment
in the file, and `subgraph.yaml` documents why no Aqua event parameter may be
marked `indexed` and why balances come from `Pushed`/`Pulled` rather than
`Swapped`. `networks.json` is generated too, so passing `--network base-sepolia`
still works and still agrees.

(`graph-cli` 0.97 has no `--studio` flag; `graph auth <key>` and
`graph deploy <name>` are the current forms. The committed scripts used
`--studio` and would have failed outright.)

Watch the sync. Studio shows indexing errors; the console shows them too.

## 5. Prove it returns correct data

**This is the step that wins the track, and the one most entries skip.** "Live
and indexing" is visible on any subgraph's status page. "Returns real, correct
data" needs a second opinion computed somewhere else.

```bash
SUBGRAPH_URL=<query endpoint from Studio> \
BASE_SEPOLIA_RPC_URL=$BASE_SEPOLIA_RPC_URL \
  node scripts/verify-subgraph.mjs
```

Compares three implementations of the same kernel — the Solidity instruction
(through `ZyroLens`), the TypeScript SDK, and the AssemblyScript mappings — at
the block the index has reached. Exits non-zero on any disagreement, and on an
empty index, which is not a vacuous pass but the exact symptom of both silent
failure modes.

Read [docs/EVENT-ORDER.md](EVENT-ORDER.md) before trusting a green result you
did not expect. This repository shipped two bugs that produced a perfectly
healthy subgraph returning wrong data, and neither was visible without this
comparison.

### If only the time-dependent fields disagree

`reservationPriceWad`, `halfSpreadWad` and `horizonRemainingSecs` failing while
balances, `q`, `midWad` and `penaltyBps` all pass is the signature of a **block
mismatch, not a kernel bug**. Those three decay continuously; the other four do
not. The verifier pins its `eth_call` to `position.lastUpdatedBlock` — the block
whose handler wrote the snapshot — precisely so this cannot happen, and it
prints that block and how far behind the index head it is.

This bit the first live run: the checker pinned to the index head, which was
630 blocks past the last fill, and reported those exact three fields as
failures against a subgraph that was entirely correct. On anvil the two blocks
coincide, so no test could have caught it.

### If it reports zero positions

In this order:

1. **`ZYRO_APP`.** `subgraph/src/config.ts` against
   `deployments/base-sepolia.json`. Re-run step 3 if they differ.
2. **The program decode.** `decodeStrategy` finding no Zyro instruction is
   indistinguishable from "this strategy is not ours", which is a legitimate
   and common case. `subgraph/tests/program.test.ts` runs it against a real
   `abi.encode(order)`; if that passes, the decoder is fine and the filter is
   the problem.
3. **`startBlock`.** Past the ship, and the ship is never seen.

### If balances disagree but prices do not

The `Pushed`/`Pulled` reconstruction has drifted. Prices are then derived from
a balance that does not exist, and the arithmetic being correct is irrelevant.

### If balances agree and prices do not

The AssemblyScript kernel disagrees with the Solidity. The verifier's third
column says which side the TypeScript SDK is on, which localises it to one
port rather than to a shared misreading.

## 6. Deploy the v4 hook **[needs a key]**

Separate from step 1 on purpose. `ZyroRouter` has 2,446 bytes of EIP-170
headroom, and compiling both under v4-core's optimizer profile spends it.

```bash
export POOL_MANAGER=0x...   # the chain's v4 PoolManager

forge script script/DeployZyroHook.s.sol   --rpc-url $BASE_SEPOLIA_RPC_URL   --private-key $PRIVATE_KEY   --broadcast --verify
```

**A hook's address is a constraint, not an output.** The `PoolManager` reads
permissions out of the low 14 bits of the hook's own address, so the script
mines a CREATE2 salt until the address carries the four flags `ZyroSkewHook`
declares, and deploys with it. The salt is mined against Foundry's
deterministic proxy at `0x4e59b448…` — the address a salted `new` in a
broadcast actually deploys from — not against your EOA.

`ZyroSkewHook.t.sol` places the hook with `deployCodeTo`, which is a cheatcode.
It proves the hook works at a valid address; it says nothing about reaching
one. That is why this script exists and why `DeployZyroHook.t.sol` tests it.

Then initialise a pool with `LPFeeLibrary.DYNAMIC_FEE_FLAG` and this hook, and
call `configurePool` as the owner. Configuration is owner-only and re-runnable.

## 7. Point an agent at it **[needs a key]**

See [subgraph/mcp/README.md](../subgraph/mcp/README.md). Needs a Gateway API
key from Studio, and prefers the **deployment** id over the subgraph id — a
subgraph id resolves to whatever version is current, so a redeploy silently
changes what the agent is querying.

## 8. Run the console

```bash
cd apps/console
cp .env.example .env.local     # fill in SUBGRAPH_URL and BASE_SEPOLIA_RPC_URL
npm install
npm run dev
```

Both variables are read server-side and neither reaches the browser; a Studio
URL can carry an API key in its path.

Without a deployment, develop against the mock:

```bash
node scripts/mock-subgraph.mjs                  # terminal 1
SUBGRAPH_URL=http://localhost:4444 npm run dev  # terminal 2
```

The mock's numbers come from `packages/strategy-sdk` — the same kernel — walked
through the exact series step 2 executes. It is a development aid: the
verification panel will fail against it, correctly, because there is no chain
behind it.

## 9. Substreams — optional

Genuinely optional, and honestly labelled: `graph_out` cannot yet serve
`schema.graphql`. See [substreams/README.md](../substreams/README.md) for the
exact list of fields it cannot fill and why. The AssemblyScript subgraph is
what satisfies the track.

---

## What is already done, without a key

| | |
|---|---|
| 106 contract tests, 125 SDK tests | `forge test`, `npm test` |
| Kernel parity across three languages | fixtures generated by the Solidity, checked by the SDK and the subgraph |
| Subgraph handler + decoder tests | matchstick, in CI — no Windows binary exists |
| `decodeStrategy` against real bytes | a live `abi.encode(order)`, not synthetic |
| Aqua's event order | pinned by `vm.recordLogs` against a real `Aqua` |
| Console | builds in CI, unconfigured and configured |
