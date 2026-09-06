// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Test.sol";

import {Aqua} from "@1inch/aqua/src/Aqua.sol";
import {ISwapVM} from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";

import {AvellanedaStoikov as AS} from "../src/libs/AvellanedaStoikov.sol";
import {ZyroLens} from "../src/periphery/ZyroLens.sol";
import {ZyroTestBase} from "./helpers/ZyroTestBase.sol";

/// @notice `ZyroLens` — the contract that turns "the subgraph is correct" from
///         a claim into a comparison.
///
/// @dev The lens is only useful if it is the *same* answer the instruction
///     would give and the *same* answer the mappings publish. Two things are
///     therefore checked here rather than left to the demo:
///
///     1. its program walk finds the Zyro instruction in the same programs
///        `subgraph/src/program.ts` does, and rejects the same ones
///     2. its arithmetic is the library's, not a paraphrase of it
///
///     A lens that disagreed with either would turn a correct subgraph into a
///     failed verification, which is worse than having no lens at all.
contract ZyroLensTest is ZyroTestBase {
    ZyroLens internal lens;

    uint40 internal constant START = 1_760_000_000;
    int256 internal constant TARGET = 1_000e18;
    int256 internal constant BOUND = 500e18;

    function setUp() public override {
        super.setUp();
        lens = new ZyroLens(address(aqua));
    }

    function _program() internal pure returns (bytes memory) {
        return _zyroProgram(GAMMA_WAD, SIGMA_SQ_WAD, BASE_SPREAD_WAD, TARGET, BOUND, HORIZON, START);
    }

    // =====================================================================
    // Decoding
    // =====================================================================

    function test_Parameters_RoundTripThroughTheWireFormat() public view {
        ZyroLens.Parameters memory p = lens.parameters(_program());

        assertEq(p.gammaWad, GAMMA_WAD, "gamma");
        assertEq(p.sigmaSqWad, SIGMA_SQ_WAD, "sigmaSq");
        assertEq(p.baseSpreadWad, BASE_SPREAD_WAD, "baseSpread");
        assertEq(p.targetInventoryWad, TARGET, "target");
        assertEq(p.boundWad, BOUND, "bound");
        assertEq(p.horizonSecs, HORIZON, "horizon");
        assertEq(p.startTimestamp, START, "start");
    }

    /// @dev The walk has to step `opcode ++ argsLength ++ args`, not scan for
    ///      the byte 34. `targetInventoryWad = 34 wei` puts a literal 0x22 in
    ///      the middle of the Zyro instruction's own arguments; a scanner finds
    ///      that first and decodes 121 bytes of garbage without erroring.
    function test_Walk_IsNotAByteScan() public view {
        bytes memory program =
            _zyroProgram(GAMMA_WAD, SIGMA_SQ_WAD, BASE_SPREAD_WAD, 34, BOUND, HORIZON, START);

        ZyroLens.Parameters memory p = lens.parameters(program);
        assertEq(p.targetInventoryWad, 34, "a 0x22 inside the args must not be read as an opcode");
        assertEq(p.gammaWad, GAMMA_WAD, "and the real instruction must still be the one decoded");
    }

    /// @dev Most programs shipped to Aqua are not Zyro positions. Publishing a
    ///      price for one of those would be worse than publishing nothing.
    function test_StockOnlyProgram_IsNotAZyroPosition() public view {
        assertFalse(lens.isZyroProgram(_stockProgram()), "XYCSwap alone is not a Zyro position");
        assertTrue(lens.isZyroProgram(_program()), "and the Zyro program is");
    }

    function test_ZyroOpcodeWithWrongArgsLength_IsRejected() public view {
        // opcode 34 claiming 8 argument bytes. Parsing it anyway would read
        // past the instruction and publish a plausible wrong position.
        bytes memory malformed = abi.encodePacked(uint8(34), uint8(8), bytes8(0));
        assertFalse(lens.isZyroProgram(malformed));
    }

    // =====================================================================
    // Arithmetic
    // =====================================================================

    /// @dev The point of the lens: at a real shipped position, every field it
    ///      returns must be the library's own answer. Restating the formulas
    ///      here would only prove this file and the lens were written by the
    ///      same hand, so the expectation is a direct library call.
    function test_State_IsTheLibrarysOwnAnswer() public {
        bytes32 hash = _shipBalanced(1_000e18, 2_000e18);
        vm.warp(START + 600);

        ZyroLens.State memory s = lens.state(
            maker, address(zyroRouter), hash, address(tokenIn), address(tokenOut), _program()
        );

        AS.Params memory kp = AS.Params(GAMMA_WAD, SIGMA_SQ_WAD, BASE_SPREAD_WAD, HORIZON);
        uint256 elapsed = 600;

        assertEq(s.balanceIn, 1_000e18, "balanceIn must come from Aqua's ledger");
        assertEq(s.balanceOut, 2_000e18, "balanceOut must come from Aqua's ledger");
        assertEq(s.elapsedSecs, elapsed, "elapsed");
        assertEq(s.inventoryImbalanceWad, 0, "shipped at target, so q is zero");
        assertEq(s.midWad, AS.midFromBalancesWad(1_000e18, 2_000e18), "mid");
        assertEq(
            s.reservationPriceWad,
            AS.reservationPriceWad(s.midWad, 0, kp, elapsed),
            "reservation price"
        );
        assertEq(s.halfSpreadWad, AS.halfSpreadWad(kp, elapsed), "half spread");
        assertEq(s.horizonRemainingSecs, AS.remaining(kp, elapsed), "horizon remaining");
        assertEq(s.penaltyBps, 0, "no imbalance, no penalty");
    }

    /// @dev At `q = 0` the reservation price *is* the mid. This is the anchor
    ///      the demo chart is read against: the two lines start together and
    ///      separate only as inventory drifts. If they start apart, the skew is
    ///      being applied to something that is not the imbalance.
    function test_AtTarget_ReservationPriceEqualsMid() public {
        bytes32 hash = _shipBalanced(1_000e18, 2_000e18);
        vm.warp(START + 1);

        ZyroLens.State memory s = lens.state(
            maker, address(zyroRouter), hash, address(tokenIn), address(tokenOut), _program()
        );
        assertEq(s.reservationPriceWad, s.midWad, "no imbalance must mean no skew");
    }

    /// @dev Holding more `tokenIn` than target is the exposed side: the maker
    ///      wants to shed it, so it must quote *below* the mid. A lens that got
    ///      this sign backwards would make a correct subgraph look broken.
    function test_ExposedInventory_QuotesBelowTheMid() public {
        bytes32 hash = _shipBalanced(1_500e18, 2_000e18);
        vm.warp(START + 600);

        ZyroLens.State memory s = lens.state(
            maker, address(zyroRouter), hash, address(tokenIn), address(tokenOut), _program()
        );

        assertEq(s.inventoryImbalanceWad, 500e18, "q = balanceIn - target");
        assertLt(s.reservationPriceWad, s.midWad, "exposed inventory must quote below the mid");
        assertGt(s.penaltyBps, 0, "and at the soft bound it must be penalised");
    }

    function test_CoveredInventory_QuotesAboveTheMid() public {
        bytes32 hash = _shipBalanced(600e18, 2_000e18);
        vm.warp(START + 600);

        ZyroLens.State memory s = lens.state(
            maker, address(zyroRouter), hash, address(tokenIn), address(tokenOut), _program()
        );

        assertEq(s.inventoryImbalanceWad, -400e18, "q must go negative below target");
        assertGt(s.reservationPriceWad, s.midWad, "covered inventory must quote above the mid");
        assertEq(s.penaltyBps, 0, "the soft bound penalises the exposed side only");
    }

    /// @dev Past the horizon the position has stopped defending itself and
    ///      quotes as an ordinary constant-product AMM. The lens must show
    ///      that, because it is what the subgraph will publish.
    function test_PastTheHorizon_TheSkewIsGone() public {
        bytes32 hash = _shipBalanced(1_500e18, 2_000e18);
        vm.warp(START + HORIZON + 1);

        ZyroLens.State memory s = lens.state(
            maker, address(zyroRouter), hash, address(tokenIn), address(tokenOut), _program()
        );

        assertEq(s.horizonRemainingSecs, 0, "the horizon must be spent");
        assertEq(s.reservationPriceWad, s.midWad, "and with it the skew");
    }

    // =====================================================================
    // Against the real Aqua
    // =====================================================================

    /// @dev Everything above runs against `MockAqua`, which exists so the tests
    ///      can steer inventory directly. That leaves one thing unproved, and it
    ///      is the thing the testnet deployment depends on: that a real
    ///      `Aqua.ship()` files balances under `keccak256(strategy)` and that
    ///      `safeBalances` finds them again under the router's `hash(order)`.
    ///      Those are the same number in Aqua mode — but "the same number" is an
    ///      argument about two hash derivations, and it costs one test to stop
    ///      arguing.
    ///
    ///      This also fixes the event order the subgraph is built on:
    ///      `Shipped` is emitted at the top of `ship()`, and one `Pushed` per
    ///      token inside the funding loop below it.
    function test_AgainstTheRealAqua_ShipResolvesUnderTheOrderHash() public {
        Aqua realAqua = new Aqua();
        ZyroLens realLens = new ZyroLens(address(realAqua));

        ISwapVM.Order memory order = _order(_program());
        bytes memory strategy = abi.encode(order);
        bytes32 orderHash = zyroRouter.hash(order);

        assertEq(keccak256(strategy), orderHash, "strategyHash must be the order hash");

        tokenIn.mint(maker, 1_000e18);
        tokenOut.mint(maker, 2_000e18);

        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenIn);
        tokens[1] = address(tokenOut);

        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 1_000e18;
        amounts[1] = 2_000e18;

        // Aqua takes custody by allowance, so the maker approves and the ship
        // records the balances without moving anything.
        vm.startPrank(maker);
        tokenIn.approve(address(realAqua), type(uint256).max);
        tokenOut.approve(address(realAqua), type(uint256).max);

        vm.recordLogs();
        bytes32 strategyHash = realAqua.ship(address(zyroRouter), strategy, tokens, amounts);
        vm.stopPrank();

        assertEq(strategyHash, orderHash, "ship must return the order hash");

        // Shipped(maker, app, strategyHash, strategy) then one Pushed per token.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 3, "one Shipped and two Pushed");
        assertEq(
            logs[0].topics[0],
            keccak256("Shipped(address,address,bytes32,bytes)"),
            "Shipped must come first - the subgraph buffers pushes on the assumption it does not"
        );
        assertEq(logs[1].topics[0], keccak256("Pushed(address,address,bytes32,address,uint256)"));
        assertEq(logs[2].topics[0], keccak256("Pushed(address,address,bytes32,address,uint256)"));

        vm.warp(START + 600);
        ZyroLens.State memory s = realLens.state(
            maker,
            address(zyroRouter),
            strategyHash,
            address(tokenIn),
            address(tokenOut),
            _program()
        );

        assertEq(s.balanceIn, 1_000e18, "safeBalances must resolve under the order hash");
        assertEq(s.balanceOut, 2_000e18, "for both tokens");
        assertEq(s.reservationPriceWad, s.midWad, "shipped at target, so no skew");
    }

    // =====================================================================
    // Helpers
    // =====================================================================

    /// @dev Keyed by the *order* hash, which is what `strategyHash` is in Aqua
    ///      mode and therefore the key `safeBalances` resolves under. Funding
    ///      the mock directly keeps the inventory an input the test steers;
    ///      {test_AgainstTheRealAqua_ShipResolvesUnderTheOrderHash} covers the
    ///      real contract.
    function _shipBalanced(uint256 amountIn, uint256 amountOut) internal returns (bytes32 hash) {
        hash = zyroRouter.hash(_order(_program()));
        aqua.setBalance(maker, address(zyroRouter), hash, address(tokenIn), amountIn);
        aqua.setBalance(maker, address(zyroRouter), hash, address(tokenOut), amountOut);
    }
}
