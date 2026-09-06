// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";

/// @notice Per-network addresses, resolved from the environment with sensible
///         chain defaults.
///
/// @dev Nothing here is hardcoded to a single deployment. `vm.envOr` lets every
///      address be overridden, which is what makes the same scripts usable
///      against a fork, a fresh anvil, and Base Sepolia without edits.
///
///      **On Aqua's address.** SwapVM publishes a canonical router at
///      `0x8fdd04dbf6111437b44bbca99c28882434e0958f` across a dozen *mainnets*,
///      but Base Sepolia is not among them and 1inch does not publish a testnet
///      Aqua address. So on a testnet the deploy script deploys `Aqua` itself,
///      from the **unmodified official source** in `lib/aqua`. That is a
///      deployment of 1inch's contract, not a reimplementation of it — which is
///      the distinction the sponsor requirement actually cares about.
abstract contract NetworkConfig is Script {
    uint256 internal constant BASE_SEPOLIA = 84532;
    uint256 internal constant BASE = 8453;
    uint256 internal constant ANVIL = 31337;

    /// @notice The canonical SwapVM router address on supported mainnets.
    address internal constant CANONICAL_SWAP_VM = 0x8fDD04Dbf6111437B44bbca99C28882434e0958f;

    /// @dev WETH9 is an OP-stack predeploy at the same address on Base and Base
    ///      Sepolia.
    address internal constant OP_STACK_WETH = 0x4200000000000000000000000000000000000006;

    error UnknownNetwork(uint256 chainId);

    /// @notice Aqua protocol address, or `address(0)` if it must be deployed.
    function aquaAddress() internal view returns (address) {
        return vm.envOr("AQUA", address(0));
    }

    /// @notice Zyro router address, once deployed.
    function routerAddress() internal view returns (address) {
        return vm.envOr("ZYRO_ROUTER", address(0));
    }

    /// @notice Uniswap v4 PoolManager, for the hook deployment.
    function poolManagerAddress() internal view returns (address) {
        return vm.envOr("POOL_MANAGER", address(0));
    }

    function wethAddress() internal view returns (address) {
        address fromEnv = vm.envOr("WETH", address(0));
        if (fromEnv != address(0)) return fromEnv;

        uint256 id = block.chainid;
        if (id == BASE_SEPOLIA || id == BASE) return OP_STACK_WETH;
        revert UnknownNetwork(id);
    }

    /// @notice Owner of deployed contracts. Defaults to the broadcasting key.
    function ownerAddress(address deployer) internal view returns (address) {
        return vm.envOr("OWNER", deployer);
    }

    function isTestnet() internal view returns (bool) {
        uint256 id = block.chainid;
        return id == BASE_SEPOLIA || id == ANVIL;
    }

    function networkName() internal view returns (string memory) {
        uint256 id = block.chainid;
        if (id == BASE_SEPOLIA) return "base-sepolia";
        if (id == BASE) return "base";
        if (id == ANVIL) return "anvil";
        return "unknown";
    }
}
