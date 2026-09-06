/**
 * Formatting for on-chain integers.
 *
 * Everything the subgraph publishes is an exact integer — WAD prices, wei
 * balances, second counts. The console's job is to make them readable without
 * making them wrong, and the two failure modes pull in opposite directions:
 * `Number(bigint)` silently loses precision above 2^53, and printing the raw
 * integer makes two prices that differ in the 15th decimal place look
 * identical at a glance.
 *
 * So: all arithmetic stays in `bigint`, and rounding happens exactly once, at
 * the point of turning a value into a string.
 */

export const WAD = 10n ** 18n;

/**
 * A fixed-point integer as a decimal string, rounded half-up.
 *
 * @dev Done by integer division rather than by `Number(v) / 1e18`. A WAD price
 *      near 2.0 survives the float round-trip; a wei balance of 2,000e18 does
 *      not, and the two are formatted by the same function.
 */
export function formatFixed(value: bigint, decimals = 18, places = 6): string {
  const negative = value < 0n;
  let v = negative ? -value : value;

  const scale = 10n ** BigInt(decimals);
  const whole = v / scale;
  let fraction = v % scale;

  if (places >= decimals) {
    const text = `${whole}.${fraction.toString().padStart(decimals, "0")}`;
    return negative ? `-${text}` : text;
  }

  // Round half-up at `places`, and carry into the whole part if it overflows.
  const cut = 10n ** BigInt(decimals - places);
  const kept = fraction / cut;
  const remainder = fraction % cut;
  let rounded = remainder * 2n >= cut ? kept + 1n : kept;

  let carried = whole;
  const limit = 10n ** BigInt(places);
  if (rounded >= limit) {
    rounded -= limit;
    carried += 1n;
  }

  const text =
    places === 0
      ? `${carried}`
      : `${carried}.${rounded.toString().padStart(places, "0")}`;
  return negative ? `-${text}` : text;
}

/** A WAD price, at the precision a quote is actually read at. */
export function formatWad(value: bigint | string, places = 6): string {
  return formatFixed(BigInt(value), 18, places);
}

/** A wei token amount, grouped, since balances are read as magnitudes. */
export function formatTokens(value: bigint | string, places = 2): string {
  const text = formatFixed(BigInt(value), 18, places);
  const [whole, fraction] = text.split(".");
  const sign = whole.startsWith("-") ? "-" : "";
  const digits = sign ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction ? `${sign}${grouped}.${fraction}` : `${sign}${grouped}`;
}

/** Signed, with an explicit `+` — the sign of `q` is the whole story. */
export function formatSigned(value: bigint | string, places = 2): string {
  const v = BigInt(value);
  const body = formatTokens(v < 0n ? -v : v, places);
  if (v === 0n) return `0.${"0".repeat(places)}`;
  return `${v > 0n ? "+" : "−"}${body}`;
}

/** Basis points as a percentage. 500 bps is the penalty's ceiling. */
export function formatBps(bps: bigint | string): string {
  return `${formatFixed(BigInt(bps), 2, 2)}%`;
}

/**
 * Difference between two WAD prices, in basis points of the first.
 *
 * @dev This is the number the headline chart exists to show: how far the
 *      reservation price has moved from the mid. Expressed relative to the mid
 *      because an absolute WAD offset is unreadable without knowing the price
 *      level it sits at.
 */
export function spreadBps(midWad: bigint | string, otherWad: bigint | string): number {
  const mid = BigInt(midWad);
  if (mid === 0n) return 0;
  const diff = BigInt(otherWad) - mid;
  // Scaled by 100 before the conversion so a sub-basis-point move still has
  // two significant digits left when it becomes a float for display.
  return Number((diff * 1_000_000n) / mid) / 100;
}

export function shortHex(hex: string, lead = 6, tail = 4): string {
  if (hex.length <= lead + tail + 2) return hex;
  return `${hex.slice(0, 2 + lead)}…${hex.slice(-tail)}`;
}

export function formatDuration(seconds: bigint | string): string {
  const total = Number(BigInt(seconds));
  if (total <= 0) return "expired";
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export function formatTimestamp(seconds: bigint | string): string {
  const date = new Date(Number(BigInt(seconds)) * 1000);
  return date.toISOString().replace("T", " ").slice(0, 19);
}
