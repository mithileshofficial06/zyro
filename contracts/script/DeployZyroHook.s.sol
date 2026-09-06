// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/Script.sol";

import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";

import {ZyroSkewHook} from "../src/uniswap/ZyroSkewHook.sol";
import {NetworkConfig} from "./NetworkConfig.sol";

/// @notice Deploys `ZyroSkewHook` against a chain's real `PoolManager`.
///
/// @dev **A v4 hook cannot simply be deployed.** The `PoolManager` reads a
///      hook's permissions out of the low 14 bits of its own address, so the
///      address is not an output of deployment — it is a constraint on it. A
///      hook deployed to an arbitrary address is rejected by
///      `Hooks.validateHookPermissions` at pool initialisation, with the
///      permissions it declares in Solidity counting for nothing.
///
///      `ZyroSkewHook.t.sol` sidesteps this with `deployCodeTo`, which places
///      bytecode at a chosen address. That is a cheatcode and does not exist on
///      a real chain, which is exactly why this script has to exist separately
///      rather than the tests being evidence the hook is deployable.
///
///      So: mine a CREATE2 salt until the resulting address carries the four
///      flags the hook declares, then deploy with it. Foundry routes a salted
///      `new` in a broadcast through the canonical CREATE2 deployer proxy at
///      `0x4e59b44847b379578588920cA78FbF26c0B4956C`, so that — not the
///      broadcasting EOA — is the address the salt must be mined against.
///      Mining against the EOA produces a salt that yields a different address
///      on deployment, and the run reverts at the flag assertion below rather
///      than silently shipping a hook the manager will refuse.
///
///      Usage:
///
///      ```
///      export POOL_MANAGER=0x...   # the chain's v4 PoolManager
///      forge script script/DeployZyroHook.s.sol \
///        --rpc-url $BASE_SEPOLIA_RPC_URL \
///        --private-key $PRIVATE_KEY \
///        --broadcast --verify
///      ```
contract DeployZyroHook is NetworkConfig {
    /// @dev Foundry's deterministic CREATE2 deployer, present on every chain
    ///      it supports. Salted `new` in a broadcast goes through this, so the
    ///      salt must be mined against it.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// @dev Bounded so a bad flag set fails in seconds rather than running the
    ///      script out of memory. Four flags out of fourteen leaves roughly one
    ///      address in 16,384 usable, so a match is expected well inside this.
    uint256 internal constant MAX_SALT = 200_000;

    error CouldNotMineHookAddress(uint160 flags);
    error MinedAddressMismatch(address expected, address actual);

    function run() external returns (address hook) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address owner = ownerAddress(deployer);

        IPoolManager manager = IPoolManager(poolManagerAddress());
        require(
            address(manager) != address(0),
            "set POOL_MANAGER - see https://docs.uniswap.org/contracts/v4/deployments"
        );

        // Must match `getHookPermissions()` exactly. Any divergence produces an
        // address the manager rejects at `initialize`, which is a much worse
        // place to discover it.
        uint160 flags = uint160(
            Hooks.AFTER_ADD_LIQUIDITY_FLAG | Hooks.AFTER_REMOVE_LIQUIDITY_FLAG
                | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
        );

        console2.log("network     ", networkName());
        console2.log("chainId     ", block.chainid);
        console2.log("deployer    ", deployer);
        console2.log("owner       ", owner);
        console2.log("poolManager ", address(manager));
        console2.log("flags       ", uint256(flags));

        bytes memory constructorArgs = abi.encode(manager, owner);
        (address mined, bytes32 salt) =
            _mine(flags, type(ZyroSkewHook).creationCode, constructorArgs);

        console2.log("mined       ", mined);
        console2.logBytes32(salt);

        vm.startBroadcast(pk);
        ZyroSkewHook deployed = new ZyroSkewHook{salt: salt}(manager, owner);
        vm.stopBroadcast();

        hook = address(deployed);

        // Both assertions matter, and for different reasons. The first catches
        // a salt mined against the wrong deployer, which is the easy mistake.
        // The second catches a permissions change made in Solidity without
        // updating `flags` above — the hook would deploy fine and then be
        // rejected by every `initialize` call.
        if (hook != mined) revert MinedAddressMismatch(mined, hook);
        require(
            uint160(hook) & Hooks.ALL_HOOK_MASK == flags,
            "deployed address does not carry the declared permissions"
        );

        _assertPermissionsMatchFlags(deployed, flags);

        console2.log("");
        console2.log("ZyroSkewHook", hook);
        console2.log("");
        console2.log("Next:");
        console2.log("  initialise a pool with LPFeeLibrary.DYNAMIC_FEE_FLAG and this hook,");
        console2.log("  then call configurePool(key, params, targetWad, boundWad) as owner.");
        console2.log("  Configuration is owner-only and re-runnable - see ZyroSkewHook.sol.");
    }

    /// @notice Finds a salt whose CREATE2 address carries exactly `flags`.
    ///
    /// @dev Written here rather than imported from
    ///      `v4-periphery/test/shared/HookMiner.sol`, which is a fine library
    ///      but resolves v4-core through the "at-uniswap" npm-style remapping —
    ///      one this project does not define, and adding it risks disturbing
    ///      the swap-vm and aqua remappings, which are already order-sensitive.
    ///      The logic is a loop.
    function _mine(uint160 flags, bytes memory creationCode, bytes memory constructorArgs)
        internal
        view
        returns (address, bytes32)
    {
        bytes32 initCodeHash = keccak256(abi.encodePacked(creationCode, constructorArgs));

        for (uint256 salt = 0; salt < MAX_SALT; salt++) {
            address candidate = _create2Address(bytes32(salt), initCodeHash);

            // The occupancy check is not paranoia: CREATE2 to an address that
            // already holds code reverts, and on a chain where this script has
            // run before, low salts are exactly the ones already taken.
            if (uint160(candidate) & Hooks.ALL_HOOK_MASK == flags && candidate.code.length == 0) {
                return (candidate, bytes32(salt));
            }
        }
        revert CouldNotMineHookAddress(flags);
    }

    function _create2Address(bytes32 salt, bytes32 initCodeHash) internal pure returns (address) {
        return address(
            uint160(
                uint256(
                    keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, salt, initCodeHash))
                )
            )
        );
    }

    /// @dev Reads the permissions back off the deployed contract and checks
    ///      they are the ones the address encodes. `flags` above is a hand-kept
    ///      copy of `getHookPermissions()`, and a hand-kept copy is exactly the
    ///      thing that drifts.
    function _assertPermissionsMatchFlags(ZyroSkewHook deployed, uint160 flags) internal view {
        Hooks.Permissions memory p = deployed.getHookPermissions();

        uint160 declared = 0;
        if (p.beforeInitialize) declared |= Hooks.BEFORE_INITIALIZE_FLAG;
        if (p.afterInitialize) declared |= Hooks.AFTER_INITIALIZE_FLAG;
        if (p.beforeAddLiquidity) declared |= Hooks.BEFORE_ADD_LIQUIDITY_FLAG;
        if (p.afterAddLiquidity) declared |= Hooks.AFTER_ADD_LIQUIDITY_FLAG;
        if (p.beforeRemoveLiquidity) declared |= Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG;
        if (p.afterRemoveLiquidity) declared |= Hooks.AFTER_REMOVE_LIQUIDITY_FLAG;
        if (p.beforeSwap) declared |= Hooks.BEFORE_SWAP_FLAG;
        if (p.afterSwap) declared |= Hooks.AFTER_SWAP_FLAG;
        if (p.beforeDonate) declared |= Hooks.BEFORE_DONATE_FLAG;
        if (p.afterDonate) declared |= Hooks.AFTER_DONATE_FLAG;
        if (p.beforeSwapReturnDelta) declared |= Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG;
        if (p.afterSwapReturnDelta) declared |= Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
        if (p.afterAddLiquidityReturnDelta) {
            declared |= Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG;
        }
        if (p.afterRemoveLiquidityReturnDelta) {
            declared |= Hooks.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG;
        }

        require(declared == flags, "getHookPermissions() disagrees with the mined flags");
    }
}
