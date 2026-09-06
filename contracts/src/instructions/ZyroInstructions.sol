// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Calldata} from "@1inch/solidity-utils/contracts/libraries/Calldata.sol";
import {Context} from "@1inch/swap-vm/src/libs/VM.sol";

import {AvellanedaStoikov} from "../libs/AvellanedaStoikov.sol";

/// @title ZyroInventorySkewArgs
/// @notice Wire encoding for the Zyro inventory-skew instruction.
///
/// @dev Mirrors the stock `DutchAuctionArgsBuilder` shape: `build()` packs with
///      `abi.encodePacked`, `parse()` extracts each field through
///      `Calldata.slice` with a named error selector, so a malformed program
///      reverts diagnosably instead of panicking.
///
///      ## Layout -- 121 argument bytes
///
///      | Offset | Bytes | Field                | Type      |
///      |--------|-------|----------------------|-----------|
///      | 0      | 16    | `gammaWad`           | `int128`  |
///      | 16     | 16    | `sigmaSqWad`         | `int128`  |
///      | 32     | 16    | `baseSpreadWad`      | `int128`  |
///      | 48     | 32    | `targetInventoryWad` | `int256`  |
///      | 80     | 32    | `boundWad`           | `int256`  |
///      | 112    | 4     | `horizonSecs`        | `uint32`  |
///      | 116    | 5     | `startTimestamp`     | `uint40`  |
///
///      The VM prefixes every instruction with a 2-byte
///      `opcode ++ argsLength` header (see `ContextLib.runLoop`), and
///      `argsLength` is a single byte, so 121 is comfortably inside the
///      255-byte per-instruction limit.
///
///      Note that `gamma`, `sigmaSq` and `baseSpread` are **signed** on the
///      wire. A negative value is representable here and must be rejected at
///      execution time -- see {ZyroInventorySkew}.
library ZyroInventorySkewArgs {
    using Calldata for bytes;

    /// @notice Total argument length, in bytes.
    uint256 internal constant ARGS_LENGTH = 121;

    error ZyroMissingGamma();
    error ZyroMissingSigmaSq();
    error ZyroMissingBaseSpread();
    error ZyroMissingTargetInventory();
    error ZyroMissingBound();
    error ZyroMissingHorizon();
    error ZyroMissingStartTimestamp();

    /// @param params             Pricing parameters. Signed on the wire.
    /// @param targetInventoryWad The maker's desired `balanceIn`.
    /// @param boundWad           Soft bound on `|q|`.
    /// @param startTimestamp     When the quoting horizon began.
    struct Decoded {
        AvellanedaStoikov.Params params;
        int256 targetInventoryWad;
        int256 boundWad;
        uint256 startTimestamp;
    }

    /// @notice Pack the instruction's argument block.
    function build(
        int128 gammaWad,
        int128 sigmaSqWad,
        int128 baseSpreadWad,
        int256 targetInventoryWad,
        int256 boundWad,
        uint32 horizonSecs,
        uint40 startTimestamp
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            gammaWad,
            sigmaSqWad,
            baseSpreadWad,
            targetInventoryWad,
            boundWad,
            horizonSecs,
            startTimestamp
        );
    }

    /// @notice Pack a complete 2-byte header plus argument block.
    /// @dev The VM reads `opcode ++ argsLength` off the front of every
    ///      instruction. There is no `InstructionBuilder` in swap-vm and no
    ///      `Opcode` enum to be constrained by, so the header is just two bytes.
    function buildInstruction(
        uint8 opcode,
        int128 gammaWad,
        int128 sigmaSqWad,
        int128 baseSpreadWad,
        int256 targetInventoryWad,
        int256 boundWad,
        uint32 horizonSecs,
        uint40 startTimestamp
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            opcode,
            uint8(ARGS_LENGTH),
            build(
                gammaWad,
                sigmaSqWad,
                baseSpreadWad,
                targetInventoryWad,
                boundWad,
                horizonSecs,
                startTimestamp
            )
        );
    }

    /// @notice Decode the argument block.
    function parse(bytes calldata args) internal pure returns (Decoded memory d) {
        d.params.gammaWad = int128(uint128(bytes16(args.slice(0, 16, ZyroMissingGamma.selector))));
        d.params.sigmaSqWad =
            int128(uint128(bytes16(args.slice(16, 32, ZyroMissingSigmaSq.selector))));
        d.params.baseSpreadWad =
            int128(uint128(bytes16(args.slice(32, 48, ZyroMissingBaseSpread.selector))));
        d.targetInventoryWad =
            int256(uint256(bytes32(args.slice(48, 80, ZyroMissingTargetInventory.selector))));
        d.boundWad = int256(uint256(bytes32(args.slice(80, 112, ZyroMissingBound.selector))));
        d.params.horizonSecs =
            uint32(bytes4(args.slice(112, 116, ZyroMissingHorizon.selector)));
        d.startTimestamp = uint40(bytes5(args.slice(116, 121, ZyroMissingStartTimestamp.selector)));
    }
}

/// @title ZyroInventorySkew
/// @notice The Zyro SwapVM instruction: re-centres the pricing curve around the
///         maker's reservation price, given their live Aqua inventory.
///
/// @dev A member of the balance-tuning family. Like the stock Dutch-auction
///      instructions it mutates the balance registers before a curve
///      instruction (`XYCSwap._xycSwapXD`) consumes them, and does nothing
///      else. It contains **no formulas of its own** -- all arithmetic lives in
///      {AvellanedaStoikov}, shared unmodified with the Uniswap v4 hook.
///
///      ## Why this is one instruction and not three
///
///      The natural design splits reservation price, spread and soft bound into
///      three sequential instructions writing to a shared register. SwapVM has
///      no such register -- its pricing state *is* the balance pair -- so
///      instructions two and three would read back already-mutated balances
///      instead of live inventory, corrupting the exact number the mechanism
///      exists to price around. One atomic instruction reads live balances
///      exactly once and is correct by construction.
///
///      ## Where the inventory comes from
///
///      Nowhere in here. `SwapVM.quote()` and `SwapVM.swap()` both populate
///      `ctx.swap.balanceIn` / `balanceOut` from `AQUA.safeBalances()` *before*
///      `runLoop()` dispatches a single instruction. By the time this executes,
///      those registers already are the maker's live wallet balance. There is
///      no lookup, no poll, and no oracle call.
///
///      ## The property that must hold
///
///      `_zyroInventorySkew` must be a pure function of `(balanceIn,
///      balanceOut, block.timestamp, program bytes)`. **Nothing in it may read
///      `ctx.vm.isStaticContext`** -- that flag is the one thing that differs
///      between a `quote()` and the `swap()` that follows it, and reading it is
///      the easiest way to make a taker's quote disagree with their execution.
///      `QuoteSwapParity.t.sol` exists to prove this holds.
contract ZyroInventorySkew {
    using ZyroInventorySkewArgs for bytes;

    /// @notice Zyro's opcode in the Aqua instruction set.
    ///
    /// @dev The stock Aqua set has 34 entries, so valid opcodes are `0..33` and
    ///      this is the next free index. It is claimed by appending to the
    ///      array returned by `AquaOpcodes._opcodes()`; no stock index moves.
    ///
    ///      Note this is **not** `0x92`. swap-vm has no `Opcode` enum and no
    ///      "family bank" address space -- dispatch is a dense array indexed by
    ///      the opcode byte, so `0x92` (146) would be an out-of-bounds panic
    ///      rather than a reserved slot. See `docs/PHASE2-SOURCE-VERIFICATION.md`.
    uint8 internal constant OPCODE = 34;

    /// @dev The horizon's start is read from program bytes. Set in the future,
    ///      `elapsed` would pin to zero indefinitely, the skew would never decay
    ///      and the horizon would mean nothing. Reject it.
    ///
    ///      Setting it in the *past* is legal -- that is a position shipped
    ///      mid-horizon -- but such a position ships already-degraded if the
    ///      horizon has elapsed.
    error ZyroStartTimestampInFuture(uint256 startTimestamp, uint256 currentTime);

    /// @notice Re-centre the curve around the maker's reservation price.
    function _zyroInventorySkew(Context memory ctx, bytes calldata args) internal view {
        ZyroInventorySkewArgs.Decoded memory d = ZyroInventorySkewArgs.parse(args);

        // Rejects negative gamma/sigmaSq/baseSpread, which the int128 wire
        // format can express and which would invert the skew into a reward for
        // drifting. Called on EVERY exec, not once at configuration.
        AvellanedaStoikov.validate(d.params);

        require(
            d.startTimestamp <= block.timestamp,
            ZyroStartTimestampInFuture(d.startTimestamp, block.timestamp)
        );

        // The registers already hold the maker's live Aqua balance.
        int256 q = int256(ctx.swap.balanceIn) - d.targetInventoryWad;
        uint256 elapsed = block.timestamp - d.startTimestamp;

        (ctx.swap.balanceIn, ctx.swap.balanceOut) = AvellanedaStoikov.applyInventorySkew(
            ctx.swap.balanceIn, ctx.swap.balanceOut, q, d.params, elapsed, d.boundWad
        );
    }
}
