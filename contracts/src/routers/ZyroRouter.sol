// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Context} from "@1inch/swap-vm/src/libs/VM.sol";
import {AquaSwapVMRouter} from "@1inch/swap-vm/src/routers/AquaSwapVMRouter.sol";

import {ZyroInventorySkew} from "../instructions/ZyroInstructions.sol";

/// @title ZyroRouter
/// @notice A stock `AquaSwapVMRouter` with exactly one extra instruction.
///
/// @dev The deployable contract. It contains neither math nor encoding -- it
///      adds a single entry to the opcode table and delegates everything else.
///
///      ## Why this is append-only, structurally
///
///      swap-vm dispatches instructions by indexing a dense array of internal
///      function pointers (`ContextLib.runLoop`: `ctx.vm.opcodes[opcode](ctx,
///      args)`). The array is produced by `AquaOpcodes._opcodes()`, which is
///      `internal pure virtual` and carries the upstream comment *"Add new
///      instructions here to maintain backward compatibility"*.
///
///      This override takes the stock array **from `super`** and copies it
///      positionally, then appends. Preserving every stock opcode's index and
///      behaviour is therefore not an argument about control flow -- it is a
///      copy loop. Consequences:
///
///      - Every program the real 1inch SDK emits runs byte-identically.
///      - No fork, no patch, no edited submodule: `lib/swap-vm` stays
///        byte-for-byte official.
///      - It is **proved, not asserted** -- `ZyroRouter.t.sol` quotes an
///        identical stock-only program on a real `AquaSwapVMRouter` and on this
///        router and requires the results to match exactly.
///
///      `AquaSwapVMRouter._instructions()` returns `_opcodes()`, and Solidity
///      resolves internal calls virtually to the most-derived override, so the
///      VM picks up the extended table without `_instructions()` being touched.
contract ZyroRouter is AquaSwapVMRouter, ZyroInventorySkew {
    /// @param aqua    Address of the Aqua protocol contract.
    /// @param weth    Address of WETH, for unwrapping support.
    /// @param owner   Router owner. Rescue-funds authority only.
    /// @param name    EIP-712 domain name.
    /// @param version EIP-712 domain version.
    constructor(
        address aqua,
        address weth,
        address owner,
        string memory name,
        string memory version
    ) AquaSwapVMRouter(aqua, weth, owner, name, version) {}

    /// @notice The stock Aqua instruction set, plus `ZyroInventorySkew` at the
    ///         next free index.
    function _opcodes()
        internal
        pure
        override
        returns (function(Context memory, bytes calldata) internal[] memory result)
    {
        function(Context memory, bytes calldata) internal[] memory stock = super._opcodes();

        result = new function(Context memory, bytes calldata) internal[](stock.length + 1);
        for (uint256 i = 0; i < stock.length; ++i) {
            result[i] = stock[i];
        }
        result[stock.length] = _zyroInventorySkew;
    }
}
