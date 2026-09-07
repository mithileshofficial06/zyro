import Link from "next/link";

import {advantageBps, advantageWad, fillRate} from "@/lib/benchmark";
import {formatTokens} from "@/lib/format";
import type {BenchmarkScenario} from "@/lib/types";

/**
 * The four scenarios, one row each.
 *
 * Shared by the landing page and `/simulate` so the headline numbers cannot
 * drift between them — they are the same component reading the same generated
 * fixture, which is a stronger guarantee than two tables that agree today.
 *
 * @dev Fill rate sits beside value deliberately. A position that ends ahead by
 *      refusing to quote has not succeeded, and that is a claim a reader can
 *      only check if both numbers are on the same row. `CompetitiveFlow.t.sol`
 *      makes the same point as an assertion; this makes it visible.
 */
export function BenchmarkSummary({
  scenarios,
  footnote = true
}: {
  scenarios: BenchmarkScenario[];
  footnote?: boolean;
}) {
  return (
    <>
      <div className="scroll-x">
        <table>
          <thead>
            <tr>
              <th>Scenario</th>
              <th>Path</th>
              <th className="num">Stock fills</th>
              <th className="num">Zyro fills</th>
              <th className="num">Stock drift</th>
              <th className="num">Zyro drift</th>
              <th className="num">Near bound</th>
              <th className="num">Zyro vs stock</th>
            </tr>
          </thead>
          <tbody>
            {scenarios.map((s) => {
              const advantage = advantageWad(s);
              const ahead = advantage >= 0n;
              return (
                <tr key={s.name}>
                  <td>
                    <strong>{s.label}</strong>{" "}
                    <span className="dim">{s.name.split("-").slice(1).join(" ")}</span>
                  </td>
                  <td className="dim mono" style={{fontSize: "0.74rem"}}>
                    {s.path}
                  </td>
                  <td className="num">
                    {s.stock.fills}{" "}
                    <span className="dim">({fillRate(s.stock.fills, s.ticks)}%)</span>
                  </td>
                  <td className="num">
                    {s.zyro.fills}{" "}
                    <span className="dim">({fillRate(s.zyro.fills, s.ticks)}%)</span>
                  </td>
                  <td className="num">{formatTokens(s.stock.maxDeviationWad, 0)}</td>
                  <td className="num maroon-text">{formatTokens(s.zyro.maxDeviationWad, 0)}</td>
                  <td className="num">
                    {s.stock.ticksNearBound} / <strong>{s.zyro.ticksNearBound}</strong>
                  </td>
                  <td className="num" style={{color: ahead ? "var(--ok)" : "var(--fail)"}}>
                    {ahead ? "+" : "−"}
                    {formatTokens(ahead ? advantage : -advantage, 1)}
                    {/* Same sign glyph as the value it annotates. `toFixed` on a
                        negative emits an ASCII hyphen, which sits beside a
                        U+2212 minus in the same cell and reads as two different
                        kinds of negative. */}
                    <span className="dim" style={{marginLeft: 6}}>
                      ({ahead ? "+" : "−"}
                      {Math.abs(advantageBps(s) / 100).toFixed(2)}%)
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {footnote ? (
        <p className="dim" style={{margin: "16px 0 0", maxWidth: "76ch", fontSize: "0.78rem"}}>
          <strong>Drift</strong> is the furthest either position got from its starting
          inventory. <strong>Near bound</strong> counts ticks spent within 20% of the soft
          bound, stock&nbsp;/&nbsp;Zyro — the risk measure a PnL column cannot show, because
          a position can end a scenario level having spent half of it one bad fill from its
          own limit. <Link href="/simulate">Every tick →</Link>
        </p>
      ) : null}
    </>
  );
}
