// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {ISwapVM} from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import {MakerTraitsLib} from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import {TakerTraitsLib} from "@1inch/swap-vm/src/libs/TakerTraits.sol";
import {AquaSwapVMRouter} from "@1inch/swap-vm/src/routers/AquaSwapVMRouter.sol";

import {ZyroRouter} from "../../src/routers/ZyroRouter.sol";
import {ZyroInventorySkewArgs} from "../../src/instructions/ZyroInstructions.sol";

/// @notice Minimal ERC-20 for tests. Only what SwapVM's transfer paths touch.
contract TestToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory n, string memory s) {
        name = n;
        symbol = s;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/// @notice Stand-in for the Aqua protocol.
///
/// @dev Zyro never calls Aqua. It reads `ctx.swap.balanceIn`/`balanceOut`, which
///      `SwapVM.quote()` and `SwapVM.swap()` populate from
///      `AQUA.safeBalances()` *before* dispatching any instruction. This mock
///      exists to control that pre-loaded number precisely, which is exactly
///      what the parity and inventory tests need — a real Aqua deployment would
///      make the maker's inventory an input we could not steer.
contract MockAqua {
    /// @dev maker => app => strategyHash => token => balance
    mapping(address => mapping(address => mapping(bytes32 => mapping(address => uint256)))) public
        balances;

    function setBalance(address maker, address app, bytes32 hash_, address token, uint256 amount)
        external
    {
        balances[maker][app][hash_][token] = amount;
    }

    function safeBalances(
        address maker,
        address app,
        bytes32 strategyHash,
        address token0,
        address token1
    ) external view returns (uint256 balance0, uint256 balance1) {
        return (
            balances[maker][app][strategyHash][token0],
            balances[maker][app][strategyHash][token1]
        );
    }

    function rawBalances(address maker, address app, bytes32 strategyHash, address token)
        external
        view
        returns (uint248 balance, uint8 tokensCount)
    {
        return (uint248(balances[maker][app][strategyHash][token]), 2);
    }

    function push(address maker, address app, bytes32 strategyHash, address token, uint256 amount)
        external
    {
        TestToken(token).transferFrom(msg.sender, maker, amount);
        balances[maker][app][strategyHash][token] += amount;
    }

    function pull(address maker, bytes32 strategyHash, address token, uint256 amount, address to)
        external
    {
        balances[maker][msg.sender][strategyHash][token] -= amount;
        TestToken(token).transferFrom(maker, to, amount);
    }
}

/// @notice Shared fixture for the router, parity and encoding suites.
abstract contract ZyroTestBase is Test {
    /// @dev Opcode indices in the stock Aqua instruction set.
    ///
    ///      `AquaOpcodes._opcodes()` builds a fixed `[35]` array and then
    ///      `mstore`s the length over element 0, so `result[i] ==
    ///      instructions[i + 1]` and the whole map is shifted by one relative to
    ///      a naive reading of the source. See
    ///      `docs/PHASE2-SOURCE-VERIFICATION.md`.
    uint8 internal constant OP_XYC_SWAP = 17;
    uint8 internal constant OP_SALT = 20;

    /// @dev The next free index after the stock set's 34 entries.
    uint8 internal constant OP_ZYRO = 34;

    // ---------------------------------------------------------------------
    // Realistic parameter calibration
    //
    // The skew term is `q * gamma * sigmaSq * (T-t) / WAD^2`, where `q` is a
    // wei-scaled token amount and `(T-t)` is a raw second count. Both are large
    // numbers, so `gamma * sigmaSq` has to be *small* for the skew to land as a
    // sensible fraction of the mid.
    //
    // Worked example, at the fixtures below: holding 500 tokens away from
    // target over a one-hour horizon,
    //
    //     skew = 500 * (1e-4 * 5e-5) * 3600 = 0.009
    //
    // against a mid of 2.0 — about 0.45%. Plausible for a maker defending an
    // inventory position.
    //
    // Picking round-looking values like `gamma = 0.5e18` instead makes the skew
    // ~1e6 times the mid, the effective price clamps to 1, and every assertion
    // about "exposed quotes worse" passes for the wrong reason. Tests that only
    // ever exercise the clamp are not testing the mechanism.
    int128 internal constant GAMMA_WAD = 1e14; // 1e-4
    int128 internal constant SIGMA_SQ_WAD = 5e13; // 5e-5
    int128 internal constant BASE_SPREAD_WAD = 1e15; // 0.001 absolute, ~0.05% of a mid of 2
    uint32 internal constant HORIZON = 1 hours;

    MockAqua internal aqua;
    TestToken internal tokenIn;
    TestToken internal tokenOut;
    TestToken internal weth;

    AquaSwapVMRouter internal stockRouter;
    ZyroRouter internal zyroRouter;

    address internal maker = makeAddr("maker");
    address internal taker = makeAddr("taker");
    address internal owner = makeAddr("owner");

    function setUp() public virtual {
        aqua = new MockAqua();
        tokenIn = new TestToken("In", "IN");
        tokenOut = new TestToken("Out", "OUT");
        weth = new TestToken("Wrapped Ether", "WETH");

        stockRouter =
            new AquaSwapVMRouter(address(aqua), address(weth), owner, "SwapVM", "1");
        zyroRouter = new ZyroRouter(address(aqua), address(weth), owner, "SwapVM", "1");
    }

    // ---------------------------------------------------------------------
    // Program construction
    // ---------------------------------------------------------------------

    /// @dev A single stock instruction with no arguments.
    function _stockProgram() internal pure returns (bytes memory) {
        return abi.encodePacked(OP_XYC_SWAP, uint8(0));
    }

    /// @dev `ZyroInventorySkew ++ XYCSwap` — the skew re-centres the balance
    ///      pair, then the stock curve instruction consumes it.
    function _zyroProgram(
        int128 gammaWad,
        int128 sigmaSqWad,
        int128 baseSpreadWad,
        int256 targetInventoryWad,
        int256 boundWad,
        uint32 horizonSecs,
        uint40 startTimestamp
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            ZyroInventorySkewArgs.buildInstruction(
                OP_ZYRO,
                gammaWad,
                sigmaSqWad,
                baseSpreadWad,
                targetInventoryWad,
                boundWad,
                horizonSecs,
                startTimestamp
            ),
            OP_XYC_SWAP,
            uint8(0)
        );
    }

    // ---------------------------------------------------------------------
    // Order / taker-data construction
    // ---------------------------------------------------------------------

    function _order(bytes memory program) internal view returns (ISwapVM.Order memory) {
        MakerTraitsLib.Args memory args;
        args.maker = maker;
        args.useAquaInsteadOfSignature = true;
        args.program = program;
        return MakerTraitsLib.build(args);
    }

    function _takerData(bool isExactIn) internal view returns (bytes memory) {
        TakerTraitsLib.Args memory args;
        args.taker = taker;
        args.isExactIn = isExactIn;
        args.useTransferFromAndAquaPush = true;
        args.isFirstTransferFromTaker = true;
        return TakerTraitsLib.build(args);
    }

    // ---------------------------------------------------------------------
    // Inventory
    // ---------------------------------------------------------------------

    /// @dev Seeds the maker's Aqua balances for a given router/order pair. This
    ///      is the number the whole mechanism prices around.
    function _seedInventory(
        address router,
        bytes32 orderHash,
        uint256 balanceIn,
        uint256 balanceOut
    ) internal {
        aqua.setBalance(maker, router, orderHash, address(tokenIn), balanceIn);
        aqua.setBalance(maker, router, orderHash, address(tokenOut), balanceOut);
    }

    /// @dev Funds and approves so a real `swap()` can settle.
    ///
    ///      Both sides are funded far beyond any amount a test trades, so that
    ///      a revert during settlement means the *strategy* could not pay —
    ///      never that the fixture ran dry. On the exact-output path in
    ///      particular, `amountIn` is derived by the curve and can be much
    ///      larger than the amount the test asked for.
    function _fundForSwap(address router, uint256 takerAmount, uint256 makerAmount) internal {
        tokenIn.mint(taker, takerAmount);
        tokenOut.mint(maker, makerAmount);

        vm.prank(taker);
        tokenIn.approve(router, type(uint256).max);
        vm.prank(maker);
        tokenOut.approve(address(aqua), type(uint256).max);
    }
}
