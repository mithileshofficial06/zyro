// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/Script.sol";

import {IAqua} from "@1inch/aqua/src/interfaces/IAqua.sol";
import {ISwapVM} from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import {MakerTraitsLib} from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import {TakerTraitsLib} from "@1inch/swap-vm/src/libs/TakerTraits.sol";

import {ZyroInventorySkewArgs} from "../src/instructions/ZyroInstructions.sol";
import {ZyroRouter} from "../src/routers/ZyroRouter.sol";
import {NetworkConfig} from "./NetworkConfig.sol";
import {ZyroDemoToken} from "./ZyroDemoToken.sol";

/// @notice Ships one real Zyro position and executes one real swap against it.
///
/// @dev **This is the highest-leverage script in the repository.**
///
///      1inch's track asks for *on-chain execution of token transfers
///      demonstrated at the demo*. A deployed address does not satisfy that; a
///      settled swap does. It is also the only thing that produces real data
///      for the subgraph and the Substreams package to index — until this runs,
///      both are indexing an empty chain and "returns real, correct data"
///      cannot be claimed.
///
///      What it does, in order:
///
///      1. deploys two 18-decimal demo tokens and mints inventory
///      2. builds a Zyro program: `InventorySkew ++ XYCSwap ++ Salt`
///      3. wraps it in a SwapVM order and ships it to Aqua with funding
///      4. quotes the position, then swaps against it
///      5. asserts the executed amount equals the quoted amount
///
///      Step 5 is the point. Quote/swap parity is proved exhaustively in
///      `QuoteSwapParity.t.sol`, but proving it once against a real chain,
///      with real settlement, is what makes the claim credible to someone who
///      has not read the tests.
///
///      Usage:
///
///      ```
///      export AQUA=0x...  ZYRO_ROUTER=0x...
///      forge script script/ShipAndSwap.s.sol \
///        --rpc-url $BASE_SEPOLIA_RPC_URL \
///        --private-key $PRIVATE_KEY --broadcast
///      ```
contract ShipAndSwap is NetworkConfig {
    /// @dev Zyro's opcode: the next free index after the stock Aqua set's 34
    ///      entries. Not `0x92` — see docs/PHASE2-SOURCE-VERIFICATION.md.
    uint8 internal constant OP_ZYRO = 34;
    uint8 internal constant OP_XYC_SWAP = 17;
    uint8 internal constant OP_SALT = 20;

    // Calibrated so a 500-token imbalance moves the quote by roughly 0.45% of a
    // mid of 2. `gamma * sigmaSq` must be small: the skew multiplies a
    // wei-scaled inventory by a raw second count, so round-looking values like
    // 0.5e18 push the effective price onto its floor and the position stops
    // responding to inventory at all.
    int128 internal constant GAMMA_WAD = 1e14;
    int128 internal constant SIGMA_SQ_WAD = 5e13;
    int128 internal constant BASE_SPREAD_WAD = 1e15;
    uint32 internal constant HORIZON = 1 hours;

    uint256 internal constant SHIP_IN = 1_000e18;
    uint256 internal constant SHIP_OUT = 2_000e18;
    uint256 internal constant SWAP_AMOUNT = 10e18;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);

        IAqua aqua = IAqua(aquaAddress());
        ZyroRouter router = ZyroRouter(payable(routerAddress()));
        require(address(aqua) != address(0), "set AQUA");
        require(address(router) != address(0), "set ZYRO_ROUTER");

        console2.log("network ", networkName());
        console2.log("maker   ", me);
        console2.log("aqua    ", address(aqua));
        console2.log("router  ", address(router));

        vm.startBroadcast(pk);

        // --- 1. tokens -------------------------------------------------------
        ZyroDemoToken tokenIn = new ZyroDemoToken("Zyro Demo In", "ZIN");
        ZyroDemoToken tokenOut = new ZyroDemoToken("Zyro Demo Out", "ZOUT");
        tokenIn.mint(me, SHIP_IN * 2);
        tokenOut.mint(me, SHIP_OUT * 2);
        tokenIn.approve(address(aqua), type(uint256).max);
        tokenOut.approve(address(aqua), type(uint256).max);
        tokenIn.approve(address(router), type(uint256).max);

        // --- 2. the program --------------------------------------------------
        // The skew re-centres the balance pair; the curve instruction then
        // consumes it. The salt makes an otherwise-identical position unique,
        // so re-shipping does not collide on one strategy hash.
        bytes memory program = abi.encodePacked(
            ZyroInventorySkewArgs.buildInstruction(
                OP_ZYRO,
                GAMMA_WAD,
                SIGMA_SQ_WAD,
                BASE_SPREAD_WAD,
                int256(SHIP_IN), // target: shipped balanced, so q starts at 0
                int256(SHIP_IN / 2), // soft bound
                HORIZON,
                uint40(block.timestamp)
            ),
            OP_XYC_SWAP,
            uint8(0),
            OP_SALT,
            uint8(8),
            bytes8(uint64(block.timestamp))
        );

        // --- 3. ship ---------------------------------------------------------
        MakerTraitsLib.Args memory makerArgs;
        makerArgs.maker = me;
        makerArgs.useAquaInsteadOfSignature = true;
        makerArgs.program = program;
        ISwapVM.Order memory order = MakerTraitsLib.build(makerArgs);

        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenIn);
        tokens[1] = address(tokenOut);

        uint256[] memory amounts = new uint256[](2);
        amounts[0] = SHIP_IN;
        amounts[1] = SHIP_OUT;

        bytes32 strategyHash = aqua.ship(address(router), abi.encode(order), tokens, amounts);

        // The Aqua strategy hash and the SwapVM order hash are the same number,
        // which is why safeBalances(maker, app, orderHash, ...) resolves.
        require(strategyHash == router.hash(order), "strategy hash must equal the order hash");

        vm.stopBroadcast();

        console2.log("tokenIn      ", address(tokenIn));
        console2.log("tokenOut     ", address(tokenOut));
        console2.logBytes32(strategyHash);

        // --- 4. quote --------------------------------------------------------
        TakerTraitsLib.Args memory takerArgs;
        takerArgs.taker = me;
        takerArgs.isExactIn = true;
        takerArgs.useTransferFromAndAquaPush = true;
        takerArgs.isFirstTransferFromTaker = true;
        bytes memory takerData = TakerTraitsLib.build(takerArgs);

        (, uint256 quotedOut,) = router.quote(
            order, address(tokenIn), address(tokenOut), SWAP_AMOUNT, takerData
        );
        console2.log("quoted amountOut", quotedOut);

        // --- 5. swap, and check it matches the quote -------------------------
        vm.startBroadcast(pk);
        (, uint256 actualOut,) = router.swap(
            order, address(tokenIn), address(tokenOut), SWAP_AMOUNT, takerData
        );
        vm.stopBroadcast();

        console2.log("actual amountOut", actualOut);
        require(actualOut == quotedOut, "quote/swap divergence on a live chain");

        console2.log("");
        console2.log("Shipped and swapped. Quote matched execution exactly.");
        console2.log("Use this strategy hash to query the subgraph.");
    }
}
