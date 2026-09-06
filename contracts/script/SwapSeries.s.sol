// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/Script.sol";

import {IAqua} from "@1inch/aqua/src/interfaces/IAqua.sol";
import {ISwapVM} from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import {MakerTraitsLib} from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import {TakerTraitsLib} from "@1inch/swap-vm/src/libs/TakerTraits.sol";

import {ZyroInventorySkewArgs} from "../src/instructions/ZyroInstructions.sol";
import {ZyroLens} from "../src/periphery/ZyroLens.sol";
import {ZyroRouter} from "../src/routers/ZyroRouter.sol";
import {NetworkConfig} from "./NetworkConfig.sol";
import {ZyroDemoToken} from "./ZyroDemoToken.sol";

/// @notice Ships one position and walks it off target with a series of
///         same-direction swaps.
///
/// @dev **`ShipAndSwap` proves the mechanism works. This one makes it
///      visible.**
///
///      A single fill produces a single point, and a single point cannot show
///      an inventory-aware quote doing anything an ordinary AMM would not. The
///      claim is that the reservation price *walks away from the mid as
///      inventory accumulates*, and the smallest evidence for that is a series
///      running one direction until the position is visibly exposed.
///
///      Each iteration is one transaction, so each lands in its own block with
///      its own timestamp. That matters twice over: `Fill` entities need
///      distinct timestamps to plot against, and the risk term decays with
///      elapsed time, so a series compressed into one block would hold `(T-t)`
///      almost constant and understate the drift.
///
///      Every step quotes first, then swaps, then requires the two to match.
///      Parity is proved exhaustively in `QuoteSwapParity.t.sol`, but proving
///      it at every step of a live series is what makes the published chart
///      trustworthy rather than merely plausible.
///
///      Usage:
///
///      ```
///      export AQUA=0x... ZYRO_ROUTER=0x... ZYRO_LENS=0x...
///      forge script script/SwapSeries.s.sol \
///        --rpc-url $BASE_SEPOLIA_RPC_URL \
///        --private-key $PRIVATE_KEY --broadcast --slow
///      ```
///
///      `--slow` is not optional: without it forge submits the whole batch at
///      once and the nonces land in the same block, collapsing the series back
///      into a single point.
contract SwapSeries is NetworkConfig {
    /// @dev The next free index after the stock Aqua set's 34 entries.
    uint8 internal constant OP_ZYRO = 34;
    uint8 internal constant OP_XYC_SWAP = 17;
    uint8 internal constant OP_SALT = 20;

    // Calibrated so a 500-token imbalance moves the quote by roughly 0.45% of a
    // mid of 2. `gamma * sigmaSq` must be small: the skew multiplies a
    // wei-scaled inventory by a raw second count, so round-looking values like
    // 0.5e18 push the effective price onto its floor and the position stops
    // responding to inventory at all — which is exactly the chart this script
    // exists to produce, rendered flat.
    int128 internal constant GAMMA_WAD = 1e14;
    int128 internal constant SIGMA_SQ_WAD = 5e13;
    int128 internal constant BASE_SPREAD_WAD = 1e15;
    uint32 internal constant HORIZON = 6 hours;

    uint256 internal constant SHIP_IN = 1_000e18;
    uint256 internal constant SHIP_OUT = 2_000e18;

    /// @dev Ten steps of 50 tokens walks `q` from 0 to +500, which is the soft
    ///      bound. The series therefore ends with the penalty fully ramped —
    ///      the interesting end of the curve, not a rounding error away from
    ///      the start.
    uint256 internal constant DEFAULT_STEPS = 10;
    uint256 internal constant DEFAULT_STEP_AMOUNT = 50e18;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);

        uint256 steps = vm.envOr("SWAP_STEPS", DEFAULT_STEPS);
        uint256 stepAmount = vm.envOr("SWAP_STEP_AMOUNT", DEFAULT_STEP_AMOUNT);

        IAqua aqua = IAqua(aquaAddress());
        ZyroRouter router = ZyroRouter(payable(routerAddress()));
        require(address(aqua) != address(0), "set AQUA");
        require(address(router) != address(0), "set ZYRO_ROUTER");

        console2.log("network    ", networkName());
        console2.log("maker/taker", me);
        console2.log("steps      ", steps);
        console2.log("step amount", stepAmount);

        (ISwapVM.Order memory order, address tokenIn, address tokenOut, bytes32 strategyHash) =
            _shipPosition(pk, me, aqua, router);

        bytes memory takerData = _takerData(me);

        // Quote and swap one step at a time. Each `vm.startBroadcast` block is
        // its own transaction, and with `--slow` its own block.
        for (uint256 i = 0; i < steps; i++) {
            (, uint256 quoted,) = router.quote(order, tokenIn, tokenOut, stepAmount, takerData);

            vm.startBroadcast(pk);
            (, uint256 actual,) = router.swap(order, tokenIn, tokenOut, stepAmount, takerData);
            vm.stopBroadcast();

            require(actual == quoted, "quote/swap divergence on a live chain");

            console2.log("--- step", i + 1);
            console2.log("  amountIn ", stepAmount);
            console2.log("  amountOut", actual);
            _logState(order, strategyHash, me, address(router), tokenIn, tokenOut);
        }

        console2.log("");
        console2.log("Series complete. Query the subgraph for this position:");
        console2.logBytes32(strategyHash);
        console2.log("tokenIn ", tokenIn);
        console2.log("tokenOut", tokenOut);
    }

    /// @dev Split out because building the order, the tokens and the ship in
    ///      one frame exceeds what `via_ir` can place on the stack, which
    ///      Solidity reports as an opaque Yul "too deep in the stack" error.
    function _shipPosition(uint256 pk, address me, IAqua aqua, ZyroRouter router)
        internal
        returns (
            ISwapVM.Order memory order,
            address tokenIn,
            address tokenOut,
            bytes32 strategyHash
        )
    {
        vm.startBroadcast(pk);

        ZyroDemoToken inToken = new ZyroDemoToken("Zyro Demo In", "ZIN");
        ZyroDemoToken outToken = new ZyroDemoToken("Zyro Demo Out", "ZOUT");
        tokenIn = address(inToken);
        tokenOut = address(outToken);

        // The taker pays in `tokenIn` on every step, so mint enough for the
        // whole series on top of the shipped inventory.
        inToken.mint(me, SHIP_IN * 4);
        outToken.mint(me, SHIP_OUT * 2);
        inToken.approve(address(aqua), type(uint256).max);
        outToken.approve(address(aqua), type(uint256).max);
        inToken.approve(address(router), type(uint256).max);

        // Skew re-centres the balance pair; the curve instruction consumes it.
        // The salt makes an otherwise-identical position unique, so re-running
        // this script does not collide on one strategy hash.
        bytes memory program = abi.encodePacked(
            ZyroInventorySkewArgs.buildInstruction(
                OP_ZYRO,
                GAMMA_WAD,
                SIGMA_SQ_WAD,
                BASE_SPREAD_WAD,
                int256(SHIP_IN), // target: shipped balanced, so q starts at 0
                int256(SHIP_IN / 2), // soft bound, reached at the last step
                HORIZON,
                uint40(block.timestamp)
            ),
            OP_XYC_SWAP,
            uint8(0),
            OP_SALT,
            uint8(8),
            bytes8(uint64(block.timestamp))
        );

        MakerTraitsLib.Args memory makerArgs;
        makerArgs.maker = me;
        makerArgs.useAquaInsteadOfSignature = true;
        makerArgs.program = program;
        order = MakerTraitsLib.build(makerArgs);

        address[] memory tokens = new address[](2);
        tokens[0] = tokenIn;
        tokens[1] = tokenOut;

        uint256[] memory amounts = new uint256[](2);
        amounts[0] = SHIP_IN;
        amounts[1] = SHIP_OUT;

        strategyHash = aqua.ship(address(router), abi.encode(order), tokens, amounts);

        vm.stopBroadcast();

        require(strategyHash == router.hash(order), "strategy hash must equal the order hash");

        console2.log("tokenIn      ", tokenIn);
        console2.log("tokenOut     ", tokenOut);
        console2.log("strategyHash ");
        console2.logBytes32(strategyHash);
    }

    function _takerData(address me) internal pure returns (bytes memory) {
        TakerTraitsLib.Args memory takerArgs;
        takerArgs.taker = me;
        takerArgs.isExactIn = true;
        takerArgs.useTransferFromAndAquaPush = true;
        takerArgs.isFirstTransferFromTaker = true;
        return TakerTraitsLib.build(takerArgs);
    }

    /// @dev Prints the numbers the subgraph is expected to publish for this
    ///      block, so a mismatch is caught while the series is still running
    ///      rather than after the whole thing has been indexed.
    ///
    ///      Silent if `ZYRO_LENS` is unset — the series is still worth having
    ///      without it, and refusing to run would be a worse trade.
    function _logState(
        ISwapVM.Order memory order,
        bytes32 strategyHash,
        address maker,
        address app,
        address tokenIn,
        address tokenOut
    ) internal view {
        address lensAddress = vm.envOr("ZYRO_LENS", address(0));
        if (lensAddress == address(0)) return;

        ZyroLens.State memory s =
            ZyroLens(lensAddress).state(maker, app, strategyHash, tokenIn, tokenOut, order.data);

        console2.log("  balanceIn ", s.balanceIn);
        console2.log("  balanceOut", s.balanceOut);
        console2.log("  q         ", s.inventoryImbalanceWad);
        console2.log("  mid       ", s.midWad);
        console2.log("  reservation", s.reservationPriceWad);
        console2.log("  penaltyBps", s.penaltyBps);
    }
}
