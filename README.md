# Zyro

**Inventory-aware dynamic liquidity — a native 1inch SwapVM instruction.**

ETHOnline 2026 · Sponsors: 1inch · The Graph · Uniswap Foundation

---

## The idea in one paragraph

A market maker earns spread on every fill and can still lose money, because
one-directional flow forces them to accumulate an asset that is falling. The
standard fix has been known since Avellaneda & Stoikov (2008): quote around
your **reservation price** — the price at which *you*, given what you
currently hold, are indifferent to trading — instead of around the market mid.

```
r = s − q·γ·σ²·(T−t)
```

This has never worked on-chain because a pool AMM's inventory belongs to
everybody: there is no individual maker with a target to be away from, so
there is no `q`. **1inch Aqua changes that.** A maker's tokens never leave
their wallet, and SwapVM pre-loads that maker's live balance into the
execution context before any instruction runs. `q` is one subtraction away
from a number no pool AMM exposes.

Zyro is the SwapVM instruction that reads it and re-centres the pricing curve
around `r`.

## What is actually claimed

Not *"we invented inventory-aware market making."* The honest claim:

> This technique has been standard on professional desks since 2008. It
> required an input no on-chain venue exposed. Aqua exposes it. Here is the
> implementation, running as a native instruction inside 1inch's own
> execution engine.

## Status

Everything that can be built without a funded key is built and tested. The
remaining work is a deployment — see [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

| Phase | Component | State |
|---|---|---|
| 0 | Repo hygiene, CI, license | done |
| 1 | Pricing kernel + fuzz suite | done |
| 2 | Read `swap-vm` source | done |
| 3 | Instruction + append-only router + quote/swap parity | done |
| 4 | Ship & swap on Base Sepolia | scripted; **needs a funded key** |
| 5 | TypeScript SDK, byte-verified against Solidity fixtures | done |
| 6 | Subgraph + Subgraph MCP | mappings done and tested; **needs a deployment** |
| 7 | Uniswap v4 hook | done; deploy script mines the address, **needs a key to run** |
| 8 | Competitive routing simulation | done — generated into `contracts/test/fixtures/benchmark.json` |
| 9 | Console | done |
| 10 | Sponsor feedback | done — [FEEDBACK/](FEEDBACK/) |

`forge test` runs 106 tests, `npm test` runs 125, and CI additionally runs the
matchstick suite (which has no Windows binary), builds the Substreams crate
(which cannot compile on Windows at all) and builds the console.

## Correctness, and why it needed a second opinion

A subgraph cannot demonstrate its own correctness, and both of the bugs this
repository shipped in its mappings produced a subgraph that synced to chainhead
in perfect health while publishing wrong numbers. One published a reservation
price of zero for every position until something traded against it; the other
filed post-fill prices under pre-fill names, in the exact series the headline
chart plots.

Neither threw. Neither failed a health check. Both came from assuming an event
order rather than reading it — see [`docs/EVENT-ORDER.md`](docs/EVENT-ORDER.md),
which closes the last open ⚠ VERIFY in the build spec against the vendored
source.

So there are now three independent implementations of the same kernel and a way
to make them disagree out loud:

| | |
|---|---|
| `contracts/src/libs/AvellanedaStoikov.sol` | prices real swaps |
| `packages/strategy-sdk` | the TypeScript port |
| `subgraph/src` | the AssemblyScript port that publishes the index |

`ZyroLens` reads `AQUA.safeBalances` and runs the Solidity library, so
`scripts/verify-subgraph.mjs` and the console's *Index vs chain* panel compare
all three at the block the index has reached — never at chainhead, which would
report a lagging subgraph as a bug.

## Quick start

```bash
# contracts and SDK — no key needed
cd contracts && forge test
cd .. && npm test

# the console, against a mock driven by the real kernel
cd apps/console && npm install
node scripts/mock-subgraph.mjs                  # terminal 1
SUBGRAPH_URL=http://localhost:4444 npm run dev  # terminal 2
```

Then [`docs/RUNBOOK.md`](docs/RUNBOOK.md) for the deployment.

## Layout

```
contracts/          Foundry project — the kernel, the instruction, the router,
                    the v4 hook, and ZyroLens (the on-chain second opinion)
packages/           TypeScript SDK — encoders and the kernel port
subgraph/           The Graph subgraph, matchstick suite, MCP config
substreams/         Substreams package — decoder done, projection partial
apps/console/       Next.js console: the price series and index vs chain, plus
                    /simulate (the benchmark, tick by tick) and
                    /position/[hash] (one position, live)
scripts/            wire-addresses (generates the deployment wiring),
                    verify-subgraph (three-way correctness check)
docs/               RUNBOOK, EVENT-ORDER, BENCHMARK, source verification
FEEDBACK/           Sponsor feedback, written as friction was hit
```

## Sponsor feedback

Written against pinned versions, with the file and line that resolved each
item — not retrospectively, and not generically.

| | |
|---|---|
| [FEEDBACK/1INCH.md](FEEDBACK/1INCH.md) | The opcode table shifted by an `mstore`; Aqua's intra-transaction log order; why the custody model is undersold. |
| [FEEDBACK/THEGRAPH.md](FEEDBACK/THEGRAPH.md) | No Windows matchstick; `--network` eating manifest comments; and the gap between a green sync and correct data, which is where both of our shipped bugs lived. |
| [FEEDBACK/UNISWAP.md](FEEDBACK/UNISWAP.md) | Permission flags in the address pressuring you toward the wrong fix; `HookMiner` filed under `test/`; where per-maker inventory stops porting to a pool. |

## What Zyro does not claim

Zyro does **not** guarantee profit, zero impermanent loss, protection against
a crash, or positive returns in any market. It provides an adaptive pricing
mechanism intended to reduce undesirable inventory accumulation, **at the cost
of some trading revenue**.

Known limits, stated openly:

- Pricing reacts *after* inventory has already moved.
- Aggressive skew reduces volume; it must be tuned per market.
- **The horizon expires.** Once `T−t` reaches zero every time-dependent term
  vanishes and the position silently becomes an ordinary constant-product AMM
  with a flat spread. It does not revert, warn, or stop trading — it stops
  defending itself.
- The Uniswap v4 path is a **port**, not a second instance of the innovation.

## License

MIT — see [LICENSE](LICENSE).
