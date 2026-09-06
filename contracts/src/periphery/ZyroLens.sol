// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IAqua} from "@1inch/aqua/src/interfaces/IAqua.sol";

import {AvellanedaStoikov as AS} from "../libs/AvellanedaStoikov.sol";
import {ZyroInventorySkewArgs} from "../instructions/ZyroInstructions.sol";

/// @title ZyroLens
/// @notice Reads a live position's published pricing state straight off the
///         chain, in the same terms the subgraph publishes it.
///
/// @dev **This contract exists so "the subgraph returns correct data" is a
///      comparison rather than an assertion.**
///
///      There are three independent implementations of the same kernel — the
///      Solidity instruction, the TypeScript SDK, and the AssemblyScript
///      mappings — and until one of them can be evaluated against real chain
///      state at a specific block, agreement between them is only agreement
///      between authors. `quote()` alone does not close that gap: it returns an
///      executed amount, so a reservation price has to be inferred back out of
///      it through the curve, and an error in the inference looks exactly like
///      an error in the index.
///
///      So this reads `AQUA.safeBalances` — the same authoritative ledger the
///      mappings reconstruct from `Pushed`/`Pulled` — and runs the same library
///      the instruction runs. A subgraph query and an `eth_call` pinned to the
///      same block must return identical numbers, field for field. Any
///      disagreement localises immediately: balances differ and the event
///      reconstruction is wrong; balances agree but prices differ and the
///      AssemblyScript port of the kernel is wrong.
///
///      View-only, holds no funds, and is not in any swap path. It is
///      deliberately not merged into `ZyroRouter`, which measures 22,130 bytes
///      against the EIP-170 limit of 24,576 and has no room to spare.
contract ZyroLens {
    /// @notice The Aqua protocol contract this lens reads balances from.
    IAqua public immutable AQUA;

    /// @notice A position's complete published state at the current block.
    ///
    /// @dev Field names and units match `subgraph/schema.graphql` exactly, so a
    ///      mismatch is a value mismatch rather than a mapping exercise.
    struct State {
        uint256 balanceIn;
        uint256 balanceOut;
        int256 inventoryImbalanceWad;
        int256 midWad;
        int256 reservationPriceWad;
        int256 halfSpreadWad;
        uint256 penaltyBps;
        uint256 horizonRemainingSecs;
        uint256 elapsedSecs;
    }

    /// @notice The parameters a position was shipped with.
    struct Parameters {
        int256 gammaWad;
        int256 sigmaSqWad;
        int256 baseSpreadWad;
        int256 targetInventoryWad;
        int256 boundWad;
        uint256 horizonSecs;
        uint256 startTimestamp;
    }

    error ZyroInstructionNotFound();

    /// @dev Zyro's opcode: the next free index after the stock Aqua set's 34
    ///      entries. Not `0x92` — see docs/PHASE2-SOURCE-VERIFICATION.md.
    uint8 internal constant OP_ZYRO = 34;

    constructor(address aqua) {
        AQUA = IAqua(aqua);
    }

    /// @notice Decodes the Zyro parameters out of a shipped program.
    ///
    /// @dev Walks `opcode(1) ++ argsLength(1) ++ args` rather than scanning for
    ///      the byte `34`, which would match inside another instruction's
    ///      arguments. This mirrors `subgraph/src/program.ts:findZyroArgs`; a
    ///      program the two walk differently is a bug in one of them, and this
    ///      is the half that runs against the real chain.
    function parameters(bytes calldata program) public pure returns (Parameters memory p) {
        ZyroInventorySkewArgs.Decoded memory d = ZyroInventorySkewArgs.parse(_findArgs(program));

        p.gammaWad = d.params.gammaWad;
        p.sigmaSqWad = d.params.sigmaSqWad;
        p.baseSpreadWad = d.params.baseSpreadWad;
        p.targetInventoryWad = d.targetInventoryWad;
        p.boundWad = d.boundWad;
        p.horizonSecs = d.params.horizonSecs;
        p.startTimestamp = d.startTimestamp;
    }

    /// @notice Whether `program` carries a Zyro instruction at all.
    /// @dev Most programs shipped to Aqua are not Zyro positions. The subgraph
    ///      skips those silently, and so must anything checking it.
    function isZyroProgram(bytes calldata program) external pure returns (bool) {
        return _offsetOfArgs(program) != type(uint256).max;
    }

    /// @notice The position's live state, from Aqua's own balance ledger.
    ///
    /// @param maker        The maker who shipped it.
    /// @param app          The Zyro router, as an Aqua app.
    /// @param strategyHash `keccak256(strategy)`, which is also the order hash.
    /// @param tokenIn      Canonical direction's input token.
    /// @param tokenOut     Canonical direction's output token.
    /// @param program      The shipped program, as carried by `Shipped`.
    function state(
        address maker,
        address app,
        bytes32 strategyHash,
        address tokenIn,
        address tokenOut,
        bytes calldata program
    ) external view returns (State memory s) {
        Parameters memory p = parameters(program);

        // The same ledger `handlePushed`/`handlePulled` reconstruct. Reverts if
        // the strategy is docked or the token was never part of it — which is
        // itself the answer, and better than returning a zero that reads as a
        // real balance.
        (s.balanceIn, s.balanceOut) = AQUA.safeBalances(maker, app, strategyHash, tokenIn, tokenOut);

        AS.Params memory kp = AS.Params({
            gammaWad: p.gammaWad,
            sigmaSqWad: p.sigmaSqWad,
            baseSpreadWad: p.baseSpreadWad,
            horizonSecs: p.horizonSecs
        });

        s.elapsedSecs = block.timestamp <= p.startTimestamp ? 0 : block.timestamp - p.startTimestamp;

        s.inventoryImbalanceWad = int256(s.balanceIn) - p.targetInventoryWad;
        s.midWad = AS.midFromBalancesWad(s.balanceIn, s.balanceOut);
        s.reservationPriceWad =
            AS.reservationPriceWad(s.midWad, s.inventoryImbalanceWad, kp, s.elapsedSecs);
        s.halfSpreadWad = AS.halfSpreadWad(kp, s.elapsedSecs);
        // Exposed side only, matching the mapping: a covered position is not
        // penalised for holding inventory it is trying to shed.
        s.penaltyBps = s.inventoryImbalanceWad >= 0
            ? AS.softBoundPenaltyBps(s.inventoryImbalanceWad, p.boundWad)
            : 0;
        s.horizonRemainingSecs = AS.remaining(kp, s.elapsedSecs);
    }

    // -----------------------------------------------------------------------
    // Program walking
    // -----------------------------------------------------------------------

    function _findArgs(bytes calldata program) internal pure returns (bytes calldata) {
        uint256 offset = _offsetOfArgs(program);
        require(offset != type(uint256).max, ZyroInstructionNotFound());
        return program[offset:offset + ZyroInventorySkewArgs.ARGS_LENGTH];
    }

    /// @return The offset of the Zyro argument block, or `type(uint256).max`.
    function _offsetOfArgs(bytes calldata program) internal pure returns (uint256) {
        uint256 pc = 0;
        while (pc + 2 <= program.length) {
            uint8 opcode = uint8(program[pc]);
            uint256 argsLength = uint8(program[pc + 1]);
            uint256 argsStart = pc + 2;
            uint256 argsEnd = argsStart + argsLength;

            if (argsEnd > program.length) return type(uint256).max;
            if (opcode == OP_ZYRO) {
                // A Zyro opcode with the wrong argument length is not a Zyro
                // position; parsing it anyway would publish a plausible number.
                if (argsLength != ZyroInventorySkewArgs.ARGS_LENGTH) return type(uint256).max;
                return argsStart;
            }

            pc = argsEnd;
        }
        return type(uint256).max;
    }
}
