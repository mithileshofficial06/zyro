/**
 * The stock Aqua instruction set, in dispatch order.
 *
 * This is a transcription of `aquaInstructions` from 1inch's own SwapVM SDK
 * (`1inch/sdks`, `typescript/swap-vm/src/swap-vm/instructions/index.ts`), which
 * in turn mirrors `AquaOpcodes._opcodes()` in `1inch/swap-vm`.
 *
 * It exists so that Zyro's opcode constants are *derived* rather than asserted.
 * The numeric opcode is the zero-based index into this array — 1inch's program
 * builder computes it exactly that way:
 *
 * ```ts
 * const opcodeIdx = this.ixsSet.findIndex((o) => o.id === opcode.id)
 * builder.addByte(BigInt(opcodeIdx)).addByte(BigInt(encodedBytes.length / 2))
 * ```
 *
 * Zyro claims `ZYRO_OPCODE = STOCK_AQUA_INSTRUCTIONS.length`, so if 1inch ever
 * appends an instruction of their own, updating this list moves Zyro out of the
 * way instead of silently colliding with it.
 *
 * @see docs/UPSTREAM-SDK-VERIFICATION.md
 * @see docs/PHASE2-SOURCE-VERIFICATION.md
 */

/** Reserved-but-unallocated slot. Dispatching to one is a no-op on-chain. */
export const EMPTY = "<empty>" as const;

export const STOCK_AQUA_INSTRUCTIONS: readonly string[] = [
  // 0-9 — debug slots, reserved.
  EMPTY,
  EMPTY,
  EMPTY,
  EMPTY,
  EMPTY,
  EMPTY,
  EMPTY,
  EMPTY,
  EMPTY,
  EMPTY,

  // 10-16 — control flow.
  "controls.jump",
  "controls.jumpIfTokenIn",
  "controls.jumpIfTokenOut",
  "controls.deadline",
  "controls.onlyTakerTokenBalanceNonZero",
  "controls.onlyTakerTokenBalanceGte",
  "controls.onlyTakerTokenSupplyShareGte",

  // 17+ — trading.
  "xycSwap.xycSwapXD",
  "concentrate.concentrateGrowLiquidity2D",
  "decay.decayXD",
  "controls.salt",
  "fee.flatFeeAmountInXD",

  // 22-26 — reserved.
  EMPTY,
  EMPTY,
  EMPTY,
  EMPTY,
  EMPTY,

  "fee.protocolFeeAmountInXD",
  "fee.aquaProtocolFeeAmountInXD",
  "fee.dynamicProtocolFeeAmountInXD",
  "fee.aquaDynamicProtocolFeeAmountInXD",
  "peggedSwap.peggedSwapGrowPriceRange2D",
  "extruction.extruction",
  "controls.onlyTxOriginTokenBalanceNonZero",
] as const;

/** Resolves a stock instruction name to its opcode byte. */
export function stockOpcode(name: string): number {
  const index = STOCK_AQUA_INSTRUCTIONS.indexOf(name);
  if (index === -1) {
    throw new Error(`unknown stock Aqua instruction: ${name}`);
  }
  return index;
}

/**
 * The next free index after the stock set — the slot Zyro claims by appending
 * to the array `AquaOpcodes._opcodes()` returns.
 */
export const ZYRO_OPCODE = STOCK_AQUA_INSTRUCTIONS.length;
