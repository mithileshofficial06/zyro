import {formatSigned, formatTokens} from "@/lib/format";

/**
 * `q` against the soft bound, drawn as a distance.
 *
 * This is the page's headline: the entire mechanism is a response to how far
 * inventory has drifted from its target, and the numbers alone do not say
 * whether 3,412 is comfortable or one fill from the edge. That is a distance,
 * and a distance wants a length.
 *
 * @dev The scale is fixed at ±1.25× the bound rather than fitted to the
 *      current `q`. A gauge that rescales to its own needle always shows the
 *      needle in the same place, which is the one thing this must never do —
 *      the bound has to stay put so drift can be seen moving toward it. Past
 *      1.25× the bar clamps and the fill changes colour instead, because a
 *      position that far out is already past every threshold the scale exists
 *      to show.
 *
 *      All arithmetic is in `bigint` until the final percentage. `q` and the
 *      bound are wei quantities around 1e21; `Number(q) / Number(bound)` would
 *      be a float division of two values well past `MAX_SAFE_INTEGER`, and the
 *      bar would sit in approximately the right place for approximately the
 *      right reason.
 */
export function Gauge({
  q,
  bound,
  penaltyBps
}: {
  q: string;
  bound: string;
  penaltyBps: string;
}) {
  const value = BigInt(q);
  const limit = BigInt(bound);

  // A position shipped with no bound has no soft-bound penalty at all — the
  // gauge would be a bar against an undefined edge.
  if (limit <= 0n) {
    return (
      <div>
        <div className="gauge">
          <div className="gauge__target" />
        </div>
        <div className="gauge__scale">
          <span>no soft bound configured</span>
          <span>q = {formatSigned(value)}</span>
        </div>
      </div>
    );
  }

  const magnitude = value < 0n ? -value : value;
  const past = magnitude >= limit;

  // Percent of the half-width, in tenths, kept integral: |q| / (1.25 × bound).
  const span = (limit * 5n) / 4n;
  const raw = Number((magnitude * 1000n) / span) / 10;
  const half = Math.min(raw, 100) / 2; // as a percentage of the full width

  return (
    <div>
      <div className="gauge">
        <div
          className={`gauge__fill${past ? " gauge__fill--over" : ""}`}
          style={
            value >= 0n
              ? {left: "50%", width: `${half}%`}
              : {right: "50%", width: `${half}%`}
          }
        />
        {/* Both bounds, always — the far one is what says the near one is not
            simply the edge of the widget. */}
        <div className="gauge__bound" style={{left: "10%"}} />
        <div className="gauge__bound" style={{left: "90%"}} />
        <div className="gauge__target" />
      </div>

      <div className="gauge__scale">
        <span>−{formatTokens(limit, 0)}</span>
        <span style={{color: past ? "var(--fail)" : "var(--white)"}}>
          q = {formatSigned(value)} · penalty {Number(penaltyBps) / 100}%
        </span>
        <span>+{formatTokens(limit, 0)}</span>
      </div>
    </div>
  );
}
