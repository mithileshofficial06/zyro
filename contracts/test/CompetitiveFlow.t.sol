// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console2} from "forge-std/Test.sol";

import {ISwapVM} from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";

import {ZyroTestBase} from "./helpers/ZyroTestBase.sol";

/// @notice The competitive routing benchmark (§23–25).
///
/// @dev **The previous benchmark proved nothing, and this one is built to avoid
///      its three failures.** It ran identical fills against a stock position
///      and a Zyro position and reported a PnL advantage that was arithmetically
///      guaranteed before it ran:
///
///      - both positions received an identical fixed amount every tick;
///      - Zyro pays out strictly less per fill *by construction* — that is the
///        entire mechanism;
///      - both were marked at the **stock** position's mid, a price Zyro never
///        quoted.
///
///      Same asset in, less asset out, common yardstick. The taker never
///      reacted, never routed elsewhere, never declined, so fill rate was pinned
///      at 100% and only the *benefit* side of the trade-off was modelled.
///
///      This benchmark fixes all three:
///
///      1. **The price path is exogenous.** It is a script constant, not
///         something the measured flow pushes around.
///      2. **The taker chooses.** It quotes both positions, routes to whichever
///         is better, and declines if neither beats the exogenous price by its
///         tolerance. Zyro can therefore *lose fills* — the cost side of the
///         trade-off it explicitly makes.
///      3. **Both positions are marked at the exogenous price**, never at
///         either one's own quote.
///
///      Lives in `test/` rather than `script/` deliberately: it needs the same
///      real routers and Aqua fixture the suite already builds, and as a test it
///      runs in CI on every commit instead of only when somebody remembers to
///      invoke a script.
contract CompetitiveFlowTest is ZyroTestBase {
    // ---------------------------------------------------------------------
    // Parameters — declared here, next to where they are used, so a reader
    // never has to go and find a config file.
    // ---------------------------------------------------------------------

    /// @dev Starting inventory for both positions, identical.
    ///
    ///      Depth matters more than it looks. A trade worth 2% of the pool costs
    ///      ~2% in constant-product slippage, which swamps a spread measured in
    ///      basis points — the first version of this benchmark used a 1,000-token
    ///      pool with 20-token fills and the taker declined 28 of 40 ticks
    ///      purely on slippage, before Zyro's skew entered into it at all. Deep
    ///      liquidity relative to trade size is what makes the *pricing* the
    ///      deciding variable.
    uint256 internal constant START_IN = 100_000e18;
    uint256 internal constant START_OUT = 100_000e18;

    /// @dev Size of each taker request, in tokenIn: 0.2% of depth, so
    ///      constant-product slippage is ~20 bps.
    uint256 internal constant TICK_SIZE = 200e18;

    /// @dev Ticks per price leg. More ticks per leg means more chances to fill
    ///      at each price, and a smoother inventory path.
    uint256 internal constant TICKS_PER_LEG = 10;

    /// @dev Seconds between ticks. Matters because the skew decays with the
    ///      horizon.
    uint256 internal constant TICK_SECONDS = 60;

    /// @dev How far below the exogenous price a taker will still accept, in bps.
    ///      Must comfortably exceed the ~20 bps of slippage a tick incurs, or
    ///      the benchmark measures slippage rather than pricing.
    uint256 internal constant TAKER_TOLERANCE_BPS = 100;

    /// @dev Target inventory for the Zyro position: exactly where it starts.
    int256 internal constant TARGET = int256(START_IN);

    /// @dev Soft bound: 5,000 tokens of drift, 5% of depth.
    int256 internal constant BOUND = 5_000e18;

    // Calibrated for THIS pool, not reused from ZyroTestBase — that fixture is
    // sized for a 1,000-token pool. The skew is `Q * gamma * sigmaSq * (T-t)`,
    // so with a 2,000-token drift over an hour, `gamma * sigmaSq = 7e-10` puts
    // the skew at ~50 bps of a mid of 1. Large enough to change routing
    // decisions, small enough that Zyro is not simply priced out of the market.
    int128 internal constant SIM_GAMMA = 1e14; // 1e-4
    int128 internal constant SIM_SIGMA_SQ = 7e12; // 7e-6
    int128 internal constant SIM_BASE_SPREAD = 5e14; // 0.0005 absolute
    uint32 internal constant SIM_HORIZON = 1 hours;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;

    // ---------------------------------------------------------------------
    // Result accounting
    // ---------------------------------------------------------------------

    struct Position {
        bytes32 orderHash;
        uint256 balanceIn;
        uint256 balanceOut;
        uint256 fills;
        uint256 volumeIn;
        uint256 volumeOut;
        uint256 maxDeviation; // max |balanceIn - START_IN|
        uint256 ticksNearBound; // ticks with |q| >= 80% of the bound
        uint256 takerCostWad; // cumulative shortfall vs the exogenous price
    }

    struct Outcome {
        string name;
        Position stock;
        Position zyro;
        uint256 ticks;
        uint256 declines; // ticks where neither position was acceptable
        uint256 stockValueWad;
        uint256 zyroValueWad;
    }

    ISwapVM.Order internal stockOrder;
    ISwapVM.Order internal zyroOrder;
    bytes internal takerData;
    uint40 internal startTs;

    function setUp() public override {
        super.setUp();
        takerData = _takerData(true);
    }

    // =====================================================================
    // Scenarios
    // =====================================================================

    /// @dev A — slow trend. Does Zyro defend without making liquidity
    ///      needlessly expensive?
    function test_ScenarioA_SlowTrend() public {
        uint256[] memory path = new uint256[](5);
        path[0] = 1.00e18;
        path[1] = 0.95e18;
        path[2] = 0.90e18;
        path[3] = 0.85e18;
        path[4] = 0.80e18;
        _report(_run("A-slow-trend", path, TICK_SIZE));
    }

    /// @dev B — fast trend. Does the skew respond fast enough to matter?
    function test_ScenarioB_FastTrend() public {
        uint256[] memory path = new uint256[](5);
        path[0] = 1.00e18;
        path[1] = 0.95e18;
        path[2] = 0.87e18;
        path[3] = 0.76e18;
        path[4] = 0.65e18;
        _report(_run("B-fast-trend", path, TICK_SIZE));
    }

    /// @dev C — toxic burst. Concentrated aggressive flow: same path as B but
    ///      with fills four times the size. Does the soft bound bite before real
    ///      damage is done?
    function test_ScenarioC_ToxicBurst() public {
        uint256[] memory path = new uint256[](3);
        path[0] = 1.00e18;
        path[1] = 0.88e18;
        path[2] = 0.72e18;
        _report(_run("C-toxic-burst", path, TICK_SIZE * 4));
    }

    /// @dev D — whipsaw. **The scenario that can falsify the thesis.**
    ///
    ///      If defending costs more in lost fills than it saves in inventory
    ///      when the move reverses, that is a real finding about parameter
    ///      calibration and it gets reported as one.
    function test_ScenarioD_Whipsaw() public {
        uint256[] memory path = new uint256[](5);
        path[0] = 1.00e18;
        path[1] = 0.80e18;
        path[2] = 1.05e18;
        path[3] = 0.78e18;
        path[4] = 1.10e18;
        _report(_run("D-whipsaw", path, TICK_SIZE));
    }

    // =====================================================================
    // Kill tests — pre-committed, per §25
    // =====================================================================

    /// @dev "A maker that avoids all inventory risk by refusing to trade is not
    ///      a successful design."
    ///
    ///      Note what this deliberately does **not** assert: a minimum share of
    ///      total flow. With a stock competitor quoting alongside it, adverse
    ///      flow *should* route away from Zyro — that is the cost side of the
    ///      trade-off working exactly as designed, not a defect. An arbitrary
    ///      fill-rate floor would fail the mechanism for succeeding.
    ///
    ///      What matters is that it participates at all, and that any advantage
    ///      it shows is not purely the result of refusing to quote.
    function test_KillTest_ZyroStillProvidesLiquidity() public {
        uint256[] memory path = new uint256[](5);
        path[0] = 1.00e18;
        path[1] = 0.95e18;
        path[2] = 0.90e18;
        path[3] = 0.85e18;
        path[4] = 0.80e18;

        Outcome memory o = _run("kill-liquidity", path, TICK_SIZE);

        assertGt(o.zyro.fills, 0, "Zyro must actually trade, not just refuse");

        if (o.zyroValueWad > o.stockValueWad) {
            assertGt(
                o.zyro.volumeIn,
                0,
                "an advantage earned by never quoting is not an advantage"
            );
        }
    }

    /// @dev The mechanism's core claim, stated so it can fail: under
    ///      one-directional adverse flow, Zyro must accumulate less of the
    ///      falling asset than the stock curve does.
    function test_KillTest_ZyroAccumulatesLessUnderAdverseFlow() public {
        uint256[] memory path = new uint256[](5);
        path[0] = 1.00e18;
        path[1] = 0.95e18;
        path[2] = 0.87e18;
        path[3] = 0.76e18;
        path[4] = 0.65e18;

        Outcome memory o = _run("kill-accumulation", path, TICK_SIZE);

        assertLe(
            o.zyro.maxDeviation,
            o.stock.maxDeviation,
            "Zyro must not drift further from target than the stock curve"
        );
    }

    // =====================================================================
    // The simulation
    // =====================================================================

    function _run(string memory name, uint256[] memory path, uint256 tickSize)
        internal
        returns (Outcome memory o)
    {
        o.name = name;

        startTs = uint40(block.timestamp);

        stockOrder = _order(_stockProgram());
        zyroOrder = _order(
            _zyroProgram(
                SIM_GAMMA, SIM_SIGMA_SQ, SIM_BASE_SPREAD, TARGET, BOUND, SIM_HORIZON, startTs
            )
        );

        o.stock.orderHash = stockRouter.hash(stockOrder);
        o.zyro.orderHash = zyroRouter.hash(zyroOrder);

        o.stock.balanceIn = START_IN;
        o.stock.balanceOut = START_OUT;
        o.zyro.balanceIn = START_IN;
        o.zyro.balanceOut = START_OUT;

        for (uint256 leg = 0; leg < path.length; ++leg) {
            uint256 price = path[leg];

            for (uint256 t = 0; t < TICKS_PER_LEG; ++t) {
                o.ticks++;
                vm.warp(block.timestamp + TICK_SECONDS);

                // The taker's reference: what the exogenous price says this
                // trade is worth, less the tolerance it will accept.
                uint256 fairOut = tickSize * price / WAD;
                uint256 minOut = fairOut * (BPS - TAKER_TOLERANCE_BPS) / BPS;

                uint256 stockOut = _quote(true, o.stock, tickSize);
                uint256 zyroOut = _quote(false, o.zyro, tickSize);

                bool stockOk = stockOut >= minOut;
                bool zyroOk = zyroOut >= minOut;

                if (!stockOk && !zyroOk) {
                    o.declines++;
                } else if (stockOut >= zyroOut && stockOk) {
                    _fill(o.stock, tickSize, stockOut, fairOut);
                } else if (zyroOk) {
                    _fill(o.zyro, tickSize, zyroOut, fairOut);
                } else {
                    _fill(o.stock, tickSize, stockOut, fairOut);
                }

                _track(o.stock);
                _track(o.zyro);
            }
        }

        // Both marked at the FINAL EXOGENOUS PRICE — never at either position's
        // own quote. This is the correction that makes the comparison mean
        // anything.
        uint256 finalPrice = path[path.length - 1];
        o.stockValueWad = o.stock.balanceIn * finalPrice / WAD + o.stock.balanceOut;
        o.zyroValueWad = o.zyro.balanceIn * finalPrice / WAD + o.zyro.balanceOut;
    }

    /// @dev Quotes a position through the real router at its current inventory.
    ///      `quote()` is the genuine pricing path; only settlement is simulated.
    function _quote(bool isStock, Position memory p, uint256 amount)
        internal
        returns (uint256)
    {
        address router = isStock ? address(stockRouter) : address(zyroRouter);
        _seedInventory(router, p.orderHash, p.balanceIn, p.balanceOut);

        ISwapVM.Order memory order = isStock ? stockOrder : zyroOrder;

        vm.prank(taker);
        try (isStock ? stockRouter : zyroRouter).quote(
            order, address(tokenIn), address(tokenOut), amount, takerData
        ) returns (uint256, uint256 amountOut, bytes32) {
            // A position cannot pay out more than it holds.
            return amountOut > p.balanceOut ? 0 : amountOut;
        } catch {
            // An unquotable state is a declined fill, not a crash.
            return 0;
        }
    }

    function _fill(Position memory p, uint256 amountIn, uint256 amountOut, uint256 fairOut)
        internal
        pure
    {
        p.balanceIn += amountIn;
        p.balanceOut -= amountOut;
        p.fills++;
        p.volumeIn += amountIn;
        p.volumeOut += amountOut;
        if (fairOut > amountOut) p.takerCostWad += fairOut - amountOut;
    }

    function _track(Position memory p) internal pure {
        uint256 deviation =
            p.balanceIn > START_IN ? p.balanceIn - START_IN : START_IN - p.balanceIn;
        if (deviation > p.maxDeviation) p.maxDeviation = deviation;
        if (deviation * 100 >= uint256(BOUND) * 80) p.ticksNearBound++;
    }

    // =====================================================================
    // Reporting
    // =====================================================================

    function _report(Outcome memory o) internal view {
        console2.log("");
        console2.log("=== scenario", o.name, "===");
        console2.log("ticks                ", o.ticks);
        console2.log("declines (both)      ", o.declines);
        console2.log("");
        console2.log("                        stock        zyro");
        console2.log("fills                 ", o.stock.fills, o.zyro.fills);
        console2.log("volume in  (wad)      ", o.stock.volumeIn, o.zyro.volumeIn);
        console2.log("volume out (wad)      ", o.stock.volumeOut, o.zyro.volumeOut);
        console2.log("max deviation (wad)   ", o.stock.maxDeviation, o.zyro.maxDeviation);
        console2.log("ticks near bound      ", o.stock.ticksNearBound, o.zyro.ticksNearBound);
        console2.log("taker cost (wad)      ", o.stock.takerCostWad, o.zyro.takerCostWad);
        console2.log("");
        console2.log("value at exogenous mark");
        console2.log("  stock               ", o.stockValueWad);
        console2.log("  zyro                ", o.zyroValueWad);

        if (o.zyroValueWad >= o.stockValueWad) {
            console2.log("  zyro ahead by       ", o.zyroValueWad - o.stockValueWad);
        } else {
            console2.log("  zyro BEHIND by      ", o.stockValueWad - o.zyroValueWad);
        }

        // Fill rate is reported alongside PnL deliberately. A position that wins
        // on value by refusing to trade has not succeeded.
        console2.log("fill rate %  stock/zyro",
            o.stock.fills * 100 / o.ticks, o.zyro.fills * 100 / o.ticks);
    }
}
