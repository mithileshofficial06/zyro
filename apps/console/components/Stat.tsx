import type {ReactNode} from "react";

/**
 * One headline number in a framed cell.
 *
 * @dev The value is deliberately not shrunk to fit. A WAD price printed to six
 *      places is long, and the alternative — truncating it to keep the cell
 *      tidy — hides the digits that distinguish a reservation price from the
 *      mid it is next to. Cells wrap instead.
 */
export function Stat({
  label,
  value,
  suffix,
  accent = false,
  hint
}: {
  label: string;
  value: ReactNode;
  suffix?: string;
  accent?: boolean;
  hint?: string;
}) {
  return (
    <div
      className={accent ? "panel panel--maroon" : "panel panel--flat"}
      style={{padding: "14px 16px"}}
    >
      <span className="label">{label}</span>
      <div
        className="num"
        style={{
          fontSize: "1.35rem",
          fontWeight: 700,
          marginTop: 6,
          overflowWrap: "anywhere",
          color: accent ? "var(--white-pure)" : "var(--white)"
        }}
      >
        {value}
        {suffix ? (
          <span className="dim" style={{fontSize: "0.72rem", marginLeft: 6}}>
            {suffix}
          </span>
        ) : null}
      </div>
      {hint ? (
        <div className="dim" style={{fontSize: "0.68rem", marginTop: 6, lineHeight: 1.35}}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

/** A label/value pair on one line, for dense parameter lists. */
export function Field({label, value, title}: {label: string; value: ReactNode; title?: string}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 16,
        padding: "7px 0",
        borderBottom: "1px solid var(--line)"
      }}
    >
      <span className="label" style={{display: "inline", flexShrink: 0}}>
        {label}
      </span>
      <span className="num" style={{textAlign: "right", overflowWrap: "anywhere"}} title={title}>
        {value}
      </span>
    </div>
  );
}
