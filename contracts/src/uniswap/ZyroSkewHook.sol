// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";

import {AvellanedaStoikov as AS} from "../libs/AvellanedaStoikov.sol";

/// @title ZyroSkewHook
/// @notice The Zyro pricing kernel expressed through Uniswap v4's dynamic-fee
///         extension point.
///
/// @dev **This is a port, not a second instance of the innovation.** "One kernel,
///      two venues" is true at the level of code reuse and false at the level of
///      the mechanism, and the difference matters:
///
///      | | Aqua path | v4 path (here) |
///      |---|---|---|
///      | Whose inventory | a specific maker's real wallet | the pool's, via a hook-maintained counter |
///      | Read from | `AQUA.safeBalances()` | this contract's own state |
///      | Lever | rotate the curve | override the LP fee |
///
///      On Aqua there is a real maker with real risk who chose these parameters.
///      Here the "inventory" belongs to a pool whose LPs never opted into a risk
///      model — the structural problem that makes inventory-aware quoting
///      impossible on pool AMMs reappears *inside* this implementation. It
///      demonstrates that the concept generalises to a fee lever. It does not
///      demonstrate a second working instance of the mechanism.
///
///      ## What is reused, and what is not
///
///      Reused: {AS.halfSpreadWad} and {AS.softBoundPenaltyBps}, both already
///      spread- and fee-shaped.
///
///      Not reused: {AS.reservationPriceWad} and {AS.recenterBalances}. Those
///      are specific to SwapVM's balance-pair curve. A v4 pool's liquidity is
///      concentrated and tick-indexed; there is no equivalent pair to rotate
///      without reimplementing v4's own swap math.
///
///      ## Security posture
///
///      Built to the constraints in Uniswap's own `v4-security-foundations`
///      skill (`Uniswap/uniswap-ai`):
///
///      - Every callback verifies `msg.sender == poolManager`. In a hook
///        `msg.sender` is *always* the PoolManager, never the end user — useless
///        for identity, essential for access control.
///      - **`beforeSwapReturnDelta` is `false`.** It is the NoOp rug-pull
///        vector: a hook holding it can claim it handled the whole swap, keep
///        the input and return nothing. A dynamic fee is `beforeSwap`'s third
///        return value, a `uint24` — not a delta — so enabling the single
///        highest-risk permission in v4 would buy nothing here.
///      - No permission is enabled that is not used, and no callback holds an
///        unbounded loop or an external call beyond one `getSlot0`.
///
///      This contract implements `IHooks` directly rather than inheriting a
///      `BaseHook`. `v4-periphery` deleted `src/utils/BaseHook.sol` and moved
///      hooks out of the repository, so the base is a moving target; and the
///      security guidance asks for the PoolManager check to be explicit, which
///      it now is, in this file, where it can be audited.
contract ZyroSkewHook is IHooks {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using LPFeeLibrary for uint24;

    /// @notice Configuration for one pool.
    /// @param params        Validated pricing parameters.
    /// @param boundWad      Soft bound on `|q|`.
    /// @param targetWad     Desired `token0` inventory.
    /// @param startTimestamp When the quoting horizon began.
    /// @param configured    Distinguishes a zeroed struct from a real config.
    struct PoolConfig {
        AS.Params params;
        int256 boundWad;
        int256 targetWad;
        uint40 startTimestamp;
        bool configured;
    }

    /// @notice 18-decimal scale, matching the kernel.
    int256 internal constant WAD = 1e18;

    /// @notice Parts-per-million, the unit v4 expresses LP fees in.
    uint256 internal constant PPM = 1_000_000;

    /// @notice The PoolManager. The only address permitted to call the callbacks.
    IPoolManager public immutable poolManager;

    /// @notice Configuration authority.
    /// @dev Deployer-owned is honest and sufficient for a proof of concept.
    ///      Production would want per-pool delegated authority — a pool's LPs,
    ///      not this contract's deployer, are the ones bearing the risk being
    ///      priced.
    address public immutable owner;

    mapping(PoolId => PoolConfig) internal _configs;

    /// @notice Net `token0` held by the pool, in WAD.
    ///
    /// @dev This is genuinely the pool's inventory, not merely net swap flow:
    ///      `afterAddLiquidity` and `afterRemoveLiquidity` are enabled so LP
    ///      mints and burns move it too. Tracking only swaps would leave the
    ///      counter drifting from the pool's real holdings by exactly the amount
    ///      LPs deposited or withdrew — and pricing risk off a number that is
    ///      not the inventory is the failure this whole project exists to avoid.
    ///
    ///      Assumes an 18-decimal `token0`. A pool with a 6-decimal `token0`
    ///      would need the target and bound scaled to match.
    mapping(PoolId => int256) public poolInventoryWad;

    error NotPoolManager();
    error NotOwner();
    error PoolNotDynamicFee();
    error PoolNotConfigured();
    error HookNotImplemented();

    event PoolConfigured(
        PoolId indexed poolId, int256 gammaWad, int256 sigmaSqWad, int256 baseSpreadWad
    );

    /// @dev Every callback is gated on this. Without it anyone could call the
    ///      hook directly and move `poolInventoryWad` to whatever they liked,
    ///      which would let them choose the fee the next swapper pays.
    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(IPoolManager _poolManager, address _owner) {
        poolManager = _poolManager;
        owner = _owner;
    }

    // ---------------------------------------------------------------------
    // Configuration
    // ---------------------------------------------------------------------

    /// @notice Set or replace a pool's pricing parameters.
    ///
    /// @dev Owner-gated and re-runnable. An earlier design let the *first
    ///      caller* set a pool's parameters permanently, with no owner and no
    ///      way to reconfigure — so anyone could front-run a pool's first
    ///      configuration with hostile parameters and lock them in forever.
    ///
    ///      Parameters are validated here with the same {AS.validate} the SwapVM
    ///      instruction runs. The negative-gamma inversion applies identically:
    ///      a negative `gamma` or `sigmaSq` would make the pool quote *cheaper*
    ///      the further its inventory drifts, paying takers to worsen it.
    function configurePool(
        PoolKey calldata key,
        AS.Params calldata params,
        int256 targetWad,
        int256 boundWad,
        uint40 startTimestamp
    ) external onlyOwner {
        if (!key.fee.isDynamicFee()) revert PoolNotDynamicFee();

        AS.validate(params);

        PoolId id = key.toId();
        _configs[id] = PoolConfig({
            params: params,
            boundWad: boundWad,
            targetWad: targetWad,
            startTimestamp: startTimestamp,
            configured: true
        });

        emit PoolConfigured(id, params.gammaWad, params.sigmaSqWad, params.baseSpreadWad);
    }

    function getPoolConfig(PoolKey calldata key) external view returns (PoolConfig memory) {
        return _configs[key.toId()];
    }

    // ---------------------------------------------------------------------
    // Permissions
    // ---------------------------------------------------------------------

    /// @notice The permissions this hook's address must encode.
    ///
    /// @dev Everything starts `false`; only what is used is enabled. Note in
    ///      particular that both `beforeSwapReturnDelta` and
    ///      `afterSwapReturnDelta` stay off — this hook never returns a delta,
    ///      only a fee, so it cannot take value out of a swap even if it were
    ///      compromised.
    function getHookPermissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: true, // inventory must see LP mints
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: true, // ...and burns
            beforeSwap: true, // the fee lever
            afterSwap: true, // inventory accounting
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false, // NoOp rug-pull vector; not needed
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // ---------------------------------------------------------------------
    // Pricing
    // ---------------------------------------------------------------------

    /// @notice The fee this pool would quote right now, in hundredths of a bip.
    /// @dev Exposed for tests, the console and any solver that wants to price a
    ///      swap without simulating it.
    function quoteFee(PoolKey calldata key, bool zeroForOne) external view returns (uint24) {
        return _feeFor(key.toId(), zeroForOne);
    }

    function _feeFor(PoolId id, bool zeroForOne) internal view returns (uint24) {
        PoolConfig memory cfg = _configs[id];
        if (!cfg.configured) revert PoolNotConfigured();

        uint256 elapsed = block.timestamp > cfg.startTimestamp
            ? block.timestamp - cfg.startTimestamp
            : 0;

        // The pool already knows its own mid authoritatively; deriving it from
        // anywhere else would be an oracle Zyro does not need.
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(id);
        int256 midWad = _midFromSqrtPriceX96(sqrtPriceX96);
        if (midWad <= 0) return uint24(0).removeOverrideFlag();

        // halfSpreadWad is an ABSOLUTE price offset. Dividing by the mid turns
        // it into a proportion, which is what a fee is.
        int256 halfSpread = AS.halfSpreadWad(cfg.params, elapsed);
        uint256 feePpm = (uint256(halfSpread) * PPM) / uint256(midWad);

        int256 q = poolInventoryWad[id] - cfg.targetWad;

        // Exposed means the trade pushes inventory further from target.
        // zeroForOne adds token0 to the pool; oneForZero removes it.
        bool exposed = zeroForOne ? (q >= 0) : (q <= 0);

        if (exposed) {
            // Covered-side flow never pays the soft-bound penalty — that is
            // exactly the flow the pool wants to attract as it nears its bound.
            uint256 penaltyBps = AS.softBoundPenaltyBps(q, cfg.boundWad);
            feePpm += penaltyBps * 100; // 1 bp = 100 ppm
        }

        uint256 maxFee = uint256(LPFeeLibrary.MAX_LP_FEE);
        if (feePpm > maxFee) feePpm = maxFee;

        return uint24(feePpm);
    }

    /// @dev `mid = (sqrtPriceX96 / 2**96)**2`, in WAD — token1 per token0.
    ///      Squaring first and shifting once keeps full precision; the
    ///      intermediate is at most 2^160 * 2^160 = 2^320 in theory, so the
    ///      shift is applied between the two multiplications to stay inside
    ///      256 bits for any real pool price.
    function _midFromSqrtPriceX96(uint160 sqrtPriceX96) internal pure returns (int256) {
        if (sqrtPriceX96 == 0) return 0;
        uint256 p = uint256(sqrtPriceX96);
        // (p * p >> 96) * WAD >> 96 — split so neither product overflows.
        uint256 intermediate = (p * p) >> 96;
        return int256((intermediate * uint256(WAD)) >> 96);
    }

    // ---------------------------------------------------------------------
    // Hook callbacks
    // ---------------------------------------------------------------------

    /// @notice Overrides the LP fee for this swap.
    /// @dev Returns a zero delta: this hook never claims any part of the swap.
    function beforeSwap(
        address,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata params,
        bytes calldata
    ) external view override onlyPoolManager returns (bytes4, BeforeSwapDelta, uint24) {
        uint24 fee = _feeFor(key.toId(), params.zeroForOne);
        return (
            IHooks.beforeSwap.selector,
            BeforeSwapDeltaLibrary.ZERO_DELTA,
            fee | LPFeeLibrary.OVERRIDE_FEE_FLAG
        );
    }

    /// @notice Applies the swap's effect on the pool's `token0` inventory.
    /// @dev `delta` is the **swapper's** balance delta, so the pool's change is
    ///      its negation. Getting that sign wrong would make the hook widen
    ///      spreads exactly when it should be tightening them.
    function afterSwap(
        address,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata,
        BalanceDelta delta,
        bytes calldata
    ) external override onlyPoolManager returns (bytes4, int128) {
        poolInventoryWad[key.toId()] -= int256(delta.amount0());
        return (IHooks.afterSwap.selector, int128(0));
    }

    /// @notice Applies an LP mint to the pool's `token0` inventory.
    function afterAddLiquidity(
        address,
        PoolKey calldata key,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta delta,
        BalanceDelta,
        bytes calldata
    ) external override onlyPoolManager returns (bytes4, BalanceDelta) {
        poolInventoryWad[key.toId()] -= int256(delta.amount0());
        return (IHooks.afterAddLiquidity.selector, BalanceDelta.wrap(0));
    }

    /// @notice Applies an LP burn to the pool's `token0` inventory.
    function afterRemoveLiquidity(
        address,
        PoolKey calldata key,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta delta,
        BalanceDelta,
        bytes calldata
    ) external override onlyPoolManager returns (bytes4, BalanceDelta) {
        poolInventoryWad[key.toId()] -= int256(delta.amount0());
        return (IHooks.afterRemoveLiquidity.selector, BalanceDelta.wrap(0));
    }

    // ---------------------------------------------------------------------
    // Disabled callbacks
    //
    // `IHooks` is a full interface, so these have to exist. The permission bits
    // above are false, so the PoolManager will never call them — reverting is
    // the honest response if one is somehow reached.
    // ---------------------------------------------------------------------

    function beforeInitialize(address, PoolKey calldata, uint160)
        external
        pure
        override
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24)
        external
        pure
        override
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function beforeAddLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        bytes calldata
    ) external pure override returns (bytes4) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        bytes calldata
    ) external pure override returns (bytes4) {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert HookNotImplemented();
    }
}
