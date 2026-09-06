// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console2} from "forge-std/Test.sol";

import {ZyroInventorySkewArgs} from "../src/instructions/ZyroInstructions.sol";
import {ZyroTestBase} from "./helpers/ZyroTestBase.sol";

/// @notice Generates the reference bytes the TypeScript SDK is asserted against.
///
/// @dev This is the cross-language correctness check. The SDK's encoders must
///      produce **byte-identical** output to the Solidity `build()`, and the
///      only trustworthy way to establish that is to capture the expectation
///      from a live run of the Solidity encoder rather than hand-deriving it
///      from reading the source — a hand-derived fixture only proves the
///      author read both implementations the same wrong way.
///
///      Running this suite rewrites `test/fixtures/encoding.json`, which
///      `packages/strategy-sdk` reads directly. Nothing is copied by hand.
///
///      The suite also asserts round-trip and layout properties, so a fixture
///      can never be regenerated into agreeing with a broken encoder.
contract EncodingFixturesTest is ZyroTestBase {
    string internal constant FIXTURE_PATH = "test/fixtures/encoding.json";

    struct Fixture {
        string name;
        int128 gammaWad;
        int128 sigmaSqWad;
        int128 baseSpreadWad;
        int256 targetInventoryWad;
        int256 boundWad;
        uint32 horizonSecs;
        uint40 startTimestamp;
    }

    function _fixtures() internal pure returns (Fixture[] memory f) {
        f = new Fixture[](4);

        // A realistic maker position: see the calibration note in ZyroTestBase.
        f[0] = Fixture({
            name: "calibrated",
            gammaWad: 1e14,
            sigmaSqWad: 5e13,
            baseSpreadWad: 1e15,
            targetInventoryWad: 1_000e18,
            boundWad: 500e18,
            horizonSecs: 3600,
            startTimestamp: 1_760_000_000
        });

        // Everything zero: the encoder must not special-case an empty position.
        f[1] = Fixture({
            name: "zeros",
            gammaWad: 0,
            sigmaSqWad: 0,
            baseSpreadWad: 0,
            targetInventoryWad: 0,
            boundWad: 0,
            horizonSecs: 0,
            startTimestamp: 0
        });

        // Negative target and bound. These are legitimately signed, and
        // two's-complement packing is the single easiest thing to get wrong
        // across a language boundary.
        f[2] = Fixture({
            name: "negative-target",
            gammaWad: 1e14,
            sigmaSqWad: 5e13,
            baseSpreadWad: 1e15,
            targetInventoryWad: -1_000e18,
            boundWad: -500e18,
            horizonSecs: 86_400,
            startTimestamp: 1_760_000_000
        });

        // Every field at its maximum, to pin the field widths.
        f[3] = Fixture({
            name: "maxima",
            gammaWad: 1e18,
            sigmaSqWad: 1e18,
            baseSpreadWad: 1e18,
            targetInventoryWad: type(int256).max,
            boundWad: type(int256).min,
            horizonSecs: type(uint32).max,
            startTimestamp: type(uint40).max
        });
    }

    function _encode(Fixture memory f) internal pure returns (bytes memory) {
        return ZyroInventorySkewArgs.build(
            f.gammaWad,
            f.sigmaSqWad,
            f.baseSpreadWad,
            f.targetInventoryWad,
            f.boundWad,
            f.horizonSecs,
            f.startTimestamp
        );
    }

    function _encodeInstruction(Fixture memory f) internal pure returns (bytes memory) {
        return ZyroInventorySkewArgs.buildInstruction(
            OP_ZYRO,
            f.gammaWad,
            f.sigmaSqWad,
            f.baseSpreadWad,
            f.targetInventoryWad,
            f.boundWad,
            f.horizonSecs,
            f.startTimestamp
        );
    }

    // =====================================================================
    // Layout invariants
    // =====================================================================

    function test_ArgsAreExactly121Bytes() public pure {
        Fixture[] memory fs = _fixtures();
        for (uint256 i = 0; i < fs.length; ++i) {
            assertEq(_encode(fs[i]).length, 121, "argument block must be exactly 121 bytes");
        }
        assertEq(ZyroInventorySkewArgs.ARGS_LENGTH, 121);
    }

    function test_InstructionIsHeaderPlusArgs() public pure {
        Fixture[] memory fs = _fixtures();
        for (uint256 i = 0; i < fs.length; ++i) {
            bytes memory instr = _encodeInstruction(fs[i]);
            assertEq(instr.length, 123, "instruction must be 2 header bytes + 121 argument bytes");
            assertEq(uint8(instr[0]), OP_ZYRO, "first byte must be the opcode");
            assertEq(uint8(instr[1]), 121, "second byte must be the argument length");
        }
    }

    /// @dev The VM reads the argument length from a single byte, so anything at
    ///      or above 256 would silently truncate.
    function test_ArgsLengthFitsInOneByte() public pure {
        assertLt(ZyroInventorySkewArgs.ARGS_LENGTH, 256, "argsLength must fit in one byte");
    }

    // =====================================================================
    // Round trip
    //
    // A fixture is only worth anything if the decoder agrees with the encoder.
    // Otherwise regenerating the file would happily bless a broken pair.
    // =====================================================================

    function test_RoundTrip() public view {
        Fixture[] memory fs = _fixtures();
        for (uint256 i = 0; i < fs.length; ++i) {
            bytes memory encoded = _encode(fs[i]);
            ZyroInventorySkewArgs.Decoded memory d = this.parseExternal(encoded);

            assertEq(d.params.gammaWad, fs[i].gammaWad, "gamma round trip");
            assertEq(d.params.sigmaSqWad, fs[i].sigmaSqWad, "sigmaSq round trip");
            assertEq(d.params.baseSpreadWad, fs[i].baseSpreadWad, "baseSpread round trip");
            assertEq(d.targetInventoryWad, fs[i].targetInventoryWad, "target round trip");
            assertEq(d.boundWad, fs[i].boundWad, "bound round trip");
            assertEq(d.params.horizonSecs, fs[i].horizonSecs, "horizon round trip");
            assertEq(d.startTimestamp, fs[i].startTimestamp, "startTimestamp round trip");
        }
    }

    function testFuzz_RoundTrip(
        int128 gammaWad,
        int128 sigmaSqWad,
        int128 baseSpreadWad,
        int256 targetInventoryWad,
        int256 boundWad,
        uint32 horizonSecs,
        uint40 startTimestamp
    ) public view {
        bytes memory encoded = ZyroInventorySkewArgs.build(
            gammaWad,
            sigmaSqWad,
            baseSpreadWad,
            targetInventoryWad,
            boundWad,
            horizonSecs,
            startTimestamp
        );
        ZyroInventorySkewArgs.Decoded memory d = this.parseExternal(encoded);

        assertEq(d.params.gammaWad, gammaWad);
        assertEq(d.params.sigmaSqWad, sigmaSqWad);
        assertEq(d.params.baseSpreadWad, baseSpreadWad);
        assertEq(d.targetInventoryWad, targetInventoryWad);
        assertEq(d.boundWad, boundWad);
        assertEq(d.params.horizonSecs, horizonSecs);
        assertEq(d.startTimestamp, startTimestamp);
    }

    /// @dev `parse` reads from calldata, so the round-trip tests need a real
    ///      external call frame to hand it a calldata slice.
    function parseExternal(bytes calldata args)
        external
        pure
        returns (ZyroInventorySkewArgs.Decoded memory)
    {
        return ZyroInventorySkewArgs.parse(args);
    }

    /// @dev A truncated argument block must revert with the named error for the
    ///      *first* field that ran out, not with a bare panic. Which error you
    ///      get is a function of where the truncation lands, so both boundaries
    ///      are pinned: the field layout is part of the wire contract.
    function test_TruncatedArgs_RevertWithNamedError() public {
        // boundWad occupies [80, 112), so 100 bytes cuts through it.
        vm.expectRevert(ZyroInventorySkewArgs.ZyroMissingBound.selector);
        this.parseExternal(_truncate(100));

        // horizonSecs occupies [112, 116), so 114 bytes clears bound and cuts
        // through the horizon instead.
        vm.expectRevert(ZyroInventorySkewArgs.ZyroMissingHorizon.selector);
        this.parseExternal(_truncate(114));

        // startTimestamp occupies [116, 121): one byte short is still an error.
        vm.expectRevert(ZyroInventorySkewArgs.ZyroMissingStartTimestamp.selector);
        this.parseExternal(_truncate(120));

        // And the full block parses.
        this.parseExternal(_truncate(121));
    }

    function _truncate(uint256 len) internal pure returns (bytes memory short) {
        bytes memory full = _encode(_fixtures()[0]);
        short = new bytes(len);
        for (uint256 i = 0; i < len; ++i) {
            short[i] = full[i];
        }
    }

    // =====================================================================
    // Fixture generation
    // =====================================================================

    /// @notice Writes `test/fixtures/encoding.json`, which the SDK reads.
    /// @dev Named `test_` so it runs in the ordinary suite: the fixtures are
    ///      regenerated on every CI run, so the SDK can never drift from the
    ///      Solidity encoder without something going red.
    function test_WriteFixtures() public {
        Fixture[] memory fs = _fixtures();

        string memory json = "[";
        for (uint256 i = 0; i < fs.length; ++i) {
            json = string.concat(
                json,
                i == 0 ? "" : ",",
                "\n  {",
                '"name":"', fs[i].name, '",',
                '"gammaWad":"', vm.toString(fs[i].gammaWad), '",',
                '"sigmaSqWad":"', vm.toString(fs[i].sigmaSqWad), '",',
                '"baseSpreadWad":"', vm.toString(fs[i].baseSpreadWad), '",',
                '"targetInventoryWad":"', vm.toString(fs[i].targetInventoryWad), '",',
                '"boundWad":"', vm.toString(fs[i].boundWad), '",',
                '"horizonSecs":', vm.toString(uint256(fs[i].horizonSecs)), ",",
                '"startTimestamp":', vm.toString(uint256(fs[i].startTimestamp)), ",",
                '"opcode":', vm.toString(uint256(OP_ZYRO)), ",",
                '"args":"', vm.toString(_encode(fs[i])), '",',
                '"instruction":"', vm.toString(_encodeInstruction(fs[i])), '"',
                "}"
            );
        }
        json = string.concat(json, "\n]\n");

        vm.writeFile(FIXTURE_PATH, json);

        console2.log("wrote", FIXTURE_PATH);
        console2.log(json);
    }
}
