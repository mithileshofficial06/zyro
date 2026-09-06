import type {ReactNode} from "react";

/**
 * A label/value pair on one line, for dense parameter lists.
 *
 * @dev The value is never truncated to keep a row tidy. These are WAD prices
 *      and wei balances read against each other, and the digits a truncation
 *      would drop are the ones that distinguish a reservation price from the
 *      mid beside it. Long values wrap.
 */
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
