"use client";

import {useState} from "react";

import {formatSigned, formatTokens, formatWad, spreadBps} from "@/lib/format";
import type {BenchmarkConfig, BenchmarkScenario, BenchmarkTick} from "@/lib/types";

/**
 * The full receipt table — every tick of every scenario.
 *
 * **This is the page's actual evidence.** The summary above it can be read as
 * four numbers chosen after the fact; a per-tick log cannot, because it shows
 * the ticks where Zyro was outbid and lost the fill sitting in the same column
 * as the ones it won. The cost side of the trade-off is not summarised here,
 * it is enumerated.
 *
 * @dev Scenarios are tabs rather than four stacked tables. All four run the
 *      same fifty ticks with the same columns, so stacking them puts two
 *      hundred near-identical rows between the reader and the comparison they
 *      came for — and the comparison is *between* scenarios, which a reader
 *      can only make if switching is one click rather than a scroll.
 */
export function Receipt({
  scenarios,
  config
}: {
  scenarios: BenchmarkScenario[];
  config: BenchmarkConfig;
}) {
  const [active, setActive] = useState(0);
  const scenario = scenarios[active];

  if (!scenario) return null;

  return (
    <section className="panel">
      <div className="panel__head">
        <h2>Receipt</h2>
        <span className="label" style={{display: "inline"}}>
          {scenario.ticks} ticks · {scenario.declines} declined
        </span>
      </div>

      <div className="tabs">
        {scenarios.map((s, i) => (
          <button
            key={s.name}
            className={`btn${i === active ? " btn--active" : ""}`}
            onClick={() => setActive(i)}
            aria-pressed={i === active}
          >
            {s.label} · {s.path}
          </button>
        ))}
      </div>

      <p className="dim" style={{margin: "0 0 18px", maxWidth: "76ch", fontSize: "0.82rem"}}>
        Each row is one taker request. It quotes both positions through the real{" "}
        <span className="mono">quote()</span> path, and takes whichever pays more — provided
        that beats the exogenous price by no worse than the{" "}
        {config.takerToleranceBps} bps tolerance. When neither does, it declines and both
        positions keep their inventory.
      </p>

      <div className="scroll-x receipt">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th className="num">Price</th>
              <th className="num">Min out</th>
              <th className="num">Stock quote</th>
              <th className="num">Zyro quote</th>
              <th className="num">Zyro Δ bps</th>
              <th>Routed</th>
              <th className="num">Stock q</th>
              <th className="num">Zyro q</th>
            </tr>
          </thead>
          <tbody>
            {scenario.receipt.map((tick) => (
              <Row key={tick.tick} tick={tick} config={config} />
            ))}
          </tbody>
        </table>
      </div>

      <p className="dim" style={{margin: "16px 0 0", maxWidth: "76ch", fontSize: "0.78rem"}}>
        <strong>q</strong> is <span className="mono">balanceIn − target</span>, the same
        quantity the instruction prices against, and the soft bound is{" "}
        {formatTokens(config.boundWad, 0)}. A row where Zyro quotes below stock and still
        takes the fill is one where stock was outside the taker&apos;s tolerance; a row
        where it quotes below and loses the fill is the mechanism paying its premium.
      </p>
    </section>
  );
}

function Row({tick, config}: {tick: BenchmarkTick; config: BenchmarkConfig}) {
  const target = BigInt(config.targetInventoryWad);
  const bound = BigInt(config.boundWad);

  const stockQ = BigInt(tick.stockBalanceInWad) - target;
  const zyroQ = BigInt(tick.zyroBalanceInWad) - target;

  // How far Zyro's quote sits from the stock curve's, in bps of the stock
  // quote. This is the skew, isolated: both positions hold different inventory
  // by now, so it is not purely the instruction's doing — but it is exactly
  // what the taker compared.
  const skew = spreadBps(tick.stockQuoteWad, tick.zyroQuoteWad);

  return (
    <tr>
      <td className="dim">{tick.tick}</td>
      <td className="num">{formatWad(tick.priceWad, 4)}</td>
      <td className="num dim">{formatWad(tick.minOutWad, 4)}</td>
      <td className={`num${tick.routed === "stock" ? "" : " dim"}`}>
        {formatWad(tick.stockQuoteWad, 4)}
      </td>
      <td className={`num${tick.routed === "zyro" ? " maroon-text" : " dim"}`}>
        {formatWad(tick.zyroQuoteWad, 4)}
      </td>
      <td className="num">
        {skew >= 0 ? "+" : ""}
        {skew.toFixed(1)}
      </td>
      <td>
        <span className={`route route--${tick.routed}`}>{tick.routed}</span>
      </td>
      <td className="num" title={nearBound(stockQ, bound)}>
        {formatSigned(stockQ, 0)}
      </td>
      <td className="num" title={nearBound(zyroQ, bound)}>
        {formatSigned(zyroQ, 0)}
      </td>
    </tr>
  );
}

/**
 * @dev 80% is the same threshold `CompetitiveFlow.t.sol` counts `ticksNearBound`
 *      at. Hard-coding a different one here would put a tooltip on the page
 *      that contradicts the column beside it.
 */
function nearBound(q: bigint, bound: bigint): string | undefined {
  const magnitude = q < 0n ? -q : q;
  if (bound === 0n || magnitude * 100n < bound * 80n) return undefined;
  return magnitude >= bound ? "past the soft bound" : "within 20% of the soft bound";
}
