import {spreadBps} from "@/lib/format";
import type {Fill} from "@/lib/types";

/**
 * The skew itself: how far the reservation price sits from the mid, per fill.
 *
 * **This exists because the price chart above it buries its own signal.** The
 * mid falls steeply across a one-direction series — that is just the
 * constant-product curve doing what it does — and the y-domain has to cover
 * that whole fall. The separation between the two lines is a small residual
 * riding on top of a large trend, so it renders as a few pixels of gap: real,
 * monotonic, and easy to miss.
 *
 * Plotted on its own, the residual *is* the series. It starts at zero, because
 * a position at its inventory target quotes exactly the mid, and walks away
 * from zero as the position takes on one side. That walk is the entire claim,
 * and it is the one number a pool AMM cannot produce at all.
 *
 * @dev Deliberately not a second y-axis on the price chart. A dual axis lets
 *      the reader infer whatever correlation the two independent scalings
 *      happen to suggest; separate panels sharing an x-axis make them read
 *      both series against the same fills.
 */

const WIDTH = 900;
const HEIGHT = 150;
const PAD = {top: 20, right: 92, bottom: 26, left: 78};

const PLOT_W = WIDTH - PAD.left - PAD.right;
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;

export function SkewTrack({
  fills,
  currentMidWad,
  currentReservationWad
}: {
  fills: Fill[];
  currentMidWad?: string;
  currentReservationWad?: string;
}) {
  if (fills.length === 0) return null;

  const values = fills.map((f) => spreadBps(f.midWadAtFill, f.reservationPriceWadAtFill));
  const labels = fills.map((_, i) => String(i + 1));

  if (currentMidWad && currentReservationWad) {
    values.push(spreadBps(currentMidWad, currentReservationWad));
    labels.push("now");
  }

  // Symmetric around zero, so the sign — which side of target the position is
  // on — is readable from the shape without consulting a number. A domain
  // fitted to the data's own min and max would put a wholly negative series
  // above the axis and make an exposed position look covered.
  const extent = Math.max(...values.map(Math.abs), 1);

  const sx = (i: number) =>
    PAD.left + (values.length === 1 ? PLOT_W / 2 : (i / (values.length - 1)) * PLOT_W);
  const zeroY = PAD.top + PLOT_H / 2;
  const sy = (v: number) => zeroY - (v / extent) * (PLOT_H / 2 - 8);

  const area =
    values.map((v, i) => `${i === 0 ? "M" : "L"}${sx(i).toFixed(2)},${sy(v).toFixed(2)}`).join(" ") +
    ` L${sx(values.length - 1).toFixed(2)},${zeroY} L${sx(0).toFixed(2)},${zeroY} Z`;

  const line = values
    .map((v, i) => `${i === 0 ? "M" : "L"}${sx(i).toFixed(2)},${sy(v).toFixed(2)}`)
    .join(" ");

  const last = values[values.length - 1];

  return (
    <div className="scroll-x" style={{marginTop: 18}}>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width="100%"
        style={{display: "block", minWidth: 640}}
        role="img"
        aria-label="Reservation price offset from the mid, in basis points, per fill"
      >
        <rect
          x={PAD.left}
          y={PAD.top}
          width={PLOT_W}
          height={PLOT_H}
          fill="#050404"
          stroke="#f5f2ed"
          strokeWidth={2}
        />

        {/* Zero is the anchor: at target the reservation price *is* the mid. */}
        <line
          x1={PAD.left}
          x2={PAD.left + PLOT_W}
          y1={zeroY}
          y2={zeroY}
          stroke="#f5f2ed"
          strokeWidth={2}
        />
        <text
          x={PAD.left - 10}
          y={zeroY + 4}
          textAnchor="end"
          fill="#9d968c"
          fontFamily="var(--font-mono)"
          fontSize={11}
        >
          0
        </text>
        <text
          x={PAD.left - 10}
          y={PAD.top + 12}
          textAnchor="end"
          fill="#9d968c"
          fontFamily="var(--font-mono)"
          fontSize={10}
        >
          +{extent.toFixed(0)}
        </text>
        <text
          x={PAD.left - 10}
          y={PAD.top + PLOT_H - 4}
          textAnchor="end"
          fill="#9d968c"
          fontFamily="var(--font-mono)"
          fontSize={10}
        >
          −{extent.toFixed(0)}
        </text>

        {/* Flat maroon fill, not a gradient. It reads as an area, not depth. */}
        <path d={area} fill="#3d0f17" stroke="none" />
        <path d={line} fill="none" stroke="#a82b38" strokeWidth={3} strokeLinecap="butt" />

        {values.map((v, i) => (
          <rect key={i} x={sx(i) - 3} y={sy(v) - 3} width={6} height={6} fill="#a82b38" />
        ))}

        {labels.map((label, i) => {
          const show = i === 0 || i === labels.length - 1 || i % 3 === 0;
          if (!show) return null;
          return (
            <text
              key={i}
              x={sx(i)}
              y={HEIGHT - 8}
              textAnchor="middle"
              fill="#9d968c"
              fontFamily="var(--font-mono)"
              fontSize={10}
            >
              {label}
            </text>
          );
        })}

        <text
          x={PAD.left + 8}
          y={PAD.top + 14}
          fill="#9d968c"
          fontFamily="var(--font-mono)"
          fontSize={10}
          letterSpacing="0.14em"
        >
          SKEW · BPS FROM MID
        </text>

        <line
          x1={sx(values.length - 1)}
          x2={PAD.left + PLOT_W + 8}
          y1={sy(last)}
          y2={sy(last)}
          stroke="#a82b38"
          strokeWidth={1}
          strokeDasharray="3 3"
        />
        <text
          x={PAD.left + PLOT_W + 12}
          y={sy(last) + 4}
          fill="#a82b38"
          fontFamily="var(--font-mono)"
          fontSize={11}
        >
          {last >= 0 ? "+" : ""}
          {last.toFixed(1)}
        </text>
      </svg>
    </div>
  );
}
