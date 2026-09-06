// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/Script.sol";

import {Aqua} from "@1inch/aqua/src/Aqua.sol";

import {ZyroRouter} from "../src/routers/ZyroRouter.sol";
import {NetworkConfig} from "./NetworkConfig.sol";

/// @notice Deploys `ZyroRouter`, and `Aqua` first if the network has none.
///
/// @dev Kept in its own file, separate from the v4 hook deployment. The build
///      spec warns that compiling both in one script pushes `ZyroRouter` over
///      EIP-170 under v4-core's optimizer profile. `ZyroRouter` currently
///      measures 22,130 bytes runtime — 2,446 under the limit — so the margin
///      is real but thin, and there is no reason to spend it.
///
///      Usage:
///
///      ```
///      forge script script/DeployZyroRouter.s.sol \
///        --rpc-url $BASE_SEPOLIA_RPC_URL \
///        --private-key $PRIVATE_KEY \
///        --broadcast --verify
///      ```
contract DeployZyroRouter is NetworkConfig {
    function run() external returns (address aqua, address router) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address owner = ownerAddress(deployer);

        console2.log("network       ", networkName());
        console2.log("chainId       ", block.chainid);
        console2.log("deployer      ", deployer);
        console2.log("owner         ", owner);

        vm.startBroadcast(pk);

        aqua = aquaAddress();
        if (aqua == address(0)) {
            require(
                isTestnet(),
                "AQUA must be set on a mainnet - never deploy a second Aqua alongside the real one"
            );
            // The official contract from lib/aqua, unmodified. 1inch does not
            // publish a Base Sepolia Aqua, so the demo deploys their source
            // rather than reimplementing it.
            aqua = address(new Aqua());
            console2.log("Aqua (deployed)", aqua);
        } else {
            console2.log("Aqua (existing)", aqua);
        }

        router = address(
            new ZyroRouter(aqua, wethAddress(), owner, "SwapVM", "1")
        );

        vm.stopBroadcast();

        console2.log("ZyroRouter    ", router);
        console2.log("WETH          ", wethAddress());
        console2.log("");
        console2.log("Next:");
        console2.log("  export AQUA=%s", aqua);
        console2.log("  export ZYRO_ROUTER=%s", router);
        console2.log("  forge script script/ShipAndSwap.s.sol --broadcast");
        console2.log("");
        console2.log("Then set both addresses in subgraph/networks.json,");
        console2.log("subgraph/src/config.ts and substreams/substreams.yaml.");
    }
}
