import Link from "next/link";

import {DrawRule} from "./motion";

/**
 * The bar on `/simulate` and `/position/[hash]`.
 *
 * @dev Deliberately not the landing page's `Nav`. That one is a client
 *      component whose whole job is scroll state — it hides until the hero is
 *      past, tracks which of five sections is being read, and drives a
 *      progress rule. None of those have a meaning on a page with no hero and
 *      no anchors, and importing it here would ship an `IntersectionObserver`
 *      and a scroll spring to observe nothing.
 *
 *      Links use `next/link` rather than bare anchors so moving between the
 *      three pages is a client transition. These are server-rendered pages
 *      that hit a subgraph and an RPC on every request, and a full document
 *      load would discard a warm connection to both.
 */
export function PageNav({current}: {current: "simulate" | "position"}) {
  return (
    <nav className="nav nav--static">
      <div className="nav__inner">
        <Link className="nav__brand" href="/">
          ZYRO<span style={{color: "var(--maroon-lit)"}}>.</span>
        </Link>

        <ul className="nav__list">
          <li>
            <Link className="nav__link" href="/">
              <span className="nav__index">←</span>
              <span className="nav__label">Console</span>
            </Link>
          </li>
          <li>
            <Link
              className={`nav__link${current === "simulate" ? " nav__link--on" : ""}`}
              href="/simulate"
              aria-current={current === "simulate" ? "page" : undefined}
            >
              <span className="nav__index">06</span>
              <span className="nav__label">Benchmark</span>
            </Link>
          </li>
        </ul>
      </div>
    </nav>
  );
}

/**
 * A section-style heading for a page that is not a section of the landing
 * page.
 */
export function PageHead({
  crumb,
  index,
  title,
  lede
}: {
  crumb: React.ReactNode;
  index: string;
  title: React.ReactNode;
  lede?: React.ReactNode;
}) {
  return (
    <header className="page-head section__head">
      <span className="page-head__crumb">{crumb}</span>
      <span className="section__index">{index}</span>
      <h1 className="section__title">{title}</h1>
      <DrawRule />
      {lede ? <p className="section__lede">{lede}</p> : null}
    </header>
  );
}
