# Phase 2 — source verification

`ZYRO_BUILD_SPEC.md` §15 marks a set of assumptions **⚠ VERIFY** and says: *"Read
these files yourself. Do not take this document's word for them."*

Done. Pinned versions:

| Dependency | Pin |
|---|---|
| `1inch/swap-vm` | `v1.0.2` @ `32c687c2b73101fc26549e48fa1ff8a4d73afbac` |
| `1inch/aqua` | `v1.0.0` @ `81c26e4619ce21556ab02b3284ee2685de21fb18` |

**Four of the six §15 assumptions are wrong at these versions**, and two of them
invalidate the contract design in Part C. Corrected design below.

---

## Summary

| # | §15 assumption | Verdict |
|---|---|---|
| 1 | `swap-vm/src/libs/VM.sol` — `Context`/`SwapRegisters` shape, `isStaticContext` | ⚠ mostly confirmed |
| 2 | `swap-vm/src/libs/OpcodeList.sol` — `0x92` unallocated in balance-tuning bank | ❌ **file does not exist; no such bank** |
| 3 | `swap-vm/src/opcodes/AquaOpcodes.sol` — `_runOpcode` is `internal virtual` | ❌ **no such function** |
| 4 | `swap-vm/src/instructions/XYCSwap.sol` — stock instruction shape | ✅ confirmed |
| 5 | `swap-vm/src/instructions/DutchAuction.sol` — balance-tuning pattern | ✅ confirmed |
| 6 | `swap-vm/src/libs/MemoryPtr.sol` — `push`/`patchLength`/`resolve` | ❌ **file does not exist** |

Separately, the three load-bearing claims in §14 that the mechanism actually
depends on all **hold**:

- ✅ There is no shared price register — the curve *is* a balance pair.
- ✅ Live inventory needs no accessor: `AQUA.safeBalances()` is read into
  `ctx.swap` **before** any instruction runs.
- ✅ `isStaticContext` really does differ between `quote()` and `swap()`, so the
  quote/swap parity risk §17 is built around is real.

---

## 1. `Context` and `SwapRegisters` — ⚠ mostly confirmed

`lib/swap-vm/src/libs/VM.sol:48`

```solidity
struct SwapRegisters {
    uint256 balanceIn;
    uint256 balanceOut;
    uint256 amountIn;
    uint256 amountOut;
    uint256 amountNetPulled;   // <- the spec says there are only four
}
```

§14 correction 1 states `SwapRegisters` is *"exactly `{balanceIn, balanceOut,
amountIn, amountOut}`"*. There is a fifth field, `amountNetPulled`, used for fee
accounting in `SwapVM._transferIn`. Zyro does not touch it.

The substance of correction 1 is intact and is the reason the design works:
**there is no price register.** Confirmed at `VM.sol:19` — `VM` holds
`isStaticContext`, `nextPC`, two calldata pointers and the opcode table, and
nothing price-shaped.

`isStaticContext` lives at `ctx.vm.isStaticContext` (`VM.sol:20`), exactly where
§17 says. `SwapVM.quote()` sets it `true` (`SwapVM.sol:124`), `SwapVM.swap()`
sets it `false` (`SwapVM.sol:170`).

## 2. There is no opcode enum, no family bank, and `0x92` is not reachable — ❌

`swap-vm/src/libs/OpcodeList.sol` **does not exist**. There is no `Opcode` enum
anywhere in the tree, no "balance-tuning family bank `0x90–0xAF`", and no
256-slot dispatch table.

What actually exists: the opcode table is a **dense array of internal function
pointers**, dispatched by index (`libs/VM.sol:130`):

```solidity
ctx.vm.opcodes[opcode](ctx, args);
```

`opcodes` is typed `function(Context memory, bytes calldata) internal[]`
(`VM.sol:24`) and is built by `AquaOpcodes._opcodes()`
(`opcodes/AquaOpcodes.sol:32`).

**The Aqua instruction set has 34 entries, so the only valid opcodes are
`0..33`.** `0x92` is 146. `ctx.vm.opcodes[146]` reverts with an array
out-of-bounds panic — it is not a "reserved-but-unallocated slot", it is off the
end of the array.

### The array is off by one, and that matters for picking an opcode

`_opcodes()` declares a **fixed** `[35]` array and then rewrites its head:

```solidity
uint256 instructionsArrayLength = instructions.length - 1;   // 34
assembly ("memory-safe") {
    result := instructions
    mstore(result, instructionsArrayLength)
}
```

A fixed-size memory array has no length prefix; a dynamic one is a pointer to a
length word followed by elements. So `mstore(result, 34)` **overwrites element
0** (a `_notInstruction` placeholder, deliberately sacrificed) with the length.

Therefore `result[i] == instructions[i + 1]`. The effective Aqua opcode map is:

| Opcode | Instruction |
|---|---|
| `0`–`9` | `_notInstruction` (reserved) |
| `10`–`16` | `Controls._jump` … `_onlyTakerTokenSupplyShareGte` |
| `17` | `XYCSwap._xycSwapXD` |
| `18` | `XYCConcentrate._xycConcentrateGrowLiquidity2D` |
| `19` | `Decay._decayXD` |
| `20` | `Controls._salt` |
| `21` | `Fee._flatFeeAmountInXD` |
| `22`–`26` | `_notInstruction` (reserved) |
| `27`–`30` | `Fee` protocol-fee instructions |
| `31` | `PeggedSwap._peggedSwapGrowPriceRange2D` |
| `32` | `Extruction._extruction` |
| `33` | `Controls._onlyTxOriginTokenBalanceNonZero` |

**Zyro's opcode is therefore `34` (`0x22`), the next free index** — not `0x92`.

The 2-byte `opcode ++ argsLength` header the spec describes *is* real
(`VM.sol:124-125`), and `argsLength` is a single byte, so the 255-byte
per-instruction limit holds. Zyro's 121-byte argument block is fine.

## 3. There is no `_runOpcode` — ❌, and the real extension point is better

§12 builds the headline correctness argument on overriding

```solidity
function _runOpcode(Context memory ctx, uint256 opcode, bytes calldata args) internal override
```

**No such function exists in swap-vm v1.0.2.** There is no dispatcher method to
override; dispatch is the array indexing at `VM.sol:130`.

The genuine extension points, both `virtual` and both explicitly documented as
extension points in the upstream source:

- `SwapVM._instructions()` (`SwapVM.sol:293`) — *"Override this function in
  router to provide supported instruction list"*
- `AquaOpcodes._opcodes()` (`AquaOpcodes.sol:32`) — `internal pure virtual`,
  carrying the comment *"NOTE: Add new instructions here to maintain backward
  compatibility"*

### The corrected append-only design

Override `_opcodes()`, take the stock array from `super`, and append:

```solidity
function _opcodes() internal pure override
    returns (function(Context memory, bytes calldata) internal[] memory result)
{
    function(Context memory, bytes calldata) internal[] memory stock = super._opcodes();
    result = new function(Context memory, bytes calldata) internal[](stock.length + 1);
    for (uint256 i = 0; i < stock.length; ++i) result[i] = stock[i];
    result[stock.length] = _zyroInventorySkew;   // opcode 34
}
```

This is a **stronger** correctness argument than the one the spec proposed, not
a weaker one. Under `_runOpcode` the claim "no stock opcode's index or behaviour
is touched" is an argument about control flow. Here it is a copy loop: the stock
entries are carried over positionally from `super._opcodes()`, so preserving
every stock index is structural rather than argued. The submodule stays
byte-for-byte official either way.

§16's append-only test is unchanged and still the thing that proves it: an
identical stock-only program must quote byte-identically on a real
`AquaSwapVMRouter` and on `ZyroRouter`.

## 4–5. Instruction shape — ✅ confirmed

`DutchAuction` (`instructions/DutchAuction.sol`) is exactly the balance-tuning
pattern §11 describes, and is the right thing to mirror:

- a `…ArgsBuilder` **library** with `build()` / `parse()`, each field extracted
  with a named error selector so a malformed program reverts diagnosably;
- a **contract** carrying the instruction as `internal view`, which mutates
  `ctx.swap.balanceIn` / `ctx.swap.balanceOut` and does nothing else.

Note the stock instructions are **contracts**, not libraries — the opcode array
holds pointers to `internal` functions on the inherited mixins. §9 calls for a
`library`; Zyro follows the stock shape instead (library for args, contract for
the instruction) so that `_zyroInventorySkew` can be referenced the same way
every stock entry is.

`XYCSwap._xycSwapXD` (`instructions/XYCSwap.sol:17`) is `internal pure`, takes no
args, and reads `balanceIn`/`balanceOut` to compute the missing amount. It is the
curve instruction Zyro must run **before**. Neither it nor `DutchAuction` reads
`isStaticContext` — the stock code holds the discipline §17 demands of Zyro.

## 6. There is no `MemoryPtr` — ❌, and the concern it raised is moot

`swap-vm/src/libs/MemoryPtr.sol` **does not exist**, and neither does
`InstructionBuilder`. §11 worries that `InstructionBuilder.pushHeader` only
accepts the stock `Opcode` enum and so cannot express a custom opcode without
editing the submodule. There is no enum and no builder, so there is nothing to
work around.

Stock instructions build their argument blocks with plain `abi.encodePacked`
(`DutchAuction.sol:32`) and parse them with `Calldata.slice` from
`@1inch/solidity-utils`. Zyro does the same.

---

## Consequences for the build

1. **Opcode `34` (`0x22`)**, not `0x92`. Wire format and the 2-byte header are
   otherwise unchanged.
2. **`ZyroRouter` overrides `_opcodes()`**, not `_runOpcode`, and appends by
   copying `super._opcodes()`.
3. **`ZyroInstructions.sol` ships a library + a contract**, mirroring
   `DutchAuction`, rather than a single library.
4. **`MemoryPtrLib` is not used**; args are `abi.encodePacked` / `Calldata.slice`.
5. The pricing kernel is untouched by all of this — which is the point of having
   built it first, with no VM dependency.
