// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AvellanedaStoikov as AS} from "../../src/libs/AvellanedaStoikov.sol";

/// @notice Exposes the pure kernel across an external call boundary.
/// @dev Needed only so `vm.expectRevert` has a real call frame to attach to --
///      `internal` library functions are inlined into the test contract, and a
///      revert inside an inlined call cannot be caught by `expectRevert`.
///      Contains no logic of its own.
contract KernelHarness {
    function validate(AS.Params memory p) external pure {
        AS.validate(p);
    }

    function remaining(AS.Params memory p, uint256 elapsed) external pure returns (uint256) {
        return AS.remaining(p, elapsed);
    }

    function riskTermWad(AS.Params memory p, uint256 elapsed) external pure returns (int256) {
        return AS.riskTermWad(p, elapsed);
    }

    function reservationPriceWad(int256 mid, int256 q, AS.Params memory p, uint256 elapsed)
        external
        pure
        returns (int256)
    {
        return AS.reservationPriceWad(mid, q, p, elapsed);
    }

    function halfSpreadWad(AS.Params memory p, uint256 elapsed) external pure returns (int256) {
        return AS.halfSpreadWad(p, elapsed);
    }

    function softBoundPenaltyBps(int256 q, int256 bound) external pure returns (uint256) {
        return AS.softBoundPenaltyBps(q, bound);
    }

    function midFromBalancesWad(uint256 balanceIn, uint256 balanceOut)
        external
        pure
        returns (int256)
    {
        return AS.midFromBalancesWad(balanceIn, balanceOut);
    }

    function recenterBalances(uint256 balanceIn, uint256 balanceOut, int256 price)
        external
        pure
        returns (uint256, uint256)
    {
        return AS.recenterBalances(balanceIn, balanceOut, price);
    }

    function applyInventorySkew(
        uint256 balanceIn,
        uint256 balanceOut,
        int256 q,
        AS.Params memory p,
        uint256 elapsed,
        int256 bound
    ) external pure returns (uint256, uint256) {
        return AS.applyInventorySkew(balanceIn, balanceOut, q, p, elapsed, bound);
    }
}
