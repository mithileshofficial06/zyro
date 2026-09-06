// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {AvellanedaStoikov as AS} from "../src/libs/AvellanedaStoikov.sol";
import {KernelHarness} from "./helpers/KernelHarness.sol";

/// @notice Property tests for the Zyro pricing kernel.
///
/// @dev These assert *properties*, not single input/output pairs. A pinned
///      input/output table would pass just as happily against a kernel with an
///      inverted sign, which is the defect this suite exists to make
///      impossible (see the "sign inversion" section at the bottom).
contract AvellanedaStoikovTest is Test {
    KernelHarness internal h;

    int256 internal constant WAD = 1e18;
    int256 internal constant MAX_PARAM = 1e18;
    uint256 internal constant MAX_HORIZON = 365 days;

    function setUp() public {
        h = new KernelHarness();
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    /// @dev Builds a parameter set already inside the validated range, so a
    ///      property test exercises the model rather than the guard.
    function _validParams(
        int256 gammaWad,
        int256 sigmaSqWad,
        int256 baseSpreadWad,
        uint256 horizonSecs
    ) internal pure returns (AS.Params memory p) {
        p = AS.Params({
            gammaWad: _boundInt(gammaWad, 0, MAX_PARAM),
            sigmaSqWad: _boundInt(sigmaSqWad, 0, MAX_PARAM),
            baseSpreadWad: _boundInt(baseSpreadWad, 0, MAX_PARAM),
            horizonSecs: horizonSecs % (MAX_HORIZON + 1)
        });
    }

    function _boundInt(int256 x, int256 lo, int256 hi) internal pure returns (int256) {
        uint256 span = uint256(hi - lo) + 1;
        uint256 offset = uint256(x < 0 ? ~uint256(x) + 1 : uint256(x)) % span;
        return lo + int256(offset);
    }

    // =====================================================================
    // Property 1 -- zero inventory produces zero skew, at any gamma, sigmaSq,
    // elapsed. This is the "degrades into an ordinary AMM at target" claim,
    // and it must be a property of the formula rather than a branch in code.
    // =====================================================================

    function testFuzz_ZeroInventory_ProducesZeroSkew(
        int256 gammaWad,
        int256 sigmaSqWad,
        int256 baseSpreadWad,
        uint256 horizonSecs,
        uint256 elapsed,
        int256 mid
    ) public view {
        AS.Params memory p = _validParams(gammaWad, sigmaSqWad, baseSpreadWad, horizonSecs);
        elapsed = bound(elapsed, 0, MAX_HORIZON);
        mid = _boundInt(mid, 1, int256(1e30));

        assertEq(
            h.reservationPriceWad(mid, 0, p, elapsed),
            mid,
            "at target the reservation price must be exactly the mid"
        );
    }

    /// @dev The stronger form of the same claim, end to end: at target, with no
    ///      spread and no risk term, the curve must come back untouched.
    function testFuzz_AtTargetWithNoSpread_LeavesCurveUnchanged(
        uint256 balanceIn,
        uint256 balanceOut
    ) public view {
        balanceIn = bound(balanceIn, 1e18, 1e30);
        balanceOut = bound(balanceOut, 1e18, 1e30);

        // gamma = 0 kills the risk term; baseSpread = 0 kills the flat spread.
        AS.Params memory p = AS.Params(0, 0, 0, 1 days);

        (uint256 newIn, uint256 newOut) = h.applyInventorySkew(balanceIn, balanceOut, 0, p, 0, 0);

        // Re-centring onto the price the pair already implies is a no-op up to
        // integer-sqrt rounding, so compare depth and price rather than bytes.
        assertApproxEqRel(newIn, balanceIn, 1e12, "balanceIn moved at target");
        assertApproxEqRel(newOut, balanceOut, 1e12, "balanceOut moved at target");
    }

    // =====================================================================
    // Property 2 -- the reservation price falls monotonically as inventory rises.
    // =====================================================================

    function testFuzz_ReservationPrice_FallsMonotonicallyAsInventoryRises(
        int256 gammaWad,
        int256 sigmaSqWad,
        uint256 horizonSecs,
        uint256 elapsed,
        int256 qLow,
        int256 qHigh
    ) public view {
        AS.Params memory p = _validParams(gammaWad, sigmaSqWad, 0, horizonSecs);
        elapsed = bound(elapsed, 0, MAX_HORIZON);
        qLow = _boundInt(qLow, -1e30, 1e30);
        qHigh = _boundInt(qHigh, -1e30, 1e30);
        if (qLow > qHigh) (qLow, qHigh) = (qHigh, qLow);

        int256 mid = 1e18;
        assertLe(
            h.reservationPriceWad(mid, qHigh, p, elapsed),
            h.reservationPriceWad(mid, qLow, p, elapsed),
            "more inventory must never raise the reservation price"
        );
    }

    // =====================================================================
    // Property 3 -- the half-spread shrinks as the horizon is consumed and
    // never falls below the maker's declared base spread.
    // =====================================================================

    function testFuzz_HalfSpread_ShrinksAsHorizonIsConsumed(
        int256 gammaWad,
        int256 sigmaSqWad,
        int256 baseSpreadWad,
        uint256 horizonSecs,
        uint256 elapsedEarly,
        uint256 elapsedLate
    ) public view {
        AS.Params memory p = _validParams(gammaWad, sigmaSqWad, baseSpreadWad, horizonSecs);
        elapsedEarly = bound(elapsedEarly, 0, MAX_HORIZON);
        elapsedLate = bound(elapsedLate, 0, MAX_HORIZON);
        if (elapsedEarly > elapsedLate) (elapsedEarly, elapsedLate) = (elapsedLate, elapsedEarly);

        int256 early = h.halfSpreadWad(p, elapsedEarly);
        int256 late = h.halfSpreadWad(p, elapsedLate);

        assertLe(late, early, "spread must not widen as the horizon is consumed");
        assertGe(late, p.baseSpreadWad, "spread must never fall below the base spread");
        assertGe(early, p.baseSpreadWad, "spread must never fall below the base spread");
    }

    /// @dev The horizon expiring is the most surprising behaviour in the whole
    ///      system: every time-dependent term vanishes and the position quietly
    ///      becomes a constant-product AMM with a flat spread. Pin it as a
    ///      named, passing test so it is documented rather than discovered.
    function testFuzz_HorizonExpiry_LeavesOnlyTheBaseSpread(
        int256 gammaWad,
        int256 sigmaSqWad,
        int256 baseSpreadWad,
        uint256 horizonSecs,
        uint256 overshoot
    ) public view {
        AS.Params memory p = _validParams(gammaWad, sigmaSqWad, baseSpreadWad, horizonSecs);
        overshoot = bound(overshoot, 0, 3650 days);
        uint256 elapsed = p.horizonSecs + overshoot;

        assertEq(h.remaining(p, elapsed), 0, "horizon must floor at zero");
        assertEq(h.riskTermWad(p, elapsed), 0, "risk term must vanish at expiry");
        assertEq(
            h.halfSpreadWad(p, elapsed), p.baseSpreadWad, "only the base spread may survive expiry"
        );
        assertEq(
            h.reservationPriceWad(1e18, 1e24, p, elapsed),
            1e18,
            "an expired horizon must stop skewing entirely"
        );
    }

    // =====================================================================
    // Property 4 -- the soft-bound penalty ramps linearly and clamps at 500 bps.
    // =====================================================================

    function testFuzz_BoundPenalty_RampsLinearlyAndClamps(int256 q, int256 bound_) public view {
        q = _boundInt(q, -1e30, 1e30);
        bound_ = _boundInt(bound_, 1, 1e30);

        uint256 penalty = h.softBoundPenaltyBps(q, bound_);
        assertLe(penalty, AS.MAX_PENALTY_BPS, "penalty must clamp at 500 bps");

        uint256 absQ = q < 0 ? uint256(-q) : uint256(q);
        if (absQ >= uint256(bound_)) {
            assertEq(penalty, AS.MAX_PENALTY_BPS, "at or past the bound the penalty is maxed");
        } else {
            assertEq(
                penalty,
                (absQ * AS.MAX_PENALTY_BPS) / uint256(bound_),
                "penalty must ramp linearly below the bound"
            );
        }
    }

    /// @dev The ramp is symmetric in the sign of `q`: it measures distance from
    ///      target, not direction. Direction is handled by side selection.
    function testFuzz_BoundPenalty_IsSymmetricInSign(int256 q, int256 bound_) public view {
        q = _boundInt(q, 1, 1e30);
        bound_ = _boundInt(bound_, 1, 1e30);
        assertEq(
            h.softBoundPenaltyBps(q, bound_),
            h.softBoundPenaltyBps(-q, bound_),
            "penalty must depend on |q| only"
        );
    }

    function testFuzz_BoundPenalty_IsMonotonicInDistance(int256 qLow, int256 qHigh, int256 bound_)
        public
        view
    {
        qLow = _boundInt(qLow, 0, 1e30);
        qHigh = _boundInt(qHigh, 0, 1e30);
        bound_ = _boundInt(bound_, 1, 1e30);
        if (qLow > qHigh) (qLow, qHigh) = (qHigh, qLow);

        assertLe(
            h.softBoundPenaltyBps(qLow, bound_),
            h.softBoundPenaltyBps(qHigh, bound_),
            "drifting further must never reduce the penalty"
        );
    }

    // =====================================================================
    // Property 5 -- a zero bound produces a zero penalty (no division by zero,
    // and "no bound declared" must mean "no penalty", not "always maxed").
    // =====================================================================

    function testFuzz_ZeroBound_ProducesZeroPenalty(int256 q) public view {
        q = _boundInt(q, -1e30, 1e30);
        assertEq(h.softBoundPenaltyBps(q, 0), 0, "an undeclared bound must not penalise");
    }

    // =====================================================================
    // Property 6 -- exposed-side pricing is strictly worse for the taker than
    // covered-side pricing at the same |q|. This is Avellaneda-Stoikov's
    // bid/ask asymmetry, expressed as which side of `r` the call lands on.
    // =====================================================================

    function testFuzz_ExposedSide_PricesStrictlyWorseThanCovered(
        int256 gammaWad,
        int256 sigmaSqWad,
        int256 baseSpreadWad,
        uint256 horizonSecs,
        uint256 elapsed,
        int256 q
    ) public view {
        // Strictness needs a strictly positive spread; with delta == 0 and
        // q == 0 the two sides legitimately coincide.
        AS.Params memory p = _validParams(gammaWad, sigmaSqWad, baseSpreadWad, horizonSecs);
        p.baseSpreadWad = _boundInt(baseSpreadWad, 1, 1e15);
        elapsed = bound(elapsed, 0, MAX_HORIZON);
        q = _boundInt(q, 1, 1e24);

        int256 mid = 1e18;
        int256 delta = h.halfSpreadWad(p, elapsed);

        int256 exposedPrice = h.reservationPriceWad(mid, q, p, elapsed) - delta;
        int256 coveredPrice = h.reservationPriceWad(mid, -q, p, elapsed) + delta;

        assertLt(
            exposedPrice,
            coveredPrice,
            "the exposed side must always quote a worse price than the covered side"
        );
    }

    /// @dev The same asymmetry, observed through the balances the VM actually
    ///      consumes rather than through the intermediate price.
    function testFuzz_ExposedSide_OutputNeverBetterThanCovered(
        int256 gammaWad,
        int256 sigmaSqWad,
        int256 baseSpreadWad,
        uint256 horizonSecs,
        uint256 elapsed,
        uint256 balanceIn,
        uint256 balanceOut,
        int256 q
    ) public view {
        AS.Params memory p = _validParams(gammaWad, sigmaSqWad, baseSpreadWad, horizonSecs);
        elapsed = bound(elapsed, 0, MAX_HORIZON);
        balanceIn = bound(balanceIn, 1e18, 1e27);
        balanceOut = bound(balanceOut, balanceIn / 5, balanceIn * 5);
        q = _boundInt(q, 1, int256(1e24));

        (, uint256 exposedOut) = h.applyInventorySkew(balanceIn, balanceOut, q, p, elapsed, 0);
        (, uint256 coveredOut) = h.applyInventorySkew(balanceIn, balanceOut, -q, p, elapsed, 0);

        assertLe(exposedOut, coveredOut, "exposed-side flow must never receive more tokenOut");
    }

    // =====================================================================
    // Property 7 -- the bound penalty actually reduces exposed-side output, and
    // never touches covered-side output. Covered flow is exactly what the
    // position wants to attract as it nears its bound.
    // =====================================================================

    function testFuzz_BoundPenalty_ReducesExposedOutput(
        int256 gammaWad,
        int256 sigmaSqWad,
        int256 baseSpreadWad,
        uint256 horizonSecs,
        uint256 elapsed,
        uint256 balanceIn,
        uint256 balanceOut,
        int256 q,
        int256 bound_
    ) public view {
        AS.Params memory p = _validParams(gammaWad, sigmaSqWad, baseSpreadWad, horizonSecs);
        elapsed = bound(elapsed, 0, MAX_HORIZON);
        balanceIn = bound(balanceIn, 1e20, 1e27);
        balanceOut = bound(balanceOut, balanceIn / 5, balanceIn * 5);
        q = _boundInt(q, 1e18, 1e24);
        // A bound at or below |q| maxes the ramp, guaranteeing a visible cut.
        bound_ = _boundInt(bound_, 1, q);

        (, uint256 withoutPenalty) = h.applyInventorySkew(balanceIn, balanceOut, q, p, elapsed, 0);
        (, uint256 withPenalty) = h.applyInventorySkew(balanceIn, balanceOut, q, p, elapsed, bound_);

        assertLt(withPenalty, withoutPenalty, "the soft bound must reduce exposed-side output");
    }

    function testFuzz_BoundPenalty_NeverTouchesCoveredSide(
        int256 gammaWad,
        int256 sigmaSqWad,
        int256 baseSpreadWad,
        uint256 horizonSecs,
        uint256 elapsed,
        uint256 balanceIn,
        uint256 balanceOut,
        int256 q,
        int256 bound_
    ) public view {
        AS.Params memory p = _validParams(gammaWad, sigmaSqWad, baseSpreadWad, horizonSecs);
        elapsed = bound(elapsed, 0, MAX_HORIZON);
        balanceIn = bound(balanceIn, 1e20, 1e27);
        balanceOut = bound(balanceOut, balanceIn / 5, balanceIn * 5);
        q = _boundInt(q, -1e24, -1);
        bound_ = _boundInt(bound_, 1, 1e24);

        (, uint256 noBound) = h.applyInventorySkew(balanceIn, balanceOut, q, p, elapsed, 0);
        (, uint256 withBound) = h.applyInventorySkew(balanceIn, balanceOut, q, p, elapsed, bound_);

        assertEq(withBound, noBound, "covered-side flow must never pay the soft-bound penalty");
    }

    // =====================================================================
    // Property 8 -- re-centring preserves depth and hits the target price.
    // The curve is rotated, not reshaped.
    // =====================================================================

    function testFuzz_Recenter_PreservesDepthAndHitsTargetPrice(
        uint256 balanceIn,
        uint256 balanceOut,
        int256 price
    ) public view {
        balanceIn = bound(balanceIn, 1e18, 1e30);
        balanceOut = bound(balanceOut, 1e18, 1e30);
        price = _boundInt(price, 1e15, 1e21);

        uint256 k = balanceIn * balanceOut;
        (uint256 newIn, uint256 newOut) = h.recenterBalances(balanceIn, balanceOut, price);

        // Depth is held constant up to the flooring in `newOut = k / newIn`.
        uint256 newK = newIn * newOut;
        assertLe(newK, k, "re-centring must never manufacture depth");
        assertLt(k - newK, newIn, "depth loss must be bounded by one flooring step");

        // And the rotated pair implies the price we asked for.
        assertApproxEqRel(
            uint256(h.midFromBalancesWad(newIn, newOut)),
            uint256(price),
            1e12,
            "re-centred pair must imply the target price"
        );
    }

    function test_Recenter_NonPositivePrice_ReturnsInputsUnchanged() public view {
        (uint256 a, uint256 b) = h.recenterBalances(1e21, 2e21, 0);
        assertEq(a, 1e21);
        assertEq(b, 2e21);

        (uint256 c, uint256 d) = h.recenterBalances(1e21, 2e21, -1);
        assertEq(c, 1e21, "a non-positive price must be a no-op, not a revert");
        assertEq(d, 2e21);
    }

    function test_MidFromBalances_ZeroBalanceIn_ReturnsZero() public view {
        assertEq(h.midFromBalancesWad(0, 1e21), 0, "must not divide by zero");
    }

    // =====================================================================
    // Sign inversion -- the defect this suite exists to make impossible.
    //
    // `Params` types gamma and sigmaSq as int256 and the SwapVM wire format
    // packs them as int128, so a negative value is representable end to end.
    // Feed one in and `r = mid - skew` becomes `r = mid + skew`: the position
    // quotes *better* prices the further it drifts from target, paying takers
    // to worsen its own inventory.
    //
    // Every property above still holds under sign inversion, because they all
    // bound gamma and sigmaSq over non-negative ranges. The bound that makes
    // those tests pass is the bound that hides the bug -- so the signs are
    // tested explicitly, here.
    // =====================================================================

    function test_NegativeGamma_Reverts() public {
        AS.Params memory p = AS.Params(-1, 1e17, 1e15, 1 days);
        vm.expectRevert(abi.encodeWithSelector(AS.NegativeGamma.selector, int256(-1)));
        h.validate(p);
    }

    function test_NegativeSigmaSq_Reverts() public {
        AS.Params memory p = AS.Params(1e17, -1, 1e15, 1 days);
        vm.expectRevert(abi.encodeWithSelector(AS.NegativeSigmaSq.selector, int256(-1)));
        h.validate(p);
    }

    function test_NegativeBaseSpread_Reverts() public {
        AS.Params memory p = AS.Params(1e17, 1e17, -1, 1 days);
        vm.expectRevert(abi.encodeWithSelector(AS.NegativeBaseSpread.selector, int256(-1)));
        h.validate(p);
    }

    function test_GammaAboveCap_Reverts() public {
        AS.Params memory p = AS.Params(1e18 + 1, 1e17, 1e15, 1 days);
        vm.expectRevert(abi.encodeWithSelector(AS.GammaTooLarge.selector, int256(1e18 + 1)));
        h.validate(p);
    }

    function test_SigmaSqAboveCap_Reverts() public {
        AS.Params memory p = AS.Params(1e17, 1e18 + 1, 1e15, 1 days);
        vm.expectRevert(abi.encodeWithSelector(AS.SigmaSqTooLarge.selector, int256(1e18 + 1)));
        h.validate(p);
    }

    function test_BaseSpreadAboveCap_Reverts() public {
        AS.Params memory p = AS.Params(1e17, 1e17, 1e18 + 1, 1 days);
        vm.expectRevert(abi.encodeWithSelector(AS.BaseSpreadTooLarge.selector, int256(1e18 + 1)));
        h.validate(p);
    }

    function test_HorizonTooLong_Reverts() public {
        AS.Params memory p = AS.Params(1e17, 1e17, 1e15, MAX_HORIZON + 1);
        vm.expectRevert(
            abi.encodeWithSelector(AS.HorizonTooLong.selector, uint256(MAX_HORIZON + 1))
        );
        h.validate(p);
    }

    function test_ParamsAtCap_AreAccepted() public view {
        // The caps are an overflow guard, not an opinion about market making --
        // the boundary itself must be usable.
        h.validate(AS.Params(1e18, 1e18, 1e18, MAX_HORIZON));
    }

    /// @notice The headline regression: over **signed** gamma and sigmaSq, a
    ///         position must never end up quoting better as it drifts further
    ///         from target.
    ///
    /// @dev Either `validate` rejects the parameters, or the skew points the
    ///      right way. There is no third outcome. Fuzzing this over a signed
    ///      range is the whole point -- restricting it to non-negative values
    ///      is precisely what concealed the defect before.
    function testFuzz_ReservationPrice_NeverRewardsDrift(
        int256 gammaWad,
        int256 sigmaSqWad,
        int256 baseSpreadWad,
        uint256 horizonSecs,
        uint256 elapsed,
        int256 q
    ) public {
        gammaWad = _boundInt(gammaWad, -1e18, 1e18);
        sigmaSqWad = _boundInt(sigmaSqWad, -1e18, 1e18);
        baseSpreadWad = _boundInt(baseSpreadWad, -1e18, 1e18);
        horizonSecs = bound(horizonSecs, 0, MAX_HORIZON);
        elapsed = bound(elapsed, 0, MAX_HORIZON);
        q = _boundInt(q, 1, 1e24);

        AS.Params memory p = AS.Params(gammaWad, sigmaSqWad, baseSpreadWad, horizonSecs);

        if (gammaWad < 0 || sigmaSqWad < 0 || baseSpreadWad < 0) {
            vm.expectRevert();
            h.validate(p);
            return;
        }

        h.validate(p);

        int256 mid = 1e18;
        assertLe(
            h.reservationPriceWad(mid, q, p, elapsed),
            mid,
            "holding too much must never quote above mid"
        );
        assertGe(
            h.reservationPriceWad(mid, -q, p, elapsed),
            mid,
            "holding too little must never quote below mid"
        );
    }
}
