// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";

import {DeployZyroHook} from "../script/DeployZyroHook.s.sol";
import {ZyroSkewHook} from "../src/uniswap/ZyroSkewHook.sol";

/// @dev Exposes the script's internals. The script itself is the thing under
///      test, which is unusual — but this one is the only path by which the
///      hook reaches a real chain, and it is not exercised by any other suite.
///      `ZyroSkewHook.t.sol` uses `deployCodeTo` to place bytecode at a chosen
///      address, which is a cheatcode: it proves the hook *works* at a valid
///      address and says nothing about whether one can be reached.
contract DeployHookHarness is DeployZyroHook {
    function mine(uint160 flags, bytes memory creationCode, bytes memory constructorArgs)
        external
        view
        returns (address, bytes32)
    {
        return _mine(flags, creationCode, constructorArgs);
    }

    function create2Address(bytes32 salt, bytes32 initCodeHash) external pure returns (address) {
        return _create2Address(salt, initCodeHash);
    }

    function assertPermissionsMatchFlags(ZyroSkewHook hook, uint160 flags) external view {
        _assertPermissionsMatchFlags(hook, flags);
    }

    function create2Deployer() external pure returns (address) {
        return CREATE2_DEPLOYER;
    }
}

/// @notice The hook deployment script.
///
/// @dev **A v4 hook's address is a constraint, not an output.** The
///      `PoolManager` reads permissions from the low 14 bits of the hook's own
///      address, so a hook at an arbitrary address is rejected at pool
///      initialisation regardless of what it declares in Solidity.
///
///      Everything here fails in a way that is expensive to discover later: a
///      salt mined against the wrong deployer produces a *valid-looking* run
///      that deploys to a different address, and a flag set that has drifted
///      from `getHookPermissions()` produces a hook that deploys cleanly and is
///      then refused by every `initialize` call on the chain.
contract DeployZyroHookTest is Test {
    DeployHookHarness internal harness;

    /// @dev A stand-in. The mining maths is independent of the manager's code;
    ///      only its address enters the constructor arguments.
    address internal constant MANAGER = 0x000000000000000000000000000000000000bEEF;
    address internal constant OWNER = 0x00000000000000000000000000000000000000A1;

    uint160 internal constant EXPECTED_FLAGS = uint160(
        Hooks.AFTER_ADD_LIQUIDITY_FLAG | Hooks.AFTER_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
            | Hooks.AFTER_SWAP_FLAG
    );

    function setUp() public {
        harness = new DeployHookHarness();
    }

    function _constructorArgs() internal pure returns (bytes memory) {
        return abi.encode(IPoolManager(MANAGER), OWNER);
    }

    // =====================================================================
    // The address maths
    // =====================================================================

    /// @dev Checked against Foundry's own implementation rather than against a
    ///      literal. A hand-rolled CREATE2 derivation that is subtly wrong —
    ///      wrong prefix byte, wrong field order — still returns a
    ///      deterministic-looking address for every salt, so a test that only
    ///      asserted determinism would pass against a broken one.
    function testFuzz_Create2Address_MatchesFoundry(bytes32 salt, bytes32 initCodeHash)
        public
        view
    {
        assertEq(
            harness.create2Address(salt, initCodeHash),
            vm.computeCreate2Address(salt, initCodeHash, harness.create2Deployer()),
            "CREATE2 derivation must match vm.computeCreate2Address"
        );
    }

    /// @dev The deterministic deployer Foundry routes a salted `new` through.
    ///      Mining against the broadcasting EOA instead is the easy mistake and
    ///      yields a salt that deploys somewhere else entirely.
    function test_Create2Deployer_IsFoundrysDeterministicProxy() public view {
        assertEq(
            harness.create2Deployer(),
            0x4e59b44847b379578588920cA78FbF26c0B4956C,
            "salt must be mined against the CREATE2 proxy, not the broadcaster"
        );
    }

    // =====================================================================
    // Mining
    // =====================================================================

    function test_Mine_ProducesAnAddressCarryingTheFlags() public view {
        (address mined,) =
            harness.mine(EXPECTED_FLAGS, type(ZyroSkewHook).creationCode, _constructorArgs());

        assertEq(
            uint160(mined) & Hooks.ALL_HOOK_MASK,
            EXPECTED_FLAGS,
            "the mined address must carry exactly the declared permissions"
        );
    }

    /// @dev The salt is only useful if deploying with it actually lands there.
    function test_Mine_SaltReproducesTheMinedAddress() public view {
        bytes memory args = _constructorArgs();
        (address mined, bytes32 salt) =
            harness.mine(EXPECTED_FLAGS, type(ZyroSkewHook).creationCode, args);

        bytes32 initCodeHash = keccak256(abi.encodePacked(type(ZyroSkewHook).creationCode, args));

        assertEq(
            vm.computeCreate2Address(salt, initCodeHash, harness.create2Deployer()),
            mined,
            "deploying with the returned salt must reach the mined address"
        );
    }

    /// @dev Different constructor arguments are a different init code hash and
    ///      therefore a different address. A miner that ignored the arguments
    ///      would return the same salt for every deployment, and the second one
    ///      would revert on a collision.
    function test_Mine_DependsOnConstructorArgs() public view {
        (address a,) = harness.mine(
            EXPECTED_FLAGS,
            type(ZyroSkewHook).creationCode,
            abi.encode(IPoolManager(MANAGER), OWNER)
        );
        (address b,) = harness.mine(
            EXPECTED_FLAGS,
            type(ZyroSkewHook).creationCode,
            abi.encode(IPoolManager(MANAGER), address(0x000000000000000000000000000000000000bEEF))
        );

        assertTrue(a != b, "a different owner must mine to a different address");
    }

    /// @dev `MAX_SALT` is a guess unless something checks it. The flags occupy
    ///      14 bits, so one address in 2^14 matches and a hit is expected
    ///      around 16k iterations — but "expected" is an average, and the
    ///      script reverts rather than degrading if the bound is short.
    ///
    ///      The worst case is all fourteen flags at once, which is the most
    ///      constrained pattern the mask permits. If that resolves inside the
    ///      bound, this hook's four-flag pattern has ample headroom.
    function test_Mine_BoundIsGenerousEnoughForTheWorstCase() public view {
        (address mined, bytes32 salt) = harness.mine(
            uint160(Hooks.ALL_HOOK_MASK), type(ZyroSkewHook).creationCode, _constructorArgs()
        );

        assertEq(
            uint160(mined) & Hooks.ALL_HOOK_MASK,
            uint160(Hooks.ALL_HOOK_MASK),
            "all fourteen flags must be reachable within MAX_SALT"
        );
        assertLt(uint256(salt), 200_000, "and the salt must be inside the bound");
    }

    /// @dev Mining is pure. Re-running the script must reproduce the same
    ///      address, or a redeploy after a failed broadcast lands somewhere new
    ///      and every address recorded downstream is stale.
    function test_Mine_IsDeterministic() public view {
        (address first, bytes32 saltA) =
            harness.mine(EXPECTED_FLAGS, type(ZyroSkewHook).creationCode, _constructorArgs());
        (address second, bytes32 saltB) =
            harness.mine(EXPECTED_FLAGS, type(ZyroSkewHook).creationCode, _constructorArgs());

        assertEq(first, second, "the same inputs must mine to the same address");
        assertEq(saltA, saltB, "and to the same salt");
    }

    // =====================================================================
    // The flags themselves
    // =====================================================================

    /// @dev **The assertion that matters most.** `flags` in the script is a
    ///      hand-written copy of `getHookPermissions()`, and a hand-written
    ///      copy is exactly the thing that drifts. Enabling a callback in the
    ///      hook without updating the script deploys a contract the manager
    ///      then refuses at every `initialize` — and the error surfaces as a
    ///      pool that cannot be created, nowhere near the cause.
    function test_ScriptFlags_MatchTheHooksDeclaredPermissions() public {
        // Placed at any address; the permissions are read from its code.
        ZyroSkewHook hook = new ZyroSkewHook(IPoolManager(MANAGER), OWNER);
        harness.assertPermissionsMatchFlags(hook, EXPECTED_FLAGS);
    }

    function test_ScriptFlags_RejectADriftedFlagSet() public {
        ZyroSkewHook hook = new ZyroSkewHook(IPoolManager(MANAGER), OWNER);

        vm.expectRevert(bytes("getHookPermissions() disagrees with the mined flags"));
        harness.assertPermissionsMatchFlags(
            hook, EXPECTED_FLAGS | uint160(Hooks.BEFORE_DONATE_FLAG)
        );
    }

    /// @dev Return-delta permissions are deliberately off. A hook that can
    ///      return an arbitrary delta can take the whole swap; the fee lever
    ///      does not need it, and the flags live in the address, so this is
    ///      also the difference between two addresses.
    function test_ReturnDeltaFlags_AreNotInTheMinedAddress() public view {
        assertEq(
            EXPECTED_FLAGS & uint160(Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG),
            0,
            "beforeSwapReturnDelta must stay off"
        );
        assertEq(
            EXPECTED_FLAGS & uint160(Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG),
            0,
            "afterSwapReturnDelta must stay off"
        );
    }
}
