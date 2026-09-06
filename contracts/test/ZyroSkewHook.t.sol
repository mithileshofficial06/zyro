// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

import {AvellanedaStoikov as AS} from "../src/libs/AvellanedaStoikov.sol";
import {ZyroSkewHook} from "../src/uniswap/ZyroSkewHook.sol";

/// @notice Tests `ZyroSkewHook` against a **real** `PoolManager`, not a mock.
///
/// @dev Split into two concerns:
///
///      1. The mechanism — at target both directions pay the same fee, and a
///         drifted inventory makes exposed flow cost more than covered flow.
///      2. The security posture Uniswap's own `v4-security-foundations` skill
///         requires: PoolManager-gated callbacks, owner-gated configuration,
///         and the permission set actually being the minimal one claimed.
contract ZyroSkewHookTest is Test, Deployers {
    using LPFeeLibrary for uint24;

    ZyroSkewHook internal hook;
    PoolKey internal poolKey;
    PoolId internal poolId;

    address internal hookOwner = makeAddr("hookOwner");
    address internal stranger = makeAddr("stranger");

    // Calibrated the same way the SwapVM tests are: gamma * sigmaSq must be
    // small, because the skew multiplies a wei-scaled inventory by a raw second
    // count. See the note in ZyroTestBase.
    int256 internal constant GAMMA = 1e14;
    int256 internal constant SIGMA_SQ = 5e13;
    int256 internal constant BASE_SPREAD = 1e15;
    uint256 internal constant HORIZON = 1 hours;

    int256 internal constant TARGET = 0;
    int256 internal constant BOUND = 100e18;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        // The hook's address must encode its permissions, so place the bytecode
        // at an address whose low bits are exactly the flags it declares.
        uint160 flags = uint160(
            Hooks.AFTER_ADD_LIQUIDITY_FLAG | Hooks.AFTER_REMOVE_LIQUIDITY_FLAG
                | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
        );
        address target = address(flags | (uint160(0x4444) << 144));
        deployCodeTo(
            "ZyroSkewHook.sol:ZyroSkewHook", abi.encode(manager, hookOwner), target
        );
        hook = ZyroSkewHook(target);

        (poolKey, poolId) = initPool(
            currency0, currency1, IHooks(address(hook)), LPFeeLibrary.DYNAMIC_FEE_FLAG, SQRT_PRICE_1_1
        );

        _configure(TARGET, BOUND);
    }

    function _params() internal pure returns (AS.Params memory) {
        return AS.Params(GAMMA, SIGMA_SQ, BASE_SPREAD, HORIZON);
    }

    function _configure(int256 target, int256 bound) internal {
        vm.prank(hookOwner);
        hook.configurePool(poolKey, _params(), target, bound, uint40(block.timestamp));
    }

    // =====================================================================
    // Configuration — Corrections 3 and 4
    // =====================================================================

    function test_Configure_RequiresDynamicFee() public {
        (PoolKey memory staticKey,) =
            initPool(currency0, currency1, IHooks(address(hook)), 3000, SQRT_PRICE_1_1);

        vm.prank(hookOwner);
        vm.expectRevert(ZyroSkewHook.PoolNotDynamicFee.selector);
        hook.configurePool(staticKey, _params(), TARGET, BOUND, uint40(block.timestamp));
    }

    /// @dev The defect this replaces: the first caller set a pool's parameters
    ///      permanently, with no owner. Anyone could front-run a pool's first
    ///      configuration with hostile parameters and lock them in forever.
    function test_Configure_IsOwnerGated() public {
        vm.prank(stranger);
        vm.expectRevert(ZyroSkewHook.NotOwner.selector);
        hook.configurePool(poolKey, _params(), TARGET, BOUND, uint40(block.timestamp));
    }

    function test_Reconfigure_WorksForOwner() public {
        int256 newTarget = 500e18;

        vm.prank(hookOwner);
        hook.configurePool(poolKey, _params(), newTarget, BOUND, uint40(block.timestamp));

        assertEq(
            hook.getPoolConfig(poolKey).targetWad,
            newTarget,
            "the owner must be able to reconfigure a live pool"
        );
    }

    function test_Reconfigure_RevertsForStranger() public {
        vm.prank(stranger);
        vm.expectRevert(ZyroSkewHook.NotOwner.selector);
        hook.configurePool(poolKey, _params(), 500e18, BOUND, uint40(block.timestamp));
    }

    /// @dev Correction 4. A negative gamma inverts the skew into a reward for
    ///      drifting, and the wire format can express one — so the guard has to
    ///      run here, not only in the SwapVM instruction.
    function test_Configure_RejectsNegativeGamma() public {
        AS.Params memory bad = AS.Params(-1, SIGMA_SQ, BASE_SPREAD, HORIZON);

        vm.prank(hookOwner);
        vm.expectRevert(abi.encodeWithSelector(AS.NegativeGamma.selector, int256(-1)));
        hook.configurePool(poolKey, bad, TARGET, BOUND, uint40(block.timestamp));
    }

    function test_Configure_RejectsNegativeSigmaSq() public {
        AS.Params memory bad = AS.Params(GAMMA, -1, BASE_SPREAD, HORIZON);

        vm.prank(hookOwner);
        vm.expectRevert(abi.encodeWithSelector(AS.NegativeSigmaSq.selector, int256(-1)));
        hook.configurePool(poolKey, bad, TARGET, BOUND, uint40(block.timestamp));
    }

    /// @dev A pool the owner never configured must refuse to quote rather than
    ///      falling back to a zeroed config, which would read as gamma = 0 and
    ///      silently price as a flat-fee AMM.
    ///
    ///      The key differs from the fixture's only in `tickSpacing`, and is
    ///      deliberately left uninitialised — `_feeFor` checks `configured`
    ///      before it touches the PoolManager, and that ordering is the point.
    function test_QuoteFee_RevertsForUnconfiguredPool() public {
        PoolKey memory other = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 30,
            hooks: IHooks(address(hook))
        });

        vm.expectRevert(ZyroSkewHook.PoolNotConfigured.selector);
        hook.quoteFee(other, true);
    }

    // =====================================================================
    // The mechanism
    // =====================================================================

    /// @dev At exactly target the skew term is zero, so neither direction is
    ///      "exposed" in a way the other is not: both pay the same fee.
    function test_AtTarget_BothDirectionsPayTheSameFee() public view {
        assertEq(hook.poolInventoryWad(poolId), 0, "fixture should start at target");
        assertEq(
            hook.quoteFee(poolKey, true),
            hook.quoteFee(poolKey, false),
            "at target the two directions must be priced identically"
        );
    }

    /// @dev The whole point, expressed as a fee: with the pool long token0,
    ///      buying *more* token0 into it costs more than taking some off it.
    function test_DriftedInventory_ExposedCostsMoreThanCovered() public {
        _driftInventory(int256(80e18));

        uint24 exposedFee = hook.quoteFee(poolKey, true); // adds token0
        uint24 coveredFee = hook.quoteFee(poolKey, false); // removes token0

        assertGt(
            exposedFee,
            coveredFee,
            "flow that worsens the pool's inventory must pay a higher fee"
        );
    }

    /// @dev The ramp is continuous, so drifting further must never reduce the
    ///      fee — no discontinuity for a solver to be surprised by.
    function test_ExposedFee_IsMonotonicInDrift() public {
        _driftInventory(int256(20e18));
        uint24 near = hook.quoteFee(poolKey, true);

        _driftInventory(int256(60e18));
        uint24 far = hook.quoteFee(poolKey, true);

        assertGe(far, near, "drifting further must never lower the exposed fee");
    }

    function test_ExposedFee_ClampsAtTheSoftBound() public {
        _driftInventory(BOUND * 2);
        uint24 past = hook.quoteFee(poolKey, true);

        _driftInventory(BOUND * 10);
        uint24 wayPast = hook.quoteFee(poolKey, true);

        assertEq(past, wayPast, "the penalty must clamp rather than grow without bound");
    }

    /// @dev Once the horizon is consumed the pool stops defending itself and
    ///      charges only the base spread. Surprising, and therefore pinned.
    function test_HorizonExpiry_LeavesOnlyTheBaseSpread() public {
        _driftInventory(int256(80e18));
        uint24 defending = hook.quoteFee(poolKey, true);

        vm.warp(block.timestamp + 30 days);
        uint24 expired = hook.quoteFee(poolKey, true);

        assertLt(expired, defending, "an expired horizon must stop widening the spread");
    }

    /// @dev Correction 5. If the counter only moved on swaps it would drift
    ///      from the pool's real holdings by exactly what LPs deposited, and
    ///      the fee would then be priced off a number that is not the inventory.
    function test_LiquidityEvents_MoveTheInventoryCounter() public {
        int256 before = hook.poolInventoryWad(poolId);

        modifyLiquidityRouter.modifyLiquidity(
            poolKey,
            IPoolManager.ModifyLiquidityParams({
                tickLower: -60,
                tickUpper: 60,
                liquidityDelta: 10e18,
                salt: 0
            }),
            ""
        );

        assertGt(
            hook.poolInventoryWad(poolId),
            before,
            "an LP mint must increase the pool's tracked token0 inventory"
        );
    }

    function test_Swap_MovesTheInventoryCounter() public {
        _addLiquidity();
        int256 before = hook.poolInventoryWad(poolId);

        swap(poolKey, true, -1e18, "");

        assertGt(
            hook.poolInventoryWad(poolId),
            before,
            "a zeroForOne swap must increase the pool's tracked token0 inventory"
        );
    }

    // =====================================================================
    // Security posture
    // =====================================================================

    /// @dev Checklist item 1 from `v4-security-foundations`. Without this
    ///      anyone could call the callbacks directly and move the inventory
    ///      counter to whatever they liked — which is to say, choose the fee
    ///      the next swapper pays.
    function test_Callbacks_RevertForNonPoolManager() public {
        IPoolManager.SwapParams memory sp =
            IPoolManager.SwapParams({zeroForOne: true, amountSpecified: -1e18, sqrtPriceLimitX96: 0});
        IPoolManager.ModifyLiquidityParams memory mp = IPoolManager.ModifyLiquidityParams({
            tickLower: -60,
            tickUpper: 60,
            liquidityDelta: 1e18,
            salt: 0
        });

        vm.startPrank(stranger);

        vm.expectRevert(ZyroSkewHook.NotPoolManager.selector);
        hook.beforeSwap(stranger, poolKey, sp, "");

        vm.expectRevert(ZyroSkewHook.NotPoolManager.selector);
        hook.afterSwap(stranger, poolKey, sp, BalanceDelta.wrap(0), "");

        vm.expectRevert(ZyroSkewHook.NotPoolManager.selector);
        hook.afterAddLiquidity(
            stranger, poolKey, mp, BalanceDelta.wrap(0), BalanceDelta.wrap(0), ""
        );

        vm.expectRevert(ZyroSkewHook.NotPoolManager.selector);
        hook.afterRemoveLiquidity(
            stranger, poolKey, mp, BalanceDelta.wrap(0), BalanceDelta.wrap(0), ""
        );

        vm.stopPrank();
    }

    /// @dev The permission set is the minimal one claimed, and in particular it
    ///      does **not** include `beforeSwapReturnDelta` — the NoOp rug-pull
    ///      vector, which would let a hook claim it handled the whole swap, keep
    ///      the input and return nothing.
    function test_Permissions_ExcludeEveryReturnDelta() public view {
        Hooks.Permissions memory p = hook.getHookPermissions();

        assertFalse(p.beforeSwapReturnDelta, "beforeSwapReturnDelta is the NoOp attack vector");
        assertFalse(p.afterSwapReturnDelta, "the hook must not be able to extract value");
        assertFalse(p.afterAddLiquidityReturnDelta, "the hook must not shortchange LPs");
        assertFalse(p.afterRemoveLiquidityReturnDelta, "the hook must not touch withdrawals");

        // And nothing is enabled that is not used.
        assertFalse(p.beforeInitialize);
        assertFalse(p.afterInitialize);
        assertFalse(p.beforeAddLiquidity);
        assertFalse(p.beforeRemoveLiquidity);
        assertFalse(p.beforeDonate);
        assertFalse(p.afterDonate);

        assertTrue(p.beforeSwap, "the fee lever");
        assertTrue(p.afterSwap, "inventory accounting");
        assertTrue(p.afterAddLiquidity, "inventory must see LP mints");
        assertTrue(p.afterRemoveLiquidity, "...and burns");
    }

    /// @dev The address's low bits must match the declared permissions, or the
    ///      PoolManager would silently not call the callbacks this hook needs.
    function test_HookAddress_EncodesItsPermissions() public view {
        uint160 addr = uint160(address(hook));

        assertTrue(addr & Hooks.BEFORE_SWAP_FLAG != 0, "beforeSwap flag missing");
        assertTrue(addr & Hooks.AFTER_SWAP_FLAG != 0, "afterSwap flag missing");
        assertTrue(addr & Hooks.AFTER_ADD_LIQUIDITY_FLAG != 0, "afterAddLiquidity flag missing");
        assertTrue(
            addr & Hooks.AFTER_REMOVE_LIQUIDITY_FLAG != 0, "afterRemoveLiquidity flag missing"
        );
        assertTrue(
            addr & Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG == 0,
            "the NoOp permission bit must not be set"
        );
    }

    function test_DisabledCallbacks_Revert() public {
        vm.expectRevert(ZyroSkewHook.HookNotImplemented.selector);
        hook.beforeInitialize(address(this), poolKey, SQRT_PRICE_1_1);

        vm.expectRevert(ZyroSkewHook.HookNotImplemented.selector);
        hook.afterInitialize(address(this), poolKey, SQRT_PRICE_1_1, 0);

        vm.expectRevert(ZyroSkewHook.HookNotImplemented.selector);
        hook.beforeDonate(address(this), poolKey, 0, 0, "");

        vm.expectRevert(ZyroSkewHook.HookNotImplemented.selector);
        hook.afterDonate(address(this), poolKey, 0, 0, "");
    }

    /// @dev `beforeSwap` runs on every swap, so the skill sets a budget of
    ///      50,000 gas. Measured through the real PoolManager path.
    function test_QuoteFee_StaysInsideTheGasBudget() public {
        _driftInventory(int256(80e18));

        uint256 before = gasleft();
        hook.quoteFee(poolKey, true);
        uint256 used = before - gasleft();

        assertLt(used, 50_000, "beforeSwap's pricing path must stay under the 50k budget");
    }

    // =====================================================================
    // Helpers
    // =====================================================================

    function _addLiquidity() internal {
        modifyLiquidityRouter.modifyLiquidity(
            poolKey,
            IPoolManager.ModifyLiquidityParams({
                tickLower: -600,
                tickUpper: 600,
                liquidityDelta: 100e18,
                salt: 0
            }),
            ""
        );
    }

    /// @dev Reconfigures the target so the pool reads as drifted by `amount`,
    ///      rather than trying to move real liquidity to a precise inventory.
    ///      `q = inventory - target`, so a negative target of `-amount` at zero
    ///      inventory gives `q = amount`.
    function _driftInventory(int256 amount) internal {
        // Read first: `vm.prank` applies to the next call, and evaluating an
        // argument that happens to be a call would consume it.
        int256 target = hook.poolInventoryWad(poolId) - amount;

        vm.prank(hookOwner);
        hook.configurePool(poolKey, _params(), target, BOUND, uint40(block.timestamp));
    }
}
