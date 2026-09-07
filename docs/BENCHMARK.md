# Competitive routing benchmark — results

Produced by [`contracts/test/CompetitiveFlow.t.sol`](../contracts/test/CompetitiveFlow.t.sol).
Every number below comes from a live `forge test` run against the real
`AquaSwapVMRouter` and `ZyroRouter`; nothing is hand-entered.

The same run writes
[`contracts/test/fixtures/benchmark.json`](../contracts/test/fixtures/benchmark.json),
which carries the per-tick receipt this page summarises. The console renders it
at `/simulate`, and CI fails on a diff under `contracts/test/fixtures/` — so a
figure edited into either the page or this table cannot survive a commit.

## What this benchmark fixes

The previous benchmark reported a 22.35-token PnL advantage that was
**arithmetically guaranteed before it ran**: both positions received identical
fixed flow, Zyro pays out strictly less per fill by construction, and both were
marked at the *stock* position's mid — a price Zyro never quoted. Same asset in,
less asset out, common yardstick.

This one:

1. **The price path is exogenous** — a declared constant, not something the
   measured flow pushes around.
2. **The taker chooses.** It quotes both positions, routes to whichever is
   better, and declines if neither beats the exogenous price by its tolerance.
   Zyro can therefore *lose fills*.
3. **Both positions are marked at the exogenous price**, never at either one's
   own quote.

## Configuration

| Parameter | Value |
|---|---|
| Starting inventory (both) | 100,000 / 100,000 |
| Tick size | 200 (0.2% of depth, ≈20 bps slippage) |
| Taker tolerance | 100 bps |
| Ticks per price leg | 10 |
| `gamma · sigmaSq` | 7e-10 |
| Base spread | 0.0005 absolute |
| Horizon | 1 hour |
| Soft bound | 5,000 (5% of depth) |

## Results

| Scenario | Path | Stock fills | Zyro fills | Stock max drift | Zyro max drift | Zyro vs stock |
|---|---|---|---|---|---|---|
| **A** slow trend | 1.00 → 0.80 | 27 (54%) | 18 (36%) | 5,400 | 3,600 | **+273.8** (+0.15%) |
| **B** fast trend | 1.00 → 0.65 | 27 (54%) | 18 (36%) | 5,400 | 3,600 | **+543.8** (+0.33%) |
| **C** toxic burst | 1.00 → 0.72, 4× size | 13 (43%) | 9 (30%) | 10,400 | 7,200 | **+627.4** (+0.37%) |
| **D** whipsaw | 1.00 → 0.80 → 1.05 → 0.78 → 1.10 | 15 (30%) | 10 (20%) | 3,000 | 2,000 | **−127.5** (−0.06%) |

Time spent near the soft bound, which is the risk measure that matters most:

| Scenario | Stock | Zyro |
|---|---|---|
| A | 13 ticks | **0** |
| B | 13 ticks | **0** |
| C | 15 ticks | 11 |

## Scenario D falsifies the simple version of the thesis

**Zyro loses in the whipsaw, and that is the correct result to report.**

D ends at 1.10 — *above* where it started. Stock accumulated 3,000 units of the
asset; Zyro's skew held it to 2,000. When the price recovers past the entry
level, having accumulated *more* of that asset is a win. Zyro bought less of
something that ultimately appreciated, and paid 127.5 units for the privilege.

That is not a bug. It is what the mechanism *is*:

> Zyro is insurance against a trend continuing. It pays out when the move
> persists (A, B, C) and costs a premium when the move reverses (D).

The premium is small — 0.06% against payouts of 0.15–0.37% — but a maker whose
market mean-reverts more often than it trends should expect to lose money
running this, and should not run it. Reporting the losing scenario is the only
way that statement can be made credibly.

## What the benchmark also caught

**It found a defect in its own first configuration before it said anything
about Zyro.** The initial setup used a 1,000-unit pool with 20-unit fills — a 2%
trade, incurring ~2% constant-product slippage against a 50 bps taker
tolerance. The taker declined 28 of 40 ticks purely on slippage. Depth relative
to trade size has to be large enough that *pricing* is the deciding variable,
or the benchmark measures the AMM curve rather than the mechanism.

**Scenarios A and B produce identical trade sequences.** The taker's choice
between the two positions compares their quotes to each other, and neither quote
depends on the exogenous price — so once both are acceptable, routing is
identical and only the final mark differs. This is correct, and it is why B's
advantage is larger than A's: the same inventory, marked at a price that fell
further.

**`targetInventoryWad` is direction-dependent.** The instruction computes
`q = ctx.swap.balanceIn - targetInventoryWad`, and `balanceIn` is whichever
token the taker is *giving*. A single target field therefore configures one
direction properly. A position quoting both ways would need a target per side.
The benchmark models one-directional flow, which is the adverse-selection case
the mechanism targets, so it does not exercise this — but it is a real
limitation of the v1 wire format and worth stating before someone discovers it
in production.

## The kill tests

Pre-committed in `CompetitiveFlow.t.sol` and passing:

- **Zyro still provides liquidity.** It trades in every scenario. Note this
  deliberately does *not* assert a minimum share of flow: with a stock
  competitor quoting alongside it, adverse flow *should* route away from Zyro.
  That is the cost side working as designed, and an arbitrary fill-rate floor
  would fail the mechanism for succeeding.
- **Zyro accumulates less under adverse flow.** Its max drift is never worse
  than the stock curve's.
- **An advantage earned by never quoting is not an advantage.** If Zyro ends
  ahead on value, its traded volume must be non-zero.
