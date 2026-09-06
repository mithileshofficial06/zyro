# ZYRO — BUILD SPECIFICATION

**Inventory-aware dynamic liquidity · ETHOnline 2026**
**Sponsors:** 1inch · The Graph · Uniswap Foundation
**Document type:** implementation specification — build from this
**Companion:** `ZYRO_PROJECT_REPORT.md` (narrative, pitch, judge-facing)

---

## 0. HOW TO USE THIS DOCUMENT

This is not a report. It is the thing you build from.

Every known defect from the previous build is already **corrected in the
specification below** rather than described as a problem. If you implement
what this document says, you do not reintroduce them. Sections marked
**⚠ VERIFY** contain assumptions that must be checked against real
dependency source before you write the code that depends on them.

Read in this order:

1. §14 — the five corrections that cost the previous build a full redesign
2. §15 — what to read in `swap-vm` before writing a single line
3. Part B — the math, which you can implement and test immediately
4. Everything else, in build order (§25)

**Do not read Part C before Part D.** The contract designs only make sense
once you know why they are shaped that way.

---

# PART A — WHAT YOU ARE BUILDING

## 1. The mechanism, in one page

A market maker earns spread on every fill and can still lose money, because
one-directional flow forces them to accumulate an asset that is falling. The
standard fix is from Avellaneda & Stoikov (2008): instead of quoting around
the market mid, quote around your **reservation price** — the price at which
*you*, given what you currently hold, are indifferent to trading.

```
r = s − q·γ·σ²·(T−t)
```

Hold too much (`q > 0`) and `r` falls below mid, making it expensive to sell
you more and cheap to buy some off you. Hold too little and the reverse. At
exactly target (`q = 0`) the skew term is zero and the system degrades
into an ordinary constant-product AMM — a property of the formula, not a
special case in code.

This has never worked on-chain because a pool AMM's inventory belongs to
everybody. There is no individual maker with a target to be away from, so
there is no `q`. **1inch Aqua changes that**: a maker's tokens never leave
their wallet, and `aqua.safeBalances(maker, app, strategyHash, tokenIn,
tokenOut)` returns that maker's real live balance at quote time. `q` is one
subtraction away from a number no pool AMM exposes.

Zyro is a native SwapVM instruction that reads it and re-centres the pricing
curve around `r`.

## 2. Why Aqua is load-bearing

This is the pitch, and it must stay narrow to stay defensible.

**Do not claim:** "we invented inventory-aware market making."
**Do claim:** "this technique has been standard on professional desks since
2008. It required an input no on-chain venue exposed. Aqua exposes it. Here
is the implementation, running as a native instruction inside 1inch's own
execution engine."

## 3. Scope

**In scope for v1:**

| Component | Deliverable |
|---|---|
| Pricing kernel | Pure Solidity library, fuzz-tested, no VM dependency |
| SwapVM instruction | Real opcode `0x92`, one atomic instruction |
| Aqua router | Provably additive over the stock router |
| Uniswap v4 hook | Same kernel, dynamic-fee lever — *a port, not a second innovation* |
| Off-chain SDK | TypeScript, byte-verified against Solidity fixtures |
| Subgraph | Live reservation-price mirror + Subgraph MCP |
| Simulation | Competitive routing benchmark (§21–24) |
| Console | Landing, receipt, position gauge |

**Explicitly out of scope for v1** — resist all of these:

- Inventory velocity / EMA trajectory tracking (see §29)
- Defensive state machines, hysteresis, hard-protect modes
- Any persistent per-strategy mutable state in the instruction
- LLM agents, bridges, leverage, lending, governance tokens
- Any sponsor integration that isn't load-bearing

---

# PART B — THE MATH

Implement this part first. It has no dependencies, needs no VM, and can be
fully fuzz-tested before you have fetched a single submodule.

## 4. The pricing kernel

Fixed-point convention: everything suffixed `Wad` is 18-decimal fixed point,
`WAD = 1e18`. All amount-shaped values assume an 18-decimal token, matching
SwapVM's own registers.

**Reservation price**

```
r = s − q·γ·σ²·(T−t)

  s        mid price, implied by the live balance pair
  q        signed inventory imbalance = balanceIn − targetInventoryWad
  γ        risk aversion
  σ²       variance estimate
  (T−t)    seconds remaining in the horizon, floored at zero
```

**Half-spread**

```
δ = δ₀ + γ·σ²·(T−t)
```

`δ₀` is a maker-declared base spread. This is a **disclosed simplification**:
full Avellaneda–Stoikov's spread term includes a `κ`-dependent order-arrival
component requiring a live limit-order-book feed you do not have. The
*reservation-price* term — the actually novel part — is implemented in full.
State this simplification openly; it is not a weakness, and hiding it would
be.

Because `ln`/`exp` are no longer on the hot path, use plain `int256`/`uint256`
WAD arithmetic. Do not pull in PRBMath.

**Mid from balances**

```
s = balanceOut · WAD / balanceIn      (tokenOut per tokenIn)
```

**Side selection**

The instruction always adds to `balanceIn` (the taker gives tokenIn), so:

```
q ≥ 0  →  exposed side  →  effective price = r − δ   (worse for the taker)
q < 0  →  covered side  →  effective price = r + δ   (better for the taker)
```

This is Avellaneda–Stoikov's bid/ask asymmetry, expressed as which side of
`r` this call's direction lands on. Clamp the effective price at a minimum of
`1` — never quote a non-positive price.

## 5. Parameter validation ⚠ **CORRECTED**

> **This section fixes the most serious defect in the previous build.**

`Params` types `γ` and `σ²` as `int256`, and the wire format packs them as
`int128`. A negative value is representable end to end. Feed one in and
`r = mid − skew` becomes `r = mid + skew`: **the position quotes better
prices the further it drifts from target, paying takers to worsen its own
inventory.**

Every other failure mode in this system fails safely. This one fails
*profitably for whoever noticed*. And the test suite cannot catch it — every
invariant holds under sign inversion, because they all fuzz `γ` and `σ²` over
non-negative ranges only. **The bound that makes the tests pass is the bound
that hides the bug.**

Implement `validate(Params)` in the kernel library and call it from **both**
consumers — the instruction on every `exec`, the hook once at configuration:

```
gammaWad       ∈ [0, 1e18]
sigmaSqWad     ∈ [0, 1e18]
baseSpreadWad  ∈ [0, 1e18]      // 1 WAD = 100% of mid; at or above that
                                 // the exposed side quotes non-positive
horizonSecs    ≤ 365 days
```

Use distinct named errors per failure (`NegativeGamma`, `GammaTooLarge`, …)
so a maker gets a diagnosable revert rather than a bare panic.

The upper bounds exist to keep intermediate products inside `int256`, not to
express an opinion about market making. With `γ` and `σ²` both at cap and a
year-long horizon, the widest term stays below ~1e38 for any inventory an
18-decimal token can express — roughly 38 orders of magnitude of headroom.

**You must also write the test that proves this**, or you will not know the
call is missing:

```
test_NegativeGamma_Reverts()
test_NegativeSigmaSq_Reverts()
testFuzz_ReservationPrice_NeverRewardsDrift()   // over signed γ, σ²
```

## 6. The soft bound

A maker declares a bound — "I never want to be more than N tokens from
target." Rather than reverting at that line, apply a penalty ramping
**linearly from 0 to 500 bps** as `|q|/bound` goes 0 → 1, then clamping.

```
penaltyBps = min(500, |q| · 500 / |bound|)
```

Apply it **only to exposed-side flow.** Covered-side flow never pays it —
that is exactly the flow the position wants to attract as it nears its bound.

**Design rule, and it governs the whole project:** a hard revert at a
boundary is a discontinuity, and discontinuities are hostile to the automated
solvers that route order flow — they receive a successful quote and then a
reverting execution. A continuous ramp is always routable. Keep this rule in
mind when you are tempted by state machines and hard-protect modes later.

## 7. Curve re-centering

SwapVM has no price variable. Its curve *is* a pair of balances. Convert the
target price back into a balance pair while preserving depth:

```
k             = balanceIn · balanceOut          // depth, held constant
newBalanceIn  = sqrt(k · WAD / price)
newBalanceOut = k / newBalanceIn
```

The implied price of the new pair is the target, and `k` is unchanged. **The
curve is rotated, not reshaped** — traders see the same depth, quoted around
`r` instead of raw mid. Guard `price <= 0` and `newBalanceIn == 0` by
returning the inputs unchanged.

## 8. Composition order

One atomic transform, in this order:

```
1. mid   ← implied by the live (balanceIn, balanceOut) pair
2. r     ← reservationPrice(mid, q, params, elapsed)
3. δ     ← halfSpread(params, elapsed), floored at 0
4. side  ← q ≥ 0 ? exposed : covered
5. price ← exposed ? r − δ : r + δ,  floored at 1
6. (newIn, newOut) ← recenter(balanceIn, balanceOut, price)
7. if exposed: newOut −= newOut · penaltyBps / 10_000
```

---

# PART C — THE CONTRACTS

## 9. File layout

```
contracts/
  src/
    libs/AvellanedaStoikov.sol          # the kernel — pure, no deps
    instructions/ZyroInstructions.sol   # ZyroInventorySkew, opcode 0x92
    routers/ZyroRouter.sol              # append-only over AquaSwapVMRouter
    uniswap/ZyroSkewHook.sol            # same kernel, v4 dynamic-fee lever
  test/
    AvellanedaStoikov.t.sol
    ZyroRouter.t.sol
    QuoteSwapParity.t.sol               # the most important file here
    ZyroSkewHook.t.sol
    EncodingFixtures.t.sol
    helpers/ZyroTestBase.sol
  script/
    CompetitiveFlow.s.sol               # the benchmark (§22)
    DeployAquaRouter.s.sol
    DeployZyroSkewHook.s.sol
    NetworkConfig.sol
```

Only four source files are yours. Keep it that way — the value is in
placement and rigour, not volume.

## 10. `AvellanedaStoikov.sol` — the kernel

Pure functions. Imports nothing but OpenZeppelin's `Math`. No storage, no
external calls, no VM dependency.

Isolated deliberately so it can be fuzzed exhaustively without deploying
anything, and so both venues share it unmodified. **One kernel, two venues** —
true at the level of code reuse, and you should say exactly that and no more
(see §13).

Required surface:

```solidity
struct Params { int256 gammaWad; int256 sigmaSqWad; int256 baseSpreadWad; uint256 horizonSecs; }

function validate(Params memory p) internal pure;                    // §5
function remaining(Params memory p, uint256 elapsed) internal pure returns (uint256);
function reservationPriceWad(int256 mid, int256 q, Params memory p, uint256 elapsed) internal pure returns (int256);
function halfSpreadWad(Params memory p, uint256 elapsed) internal pure returns (int256);
function softBoundPenaltyBps(int256 q, int256 bound) internal pure returns (uint256);
function midFromBalancesWad(uint256 balanceIn, uint256 balanceOut) internal pure returns (int256);
function recenterBalances(uint256 balanceIn, uint256 balanceOut, int256 price) internal pure returns (uint256, uint256);
function applyInventorySkew(uint256 balanceIn, uint256 balanceOut, int256 q, Params memory p, uint256 elapsed, int256 bound) internal pure returns (uint256, uint256);
```

## 11. `ZyroInstructions.sol` — the instruction

The adapter between SwapVM's byte-level world and the pure math. Handles
encoding and decoding; **contains no formulas of its own.**

Structured as a `library` with `build()` / `parse()` / `exec()` — the same
shape every stock instruction uses. Internal library functions are callable
from any importing contract without inheritance, exactly like stock opcodes.

### Opcode choice

`0x92`, in SwapVM's **balance-tuning family bank** (`0x90–0xAF`),
reserved-but-unallocated in the stock enum. This is the documented extension
point: *"for new instructions take the next free slots of their family bank."*

The instruction genuinely belongs to that family — like the stock
Dutch-auction instructions, it mutates the balance registers before a curve
instruction consumes them, and does nothing else. **The opcode is defined
entirely in your own files. The submodule stays byte-for-byte official.**

### Wire format — 121 arg bytes + 2-byte header

| Offset | Bytes | Field | Type |
|---|---|---|---|
| — | 1 | opcode | `0x92` |
| — | 1 | args length | `0x79` = 121 |
| 0 | 16 | `gammaWad` | `int128` |
| 16 | 16 | `sigmaSqWad` | `int128` |
| 32 | 16 | `baseSpreadWad` | `int128` |
| 48 | 32 | `targetInventoryWad` | `int256` |
| 80 | 32 | `boundWad` | `int256` |
| 112 | 4 | `horizonSecs` | `uint32` |
| 116 | 5 | `startTimestamp` | `uint40` |

121 bytes is well under the VM's 255-byte per-instruction limit (args length
packs into a single byte).

`InstructionBuilder.pushHeader` only accepts the stock `Opcode` enum type,
which cannot represent an opcode you define without editing the submodule —
so write the 2-byte header using the raw `uint8` overload of
`MemoryPtrLib.push` instead.

### `exec` — the two corrections

```
1. d ← parse(args)
2. validate(d.params)                              ⚠ CORRECTION 1 (§5)
3. if d.startTimestamp > block.timestamp: revert   ⚠ CORRECTION 2 (below)
4. q       ← int256(ctx.swap.balanceIn) − d.targetInventoryWad
5. elapsed ← block.timestamp − d.startTimestamp
6. (ctx.swap.balanceIn, ctx.swap.balanceOut) ← applyInventorySkew(...)
```

> **⚠ CORRECTION 2 — future-dated `startTimestamp`.**
> The horizon's start is read from program bytes and previously trusted.
> Set in the future, `elapsed` pins to zero indefinitely: the skew never
> decays and the horizon means nothing. Revert instead. (Setting it in the
> *past* is legal — that is a position shipped mid-horizon — but be aware it
> ships already-degraded if the horizon has elapsed; see §28.)

### The property that must hold

`exec` must be a pure function of `(balanceIn, balanceOut, block.timestamp,
program bytes)`. **Nothing in it may read `ctx.vm.isStaticContext.**
See §17.

## 12. `ZyroRouter.sol` — the append-only router

The deployable contract. Contains neither math nor encoding. It routes a
single opcode byte and delegates everything else:

```solidity
function _runOpcode(Context memory ctx, uint256 opcode, bytes calldata args)
    internal override
{
    if (opcode == ZyroInventorySkew.OPCODE) {
        ZyroInventorySkew.exec(ctx, args);
    } else {
        super._runOpcode(ctx, opcode, args);
    }
}
```

`_runOpcode` is declared `internal virtual` on the stock dispatcher — a
deliberate invitation to extend. Solidity resolves internal calls virtually
to the most-derived override, so when the stock dispatcher calls it,
execution lands here.

**This is the strongest correctness argument in the project.** Consequences:

- No stock opcode's behaviour or index is touched. Every program the real
  1inch SDK emits runs byte-identically.
- No fork, no patch, no edited submodule.
- It is **proved, not asserted** — §16 requires the test.

## 13. `ZyroSkewHook.sol` — the v4 port

Same kernel, expressed through v4's dynamic-fee extension point:
`beforeSwap` returns `uint24 fee | LPFeeLibrary.OVERRIDE_FEE_FLAG` on a pool
initialised with `LPFeeLibrary.DYNAMIC_FEE_FLAG`.

The hook reuses `halfSpreadWad` and `softBoundPenaltyBps` — both already
spread/fee-shaped — and **not** `reservationPriceWad`/`recenterBalances`,
which are specific to SwapVM's balance-pair curve. A v4 pool's liquidity is
concentrated and tick-indexed; there is no equivalent pair to rotate without
reimplementing v4's own swap math.

Mid comes from the pool's own `sqrtPriceX96` via `StateLibrary.getSlot0` —
the pool already knows this authoritatively. Convert `halfSpreadWad` (an
absolute price offset) to parts-per-million by dividing by mid.

### Three corrections

> **⚠ CORRECTION 3 — permissionless permanent configuration.**
> Previously the first caller set a pool's parameters forever, with no owner
> and no way to reconfigure. Anyone could front-run with hostile parameters
> and lock them in. **Set an `owner` in the constructor, restrict
> `configurePool` to it, and allow reconfiguration.** Deployer-owned is
> honest and sufficient for a proof of concept; note in comments that
> production would want per-pool delegated authority.

> **⚠ CORRECTION 4 — validate at configuration.**
> Call `AvellanedaStoikov.validate(params)` before storing config. The
> negative-gamma inversion applies here identically.

> **⚠ CORRECTION 5 — inventory ignores liquidity events.**
> `poolInventoryWad` previously moved only in `_afterSwap`, with
> `afterAddLiquidity`/`afterRemoveLiquidity` disabled. An LP minting or
> burning changes the pool's real token0 holdings by an amount the hook never
> sees. **Either** enable those two permissions and track their deltas
> (correct, but changes the hook's address flags — re-mine with `HookMiner`),
> **or** rename the variable to `poolNetSwapFlowWad` and document honestly
> that it tracks net swap flow since configuration, not pool inventory.
> Do not leave it named `poolInventoryWad` while it means something else.

### The honesty requirement

Whose inventory is being priced differs fundamentally between the venues:

| | Aqua path | v4 path |
|---|---|---|
| Whose inventory | a specific maker's real wallet | the pool's, via a hook-maintained counter |
| Read from | `AQUA.safeBalances()` | the hook's own state |
| Lever | rotate the curve | override the LP fee |

On Aqua there is a real maker with real risk. On v4 the "inventory" belongs
to a pool whose LPs never opted into a risk model — the structural problem
that makes this impossible on pool AMMs reappears *inside* the v4
implementation.

> **"One kernel, two venues" is true at the level of code reuse. It is not
> true at the level of the mechanism. Present the v4 path as a port that
> demonstrates the concept generalises to a fee lever — not as a second
> instance of the innovation.**

---

# PART D — READ THE SOURCE FIRST

## 14. Five corrections that cost the previous build a redesign

These were each discovered the hard way, after writing code against a
plausible but wrong assumption. **You get them for free. Do not rediscover
them.**

**1. There is no shared price register.** `Context.SwapRegisters` is exactly
`{balanceIn, balanceOut, amountIn, amountOut}`. Every stock instruction that
"adjusts price" does it by mutating `balanceIn`/`balanceOut` before a
swap-curve instruction consumes them.

**2. One opcode, not three.** The natural design splits reservation price /
spread / soft bound into three sequential instructions writing to a shared
register. With no such register, instructions two and three would read back
*already-mutated* balances instead of live inventory — corrupting the exact
number the mechanism exists to price around. One atomic instruction reads
live balances exactly once and is correct by construction.

**3. Live inventory needs no accessor.** `SwapVM.quote()`/`swap()` populate
`ctx.swap.balanceIn`/`balanceOut` from `AQUA.safeBalances()` **before any
instruction runs.** There is no lookup, poll, or oracle call. By the time
your instruction executes, that already *is* the maker's live Aqua balance.

**4. Opcode dispatch is a fixed 256-slot table, not a dynamic array.** You do
not append to anything. You claim an unallocated byte in the existing family
bank and override `_runOpcode`.

**5. `@1inch/aqua-sdk` is a stateless calldata encoder**, not an async client.
`AquaProtocolContract.buildShipTx()` returns `{to, data, value}` for your own
wallet/provider to submit. There is no `.ship()` that sends a transaction.

## 15. ⚠ VERIFY before writing the instruction

Read these files yourself. Do not take this document's word for them:

| File | What to confirm |
|---|---|
| `swap-vm/src/libs/VM.sol` | `Context` and `SwapRegisters` shape; where `isStaticContext` lives |
| `swap-vm/src/libs/OpcodeList.sol` | that `0x92` is still unallocated in the balance-tuning bank |
| `swap-vm/src/opcodes/AquaOpcodes.sol` | that `_runOpcode` is still `internal virtual` |
| `swap-vm/src/instructions/XYCSwap.sol` | the stock instruction shape you are mirroring |
| `swap-vm/src/instructions/DutchAuction.sol` | the balance-tuning family pattern |
| `swap-vm/src/libs/MemoryPtr.sol` | `push`/`skip`/`patchLength`/`resolve` semantics |

**Toolchain gotcha:** `swap-vm` and `aqua` resolve Solidity dependencies via
`npm install` into `node_modules`, referenced by `remappings.txt` — not
`forge install` submodules. A fresh `forge build` fails with unresolved
imports until you run `npm install --ignore-scripts` inside `swap-vm`.

**v4 gotcha:** `v4-periphery`'s `main` deleted `src/utils/BaseHook.sol`
(commit `5da22e60`, "remove hooks and move to hook repo") with no forwarding
pointer. Pin to `3779387e`, the last commit that still has it.

**solc conflict:** `swap-vm`/`aqua` pin exactly `0.8.30`; `v4-core` pins
exactly `0.8.26`. Use `auto_detect_solc = true` plus a
`compilation_restrictions` entry giving `v4-core` its own much higher
`optimizer_runs` (~44,444,444, matching v4-core's own `foundry.toml`) or
`Pool.sol` hits a stack-too-deep Yul error under `via_ir`.

**Contract size:** do not put the Aqua router deploy and the hook deploy in
one script file. Compiling `ZyroRouter` under v4-core's optimizer profile
pushes it over EIP-170's 24,576-byte limit (27,862 vs 21,510 compiled alone).

---

# PART E — TESTS

## 16. Required suite

Target ≥ 24 Foundry tests, most of them fuzz tests at 2,000 runs. Assert
*properties*, not single input/output pairs.

**`AvellanedaStoikov.t.sol`** — 8+ properties:

- zero inventory produces zero skew, at any `γ`, `σ²`, elapsed
- reservation price falls monotonically as inventory rises
- half-spread shrinks as the horizon is consumed, never below `δ₀`
- bound penalty ramps linearly and clamps at 500 bps
- zero bound produces zero penalty
- exposed-side pricing is strictly worse than covered-side at the same `|q|`
- bound penalty actually reduces exposed-side output
- re-centring preserves depth and hits the target price

**`ZyroRouter.t.sol`** — the append-only property:

- an identical stock-only program quotes **byte-identically** on a real
  `AquaSwapVMRouter` and on `ZyroRouter`
- `0x92` reverts on the stock router and executes on yours

**`ZyroSkewHook.t.sol`** — against a real `PoolManager` via `Deployers` and
`HookMiner`, not a mock:

- configuration requires a dynamic fee
- configuration is owner-gated (**new**, per Correction 3)
- reconfiguration works for the owner and reverts for anyone else (**new**)
- at target, both directions pay the base fee
- drifted inventory makes exposed fills cost more than covered fills

**`EncodingFixtures.t.sol`** — prints reference bytes that the TypeScript
encoders are asserted against. This is your cross-language correctness check.

**New regression tests this build must add:**

```
test_NegativeGamma_Reverts()
test_NegativeSigmaSq_Reverts()
test_NegativeBaseSpread_Reverts()
test_GammaAboveCap_Reverts()
test_FutureStartTimestamp_Reverts()
testFuzz_ReservationPrice_NeverRewardsDrift()
```

Without these, a missing `validate()` call is invisible.

## 17. `QuoteSwapParity.t.sol` — the file that matters most

A normal AMM prices off pool reserves — identical for everyone, at any time.
Zyro prices off a specific maker's live wallet balance **plus the clock**.
That is far more state, and therefore far more surface for a quote to
disagree with the execution that follows it. SwapVM hands every instruction
an `isStaticContext` flag saying whether it is inside a read-only quote or a
real swap — making it trivially easy to introduce exactly that bug.

**Your instruction must never read that flag, and this file must prove it**
across a fuzzed space of balances, parameters, elapsed times and trade sizes,
plus explicit cases exactly at the soft bound and past it.

```
assertEq(quotedOut, actualOut, "quote/swap divergence at this inventory state")
```

If a taker cannot trust that the price they were quoted is the price they
get, nothing else about the mechanism matters.

**Fuzz-bound discipline:** bound `balanceOut` relative to `balanceIn` (0.2×–5×)
and inventory imbalance relative to the shipped balance. An arbitrarily
lopsided starting pool is a misconfiguration, not a parity bug. **But do not
bound `γ` and `σ²` to non-negative ranges and call that coverage** — that is
precisely what concealed the sign-inversion defect. Test signs explicitly in
the dedicated tests above.

## 18. The tested failure mode

Keep this one. A grossly misconfigured strategy — target wildly far from the
shipped balance, at high risk aversion — can re-centre the curve to promise
more output than the maker holds. Assert that the swap **reverts** rather
than silently under- or over-paying:

```
test_InsolventSkew_SwapRevertsSafely()
```

The stock `DutchAuctionBalanceOut` instruction has the same characteristic by
design, and Aqua's settlement pull is the backstop either way. Turning a
known limitation into a named passing test converts a surprise into a
documented safety property. *"Fails safely"* is a real guarantee.

---

# PART F — OFF-CHAIN

## 19. SDK (`packages/strategy-sdk`)

TypeScript encoders that must produce **byte-identical** output to the
Solidity `build()`. Capture expectations verbatim from a live run of
`EncodingFixtures.t.sol` — never hand-derive them from reading the source.

Minimum surface: `encodeZyroInventorySkew`, `encodeXYCSwap`, `encodeSalt`,
`buildZyroProgram`, `buildOrder`, `encodeOrder`, `buildShipZyroStrategyTx`,
`buildDockTx`.

A full program is `InventorySkew ++ XYCSwap ++ Salt`. The salt prevents
re-shipping identical parameters from colliding on `strategyHash`.

`buildOrder` must enforce `tokenA < tokenB` numerically. Maker hooks are not
needed — do not implement their variable-length slice-index packing without a
fixture to verify against.

## 20. Subgraph — **corrected design**

The routability problem this solves: liquidity here is order-based and
distributed across individual makers. There is no pool contract holding
reserves, so a router cannot read a reserve to price a Zyro position. It
would have to re-derive the entire formula itself. The subgraph re-runs the
same Avellaneda–Stoikov math in AssemblyScript so a solver can query the
current reservation price directly.

> **⚠ CORRECTION 6 — balances must come from `Pushed`/`Pulled`.**
> The previous build initialised position balances to **zero** and then
> accumulated `Swapped` deltas on top of zero. Every published reservation
> price was therefore computed from deltas rather than balances.
>
> Aqua emits `Pushed(maker, app, strategyHash, token, amount)` and
> `Pulled(...)` — the authoritative per-strategy balance ledger. **Handle
> both, and stop deriving balances from `Swapped` deltas entirely** or you
> will double-count.
>
> Two ordering details: `Pushed` may fire *before* `Shipped` within the same
> `ship()` transaction, so buffer early pushes in a small pending entity and
> drain it when the position is created. And ⚠ **VERIFY** that `Pushed`/
> `Pulled` also fire at swap settlement — confirm this against the real
> on-chain transaction from §25 Phase 4 before trusting it.
>
> **✅ RESOLVED — and both halves of this paragraph were wrong. See
> [docs/EVENT-ORDER.md](docs/EVENT-ORDER.md).**
>
> Settled against the vendored source rather than a testnet run, which also
> answered the half that was not flagged.
>
> `Pushed`/`Pulled` **do** fire at settlement — but *before* `Swapped`, not
> after, because `SwapVM._swap` settles and then emits. So `handleSwapped`
> reading the store for "pre-fill" state got post-fill balances, and CORRECTION
> 7's prescribed fix does not work: another handler has already mutated them.
> The pre-fill state is reconstructed by undoing the fill's own deltas instead.
>
> And `ship()` emits `Shipped` **first**, then one `Pushed` per token from the
> funding loop below it — the reverse of what this paragraph says. The
> `PendingPush` buffer can therefore never fire (`push()` reverts on an
> unshipped strategy), so the position was never priced at ship and published a
> mid of zero until something traded against it. The price is now published from
> `handlePushed`/`handlePulled`, where the funding actually lands.

> **⚠ CORRECTION 7 — `midWadAtFill` is captured too late.**
> The previous build wrote `fill.midWadAtFill` *after* mutating balances
> with that same fill — storing the post-fill mid under a pre-fill name.
> Capture the mid **before** applying the fill's deltas. This is the number
> behind your headline demo chart.

Other essentials:

- `BigInt.fromSignedBytes`/`fromUnsignedBytes` expect **little-endian** input.
  Every value you decode from EVM bytes is big-endian. Reverse the slice
  first. Getting this wrong gives you a wrong number that still looks
  plausible — no error.
- `@entity` now requires an explicit `immutable` argument.
- Decode Aqua's `Shipped.strategy` blob with
  `ethereum.decode("(address,uint256,bytes)", …)`; `order.data` is
  `tokenA(20) ++ tokenB(20) ++ program`.
  **✅ CORRECTED:** `order.data` is `hooksData ++ program`, with no token
  prefix — 1inch's own `MakerTraitsLib.build` shows it, and the program's start
  is recorded in bits [208, 224) of the traits word. Slicing at a fixed 40
  would read 38 bytes of the Zyro instruction's arguments as two addresses and
  then mis-parse the rest, silently, since the walk would still find plausible
  opcode/length pairs. Checked against a real `abi.encode(order)` in
  `subgraph/tests/program.test.ts`.
- Filter by app address — Aqua's `Shipped` fires for every app built on it.

Wire `subgraph/mcp/mcp.config.json` to The Graph's official Subgraph MCP
endpoint (`https://subgraphs.mcp.thegraph.com/sse`). This is the
**Composable-track** qualification path.

## 21. Console (`apps/console`)

Three pages: landing (PnL comparison + headline), `/simulate` (full receipt
table), `/position/[hash]` (live gauge).

**Every number must be generated, never hand-typed.** Pipe the simulation
output through a small parser that emits both the README table and the JSON
the app reads. Assemble the headline sentence programmatically from the run.
This is unusually good discipline and worth stating out loud.

The strongest visual: mid and reservation price on one chart over the fill
series — two lines that sit on top of each other when balanced and separate
as inventory drifts.

---

# PART G — THE SIMULATION, REDESIGNED

## 22. Why the previous benchmark proved nothing

The old simulation ran 40 identical fills against a stock position and a Zyro
position and reported a 22.35-token PnL advantage. **That result was
arithmetically guaranteed before the simulation ran**, for three reasons:

- both positions received an identical fixed amount of token0 every tick
- Zyro pays out strictly less token1 per fill *by construction* — that is
  the entire mechanism
- both were marked at the **stock** position's mid, a price Zyro never quoted

Same asset in, less asset out, common yardstick. The only thing 40 ticks
established was the magnitude of a difference whose direction was decided in
advance. The taker never reacted, never routed elsewhere, never declined —
so fill rate was pinned at 100% and only the *benefit* side of the trade-off
was modelled, never the cost.

**Do not rebuild this.** It proves *"skewing charges more"* (true by
construction), not *"skewing produces better risk-adjusted returns"* (the
actual thesis).

## 23. Competitive routing benchmark — build this instead

```
                exogenous price process
                          ↓
              ┌───────────┴───────────┐
              ↓                       ↓
        stock position           zyro position
              ↓                       ↓
              └───────────┬───────────┘
                          ↓
              taker compares both quotes
                          ↓
                routes to the better one
```

Three properties the old one lacked:

**1. The price path is exogenous.** Previously mid fell 1.00 → 0.70 *because*
one-directional flow pushed the stock curve down — an artefact of the same
flow being measured, not an external process. Drive the series from an
independent price path instead.

**2. The taker chooses.** It requests a quote from both positions and routes
to whichever is better, or declines if both are worse than some reference.
This is what makes the result meaningful: Zyro can now *lose fills*, which
is the cost side of the trade-off the mechanism explicitly makes.

**3. Both positions are marked at the exogenous price**, not at either
position's own quote.

Declare all parameters as constants at the top of the script, next to where
they are used — not in a config file a judge has to go find.

## 24. Stress scenarios

Run all four. Publish reproducible configurations.

| Scenario | Path | Question |
|---|---|---|
| **A — slow trend** | 1.00 → 0.95 → 0.90 → 0.85 → 0.80 | Does Zyro defend without making liquidity needlessly expensive? |
| **B — fast trend** | 1.00 → 0.95 → 0.87 → 0.76 → 0.65 | Does the skew respond fast enough to matter? |
| **C — toxic burst** | concentrated aggressive fills | Does the soft bound bite before real damage? |
| **D — whipsaw** | 1.00 → 0.80 → 1.05 → 0.78 → 1.10 | **Mandatory.** Does defending cost more in fills than it saves in inventory when the move reverses? |

Scenario D is the one that can falsify the thesis. Run it, and report what it
says.

## 25. Metrics

Report all of these, not just PnL:

```
PnL                          fill rate
max inventory deviation      route-away rate
inventory recovery time      taker execution cost
time near the soft bound     PnL per unit inventory risk
```

**A maker that avoids all inventory risk by refusing to trade is not a
successful design.** The objective is protection *plus* liquidity
availability *plus* acceptable taker pricing — not maximum PnL.

### Kill tests — pre-commit to these

- If Zyro performs the same as stock across realistic scenarios, say so.
- If it loses fills faster than it saves on inventory in Scenario D, that is
  a real finding about parameter calibration. Report it.
- If all flow routes away while inventory stays dangerous, the mechanism
  needs a different liquidity-control strategy.

**Reporting an honest negative result is worth more than never having asked.**

---

# PART H — BUILD ORDER

## 26. Phases

**Phase 0 — repo hygiene (first commit)**
`LICENSE` (MIT), `.github/workflows/ci.yml` running `forge test` + SDK tests,
dependencies pinned to **exact commits**, `README.md` skeleton. Do this
first so CI is green from commit one, not bolted on at the end.

**Phase 1 — the kernel**
`AvellanedaStoikov.sol` + `AvellanedaStoikov.t.sol`, including the new sign
tests. No dependencies, no VM. You can finish this before fetching a
submodule.

**Phase 2 — read the source** (§15). Do not skip.

**Phase 3 — instruction + router**
`ZyroInstructions.sol`, `ZyroRouter.sol`, `ZyroTestBase.sol`,
`ZyroRouter.t.sol`, then **`QuoteSwapParity.t.sol`**. Do parity here, not
later — it constrains the design and it is your strongest claim.

**Phase 4 — ⭐ SHIP AND SWAP ON BASE SEPOLIA**

> **This is the highest-leverage half-day in the entire project. Do not defer
> it to the end.**
>
> Deploy, `ship()` one real position, execute one real `swap()` against it.
> That single action:
> - satisfies 1inch's stated *"onchain execution of token transfers presented
>   at demo"* requirement, which a deployed address alone **does not**
> - gives The Graph track actual data to index, making "live data" true
> - is the only thing that will reveal whether the subgraph corrections
>   actually work
> - turns `/position/[hash]` from a stand-in into a real page

**Phase 5 — SDK + fixtures.** Capture from a live `EncodingFixtures` run.

**Phase 6 — subgraph.** Build with Corrections 6 and 7 in from the start.
Validate reconstructed state against the real transaction from Phase 4.

**Phase 7 — the v4 hook.** With Corrections 3, 4 and 5.

**Phase 8 — competitive simulation** (§23) and all four scenarios.

**Phase 9 — console.** Wired to generated JSON.

**Phase 10 — feedback files + demo rehearsal.**

---

# PART I — SPONSOR REQUIREMENTS

## 27. Checklist

> ⚠ Verify current wording against the live sponsor pages — criteria change.

**1inch — your strongest track. Lead with it.**

- [ ] Official Aqua/SwapVM contracts used verbatim, unmodified
- [ ] The mechanism **is** a SwapVM opcode, not an app layered on top
- [ ] Append-only extension, proved by test
- [ ] **On-chain execution of token transfers demonstrated** ← Phase 4
- [ ] Proper git history — **commit per feature, from commit one**
- [ ] `FEEDBACK/1INCH.md`

**The Graph — Composable track**

- [ ] Subgraph live, indexing, no indexing errors
- [ ] **Returns real, correct data** ← requires Phase 4 *and* Correction 6
- [ ] Composed with Subgraph MCP (`mcp.config.json`)
- [ ] `FEEDBACK/THEGRAPH.md`

**Uniswap Foundation**

- [ ] Public repo
- [ ] `FEEDBACK/UNISWAP.md` + developer feedback form (manual step)
- [ ] README points at the specific contracts/lines
- [ ] Hook deployed against the chain's real `PoolManager`

Write the feedback files **as you hit the friction**, not retrospectively.
The specific, verified ones are worth real credit; generic ones are not.

---

# PART J — DISCIPLINE

## 28. What not to claim

Zyro does **not** guarantee profit, zero impermanent loss, protection against
a crash, perfect market making, zero inventory risk, or positive returns in
any market.

It provides: **an adaptive pricing mechanism intended to reduce undesirable
inventory accumulation, at the cost of some trading revenue.**

Known limits to state openly:

- Pricing reacts *after* inventory has already moved.
- Aggressive skew reduces volume — this must be tuned per market.
- **The horizon expires.** Once `T−t` hits zero, every time-dependent term
  vanishes and the position silently becomes an ordinary constant-product AMM
  with a flat spread. It does not revert, warn, or stop trading — it stops
  defending itself. This is the single most surprising behaviour in the
  system and anyone operating a position needs to know it.
- The v4 path is a port, not a second instance of the innovation.

## 29. Deliberately deferred

Inventory velocity, defensive state machines, and hysteresis are **out of
scope**, and the reasons are technical, not schedule-driven:

- Velocity needs per-strategy history, which needs persistent mutable state,
  which **directly threatens quote/swap parity** — your single strongest
  correctness property. `quote()` runs in a static context and cannot write.
- A per-fill EMA is **spammable**: an attacker pushes dust swaps contributing
  `ΔI ≈ 0`, decaying the average toward zero and resetting the defense for
  the cost of gas, then hits the position with the fill it should have been
  defending against. A time-weighted decay would be required.
- A discrete state machine reintroduces exactly the **discontinuity** §6
  rejects as hostile to solvers.
- A weighted risk-pressure heuristic **abandons the Avellaneda–Stoikov
  citation**, which is what makes the pitch defensible. You would trade a
  published 2008 result for three hand-tuned weights and a proof burden.

It is a legitimate v2 direction and a good answer to *"what's next?"* It is
not a v1 feature.

## 30. Demo sequence

Open with the problem, not with Solidity.

1. Show a balanced position — mid and reservation price coincide
2. Send repeated one-directional trades
3. Show inventory drifting from target
4. Show the reservation price separating from mid, live
5. Show the exposed-side quote worsening as `q` grows
6. Show the covered-side quote improving at the same moment
7. Show the real Base Sepolia transaction and the subgraph query returning it
8. Compare final economics under competitive routing
9. **State the sharpest limitation yourself before anyone asks**

Step 9 is not a weakness. Volunteering a limitation before a judge finds it
is one of the strongest credibility signals available.

---

## 31. The thing to remember

```
              TRADE REQUEST
                   ↓
     LIVE WALLET BALANCE (pre-loaded)
                   ↓
          q = balance − target
                   ↓
      r = mid − q·γ·σ²·(T−t)
                   ↓
    exposed → r − δ    covered → r + δ
                   ↓
         ┌─────────┴─────────┐
         ↓                   ↓
  RE-CENTRE CURVE        ADJUST FEE
    (1inch path)        (Uniswap path)
         ↓                   ↓
         └─────────┬─────────┘
                   ↓
             TRADE EXECUTES
                   ↓
            INVENTORY CHANGES
                   ↓
              ── LOOP ──
```

The contribution is not a better trading algorithm. It is:

**individual position → observable live inventory → reservation-price
calculation → automatic price adjustment → feedback-driven rebalancing**

made possible by a custody model that only recently existed on-chain.
