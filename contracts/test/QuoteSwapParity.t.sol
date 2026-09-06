// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ISwapVM} from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";

import {ZyroTestBase} from "./helpers/ZyroTestBase.sol";

/// @notice The file that matters most.
///
/// @dev A normal AMM prices off pool reserves — identical for everyone, at any
///      time. Zyro prices off a specific maker's live wallet balance **plus the
///      clock**. That is far more state, and therefore far more surface for a
///      quote to disagree with the execution that follows it.
///
///      SwapVM hands every instruction an `isStaticContext` flag saying whether
///      it is inside a read-only `quote()` or a real `swap()`, which makes it
///      trivially easy to introduce exactly that bug. `ZyroInventorySkew` must
///      never read that flag, and this file is what proves it: `quote()` sets
///      the flag `true` and `swap()` sets it `false`, so if the instruction ever
///      branched on it, these assertions would fail.
///
///      If a taker cannot trust that the price they were quoted is the price
///      they get, nothing else about the mechanism matters.
contract QuoteSwapParityTest is ZyroTestBase {
    uint256 internal constant FUNDING = 1e33;

    /// @dev Quote, then execute the identical order in the same block, and
    ///      require the two to agree.
    ///
    ///      Parity is the conjunction of two claims, and both are asserted:
    ///
    ///      1. **They agree on whether the trade is possible at all.** A quote
    ///         that reverts must be matched by a swap that reverts. A taker
    ///         handed a revert must not be able to force the trade through, and
    ///         a taker handed a price must not be turned away.
    ///      2. **They agree on the numbers.** When both succeed, `amountIn` and
    ///         `amountOut` must be equal, not merely close.
    ///
    ///      There is exactly one legitimate way for the swap to fail after a
    ///      *successful* quote: the re-centred curve promised more `tokenOut`
    ///      than the maker holds, and Aqua's settlement pull refuses. That is
    ///      the documented failure mode of §18, and the catch branch asserts the
    ///      quote really did over-promise rather than swallowing whatever went
    ///      wrong — any other revert would otherwise slip past unnoticed.
    function _assertParity(
        ISwapVM.Order memory order,
        uint256 balanceIn,
        uint256 balanceOut,
        uint256 amount,
        bool isExactIn
    ) internal {
        bytes32 orderHash = zyroRouter.hash(order);
        _seedInventory(address(zyroRouter), orderHash, balanceIn, balanceOut);
        _fundForSwap(address(zyroRouter), FUNDING, FUNDING);

        bytes memory takerData = _takerData(isExactIn);

        uint256 takerFunds = tokenIn.balanceOf(taker);

        vm.prank(taker);
        try zyroRouter.quote(order, address(tokenIn), address(tokenOut), amount, takerData)
        returns (uint256 quotedIn, uint256 quotedOut, bytes32) {
            vm.prank(taker);
            try zyroRouter.swap(order, address(tokenIn), address(tokenOut), amount, takerData)
            returns (uint256 actualIn, uint256 actualOut, bytes32) {
                assertEq(
                    quotedIn, actualIn, "quote/swap divergence in amountIn at this inventory state"
                );
                assertEq(
                    quotedOut,
                    actualOut,
                    "quote/swap divergence in amountOut at this inventory state"
                );
            } catch {
                // Exactly two things can legitimately fail at settlement after a
                // successful quote, and the assertion names both rather than
                // swallowing whatever went wrong:
                //
                //   1. the re-centred curve promised more tokenOut than the
                //      maker holds (§18's documented failure mode); or
                //   2. on the exact-output path, the derived amountIn exceeds
                //      what the taker actually has — a rotated curve can demand
                //      an enormous input for a small output.
                //
                // Anything else is a parity bug and must fail here.
                assertTrue(
                    quotedOut > balanceOut || quotedIn > takerFunds,
                    "swap reverted for a reason other than either side being unable to pay"
                );
            }
        } catch {
            // An unquotable state must be an unswappable one.
            vm.prank(taker);
            vm.expectRevert();
            zyroRouter.swap(order, address(tokenIn), address(tokenOut), amount, takerData);
        }
    }

    // =====================================================================
    // The property, fuzzed
    // =====================================================================

    /// @dev Fuzz-bound discipline, per §17: `balanceOut` is bounded relative to
    ///      `balanceIn` (0.2x–5x) and the inventory imbalance relative to the
    ///      shipped balance, because an arbitrarily lopsided starting pool is a
    ///      misconfiguration rather than a parity bug.
    ///
    ///      `gamma` and `sigmaSq` are bounded non-negative **here only**,
    ///      because a negative value reverts in `quote()` and `swap()` alike,
    ///      which says nothing about parity. The signs are tested explicitly in
    ///      `AvellanedaStoikov.t.sol` and `ZyroRouter.t.sol` — bounding them
    ///      non-negative and calling that coverage is what hid the defect
    ///      before.
    ///
    ///      They are additionally bounded to a *realistic* magnitude so that
    ///      most runs land in the regime the mechanism actually operates in,
    ///      rather than pinning the effective price to its floor of 1 and
    ///      testing the clamp over and over.
    function testFuzz_QuoteMatchesSwap(
        uint256 balanceIn,
        uint256 balanceOut,
        uint256 amount,
        int128 gammaWad,
        int128 sigmaSqWad,
        int128 baseSpreadWad,
        uint32 horizonSecs,
        uint256 elapsed,
        int256 target
    ) public {
        balanceIn = bound(balanceIn, 1e18, 1e24);
        balanceOut = bound(balanceOut, balanceIn / 5, balanceIn * 5);
        amount = bound(amount, 1e12, balanceIn / 10);

        gammaWad = int128(int256(bound(int256(gammaWad), 0, 1e15)));
        sigmaSqWad = int128(int256(bound(int256(sigmaSqWad), 0, 1e15)));
        baseSpreadWad = int128(int256(bound(int256(baseSpreadWad), 0, 1e16)));
        horizonSecs = uint32(bound(uint256(horizonSecs), 1, 365 days));
        elapsed = bound(elapsed, 0, 2 * uint256(horizonSecs));

        // Imbalance bounded relative to the shipped balance, and spanning both
        // sides of target so exposed and covered flow are both exercised.
        target = bound(target, int256(balanceIn) / 4, int256(balanceIn) * 4);

        uint40 start = uint40(block.timestamp);
        vm.warp(block.timestamp + elapsed);

        ISwapVM.Order memory order = _order(
            _zyroProgram(
                gammaWad, sigmaSqWad, baseSpreadWad, target, int256(balanceIn), horizonSecs, start
            )
        );

        _assertParity(order, balanceIn, balanceOut, amount, true);
    }

    /// @dev Parity must hold on the exact-output path too, which takes a
    ///      different branch through `XYCSwap` and derives `amountIn` rather
    ///      than `amountOut`.
    function testFuzz_QuoteMatchesSwap_ExactOut(
        uint256 balanceIn,
        uint256 balanceOut,
        uint256 amount,
        int128 gammaWad,
        uint256 elapsed,
        int256 target
    ) public {
        balanceIn = bound(balanceIn, 1e20, 1e24);
        balanceOut = bound(balanceOut, balanceIn / 5, balanceIn * 5);
        amount = bound(amount, 1e12, balanceOut / 100);

        gammaWad = int128(int256(bound(int256(gammaWad), 0, 1e15)));
        elapsed = bound(elapsed, 0, 2 days);
        target = bound(target, int256(balanceIn) / 4, int256(balanceIn) * 4);

        uint40 start = uint40(block.timestamp);
        vm.warp(block.timestamp + elapsed);

        ISwapVM.Order memory order = _order(
            _zyroProgram(gammaWad, SIGMA_SQ_WAD, BASE_SPREAD_WAD, target, int256(balanceIn), HORIZON, start)
        );

        _assertParity(order, balanceIn, balanceOut, amount, false);
    }

    // =====================================================================
    // Explicit cases at, and past, the soft bound
    //
    // The penalty ramp is the one place where the output depends on a second,
    // independently-derived quantity. §17 requires these be pinned rather than
    // left to the fuzzer to stumble into.
    // =====================================================================

    uint256 internal constant BAL_IN = 1_000e18;
    uint256 internal constant BAL_OUT = 2_000e18;

    function test_Parity_ExactlyAtSoftBound() public {
        int256 target = 500e18;
        int256 bound_ = int256(BAL_IN) - target; // |q| == bound exactly

        ISwapVM.Order memory order = _order(
            _zyroProgram(
                GAMMA_WAD, SIGMA_SQ_WAD, BASE_SPREAD_WAD, target, bound_, HORIZON, uint40(block.timestamp)
            )
        );
        _assertParity(order, BAL_IN, BAL_OUT, 10e18, true);
    }

    function test_Parity_PastSoftBound() public {
        int256 target = 100e18;
        int256 bound_ = 50e18; // |q| = 900e18: far past the bound, penalty clamped

        ISwapVM.Order memory order = _order(
            _zyroProgram(
                GAMMA_WAD, SIGMA_SQ_WAD, BASE_SPREAD_WAD, target, bound_, HORIZON, uint40(block.timestamp)
            )
        );
        _assertParity(order, BAL_IN, BAL_OUT, 10e18, true);
    }

    function test_Parity_JustInsideSoftBound() public {
        int256 target = 900e18;
        int256 bound_ = 200e18; // |q| = 100e18: half way up the ramp

        ISwapVM.Order memory order = _order(
            _zyroProgram(
                GAMMA_WAD, SIGMA_SQ_WAD, BASE_SPREAD_WAD, target, bound_, HORIZON, uint40(block.timestamp)
            )
        );
        _assertParity(order, BAL_IN, BAL_OUT, 10e18, true);
    }

    function test_Parity_CoveredSide() public {
        int256 target = 1_500e18; // q = -500e18: the position wants tokenIn

        ISwapVM.Order memory order = _order(
            _zyroProgram(
                GAMMA_WAD, SIGMA_SQ_WAD, BASE_SPREAD_WAD, target, 500e18, HORIZON, uint40(block.timestamp)
            )
        );
        _assertParity(order, BAL_IN, BAL_OUT, 10e18, true);
    }

    function test_Parity_AtTarget() public {
        ISwapVM.Order memory order = _order(
            _zyroProgram(
                GAMMA_WAD,
                SIGMA_SQ_WAD,
                BASE_SPREAD_WAD,
                int256(BAL_IN),
                500e18,
                HORIZON,
                uint40(block.timestamp)
            )
        );
        _assertParity(order, BAL_IN, BAL_OUT, 10e18, true);
    }

    /// @dev Once the horizon is consumed the position stops defending itself.
    ///      Parity still has to hold there — a degraded position is not an
    ///      excuse for a quote that lies.
    function test_Parity_AfterHorizonExpiry() public {
        uint40 start = uint40(block.timestamp);

        ISwapVM.Order memory order = _order(
            _zyroProgram(GAMMA_WAD, SIGMA_SQ_WAD, BASE_SPREAD_WAD, 500e18, 200e18, HORIZON, start)
        );

        vm.warp(block.timestamp + 30 days);
        _assertParity(order, BAL_IN, BAL_OUT, 10e18, true);
    }

    // =====================================================================
    // The tested failure mode (§18)
    // =====================================================================

    /// @dev A grossly misconfigured strategy can re-centre the curve to promise
    ///      more `tokenOut` than the maker actually holds.
    ///
    ///      It is the **covered** side that does this: a target far *above* the
    ///      live balance pushes the reservation price up, and rotating the curve
    ///      to that price inflates the effective `balanceOut` well beyond the
    ///      real inventory behind it. (The exposed side cannot: it drives the
    ///      price down, and the effective price floors at 1.)
    ///
    ///      The stock `DutchAuctionBalanceOut` instruction has the same
    ///      characteristic by design, and Aqua's settlement pull is the backstop
    ///      either way. What matters is that it **fails safely** — the swap must
    ///      revert rather than silently under- or over-paying. Turning a known
    ///      limitation into a named passing test converts a surprise into a
    ///      documented safety property.
    function test_InsolventSkew_SwapRevertsSafely() public {
        // Target three orders of magnitude above the shipped balance, at maximum
        // risk aversion over a year: the reservation price runs away upward.
        ISwapVM.Order memory order =
            _order(_zyroProgram(1e18, 1e18, 0, 1e24, 0, 365 days, uint40(block.timestamp)));

        bytes32 orderHash = zyroRouter.hash(order);
        _seedInventory(address(zyroRouter), orderHash, BAL_IN, BAL_OUT);
        _fundForSwap(address(zyroRouter), FUNDING, FUNDING);

        bytes memory takerData = _takerData(true);

        // The quote is happy to promise it...
        vm.prank(taker);
        (, uint256 quotedOut,) =
            zyroRouter.quote(order, address(tokenIn), address(tokenOut), 10e18, takerData);
        assertGt(quotedOut, BAL_OUT, "fixture did not actually over-promise");

        // ...and settlement refuses to pay it.
        vm.prank(taker);
        vm.expectRevert();
        zyroRouter.swap(order, address(tokenIn), address(tokenOut), 10e18, takerData);
    }
}
