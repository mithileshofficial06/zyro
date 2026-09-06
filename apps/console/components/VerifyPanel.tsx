"use client";

import {useCallback, useState} from "react";

import {shortHex} from "@/lib/format";
import type {VerificationResult} from "@/lib/types";

/**
 * Index against chain, field for field.
 *
 * **This is the panel that answers the actual requirement.** "Live and
 * indexing" is visible from any subgraph's status page. "Returns real, correct
 * data" is not a claim a subgraph can support about itself — it needs a second
 * opinion computed somewhere else, and this is that opinion rendered next to
 * it.
 *
 * The left column is what the AssemblyScript mappings published. The right is
 * what `ZyroLens` returns from `AQUA.safeBalances` and the same Solidity
 * library the instruction runs, called at **the block the index has reached**.
 *
 * @dev Balances are listed first on purpose. The mappings reconstruct them
 *      from `Pushed`/`Pulled` events while the lens reads Aqua's ledger
 *      directly, so a disagreement there accounts for every price
 *      disagreement below it — the arithmetic can be flawless and still
 *      produce the wrong number from the wrong balance. The row order makes
 *      the reader diagnose top-down.
 */
export function VerifyPanel({
  positionId,
  initial
}: {
  positionId: string;
  initial: VerificationResult | null;
}) {
  const [result, setResult] = useState<VerificationResult | null>(initial);
  const [pending, setPending] = useState(false);

  const run = useCallback(async () => {
    setPending(true);
    try {
      const response = await fetch(`/api/verify?id=${positionId}`, {cache: "no-store"});
      const json = await response.json();
      setResult(
        response.ok
          ? (json as VerificationResult)
          : {ok: false, block: 0, comparisons: [], error: json.error ?? response.statusText}
      );
    } catch (error) {
      setResult({
        ok: false,
        block: 0,
        comparisons: [],
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setPending(false);
    }
  }, [positionId]);

  return (
    <section className="panel">
      <div className="panel__head">
        <h2>Index vs chain</h2>
        <div className="row" style={{gap: 10}}>
          {result && !result.error ? (
            <span className={result.ok ? "tag tag--live" : "tag"} style={{color: result.ok ? undefined : "var(--maroon-lit)"}}>
              {result.ok ? "agrees" : "mismatch"}
            </span>
          ) : null}
          <button className="btn" onClick={run} disabled={pending}>
            {pending ? "checking…" : "re-check"}
          </button>
        </div>
      </div>

      <p className="dim" style={{margin: "0 0 16px", maxWidth: "68ch", fontSize: "0.82rem"}}>
        The left column is what the subgraph published. The right is{" "}
        <span className="mono">ZyroLens.state()</span>, reading{" "}
        <span className="mono">AQUA.safeBalances</span> and the same Solidity library the
        instruction prices with — called at the block the index has reached, not at
        chainhead. Comparing against chainhead would report a lagging index as a bug.
      </p>

      {result?.error ? (
        <div
          className="panel panel--flat"
          style={{borderColor: "var(--maroon-lit)", padding: 16}}
        >
          <span className="label" style={{color: "var(--maroon-lit)"}}>
            Could not verify
          </span>
          <p className="mono" style={{margin: "8px 0 0", fontSize: "0.78rem"}}>
            {result.error}
          </p>
        </div>
      ) : null}

      {result && !result.error ? (
        <>
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Field</th>
                  <th className="num">Subgraph</th>
                  <th className="num">ZyroLens</th>
                  <th>·</th>
                </tr>
              </thead>
              <tbody>
                {result.comparisons.map((row) => (
                  <tr key={row.field}>
                    <td className="dim">{row.field}</td>
                    <td className="num">{row.indexed}</td>
                    <td className="num">{row.onChain}</td>
                    <td
                      style={{
                        color: row.agrees ? "var(--ok)" : "var(--fail)",
                        fontWeight: 700
                      }}
                    >
                      {row.agrees ? "=" : "≠"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div
            className="row"
            style={{justifyContent: "space-between", marginTop: 14, fontSize: "0.72rem"}}
          >
            <span className="num dim">
              position {shortHex(positionId, 10, 6)} · block {result.block}
            </span>
            <span className="num" style={{color: result.ok ? "var(--ok)" : "var(--fail)"}}>
              {result.comparisons.filter((c) => c.agrees).length}/{result.comparisons.length} fields
              agree
            </span>
          </div>
        </>
      ) : null}

      {!result ? (
        <p className="dim" style={{margin: 0, fontSize: "0.82rem"}}>
          Not run yet.
        </p>
      ) : null}
    </section>
  );
}
