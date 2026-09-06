import type {ReactNode} from "react";

import {DrawRule, Reveal} from "./motion";

/**
 * A numbered section with a heavy rule under its heading.
 *
 * @dev The previous page ran every panel together at one rhythm, so nothing
 *      read as a section — it looked like a settings screen. Numbering them
 *      does two things: it tells the reader how far through they are, and it
 *      forces each block to justify existing as a step in an argument rather
 *      than as another card.
 */
export function Section({
  id,
  index,
  title,
  lede,
  children,
  aside
}: {
  id?: string;
  index: string;
  title: ReactNode;
  lede?: ReactNode;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className="section" id={id}>
      <header className="section__head">
        <Reveal>
          <span className="section__index">{index}</span>
        </Reveal>

        <Reveal delay={0.05}>
          <h2 className="section__title">{title}</h2>
        </Reveal>

        <DrawRule delay={0.12} />

        {lede ? (
          <Reveal delay={0.16}>
            <p className="section__lede">{lede}</p>
          </Reveal>
        ) : null}

        {aside ? <Reveal delay={0.2}>{aside}</Reveal> : null}
      </header>

      {children}
    </section>
  );
}
