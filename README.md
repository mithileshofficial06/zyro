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

Build in progress. See [`ZYRO_BUILD_SPEC.md`](ZYRO_BUILD_SPEC.md) for the full
implementation specification and [§26](ZYRO_BUILD_SPEC.md) for build order.

| Phase | Component | State |
|---|---|---|
| 0 | Repo hygiene, CI, license | in progress |
| 1 | Pricing kernel + fuzz suite | — |
| 2 | Read `swap-vm` source | — |
| 3 | Instruction + append-only router + quote/swap parity | — |
| 4 | Ship & swap on Base Sepolia | — |
| 5 | TypeScript SDK, byte-verified against Solidity fixtures | — |
| 6 | Subgraph + Subgraph MCP | — |
| 7 | Uniswap v4 hook | — |
| 8 | Competitive routing simulation | — |
| 9 | Console | — |

## Layout

```
contracts/          Foundry project — the kernel, the instruction, the router, the hook
packages/           TypeScript SDK
subgraph/           The Graph subgraph + MCP config
apps/console/       Landing, simulation receipt, live position gauge
FEEDBACK/           Sponsor feedback, written as friction is hit
```

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
