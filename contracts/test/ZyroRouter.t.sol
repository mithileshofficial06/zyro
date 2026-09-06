// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ISwapVM} from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";

import {ZyroTestBase} from "./helpers/ZyroTestBase.sol";

/// @notice Proves `ZyroRouter` is append-only over the stock `AquaSwapVMRouter`.
///
/// @dev This is the strongest correctness argument in the project, and §12 of
///      the build spec insists it be **proved, not asserted**. The claim is
///      that adding Zyro's instruction cannot change how any existing program
///      behaves — so the test runs byte-identical stock programs against a real
///      `AquaSwapVMRouter` and against `ZyroRouter` and requires identical
///      results.
contract ZyroRouterTest is ZyroTestBase {
    uint256 internal constant BAL_IN = 1_000e18;
    uint256 internal constant BAL_OUT = 2_000e18;

    // =====================================================================
    // The append-only property
    // =====================================================================

    function test_StockProgram_QuotesIdenticallyOnBothRouters() public {
        bytes memory program = _stockProgram();
        ISwapVM.Order memory order = _order(program);
        bytes memory takerData = _takerData(true);

        bytes32 orderHash = stockRouter.hash(order);
        _seedInventory(address(stockRouter), orderHash, BAL_IN, BAL_OUT);
        _seedInventory(address(zyroRouter), orderHash, BAL_IN, BAL_OUT);

        vm.prank(taker);
        (uint256 stockIn, uint256 stockOut,) =
            stockRouter.quote(order, address(tokenIn), address(tokenOut), 10e18, takerData);

        vm.prank(taker);
        (uint256 zyroIn, uint256 zyroOut,) =
            zyroRouter.quote(order, address(tokenIn), address(tokenOut), 10e18, takerData);

        assertEq(zyroIn, stockIn, "stock program's amountIn diverged");
        assertEq(zyroOut, stockOut, "stock program's amountOut diverged");
        assertGt(stockOut, 0, "fixture produced no output; the test would be vacuous");
    }

    /// @dev The same claim across a fuzzed space of inventories and trade sizes,
    ///      and over a program carrying a salt as well as the curve instruction,
    ///      so more than one stock opcode index is exercised.
    function testFuzz_StockProgram_QuotesIdenticallyOnBothRouters(
        uint256 balanceIn,
        uint256 balanceOut,
        uint256 amountIn,
        bytes8 salt
    ) public {
        balanceIn = bound(balanceIn, 1e18, 1e27);
        balanceOut = bound(balanceOut, balanceIn / 5, balanceIn * 5);
        amountIn = bound(amountIn, 1e12, balanceIn / 2);

        bytes memory program = abi.encodePacked(
            OP_SALT, uint8(8), salt, OP_XYC_SWAP, uint8(0)
        );
        ISwapVM.Order memory order = _order(program);
        bytes memory takerData = _takerData(true);

        bytes32 orderHash = stockRouter.hash(order);
        _seedInventory(address(stockRouter), orderHash, balanceIn, balanceOut);
        _seedInventory(address(zyroRouter), orderHash, balanceIn, balanceOut);

        vm.prank(taker);
        (uint256 stockIn, uint256 stockOut,) =
            stockRouter.quote(order, address(tokenIn), address(tokenOut), amountIn, takerData);

        vm.prank(taker);
        (uint256 zyroIn, uint256 zyroOut,) =
            zyroRouter.quote(order, address(tokenIn), address(tokenOut), amountIn, takerData);

        assertEq(zyroIn, stockIn, "stock program's amountIn diverged");
        assertEq(zyroOut, stockOut, "stock program's amountOut diverged");
    }

    /// @dev The order hash is what Aqua keys a maker's balances by. If adding an
    ///      opcode changed it, every already-shipped position would be orphaned.
    function test_OrderHash_IsIdenticalOnBothRouters() public view {
        ISwapVM.Order memory order = _order(_stockProgram());
        assertEq(
            zyroRouter.hash(order), stockRouter.hash(order), "order hash must not depend on the router"
        );
    }

    // =====================================================================
    // The new opcode exists only on ZyroRouter
    // =====================================================================

    /// @dev Opcode 34 is one past the end of the stock 34-entry dispatch array,
    ///      so the stock router panics on it. That is precisely what makes it a
    ///      free index to claim.
    function test_ZyroOpcode_RevertsOnStockRouter() public {
        bytes memory program = _zyroProgram(0.1e18, 0.1e18, 0, 1_000e18, 500e18, 1 days, uint40(block.timestamp));
        ISwapVM.Order memory order = _order(program);
        bytes memory takerData = _takerData(true);

        bytes32 orderHash = stockRouter.hash(order);
        _seedInventory(address(stockRouter), orderHash, BAL_IN, BAL_OUT);

        vm.prank(taker);
        vm.expectRevert();
        stockRouter.quote(order, address(tokenIn), address(tokenOut), 10e18, takerData);
    }

    function test_ZyroOpcode_ExecutesOnZyroRouter() public {
        bytes memory program = _zyroProgram(0.1e18, 0.1e18, 0, 1_000e18, 500e18, 1 days, uint40(block.timestamp));
        ISwapVM.Order memory order = _order(program);
        bytes memory takerData = _takerData(true);

        bytes32 orderHash = zyroRouter.hash(order);
        _seedInventory(address(zyroRouter), orderHash, BAL_IN, BAL_OUT);

        vm.prank(taker);
        (, uint256 amountOut,) =
            zyroRouter.quote(order, address(tokenIn), address(tokenOut), 10e18, takerData);

        assertGt(amountOut, 0, "the Zyro instruction must execute and produce a quote");
    }

    // =====================================================================
    // The mechanism, observed end to end through the VM
    // =====================================================================

    /// @dev At exactly target, with no base spread and no time left, the skew
    ///      term is zero and Zyro must degrade into the stock constant-product
    ///      quote. This is the "it is a property of the formula, not a special
    ///      case in code" claim, tested through the real VM rather than against
    ///      the kernel in isolation.
    function test_AtTarget_WithNoSpread_MatchesStockQuote() public {
        bytes memory stock = _stockProgram();
        ISwapVM.Order memory stockOrder = _order(stock);

        // gamma = 0 kills the risk term; baseSpread = 0 kills the flat spread;
        // target == balanceIn puts q at exactly zero.
        bytes memory zyro = _zyroProgram(0, 0, 0, int256(BAL_IN), 0, 1 days, uint40(block.timestamp));
        ISwapVM.Order memory zyroOrder = _order(zyro);

        bytes memory takerData = _takerData(true);

        _seedInventory(address(stockRouter), stockRouter.hash(stockOrder), BAL_IN, BAL_OUT);
        _seedInventory(address(zyroRouter), zyroRouter.hash(zyroOrder), BAL_IN, BAL_OUT);

        vm.prank(taker);
        (, uint256 stockOut,) =
            stockRouter.quote(stockOrder, address(tokenIn), address(tokenOut), 10e18, takerData);

        vm.prank(taker);
        (, uint256 zyroOut,) =
            zyroRouter.quote(zyroOrder, address(tokenIn), address(tokenOut), 10e18, takerData);

        // Re-centring onto the price the pair already implies is a no-op up to
        // integer-sqrt rounding.
        assertApproxEqRel(zyroOut, stockOut, 1e12, "at target Zyro must quote the stock price");
    }

    /// @dev Holding too much tokenIn: the position is exposed, and taking more
    ///      must cost the taker more than the stock curve would charge.
    function test_ExposedInventory_QuotesWorseThanStock() public {
        uint256 amount = 10e18;
        bytes memory takerData = _takerData(true);

        ISwapVM.Order memory stockOrder = _order(_stockProgram());
        _seedInventory(address(stockRouter), stockRouter.hash(stockOrder), BAL_IN, BAL_OUT);

        vm.prank(taker);
        (, uint256 stockOut,) =
            stockRouter.quote(stockOrder, address(tokenIn), address(tokenOut), amount, takerData);

        // Target far below the live balance => q > 0 => exposed.
        ISwapVM.Order memory zyroOrder = _order(
            _zyroProgram(0.5e18, 0.2e18, 0, int256(BAL_IN / 2), int256(BAL_IN), 1 days, uint40(block.timestamp))
        );
        _seedInventory(address(zyroRouter), zyroRouter.hash(zyroOrder), BAL_IN, BAL_OUT);

        vm.prank(taker);
        (, uint256 zyroOut,) =
            zyroRouter.quote(zyroOrder, address(tokenIn), address(tokenOut), amount, takerData);

        assertLt(zyroOut, stockOut, "an exposed position must quote worse than the stock curve");
    }

    /// @dev Holding too little: the position is covered, wants the flow, and
    ///      must quote better than the stock curve to attract it.
    function test_CoveredInventory_QuotesBetterThanStock() public {
        uint256 amount = 10e18;
        bytes memory takerData = _takerData(true);

        ISwapVM.Order memory stockOrder = _order(_stockProgram());
        _seedInventory(address(stockRouter), stockRouter.hash(stockOrder), BAL_IN, BAL_OUT);

        vm.prank(taker);
        (, uint256 stockOut,) =
            stockRouter.quote(stockOrder, address(tokenIn), address(tokenOut), amount, takerData);

        // Target far above the live balance => q < 0 => covered.
        ISwapVM.Order memory zyroOrder = _order(
            _zyroProgram(0.5e18, 0.2e18, 0, int256(BAL_IN * 2), int256(BAL_IN), 1 days, uint40(block.timestamp))
        );
        _seedInventory(address(zyroRouter), zyroRouter.hash(zyroOrder), BAL_IN, BAL_OUT);

        vm.prank(taker);
        (, uint256 zyroOut,) =
            zyroRouter.quote(zyroOrder, address(tokenIn), address(tokenOut), amount, takerData);

        assertGt(zyroOut, stockOut, "a covered position must quote better than the stock curve");
    }

    // =====================================================================
    // Parameter validation reaches the VM
    // =====================================================================

    /// @dev The kernel's guard has to be wired into `exec`, not merely to exist.
    ///      Without this, a missing `validate()` call is invisible.
    function test_NegativeGammaInProgram_Reverts() public {
        bytes memory program =
            _zyroProgram(-1, 0.1e18, 0, int256(BAL_IN), 0, 1 days, uint40(block.timestamp));
        ISwapVM.Order memory order = _order(program);
        bytes memory takerData = _takerData(true);

        _seedInventory(address(zyroRouter), zyroRouter.hash(order), BAL_IN, BAL_OUT);

        vm.prank(taker);
        vm.expectRevert();
        zyroRouter.quote(order, address(tokenIn), address(tokenOut), 10e18, takerData);
    }

    function test_FutureStartTimestamp_Reverts() public {
        bytes memory program = _zyroProgram(
            0.1e18, 0.1e18, 0, int256(BAL_IN), 0, 1 days, uint40(block.timestamp + 1)
        );
        ISwapVM.Order memory order = _order(program);
        bytes memory takerData = _takerData(true);

        _seedInventory(address(zyroRouter), zyroRouter.hash(order), BAL_IN, BAL_OUT);

        vm.prank(taker);
        vm.expectRevert();
        zyroRouter.quote(order, address(tokenIn), address(tokenOut), 10e18, takerData);
    }
}
