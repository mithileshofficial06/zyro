// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console2} from "forge-std/Test.sol";

import {IAqua} from "@1inch/aqua/src/interfaces/IAqua.sol";
import {ISwapVM} from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import {MakerTraits, MakerTraitsLib} from "@1inch/swap-vm/src/libs/MakerTraits.sol";

import {ZyroTestBase} from "./helpers/ZyroTestBase.sol";

/// @notice Reference outputs for the SDK's order, hash and Aqua-calldata builders.
///
/// @dev The SDK re-implements three things it cannot get wrong: the `MakerTraits`
///      bit packing, `abi.encode` of the order tuple, and `keccak256` over it.
///      Each has the same failure mode — a plausible wrong value, no error, and a
///      position that either cannot be found or cannot be docked.
///
///      So the on-chain libraries produce the expectation. Traits come from the
///      real `MakerTraitsLib.build`, the order bytes from `abi.encode`, and the
///      hash from the router's own `hash()`. `packages/strategy-sdk` is asserted
///      against all of them.
contract OrderFixturesTest is ZyroTestBase {
    string internal constant FIXTURE_PATH = "test/fixtures/order.json";

    /// @dev Fixed so the fixture is reproducible; `makeAddr` derives from a
    ///      label, but pinning the literal keeps the file stable if forge-std
    ///      ever changes that derivation.
    address internal constant FIXED_MAKER = 0x00000000000000000000000000000000000000A1;

    uint40 internal constant FIXED_START = 1_760_000_000;
    bytes8 internal constant FIXED_SALT = 0xdeadbeefcafebabe;

    function _program() internal pure returns (bytes memory) {
        return abi.encodePacked(
            _zyroProgram(
                GAMMA_WAD,
                SIGMA_SQ_WAD,
                BASE_SPREAD_WAD,
                1_000e18,
                500e18,
                HORIZON,
                FIXED_START
            ),
            OP_SALT,
            uint8(8),
            FIXED_SALT
        );
    }

    function _fixedOrder() internal pure returns (ISwapVM.Order memory) {
        MakerTraitsLib.Args memory args;
        args.maker = FIXED_MAKER;
        args.useAquaInsteadOfSignature = true;
        args.program = _program();
        return MakerTraitsLib.build(args);
    }

    // =====================================================================
    // Properties the SDK must also exhibit
    // =====================================================================

    /// @dev With no hooks, all four `uint16` offsets are zero, so the program
    ///      starts at byte 0 and `order.data` *is* the program.
    function test_NoHooks_MeansDataIsExactlyTheProgram() public pure {
        ISwapVM.Order memory order = _fixedOrder();
        assertEq(order.data, _program(), "with no hooks, data must be exactly the program");
        assertEq(
            uint256(MakerTraits.unwrap(order.traits) >> 208) & 0xffff,
            0,
            "the program offset must be zero when no hooks are configured"
        );
    }

    /// @dev Bit 254 is `USE_AQUA_INSTEAD_OF_SIGNATURE`. If the SDK set the wrong
    ///      bit the router would demand a signature and the swap would revert.
    function test_AquaFlag_IsBit254() public pure {
        uint256 traits = MakerTraits.unwrap(_fixedOrder().traits);
        assertTrue((traits >> 254) & 1 == 1, "the Aqua flag must be bit 254");
        assertTrue((traits >> 255) & 1 == 0, "shouldUnwrap must be clear");
        assertTrue((traits >> 253) & 1 == 0, "allowZeroAmountIn must be clear");
    }

    /// @dev A zero receiver means "the maker"; the SDK must not write the maker
    ///      into the low bits, which would be a *custom* receiver that happens to
    ///      equal the maker and changes the hash.
    function test_Receiver_IsZeroWhenUnset() public pure {
        uint256 traits = MakerTraits.unwrap(_fixedOrder().traits);
        assertEq(uint256(uint160(traits)), 0, "an unset receiver must stay zero");
    }

    /// @dev The Aqua strategy hash and the SwapVM order hash are the same number.
    ///      This is why `safeBalances(maker, app, orderHash, …)` finds a position
    ///      shipped by `ship()`.
    function test_StrategyHash_EqualsOrderHash() public view {
        ISwapVM.Order memory order = _fixedOrder();
        bytes memory strategy = abi.encode(order);

        assertEq(
            keccak256(strategy),
            zyroRouter.hash(order),
            "keccak256(strategy) must equal the router's order hash"
        );
    }

    /// @dev Selectors the SDK derives from the canonical signatures.
    function test_AquaSelectors() public pure {
        assertEq(
            bytes4(keccak256("ship(address,bytes,address[],uint256[])")),
            IAqua.ship.selector,
            "ship selector"
        );
        assertEq(
            bytes4(keccak256("dock(address,bytes32,address[])")),
            IAqua.dock.selector,
            "dock selector"
        );
    }

    // =====================================================================
    // Fixture generation
    // =====================================================================

    function _tokens() internal view returns (address[] memory tokens) {
        tokens = new address[](2);
        tokens[0] = address(tokenIn);
        tokens[1] = address(tokenOut);
    }

    function _amounts() internal pure returns (uint256[] memory amounts) {
        amounts = new uint256[](2);
        amounts[0] = 1_000e18;
        amounts[1] = 2_000e18;
    }

    /// @dev Split from {_txJson} because building the whole record in one
    ///      expression exceeds what `via_ir` can place on the stack, which
    ///      Solidity reports as an opaque Yul "too deep in the stack" error.
    function _identityJson() internal view returns (string memory) {
        ISwapVM.Order memory order = _fixedOrder();
        bytes memory strategy = abi.encode(order);

        return string.concat(
            '  "maker":"', vm.toString(FIXED_MAKER), '",\n',
            // abi.encodePacked keeps this 8 bytes; vm.toString(bytes8) widens
            // it to 32, which would have the SDK build a different program.
            '  "salt":"', vm.toString(abi.encodePacked(FIXED_SALT)), '",\n',
            '  "startTimestamp":', vm.toString(uint256(FIXED_START)), ",\n",
            '  "program":"', vm.toString(order.data), '",\n',
            '  "traits":"', vm.toString(MakerTraits.unwrap(order.traits)), '",\n',
            '  "strategy":"', vm.toString(strategy), '",\n',
            '  "strategyHash":"', vm.toString(keccak256(strategy)), '",\n',
            '  "orderHash":"', vm.toString(zyroRouter.hash(order)), '",\n'
        );
    }

    function _txJson() internal view returns (string memory) {
        bytes memory strategy = abi.encode(_fixedOrder());
        address[] memory tokens = _tokens();

        return string.concat(
            '  "app":"', vm.toString(address(zyroRouter)), '",\n',
            '  "aqua":"', vm.toString(address(aqua)), '",\n',
            '  "tokens":["', vm.toString(tokens[0]), '","', vm.toString(tokens[1]), '"],\n',
            '  "amounts":["1000000000000000000000","2000000000000000000000"],\n',
            '  "shipCalldata":"',
            vm.toString(
                abi.encodeCall(IAqua.ship, (address(zyroRouter), strategy, tokens, _amounts()))
            ),
            '",\n',
            '  "dockCalldata":"',
            vm.toString(
                abi.encodeCall(IAqua.dock, (address(zyroRouter), keccak256(strategy), tokens))
            ),
            '"\n'
        );
    }

    function test_WriteFixtures() public {
        vm.writeFile(FIXTURE_PATH, string.concat("{\n", _identityJson(), _txJson(), "}\n"));
        console2.log("wrote", FIXTURE_PATH);
    }
}
