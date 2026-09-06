// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console2} from "forge-std/Test.sol";

import {AvellanedaStoikov as AS} from "../src/libs/AvellanedaStoikov.sol";
import {KernelHarness} from "./helpers/KernelHarness.sol";

/// @notice Generates reference outputs of the pricing kernel for the off-chain
///         re-implementations to be checked against.
///
/// @dev The subgraph exists because Zyro's liquidity is order-based: there is no
///      pool contract holding reserves, so a solver cannot read a reserve to
///      price a position. It has to be told the reservation price, which means
///      the kernel gets re-implemented off-chain — in AssemblyScript for the
///      subgraph, and in TypeScript for the SDK.
///
///      Three implementations of the same arithmetic is three chances to
///      disagree, and a subgraph that publishes a reservation price the chain
///      would not quote is worse than one that publishes nothing: a solver
///      routes on it, and the execution disagrees with the quote.
///
///      So the Solidity is the source of truth and this file writes its answers
///      to `test/fixtures/kernel.json`. Every other implementation is asserted
///      against that. Regenerated on each `forge test`, and CI fails if the
///      committed copy drifts.
contract KernelFixturesTest is Test {
    string internal constant FIXTURE_PATH = "test/fixtures/kernel.json";

    KernelHarness internal h;

    struct Case {
        string name;
        uint256 balanceIn;
        uint256 balanceOut;
        int256 q;
        int256 gammaWad;
        int256 sigmaSqWad;
        int256 baseSpreadWad;
        uint256 horizonSecs;
        uint256 elapsed;
        int256 boundWad;
    }

    function setUp() public {
        h = new KernelHarness();
    }

    function _cases() internal pure returns (Case[] memory c) {
        c = new Case[](7);

        // The calibrated fixture: a 500-token imbalance at ~0.45% of a mid of 2.
        c[0] = Case("at-target", 1_000e18, 2_000e18, 0, 1e14, 5e13, 1e15, 3600, 0, 500e18);
        c[1] = Case("exposed", 1_000e18, 2_000e18, 500e18, 1e14, 5e13, 1e15, 3600, 0, 500e18);
        c[2] = Case("covered", 1_000e18, 2_000e18, -500e18, 1e14, 5e13, 1e15, 3600, 0, 500e18);

        // Half way up the soft-bound ramp, and past it (penalty clamps at 500bps).
        c[3] = Case("half-ramp", 1_000e18, 2_000e18, 250e18, 1e14, 5e13, 1e15, 3600, 0, 500e18);
        c[4] = Case("past-bound", 1_000e18, 2_000e18, 900e18, 1e14, 5e13, 1e15, 3600, 0, 100e18);

        // Mid-horizon: the risk term is partly decayed.
        c[5] = Case("mid-horizon", 1_000e18, 2_000e18, 500e18, 1e14, 5e13, 1e15, 3600, 1800, 500e18);

        // Past expiry: every time-dependent term is gone and only delta0 is left.
        c[6] = Case("expired", 1_000e18, 2_000e18, 500e18, 1e14, 5e13, 1e15, 3600, 7200, 500e18);
    }

    function _params(Case memory c) internal pure returns (AS.Params memory) {
        return AS.Params(c.gammaWad, c.sigmaSqWad, c.baseSpreadWad, c.horizonSecs);
    }

    /// @dev Sanity properties on the fixture set itself. A fixture file is only
    ///      worth as much as the confidence that the values in it are right, so
    ///      the generator asserts the mechanism holds across the cases it emits
    ///      rather than blindly serialising whatever the kernel returned.
    function test_FixturesExhibitTheMechanism() public view {
        Case[] memory cs = _cases();

        int256 mid = h.midFromBalancesWad(1_000e18, 2_000e18);
        assertEq(mid, 2e18, "fixture mid should be exactly 2.0");

        // at-target: no skew at all.
        assertEq(
            h.reservationPriceWad(mid, cs[0].q, _params(cs[0]), cs[0].elapsed),
            mid,
            "at target the reservation price is the mid"
        );

        // exposed sits below mid, covered above, symmetrically.
        int256 rExposed = h.reservationPriceWad(mid, cs[1].q, _params(cs[1]), cs[1].elapsed);
        int256 rCovered = h.reservationPriceWad(mid, cs[2].q, _params(cs[2]), cs[2].elapsed);
        assertLt(rExposed, mid, "exposed must quote below mid");
        assertGt(rCovered, mid, "covered must quote above mid");
        assertEq(mid - rExposed, rCovered - mid, "the skew must be symmetric in the sign of q");

        // The skew is a plausible fraction of the mid, not a clamped runaway.
        assertLt(mid - rExposed, mid / 20, "calibrated skew should be well under 5% of mid");
        assertGt(mid - rExposed, 0, "calibrated skew should not round to nothing");

        // Soft bound: half way up ramps to half of the cap, past it clamps.
        assertEq(h.softBoundPenaltyBps(cs[3].q, cs[3].boundWad), 250, "half ramp is 250 bps");
        assertEq(h.softBoundPenaltyBps(cs[4].q, cs[4].boundWad), 500, "past bound clamps at 500");

        // Decay: mid-horizon skews less than at the start, expired not at all.
        int256 rMid = h.reservationPriceWad(mid, cs[5].q, _params(cs[5]), cs[5].elapsed);
        assertGt(rMid, rExposed, "half the horizon consumed means half the skew");
        assertEq(
            h.reservationPriceWad(mid, cs[6].q, _params(cs[6]), cs[6].elapsed),
            mid,
            "an expired horizon stops skewing entirely"
        );
        assertEq(
            h.halfSpreadWad(_params(cs[6]), cs[6].elapsed),
            cs[6].baseSpreadWad,
            "only the base spread survives expiry"
        );
    }

    /// @dev The inputs of one case. Split from {_outputsJson} because building
    ///      the whole record in one expression puts more live locals on the
    ///      stack than `via_ir` can place, and Solidity reports that as a Yul
    ///      "too deep in the stack" error rather than anything actionable.
    function _inputsJson(Case memory c) internal pure returns (string memory) {
        return string.concat(
            '"name":"', c.name, '",',
            '"balanceIn":"', vm.toString(c.balanceIn), '",',
            '"balanceOut":"', vm.toString(c.balanceOut), '",',
            '"q":"', vm.toString(c.q), '",',
            '"gammaWad":"', vm.toString(c.gammaWad), '",',
            '"sigmaSqWad":"', vm.toString(c.sigmaSqWad), '",',
            '"baseSpreadWad":"', vm.toString(c.baseSpreadWad), '",',
            '"horizonSecs":', vm.toString(c.horizonSecs), ",",
            '"elapsed":', vm.toString(c.elapsed), ",",
            '"boundWad":"', vm.toString(c.boundWad), '",'
        );
    }

    /// @dev Every intermediate the off-chain kernels must reproduce, not just
    ///      the final balance pair. If only the endpoint were published, an
    ///      implementation could land on it with two compensating errors.
    function _outputsJson(Case memory c) internal view returns (string memory) {
        AS.Params memory p = _params(c);
        int256 mid = h.midFromBalancesWad(c.balanceIn, c.balanceOut);
        (uint256 newIn, uint256 newOut) =
            h.applyInventorySkew(c.balanceIn, c.balanceOut, c.q, p, c.elapsed, c.boundWad);

        return string.concat(
            '"remaining":', vm.toString(h.remaining(p, c.elapsed)), ",",
            '"riskTermWad":"', vm.toString(h.riskTermWad(p, c.elapsed)), '",',
            '"midWad":"', vm.toString(mid), '",',
            '"reservationPriceWad":"',
            vm.toString(h.reservationPriceWad(mid, c.q, p, c.elapsed)),
            '",',
            '"halfSpreadWad":"', vm.toString(h.halfSpreadWad(p, c.elapsed)), '",',
            '"penaltyBps":', vm.toString(h.softBoundPenaltyBps(c.q, c.boundWad)), ",",
            '"newBalanceIn":"', vm.toString(newIn), '",',
            '"newBalanceOut":"', vm.toString(newOut), '"'
        );
    }

    function test_WriteFixtures() public {
        Case[] memory cs = _cases();

        string memory json = "[";
        for (uint256 i = 0; i < cs.length; ++i) {
            json = string.concat(
                json,
                i == 0 ? "" : ",",
                "\n  {",
                _inputsJson(cs[i]),
                _outputsJson(cs[i]),
                "}"
            );
        }
        json = string.concat(json, "\n]\n");

        vm.writeFile(FIXTURE_PATH, json);
        console2.log("wrote", FIXTURE_PATH);
    }
}
