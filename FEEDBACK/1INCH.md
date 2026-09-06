# Feedback — 1inch (SwapVM / Aqua)

Written against `1inch/swap-vm` `v1.0.2` (`32c687c2`) and `1inch/aqua` `v1.0.0`
(`81c26e46`), both used unmodified as submodules.

Everything below is friction we actually hit, with the file and line that
resolved it. We've tried to be specific about *how each one failed*, because in
every case the failure was silent — the wrong answer, not an error.

---

## 1. `AquaOpcodes._opcodes()` returns a 35-element array holding 34 opcodes

This is the single most expensive thing we hit, and it is invisible from the
source unless you read the assembly.

`AquaOpcodes.sol:32` declares a **fixed `[35]` array**, populates it, and then
rewrites the length word:

```solidity
assembly ("memory-safe") {
    mstore(result, instructionsArrayLength)   // 34
}
```

In memory a dynamic array is a length word followed by its elements, so
`mstore(result, 34)` **overwrites element 0** and shifts the whole table by one.
The consequence is that `result[i] == instructions[i + 1]` — every opcode index
a reader derives by counting declarations in the source is off by one.

**Why it cost us so much:** the failure is not a revert. Dispatching opcode `i`
runs instruction `i+1`, which is a valid instruction with a valid argument
layout, so a program built against a naive reading executes and returns a
plausible number. We only caught it by quoting an identical stock-only program
on a real `AquaSwapVMRouter` and on ours and requiring byte-identical results.

**What would have helped:** a comment at the `mstore`, or a public constant
naming the opcode of each stock instruction. One line either way.

## 2. There is no opcode "bank" or reserved address space

We had assumed, from reading around the ecosystem, that opcodes were allocated
in family banks with unallocated ranges — and specifically that `0x92` was free.

There is no `OpcodeList.sol`, no `Opcode` enum, and no bank. The table is a
dense array of 34 entries, so the valid opcodes are `0..33` and the next free
index is `34`. `0x92` is 146: an out-of-bounds array access and a panic, not a
reserved slot.

Not a defect — but a short note in the README on how third parties should pick
an opcode would save everyone this.

## 3. `Aqua.ship()` emits `Shipped` *before* `Pushed`, and it matters downstream

`Aqua.sol:45` emits `Shipped`, then the funding loop below it emits one `Pushed`
per token at `Aqua.sol:50`.

We built an indexer on the opposite assumption — that a push could arrive before
the position existed — and buffered early pushes to drain on `Shipped`. The
buffer can never fire (`push()` reverts on an unshipped strategy,
`Aqua.sol:74`), so our positions were priced from zero balances and published a
reservation price of `0` until something happened to trade against them.

The subgraph synced to chainhead, reported no errors, and indexed silence.

## 4. `Pushed`/`Pulled` fire at swap settlement, *before* `Swapped`

This one is a genuine composition hazard for anyone indexing Aqua.

`SwapVM._swap` settles and then emits: `_transferIn`/`_transferOut` call
`AQUA.push`/`AQUA.pull` (which emit at `Aqua.sol:78` and `:68`), and only
afterwards does `emit Swapped` run at `SwapVM.sol:214`.

So within one transaction the log order is:

```
Pushed(tokenIn,  +amountIn)
Pulled(tokenOut, -amountOut)
Swapped(...)
```

Any handler that reads accumulated balances when processing `Swapped` — to
record the state a fill executed against — gets **post-fill** balances. We were
storing the post-fill mid under a pre-fill name in the exact series our headline
chart plots. It rendered perfectly and was wrong.

**Suggestion:** document the intra-transaction log order in the Aqua README.
It is not inferable from either contract in isolation, it is load-bearing for
every indexer, and it is the kind of thing that produces confidently wrong
dashboards rather than broken ones.

## 5. Aqua's custody model is the best thing here and is undersold

`ship()` moves **no tokens**. It writes a number into a mapping annotated
`// aka makers' allowances` (`Aqua.sol:24`). The only two transfers in the whole
contract are in `push` and `pull`, at settlement, and they move tokens
maker ↔ taker directly.

This is precisely what made our project possible. Avellaneda–Stoikov needs `q`,
a *named maker's* signed inventory imbalance against *their own* target. A pool
AMM's inventory belongs to everybody, so there is no individual to be away from
a target and no `q` to price against. Aqua gives every position an owner, and
`SwapVM._swap` pre-loads that owner's live balance into `ctx.swap` from
`AQUA.safeBalances` **before dispatching any instruction** — so the number is
already in a register when our opcode runs.

We'd lead with this framing. "Shared liquidity layer" undersells it; the
property that matters is that per-maker inventory is a first-class, readable
input at execution time. That is a capability, not a plumbing detail.

## 6. `order.data` is `hooksData ++ program`, and the offset is packed in traits

We had it documented internally as `tokenA(20) ++ tokenB(20) ++ program`. It is
not. `MakerTraitsLib.build` shows `order.data` is `hooksData ++ program`, with
the program's start offset in bits **[208, 224)** of the traits word.

Slicing at a fixed 40 bytes reads 38 bytes of instruction arguments as two
addresses and then mis-parses everything after — silently, because the opcode
walk still finds plausible `opcode ++ length` pairs in the remainder.

A one-line comment on the `Order.data` field naming its layout would close this.

## 7. Extending the instruction set is genuinely clean

Credit where it's due. `_opcodes()` being `internal pure virtual` with the
comment *"Add new instructions here to maintain backward compatibility"* meant
we could take the stock array from `super`, copy it positionally, and append —
no fork, no patched submodule, `lib/swap-vm` byte-for-byte official.

Better still, the property is *structural* rather than a promise: preserving
every stock opcode's index is a copy loop, so it can be proved rather than
asserted. Our `ZyroRouter.t.sol` quotes an identical stock-only program on a
real `AquaSwapVMRouter` and on ours and requires exact equality.

We'd like to see this pattern documented as the supported extension path. It is
much better than the "fork and patch" most VMs leave you with.

## 8. Minor: `EIP-170` headroom is thin

`ZyroRouter` — a stock `AquaSwapVMRouter` plus exactly one instruction —
measures 22,130 bytes against the 24,576 limit. That is 2,446 bytes for one
opcode's worth of arithmetic.

We ended up moving our read-only lens into a separate contract for this reason,
which is fine. But anyone adding two or three instructions under v4-core's
optimizer profile will hit the limit, and it's worth saying so up front.

---

## Summary

| Friction | Cost | Fix |
|---|---|---|
| Opcode table shifted by an `mstore` | High — silently runs the wrong instruction | One comment at `AquaOpcodes.sol:32` |
| No documented opcode allocation | Medium — we targeted an out-of-bounds index | A README note |
| `Shipped` before `Pushed` | High — indexer published zeros, no error | Document the order |
| Settlement emits before `Swapped` | High — confidently wrong chart | Document intra-tx log order |
| `order.data` layout | Medium — silent mis-parse | Comment on the field |

Nothing here is a bug in Aqua or SwapVM. Every item is a place where the source
is correct and the *reading order* is not obvious, and where getting it wrong
produces a plausible number instead of an error. That combination is what made
each of them expensive.
