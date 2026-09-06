# Sponsor tracks and the upstream sources behind them

Zyro targets three sponsor tracks. This file records which upstream repository
each deliverable is built against, what that source actually provided, and — where
it matters — where the source contradicted the build spec.

The rule for every entry: **read the source, don't trust the summary.** Four of
six assumptions in `ZYRO_BUILD_SPEC.md` §15 were wrong at the pinned versions,
and two of them would have produced a router that silently broke stock
instructions.

---

## 1inch — the lead track

| Source | Used for | Verified in |
|---|---|---|
| [`1inch/swap-vm`](https://github.com/1inch/swap-vm) `v1.0.2` | The VM Zyro's instruction runs inside; the opcode table it appends to | [`PHASE2-SOURCE-VERIFICATION.md`](PHASE2-SOURCE-VERIFICATION.md) |
| [`1inch/aqua`](https://github.com/1inch/aqua) `v1.0.0` | `safeBalances` — the live per-maker inventory the whole mechanism needs | same |
| [`1inch/sdks`](https://github.com/1inch/sdks) `typescript/swap-vm` | Independent confirmation of the opcode map; order/traits encoding | [`UPSTREAM-SDK-VERIFICATION.md`](UPSTREAM-SDK-VERIFICATION.md) |
| [`1inch/sdks`](https://github.com/1inch/sdks) `typescript/aqua` | `ship`/`dock` calldata shape, event signatures, strategy-hash derivation | same |

**What the sources changed.** The spec's contract design in Part C could not be
built as written:

- Opcode `0x92` is unreachable — dispatch is a dense 34-entry array, so `0x92`
  (146) is an out-of-bounds panic, not a reserved slot in a family bank. Zyro's
  opcode is **34**.
- `_runOpcode` does not exist. The real extension point is `_opcodes()`, and
  appending to a positional copy of `super._opcodes()` makes the append-only
  property a copy loop rather than an argument.
- `order.data` is `hooksData ++ program`, not `tokenA ++ tokenB ++ program`.

The opcode map now has **three independent confirmations**: the Solidity, 1inch's
own TypeScript SDK, and a live test against a real `AquaSwapVMRouter`.

**Note on packaging.** `@1inch/swap-vm` and `@1inch/aqua` are not published to
npm and carry a non-OSS licence, so `packages/strategy-sdk` cannot depend on
them. It stays zero-dependency and proves correctness by byte-equality against
fixtures generated from a live `forge test` run — a stronger check than API
compatibility would have been.

---

## Uniswap Foundation

| Source | Used for |
|---|---|
| [`Uniswap/uniswap-ai`](https://github.com/Uniswap/uniswap-ai) — `uniswap-hooks` plugin | Security requirements for `ZyroSkewHook` |
| `Uniswap/v4-core`, `Uniswap/v4-periphery` | `PoolManager`, `BaseHook`, `HookMiner` |

The `v4-security-foundations` skill is the design brief for the hook, not
background reading. Concretely, it sets these constraints:

- **Every callback verifies `msg.sender == poolManager`.** In a hook `msg.sender`
  is *always* the PoolManager, never the user, so it is useless for identity and
  essential for access control.
- **`beforeSwapReturnDelta` stays `false`.** It is the NoOp rug-pull vector: a
  hook can claim it handled the whole swap, keep the input and return nothing.
  Zyro does not need it — a dynamic fee is `beforeSwap`'s third return value
  (`uint24`), not a delta. Enabling it would add the single highest-risk
  permission for no benefit.
- **Start with every permission `false`** and enable only what is used. Zyro
  needs `beforeSwap` (the fee lever), `afterSwap` and the two liquidity
  callbacks (Correction 5 — the hook's inventory counter is wrong if it cannot
  see LP mints and burns).
- **`beforeSwap` gas budget < 50,000**, since it runs on every swap. Zyro's
  hook path uses `halfSpreadWad` and `softBoundPenaltyBps` only — no loops, no
  `sqrt`, no external calls beyond one `getSlot0`.
- **Fuzz and invariant testing required**; a hook with `beforeSwap` enabled is
  in the "professional audit recommended" band.

The skill also flags `v4-periphery/src/base/hooks/BaseHook.sol` as the import
path, which differs from the `src/utils/BaseHook.sol` path the build spec warns
about. Resolved against the installed submodule rather than either document.

---

## The Graph

| Source | Used for |
|---|---|
| [`graphprotocol/subgraphs-skills`](https://github.com/graphprotocol/subgraphs-skills) | Schema design, manifest, AssemblyScript handler patterns |
| [`streamingfast/substreams-skills`](https://github.com/streamingfast/substreams-skills) | Substreams module structure (Rust) |
| [`pinax-network/substreams-evm`](https://github.com/pinax-network/substreams-evm) | Pre-built EVM/DEX Substreams modules, incl. `uniswap-v4` |
| [`streamingfast/substreams-chain-modules`](https://github.com/streamingfast/substreams-chain-modules) | Higher-level DEX/stablecoin datasets |

The routability problem the subgraph solves: Zyro's liquidity is order-based and
distributed across individual makers. There is no pool contract holding reserves,
so a router cannot read a reserve to price a Zyro position — it would have to
re-derive the entire Avellaneda–Stoikov calculation itself. The subgraph re-runs
that math in AssemblyScript so a solver can query the current reservation price
directly.

**What the sources changed.** Two things the subgraph must get right, both
confirmed against `IAqua.sol` and the Aqua SDK:

- **No parameter on `Shipped`, `Docked`, `Pushed` or `Pulled` is `indexed`.**
  Every field lives in the data blob. A handler expecting `maker` or `app` in
  `topics` reads the wrong bytes and does not error.
- **Position balances come from `Pushed`/`Pulled`,** the authoritative
  per-strategy ledger — not from accumulating `Swapped` deltas on top of zero,
  which is what the previous build did and why every published reservation price
  was computed from deltas rather than balances.

Substreams is a live option for this track and the modules above cover EVM DEX
data, but it requires a Rust toolchain that is not installed on this machine. The
subgraph path needs only AssemblyScript. Recorded here as a deliberate choice,
not an oversight.

---

## Cross-cutting

`1inch/sdks` also ships `typescript/sdk-core` and `@1inch/byte-utils`, which *are*
on npm. They are not used: `strategy-sdk`'s value is that it has no dependencies
and is checked against the Solidity byte-for-byte.
