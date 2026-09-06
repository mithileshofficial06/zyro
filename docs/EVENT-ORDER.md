# Aqua's event order, and the two bugs it exposed

Closes the open **⚠ VERIFY** in build spec §20.

The spec left one question unanswered and flagged it as needing a real
transaction to settle:

> ⚠ **VERIFY** that `Pushed`/`Pulled` also fire at swap settlement — confirm
> this against the real on-chain transaction from §25 Phase 4 before trusting
> it.

It does not need a transaction. Both contracts are vendored in this repository
at pinned commits, and the answer is in their source. Reading it there is
strictly better than reading it off a testnet run, because it also settles the
question the spec did *not* flag — the one that was assumed rather than
checked, and assumed backwards.

Both answers falsify an ordering assumption the mappings were built on, and
each produced a bug whose only symptom is wrong data.

---

## 1. `ship()` emits `Shipped` before `Pushed`, not after

`contracts/lib/aqua/src/Aqua.sol`:

```solidity
function ship(address app, bytes calldata strategy, address[] calldata tokens, uint256[] calldata amounts)
    external returns (bytes32 strategyHash)
{
    strategyHash = keccak256(strategy);
    ...
    emit Shipped(msg.sender, app, strategyHash, strategy);   // ← line 45
    for (uint256 i = 0; i < tokens.length; i++) {
        ...
        emit Pushed(msg.sender, app, strategyHash, tokens[i], amounts[i]);  // ← line 50
    }
}
```

`Shipped` at the top, one `Pushed` per token in the funding loop underneath it.
Spec §20 states the reverse:

> `Pushed` may fire *before* `Shipped` within the same `ship()` transaction, so
> buffer early pushes in a small pending entity and drain it when the position
> is created.

The `PendingPush` buffer built on that reading cannot fire against this Aqua at
all. `push()` requires `tokensCount > 0`, which only `ship()` sets, so a push
to a strategy that has not been shipped reverts — there is no such thing as an
early push here.

### What it broke

`handleShipped` drained the buffer and priced the position only if the drain
returned two or more tokens. The drain always returned nothing, so
`refreshPricing` never ran at ship time, and every position published:

```
midWad              = 0
reservationPriceWad = 0
```

…until something happened to trade against it. A solver querying between the
ship and the first fill routed on a mid of zero. Nothing errored, no handler
failed, and the subgraph synced to chainhead in perfect health.

### The fix

The price is published from `handlePushed`/`handlePulled`, where funding and
settlement actually land. `Position.tokens` records the funded pair in push
order and fixes the canonical pricing direction at ship, so a later
reverse-direction fill cannot invert the published series.

The buffer stays, documented as defence for the reverse order. It costs one
store read and it is the difference between silent zero balances and correct
ones if a future Aqua reorders.

---

## 2. `Swapped` is emitted *after* settlement, so "pre-fill" state is post-fill

`contracts/lib/swap-vm/src/SwapVM.sol`, in `_swap`:

```solidity
if (takerTraits.isFirstTransferFromTaker()) {
    _transferIn(ctx, order, takerTraits, takerData, originalAquaBalanceIn);
    _transferOut(ctx, order, takerTraits, takerData);
} else {
    _transferOut(ctx, order, takerTraits, takerData);
    _transferIn(ctx, order, takerTraits, takerData, originalAquaBalanceIn);
}

_reentrancyGuards[orderHash].unlock();
emit Swapped(orderHash, order.maker, msg.sender, tokenIn, tokenOut, amountIn, amountOut);
```

`_transferIn` and `_transferOut` call `AQUA.push` and `AQUA.pull`, and both of
those emit. So **yes** — `Pushed`/`Pulled` do fire at settlement, which is the
question §20 asked. The mapping was right to let those handlers own the balance
ledger and right not to touch balances in `handleSwapped`.

But the emission order is the part that matters, and it is the opposite of what
`handleSwapped` needed:

```
Pushed(tokenIn,  +amountIn)     ← settlement
Pulled(tokenOut, -amountOut)    ← settlement
Swapped(...)                    ← last
```

### What it broke

`handleSwapped` read the store for what it labelled "pre-fill state, captured
first". By the time it ran, `handlePushed` and `handlePulled` had already
applied the fill's deltas. So `midWadAtFill` and `reservationPriceWadAtFill`
stored **post-fill** values under pre-fill names.

Spec §20's CORRECTION 7 identified exactly this hazard —

> The previous build wrote `fill.midWadAtFill` *after* mutating balances with
> that same fill — storing the post-fill mid under a pre-fill name. This is the
> number behind your headline demo chart.

— and the fix it prescribed (read the store before touching balances) does not
work, because another handler has already touched them.

The visible consequence: the headline chart plots mid against reservation price
across a fill series. With post-fill values the two lines still separate and
still look correct. They are simply shifted one fill to the left, and the first
point — the balanced one, where the two lines must coincide exactly — no longer
does.

### The fix

`preFillBalance` reconstructs the pre-fill state by undoing the fill's own
deltas:

```
pre(token) = current(token)
           − amountIn   if token is the fill's tokenIn
           + amountOut  if token is the fill's tokenOut
```

Exact, because settlement moves precisely the amounts the event reports.
Written per-token rather than per-side so it stays correct whichever way round
the fill ran relative to the canonical direction.

---

## Why these survived review

The mappings had **no handler tests**. `tests/kernel.test.ts` covered the
arithmetic, `tests/helpers/events.ts` had been written to build mock events —
and was never imported by anything.

Both bugs are also invisible to the class of test that would have been written
without knowing the answer. A handler test that emits `Pushed` before `Shipped`
because the spec says so passes against the buggy code and fails against the
correct code.

So the tests added alongside the fix replay the order the contracts actually
emit, and `ZyroLensTest.test_AgainstTheRealAqua_ShipResolvesUnderTheOrderHash`
pins it with `vm.recordLogs` against a real `Aqua` deployment:

```solidity
assertEq(logs.length, 3, "one Shipped and two Pushed");
assertEq(logs[0].topics[0], keccak256("Shipped(address,address,bytes32,bytes)"));
assertEq(logs[1].topics[0], keccak256("Pushed(address,address,bytes32,address,uint256)"));
assertEq(logs[2].topics[0], keccak256("Pushed(address,address,bytes32,address,uint256)"));
```

If a future Aqua bump changes the order, that test fails in CI rather than the
subgraph quietly publishing zeros.

---

## Both failure modes look identical from outside

This is the through-line. Neither bug throws, logs, or fails a health check.
One publishes zeros until the first trade; the other publishes numbers that are
off by one fill. A subgraph exhibiting either syncs to chainhead and reports
itself healthy.

That is why `scripts/verify-subgraph.mjs` and the console's *Index vs chain*
panel exist, and why `ZyroLens` was written to make the comparison direct
rather than inferred from `quote()`. "Live and indexing" would have been true
of the broken build in both cases.

## References

| Claim | Source |
|---|---|
| `Shipped` precedes `Pushed` in `ship()` | `contracts/lib/aqua/src/Aqua.sol:45-51` |
| `push()` reverts on an unshipped strategy | `contracts/lib/aqua/src/Aqua.sol:72-80` |
| Settlement precedes `Swapped` | `contracts/lib/swap-vm/src/SwapVM.sol:203-214` |
| `push`/`pull` emit | `contracts/lib/aqua/src/Aqua.sol:63-80` |
| Pinned by a test against real Aqua | `contracts/test/ZyroLens.t.sol` |
| Pinned by handler tests | `subgraph/tests/handlers.test.ts` |
