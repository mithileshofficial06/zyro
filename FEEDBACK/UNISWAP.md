# Feedback — Uniswap Foundation (v4 hooks)

Written against `v4-core` and `v4-periphery` as pinned submodules, building
`ZyroSkewHook` — a dynamic-fee hook that ports our inventory-skew kernel onto
v4 as a fee lever.

Context for what follows: the hook is honestly a **port**, not a second instance
of our innovation. The mechanism belongs on 1inch Aqua, where per-maker
inventory is a first-class input. On v4 there is no individual maker, so the
best available analogue is pool-level net flow, and we think being clear about
that is more useful than overclaiming. Several notes below come from working
out exactly where the analogy breaks.

---

## 1. Permission flags live in the address, and that shapes iteration

The flags-in-address design is elegant — the `PoolManager` can check
capabilities with a bitmask and no external call. But it has a development cost
that we don't think is widely advertised: **changing which callbacks a hook
implements changes its address**, so every permission change means re-mining a
CREATE2 salt.

We hit this mid-build. Our hook originally tracked inventory only in
`_afterSwap`, with `afterAddLiquidity`/`afterRemoveLiquidity` disabled. That is
wrong — an LP minting or burning changes the pool's real token0 holdings by an
amount the hook never sees, so the variable we were calling `poolInventoryWad`
actually meant "net swap flow since configuration".

The correct fix (enable both permissions and track their deltas) changed the
address flags and forced a re-mine. The tempting fix was to rename the variable
and document the limitation. We took the correct one, but we want to flag that
the address coupling creates real pressure toward the wrong choice — the cheap
fix is a rename and the right fix is a re-deployment.

**Suggestion:** call this out explicitly in the hooks guide, under a heading
like "changing permissions changes your address". Frame it as a design decision
to make early, because retrofitting a callback is disproportionately expensive.

## 2. `HookMiner` lives in `test/shared/`, which reads as test-only

`HookMiner.sol` is in `v4-periphery/test/shared/`. It is required for *any*
production deployment of *any* hook with permissions, which is nearly all of
them.

Its location strongly implies it is a test utility. We nearly wrote our own
before finding it. Moving it to `src/utils/` — or even just naming it in the
deployment docs with its actual path — would help.

## 3. Return-delta permissions deserve a security warning at the flag

We disabled `beforeSwapReturnDelta` and `afterSwapReturnDelta` deliberately: a
hook that can return an arbitrary delta can take the whole swap, which is a
rug-pull vector, and our fee lever does not need it.

That reasoning came from ecosystem discussion, not from the interface. The
`Hooks.Permissions` struct presents all fourteen flags as peers, and four of
them are categorically more dangerous than the other ten.

**Suggestion:** a `@dev` warning on the return-delta fields in the struct
itself, where someone filling in the boolean will read it. The docs say this;
the type does not, and the type is what you're looking at when you decide.

## 4. Dynamic fees are well designed and under-documented

`LPFeeLibrary.OVERRIDE_FEE_FLAG` is exactly the right primitive: return a fee
from `beforeSwap` with the override bit set and it applies to that swap only,
with no storage write. That made an inventory-responsive fee genuinely cheap.

But we found the mechanism mostly by reading `LPFeeLibrary` and the
`PoolManager` swap path. The pattern deserves a worked example in the docs
that goes end to end: `initialize` with `LPFeeLibrary.DYNAMIC_FEE_FLAG`,
compute in `beforeSwap`, return with the override bit, and — importantly —
what happens if you forget the bit.

## 5. Testing infrastructure is the best we have used

`Deployers`, `PoolSwapTest`, `PoolModifyLiquidityTest` and
`deployMintAndApprove2Currencies` meant our hook's 19 tests run against a
**real** `PoolManager` rather than a mock. For a hook, where every subtlety
lives in the callback contract with the manager, that distinction is the whole
value of the suite. Genuinely excellent, and a high bar other protocols should
be measured against.

Two small things:

- `deployMintAndApprove2Currencies` returning currencies in sorted order rather
  than declaration order is correct and surprising. A comment at the call site
  in the template would save a debugging session.
- `unlock`/callback reentrancy makes stack traces deep. `-vvvv` output for a
  failing hook assertion is long enough to be hard to read. Not a defect, but if
  there is room for a `--hook-trace`-style filter, it would be welcome.

## 6. Where the analogy to per-maker inventory breaks

Offered as design feedback rather than a complaint, since we suspect it is a
recurring question for hook authors.

Avellaneda–Stoikov prices around `q` — a *named maker's* signed inventory
imbalance against *their own* declared target. v4 has no named maker: pool
inventory belongs to all LPs jointly, and they have no shared target. So a hook
can only ever skew on a pool-level aggregate, which is a different quantity with
a different meaning.

Concretely, our v4 hook must track pool-level flow and apply a fee adjustment
symmetric across every LP, including one who just deposited and has no exposure
to the imbalance being priced. On Aqua the same math is exact, because the
position has one owner.

We are not sure there is an action here — it may just be a property of pooled
liquidity. But if v4 ever grows per-position hook state addressable by
`positionKey`, a genuine per-LP inventory model becomes possible, and we think
that would be a significant capability.

## 7. Configuration is permissionless by default, and that is a trap

Our first version let the *first caller* set a pool's parameters permanently,
with no owner and no reconfiguration. Anyone could have front-run with hostile
parameters and locked them in.

Nothing in the hook template or docs pushed us toward that mistake — but nothing
pushed us away from it either, and "the hook has configuration" is an extremely
common shape. A note in the hooks guide about who is allowed to configure a
hook, and the front-running risk of "first caller wins", would be well placed.
Ours is now owner-restricted with reconfiguration allowed, and validates
parameters before storing them.

---

## Summary

| Friction | Cost | Suggested fix |
|---|---|---|
| Permission change ⇒ address change | Medium — pressures you toward the wrong fix | Say so early in the hooks guide |
| `HookMiner` in `test/shared/` | Low — nearly rewrote it | Move to `src/utils/`, or name the path in deploy docs |
| Return-delta flags presented as peers | Potentially high | `@dev` warning on the struct fields |
| Dynamic-fee override under-documented | Medium | An end-to-end worked example |
| Permissionless configuration | High if shipped | A note on configuration authority |

And the counterweight: `Deployers` + `PoolSwapTest` testing against a real
`PoolManager` is the best hook-development experience we have had with any
protocol, and it is why we were confident enough to enable two extra callbacks
and re-mine rather than rename a variable and write a caveat.
