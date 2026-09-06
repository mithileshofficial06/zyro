import {AnimatedBar, AnimatedLabel, AnimatedMarker, AnimatedPath, AnimatedRule} from "./AnimatedSvg";
import {spreadBps} from "@/lib/format";
import type {Fill} from "@/lib/types";

/**
 * Mid against reservation price, across a position's fill series.
 *
 * **This is the chart the whole project is an argument for.** Two lines that
 * start on top of each other while the position is balanced, and separate as
 * inventory accumulates. A pool AMM cannot draw the second line at all; it has
 * one price and no notion of whose inventory is behind it.
 *
 * @dev **The y-domain is the entire design problem here.** The separation
 *      between the two series is around 0.45% of the mid at full drift. Drawn
 *      against a domain of `[0, max]` — the default of every charting library
 *      — the two lines land within a pixel of each other and the chart shows
 *      nothing at all, while looking completely correct. So the domain is the
 *      data's own range, padded, and the axis is labelled with real prices so
 *      the zoom is visible rather than hidden.
 *
 *      Rendered as plain SVG on the server. No chart library, no client
 *      JavaScript: the shapes are lines through points, and every library that
 *      would draw them also brings smoothing, rounded caps and easing — all of
 *      which are wrong for this page, and two of which would misrepresent the
 *      data by interpolating between fills that did not happen.
 */

const WIDTH = 900;
const HEIGHT = 340;
const PAD = {top: 24, right: 92, bottom: 44, left: 78};

const PLOT_W = WIDTH - PAD.left - PAD.right;
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;

interface Props {
  fills: Fill[];
  /** Appended so the current state continues the line past the last fill. */
  currentMidWad?: string;
  currentReservationWad?: string;
}

interface Point {
  x: number;
  mid: number;
  reservation: number;
  /** Kept exact alongside the plotted floats, for the readout below. */
  midWad: string;
  reservationWad: string;
  q: bigint;
  label: string;
}

export function PriceSeries({fills, currentMidWad, currentReservationWad}: Props) {
  if (fills.length === 0) {
    return (
      <div className="panel panel--flat" style={{borderStyle: "dashed", padding: 40}}>
        <span className="label">No fills indexed</span>
        <p className="dim" style={{margin: "10px 0 0", maxWidth: "52ch"}}>
          A position quotes from the moment it is shipped, but the series needs
          trades to plot. Run <span className="mono">script/SwapSeries.s.sol</span> to
          walk this position off target.
        </p>
      </div>
    );
  }

  // WAD integers to floats, once, after the domain is known. Every value here
  // is ~2e18 and the separation between the two series lives in digits a
  // float would keep — but only because both are divided by the same 1e18
  // first. Subtracting the raw bigints before converting is what preserves it.
  const toFloat = (wad: string) => Number(BigInt(wad)) / 1e18;

  const points: Point[] = fills.map((fill, i) => ({
    x: i,
    mid: toFloat(fill.midWadAtFill),
    reservation: toFloat(fill.reservationPriceWadAtFill),
    midWad: fill.midWadAtFill,
    reservationWad: fill.reservationPriceWadAtFill,
    q: BigInt(fill.inventoryImbalanceWadAtFill),
    label: String(i + 1)
  }));

  // The position's live state continues the series past the last fill, so the
  // chart shows where it is quoting *now* rather than where it last traded.
  if (currentMidWad && currentReservationWad) {
    points.push({
      x: points.length,
      mid: toFloat(currentMidWad),
      reservation: toFloat(currentReservationWad),
      midWad: currentMidWad,
      reservationWad: currentReservationWad,
      q: 0n,
      label: "now"
    });
  }

  const values = points.flatMap((p) => [p.mid, p.reservation]);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);

  // A flat series (a position that has never drifted) has zero range, and a
  // zero-range domain divides by zero. Fall back to a 1% window around the
  // value so the line renders down the middle rather than vanishing.
  const span = rawMax - rawMin;
  const pad = span === 0 ? Math.max(rawMax * 0.01, 1e-9) : span * 0.18;
  const yMin = rawMin - pad;
  const yMax = rawMax + pad;

  const sx = (i: number) =>
    PAD.left + (points.length === 1 ? PLOT_W / 2 : (i / (points.length - 1)) * PLOT_W);
  const sy = (v: number) => PAD.top + PLOT_H - ((v - yMin) / (yMax - yMin)) * PLOT_H;

  const path = (key: "mid" | "reservation") =>
    points.map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.x).toFixed(2)},${sy(p[key]).toFixed(2)}`).join(" ");

  // Five gridlines, labelled with real prices. Without the labels the reader
  // cannot tell a 0.4% separation from a 40% one, and the zoom becomes a lie.
  const ticks = Array.from({length: 5}, (_, i) => yMin + ((yMax - yMin) * i) / 4);

  const last = points[points.length - 1];
  // From the exact integers, not from the plotted floats. The floats exist to
  // place pixels; rounding a price back out of one to quote a basis-point
  // figure would report the renderer's error as the position's spread.
  const separation = spreadBps(last.midWad, last.reservationWad);

  return (
    <div>
      <div className="scroll-x">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          width="100%"
          style={{display: "block", minWidth: 640}}
          role="img"
          aria-label="Mid price against reservation price across the position's fills"
        >
          {/* Plot frame. Heavy, and drawn before anything else sits in it. */}
          <rect
            x={PAD.left}
            y={PAD.top}
            width={PLOT_W}
            height={PLOT_H}
            fill="#050404"
            stroke="#f5f2ed"
            strokeWidth={2}
          />

          {ticks.map((value, i) => {
            const y = sy(value);
            return (
              <g key={i}>
                <line
                  x1={PAD.left}
                  x2={PAD.left + PLOT_W}
                  y1={y}
                  y2={y}
                  stroke="#2a2724"
                  strokeWidth={1}
                />
                <text
                  x={PAD.left - 10}
                  y={y + 4}
                  textAnchor="end"
                  fill="#9d968c"
                  fontFamily="var(--font-mono)"
                  fontSize={11}
                >
                  {value.toFixed(4)}
                </text>
              </g>
            );
          })}

          {/* Mid first, so the reservation price draws over it where they meet
              — the overlap at the balanced end is the point being made, and
              the maroon line is the one that has to read as on top.

              Both draw left to right over the same window, in step. That is
              deliberate: they share a starting point and diverge rightwards,
              so drawing them together shows the separation *opening*, which
              is the claim. Revealing a finished picture leaves the reader to
              find the gap on their own. */}
          <AnimatedPath d={path("mid")} stroke="#f5f2ed" strokeWidth={3} duration={1.3} />
          <AnimatedPath d={path("reservation")} stroke="#a82b38" strokeWidth={3.5} duration={1.3} />

          {/* Square markers, not circles. Every fill is a discrete event and
              the shape should say so. Each pops in as the line reaches it —
              the delay is the point's own position along the draw, so a marker
              never arrives ahead of its segment. */}
          {points.map((p, i) => {
            const arrival = 1.3 * (i / Math.max(points.length - 1, 1));
            return (
              <g key={i}>
                <AnimatedMarker x={sx(p.x)} y={sy(p.mid)} size={6} fill="#f5f2ed" delay={arrival} />
                <AnimatedMarker
                  x={sx(p.x)}
                  y={sy(p.reservation)}
                  size={7}
                  fill="#a82b38"
                  stroke="#0a0908"
                  strokeWidth={1}
                  delay={arrival}
                />
              </g>
            );
          })}

          {points.map((p, i) => {
            // Label the ends and every third step; labelling all of a
            // 30-fill series turns the axis into a smear.
            const show = i === 0 || i === points.length - 1 || i % 3 === 0;
            if (!show) return null;
            return (
              <text
                key={i}
                x={sx(p.x)}
                y={PAD.top + PLOT_H + 18}
                textAnchor="middle"
                fill="#9d968c"
                fontFamily="var(--font-mono)"
                fontSize={10}
              >
                {p.label}
              </text>
            );
          })}

          <text
            x={PAD.left + PLOT_W / 2}
            y={HEIGHT - 8}
            textAnchor="middle"
            fill="#9d968c"
            fontFamily="var(--font-mono)"
            fontSize={10}
            letterSpacing="0.14em"
          >
            FILL
          </text>

          {/* The reservation price's end state, called out where the line
              lands rather than left to the legend. */}
          {/* Both callouts wait until the lines have finished drawing. They
              are the answer, and an answer that appears before its working
              is just a number. */}
          <g>
            <AnimatedRule
              x1={sx(last.x)}
              x2={PAD.left + PLOT_W + 8}
              y1={sy(last.reservation)}
              y2={sy(last.reservation)}
              stroke="#a82b38"
              dash="3 3"
              delay={1.3}
            />
            <AnimatedLabel
              x={PAD.left + PLOT_W + 12}
              y={sy(last.reservation) + 4}
              fill="#a82b38"
              delay={1.5}
            >
              {last.reservation.toFixed(4)}
            </AnimatedLabel>
            <AnimatedRule
              x1={sx(last.x)}
              x2={PAD.left + PLOT_W + 8}
              y1={sy(last.mid)}
              y2={sy(last.mid)}
              stroke="#f5f2ed"
              dash="3 3"
              delay={1.3}
            />
            <AnimatedLabel
              x={PAD.left + PLOT_W + 12}
              y={sy(last.mid) + 4}
              fill="#f5f2ed"
              delay={1.5}
            >
              {last.mid.toFixed(4)}
            </AnimatedLabel>
          </g>
        </svg>
      </div>

      <div
        className="row"
        style={{justifyContent: "space-between", marginTop: 14, gap: 20}}
      >
        <div className="row" style={{gap: 20}}>
          <span className="row" style={{gap: 8}}>
            <span
              style={{width: 22, height: 4, background: "#f5f2ed", display: "inline-block"}}
            />
            <span className="label" style={{display: "inline"}}>
              Mid
            </span>
          </span>
          <span className="row" style={{gap: 8}}>
            <span
              style={{width: 22, height: 4, background: "#a82b38", display: "inline-block"}}
            />
            <span className="label" style={{display: "inline"}}>
              Reservation price
            </span>
          </span>
        </div>
        <span className="num dim" style={{fontSize: "0.74rem"}}>
          separation at last point:{" "}
          <span className="maroon-text">
            {separation >= 0 ? "+" : ""}
            {separation.toFixed(2)} bps
          </span>
        </span>
      </div>
    </div>
  );
}

/**
 * The inventory the prices above are a response to.
 *
 * @dev Drawn as a separate track rather than a second y-axis on the price
 *      chart. A dual axis lets the reader infer a correlation from whatever
 *      scaling the axes happened to get; stacked panels that share an x-axis
 *      make them read the two series against the same fills instead.
 */
export function InventoryTrack({fills}: {fills: Fill[]}) {
  if (fills.length === 0) return null;

  const H = 110;
  const values = fills.map((f) => Number(BigInt(f.inventoryImbalanceWadAtFill)) / 1e18);
  const max = Math.max(...values.map(Math.abs), 1);

  const sx = (i: number) =>
    PAD.left + (fills.length === 1 ? PLOT_W / 2 : (i / (fills.length - 1)) * PLOT_W);
  // Zero is pinned to the middle of the track, so the sign of q — which side
  // of target the position is on — is legible without reading a number.
  const sy = (v: number) => H / 2 - (v / max) * (H / 2 - 12);

  return (
    <div className="scroll-x" style={{marginTop: 18}}>
      <svg viewBox={`0 0 ${WIDTH} ${H}`} width="100%" style={{display: "block", minWidth: 640}}>
        <rect
          x={PAD.left}
          y={4}
          width={PLOT_W}
          height={H - 8}
          fill="#050404"
          stroke="#f5f2ed"
          strokeWidth={2}
        />
        <line
          x1={PAD.left}
          x2={PAD.left + PLOT_W}
          y1={H / 2}
          y2={H / 2}
          stroke="#7b1e28"
          strokeWidth={2}
        />
        <text
          x={PAD.left - 10}
          y={H / 2 + 4}
          textAnchor="end"
          fill="#9d968c"
          fontFamily="var(--font-mono)"
          fontSize={10}
        >
          q=0
        </text>

        {values.map((v, i) => {
          const y = sy(v);
          const barTop = Math.min(y, H / 2);
          const barHeight = Math.max(Math.abs(H / 2 - y), 1);
          const width = Math.max(PLOT_W / Math.max(values.length, 1) - 6, 3);
          return (
            <AnimatedBar
              key={i}
              x={sx(i) - width / 2}
              y={barTop}
              width={width}
              height={barHeight}
              fill={v >= 0 ? "#a82b38" : "#3d0f17"}
              stroke="#f5f2ed"
              strokeWidth={1}
              // Positive bars grow up off the axis, negative ones down. The
              // side of zero a bar sits on is the only thing this track says.
              fromBottom={v >= 0}
              delay={0.3 + i * 0.05}
            />
          );
        })}

        <text
          x={PAD.left + 8}
          y={20}
          fill="#9d968c"
          fontFamily="var(--font-mono)"
          fontSize={10}
          letterSpacing="0.14em"
        >
          INVENTORY IMBALANCE
        </text>
      </svg>
    </div>
  );
}
