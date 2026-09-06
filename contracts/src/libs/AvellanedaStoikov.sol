// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title AvellanedaStoikov
/// @notice The Zyro pricing kernel: inventory-aware reservation-price quoting,
///         after Avellaneda & Stoikov (2008).
///
/// @dev Pure functions only. No storage, no external calls, no VM dependency.
///      Isolated deliberately so it can be fuzzed exhaustively without
///      deploying anything, and so both venues (the 1inch SwapVM instruction
///      and the Uniswap v4 hook) share it unmodified.
///
///      ## The mechanism
///
///      A maker quoting around the market mid accumulates whatever the flow
///      pushes onto them. Quoting around the *reservation price* instead --
///      the price at which the maker, given what they currently hold, is
///      indifferent to trading -- makes it expensive to push them further from
///      target and cheap to take inventory back off them:
///
///          r = s - q*gamma*sigmaSq*(T-t)
///          delta = delta0 + gamma*sigmaSq*(T-t)
///
///      At exactly target (`q == 0`) the skew term is zero and the system
///      degrades into an ordinary constant-product AMM with a flat spread.
///      That is a property of the formula, not a special case in code.
///
///      ## Disclosed simplification
///
///      Full Avellaneda-Stoikov's spread term includes a `kappa`-dependent
///      order-arrival component requiring a live limit-order-book feed that no
///      on-chain venue provides. Only the base spread `delta0` stands in for
///      it here. The *reservation-price* term -- the actually novel part, and
///      the one Aqua's live per-maker balance makes computable on-chain -- is
///      implemented in full.
///
///      ## Fixed-point convention
///
///      Everything suffixed `Wad` is 18-decimal fixed point, `WAD = 1e18`. All
///      amount-shaped values assume an 18-decimal token, matching SwapVM's own
///      registers.
///
///      `gamma` and `sigmaSq` are treated as dimensionless WAD coefficients and
///      `(T-t)` as an integer count of seconds, so the skew term carries a
///      per-second scale that the operator absorbs into their choice of
///      `gamma*sigmaSq`. `baseSpreadWad` and the value returned by
///      {halfSpreadWad} are **absolute** WAD price offsets in the same units as
///      the mid, which is what lets {applyInventorySkew} compute `r -/+ delta`
///      directly (see the composition order below) and what lets the v4 hook
///      recover a proportional fee by dividing by the pool's own mid.
///
///      ## Composition order (one atomic transform)
///
///      1. mid   <- implied by the live (balanceIn, balanceOut) pair
///      2. r     <- reservationPriceWad(mid, q, params, elapsed)
///      3. delta <- halfSpreadWad(params, elapsed), floored at 0
///      4. side  <- q >= 0 ? exposed : covered
///      5. price <- exposed ? r - delta : r + delta, floored at 1
///      6. (newIn, newOut) <- recenterBalances(balanceIn, balanceOut, price)
///      7. if exposed: newOut -= newOut * penaltyBps / 10_000
library AvellanedaStoikov {
    /// @notice 18-decimal fixed-point scale.
    int256 internal constant WAD = 1e18;

    /// @notice Basis-point denominator.
    uint256 internal constant BPS = 10_000;

    /// @notice Ceiling of the soft-bound penalty ramp, in basis points (5%).
    uint256 internal constant MAX_PENALTY_BPS = 500;

    /// @notice Upper bound on `gamma`, `sigmaSq` and `baseSpread`, in WAD.
    int256 internal constant MAX_PARAM_WAD = 1e18;

    /// @notice Upper bound on the quoting horizon.
    uint256 internal constant MAX_HORIZON_SECS = 365 days;

    // ---------------------------------------------------------------------
    // Errors
    //
    // Distinct named errors per failure so a maker gets a diagnosable revert
    // rather than a bare panic.
    // ---------------------------------------------------------------------

    error NegativeGamma(int256 gammaWad);
    error GammaTooLarge(int256 gammaWad);
    error NegativeSigmaSq(int256 sigmaSqWad);
    error SigmaSqTooLarge(int256 sigmaSqWad);
    error NegativeBaseSpread(int256 baseSpreadWad);
    error BaseSpreadTooLarge(int256 baseSpreadWad);
    error HorizonTooLong(uint256 horizonSecs);

    /// @param gammaWad      Risk aversion, WAD. Must be in [0, 1e18].
    /// @param sigmaSqWad    Variance estimate, WAD. Must be in [0, 1e18].
    /// @param baseSpreadWad Maker-declared base half-spread `delta0`, an
    ///                      absolute WAD price offset. Must be in [0, 1e18].
    /// @param horizonSecs   Quoting horizon `T`, in seconds. Must be <= 365d.
    struct Params {
        int256 gammaWad;
        int256 sigmaSqWad;
        int256 baseSpreadWad;
        uint256 horizonSecs;
    }

    /// @notice Rejects any parameter set that could invert or overflow the model.
    ///
    /// @dev **This is the single most important function in the library.**
    ///
    ///      `Params` types `gamma` and `sigmaSq` as `int256`, and the SwapVM
    ///      wire format packs them as `int128`. A negative value is
    ///      representable end to end. Feed one in and
    ///
    ///          r = mid - q*gamma*sigmaSq*(T-t)
    ///
    ///      becomes `r = mid + skew`: the position then quotes *better* prices
    ///      the further it drifts from target, paying takers to worsen its own
    ///      inventory. Every other failure mode in this system fails safely.
    ///      This one fails profitably for whoever noticed.
    ///
    ///      A property suite cannot catch it on its own, because every
    ///      invariant still holds under sign inversion when `gamma` and
    ///      `sigmaSq` are fuzzed over non-negative ranges only -- the bound
    ///      that makes the tests pass is the bound that hides the bug. It is
    ///      therefore tested by dedicated signed-range tests, and this function
    ///      must be called by **both** consumers: the SwapVM instruction on
    ///      every `exec`, and the v4 hook once at configuration.
    ///
    ///      The upper bounds exist to keep intermediate products inside
    ///      `int256`, not to express an opinion about market making. With
    ///      `gamma` and `sigmaSq` both at cap and a year-long horizon the
    ///      widest term stays far below `int256`'s range for any inventory an
    ///      18-decimal token can express.
    function validate(Params memory p) internal pure {
        if (p.gammaWad < 0) revert NegativeGamma(p.gammaWad);
        if (p.gammaWad > MAX_PARAM_WAD) revert GammaTooLarge(p.gammaWad);
        if (p.sigmaSqWad < 0) revert NegativeSigmaSq(p.sigmaSqWad);
        if (p.sigmaSqWad > MAX_PARAM_WAD) revert SigmaSqTooLarge(p.sigmaSqWad);
        if (p.baseSpreadWad < 0) revert NegativeBaseSpread(p.baseSpreadWad);
        if (p.baseSpreadWad > MAX_PARAM_WAD) revert BaseSpreadTooLarge(p.baseSpreadWad);
        if (p.horizonSecs > MAX_HORIZON_SECS) revert HorizonTooLong(p.horizonSecs);
    }

    /// @notice Seconds left in the quoting horizon, floored at zero.
    ///
    /// @dev Once this reaches zero every time-dependent term vanishes and the
    ///      position silently becomes an ordinary constant-product AMM with a
    ///      flat `delta0` spread. It does not revert, warn, or stop trading --
    ///      it stops defending itself. This is the most surprising behaviour in
    ///      the system and anyone operating a position needs to know it.
    function remaining(Params memory p, uint256 elapsed) internal pure returns (uint256) {
        return elapsed >= p.horizonSecs ? 0 : p.horizonSecs - elapsed;
    }

    /// @notice The shared risk term `gamma*sigmaSq*(T-t)`, in WAD.
    /// @dev Factored out because it appears identically in both the
    ///      reservation price and the half-spread.
    function riskTermWad(Params memory p, uint256 elapsed) internal pure returns (int256) {
        int256 pressure = (p.gammaWad * p.sigmaSqWad) / WAD;
        return pressure * int256(remaining(p, elapsed));
    }

    /// @notice `r = s - q*gamma*sigmaSq*(T-t)`.
    ///
    /// @param mid     Mid price, WAD (tokenOut per tokenIn).
    /// @param q       Signed inventory imbalance, `balanceIn - targetInventoryWad`.
    /// @param p       Validated parameters.
    /// @param elapsed Seconds since the horizon started.
    ///
    /// @dev Holding too much (`q > 0`) pulls `r` below mid, making it expensive
    ///      to sell the maker more and cheap to buy some off them. Holding too
    ///      little does the reverse.
    function reservationPriceWad(int256 mid, int256 q, Params memory p, uint256 elapsed)
        internal
        pure
        returns (int256)
    {
        int256 skew = (q * riskTermWad(p, elapsed)) / WAD;
        return mid - skew;
    }

    /// @notice `delta = delta0 + gamma*sigmaSq*(T-t)`, an absolute WAD price offset.
    /// @dev Widest at the start of the horizon, narrowing to exactly `delta0`
    ///      once the horizon is consumed. Never below `delta0` for validated
    ///      parameters, since the risk term is non-negative.
    function halfSpreadWad(Params memory p, uint256 elapsed) internal pure returns (int256) {
        int256 d = p.baseSpreadWad + riskTermWad(p, elapsed);
        return d < 0 ? int256(0) : d;
    }

    /// @notice Soft-bound penalty, ramping linearly 0 -> 500 bps as `|q|/|bound|`
    ///         goes 0 -> 1, then clamping.
    ///
    /// @dev A hard revert at a boundary is a discontinuity, and discontinuities
    ///      are hostile to the automated solvers that route order flow: they
    ///      receive a successful quote and then a reverting execution. A
    ///      continuous ramp is always routable. This design rule governs the
    ///      whole project -- it is why there is no defensive state machine and
    ///      no hard-protect mode anywhere in Zyro.
    ///
    ///      The caller applies this to **exposed-side flow only**. Covered-side
    ///      flow never pays it: that is exactly the flow the position wants to
    ///      attract as it nears its bound.
    function softBoundPenaltyBps(int256 q, int256 bound) internal pure returns (uint256) {
        uint256 absBound = _abs(bound);
        if (absBound == 0) return 0;
        uint256 penalty = Math.mulDiv(_abs(q), MAX_PENALTY_BPS, absBound);
        return penalty > MAX_PENALTY_BPS ? MAX_PENALTY_BPS : penalty;
    }

    /// @notice `s = balanceOut * WAD / balanceIn`, the price implied by the pair.
    /// @dev SwapVM has no price variable -- its curve *is* a pair of balances --
    ///      so the mid has to be recovered from them.
    function midFromBalancesWad(uint256 balanceIn, uint256 balanceOut)
        internal
        pure
        returns (int256)
    {
        if (balanceIn == 0) return 0;
        return int256(Math.mulDiv(balanceOut, uint256(WAD), balanceIn));
    }

    /// @notice Rotates the curve so its implied price becomes `price`, holding
    ///         depth `k = balanceIn * balanceOut` constant.
    ///
    /// ```
    /// k            = balanceIn * balanceOut
    /// newBalanceIn = sqrt(k * WAD / price)
    /// newBalanceOut= k / newBalanceIn
    /// ```
    ///
    /// @dev **The curve is rotated, not reshaped.** Traders see the same depth,
    ///      quoted around `r` instead of raw mid. This is how a price-shaped
    ///      quantity is expressed to a VM whose only pricing state is a balance
    ///      pair.
    ///
    ///      Returns the inputs unchanged when `price <= 0` or when the rotation
    ///      would collapse `balanceIn` to zero, rather than reverting -- see the
    ///      continuity rule on {softBoundPenaltyBps}.
    function recenterBalances(uint256 balanceIn, uint256 balanceOut, int256 price)
        internal
        pure
        returns (uint256, uint256)
    {
        if (price <= 0) return (balanceIn, balanceOut);

        uint256 k = balanceIn * balanceOut;
        if (k == 0) return (balanceIn, balanceOut);

        uint256 newBalanceIn = Math.sqrt(Math.mulDiv(k, uint256(WAD), uint256(price)));
        if (newBalanceIn == 0) return (balanceIn, balanceOut);

        return (newBalanceIn, k / newBalanceIn);
    }

    /// @notice The whole mechanism, as one atomic transform.
    ///
    /// @param balanceIn  Live tokenIn balance (on Aqua, the maker's real wallet
    ///                   balance, pre-loaded into the VM context before any
    ///                   instruction runs).
    /// @param balanceOut Live tokenOut balance.
    /// @param q          Signed inventory imbalance, `balanceIn - target`.
    /// @param p          Parameters. The caller must have {validate}d them.
    /// @param elapsed    Seconds since the horizon started.
    /// @param bound      Maker-declared soft bound on `|q|`.
    ///
    /// @dev The instruction always adds to `balanceIn` (the taker gives
    ///      tokenIn), so the sign of `q` alone decides which side of `r` this
    ///      call lands on -- Avellaneda-Stoikov's bid/ask asymmetry, expressed
    ///      as a direction rather than as two separate quotes.
    function applyInventorySkew(
        uint256 balanceIn,
        uint256 balanceOut,
        int256 q,
        Params memory p,
        uint256 elapsed,
        int256 bound
    ) internal pure returns (uint256, uint256) {
        int256 mid = midFromBalancesWad(balanceIn, balanceOut);
        int256 r = reservationPriceWad(mid, q, p, elapsed);
        int256 delta = halfSpreadWad(p, elapsed);

        // q >= 0 -> exposed: the position already holds too much tokenIn, so
        //           taking more is priced worse for the taker.
        // q <  0 -> covered: the position wants tokenIn, so it pays up.
        bool exposed = q >= 0;

        int256 price = exposed ? r - delta : r + delta;
        if (price < 1) price = 1; // never quote a non-positive price

        (uint256 newIn, uint256 newOut) = recenterBalances(balanceIn, balanceOut, price);

        if (exposed) {
            uint256 penaltyBps = softBoundPenaltyBps(q, bound);
            if (penaltyBps != 0) {
                newOut -= Math.mulDiv(newOut, penaltyBps, BPS);
            }
        }

        return (newIn, newOut);
    }

    /// @dev `abs` for `int256`, safe at `type(int256).min`.
    function _abs(int256 x) private pure returns (uint256) {
        unchecked {
            // casting to 'uint256' is safe because the result is a magnitude,
            // not a signed value: for x < 0 the two's-complement bit pattern
            // negated in unsigned arithmetic is exactly |x|, and this is the
            // only formulation that does not overflow at type(int256).min.
            // forge-lint: disable-next-line(unsafe-typecast)
            return x < 0 ? uint256(~uint256(x) + 1) : uint256(x);
        }
    }
}
