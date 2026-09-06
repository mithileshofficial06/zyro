"use client";

import {motion, useReducedMotion, useScroll, useTransform} from "framer-motion";
import {useRef} from "react";

import {EASE, Marquee, Pulse, SplitText} from "./motion";

/**
 * The hero.
 *
 * @dev The page is evidence, so the hero has to make one claim and make it
 *      unmissable: there is a price here that no pool AMM can produce. Every
 *      moving part below serves that sentence and nothing else.
 *
 *      **The formula is the art.** Rather than decorating with shapes, the
 *      Avellaneda–Stoikov reservation price is set enormous and assembled term
 *      by term — `r`, then `s`, then the risk term that is the entire
 *      contribution. It is the one image that explains the project without a
 *      caption, and it is real notation rather than a logo.
 */

const BAND = [
  "INVENTORY-AWARE",
  "1INCH AQUA",
  "SWAPVM INSTRUCTION",
  "AVELLANEDA–STOIKOV",
  "RESERVATION PRICE",
  "THE GRAPH"
];

export function Hero({
  block,
  network,
  configured,
  hasErrors
}: {
  block: number | null;
  network: string | null;
  configured: boolean;
  hasErrors: boolean;
}) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLElement>(null);

  // Parallax on the formula only. The headline stays put — text that drifts
  // while you are trying to read it is a cost with no benefit.
  const {scrollYProgress} = useScroll({
    target: ref,
    offset: ["start start", "end start"]
  });
  const formulaY = useTransform(scrollYProgress, [0, 1], [0, reduced ? 0 : 90]);
  const formulaOpacity = useTransform(scrollYProgress, [0, 0.8], [1, reduced ? 1 : 0.15]);

  return (
    <section ref={ref} className="hero">
      <div className="hero__inner">
        <motion.div
          className="row"
          style={{gap: 10, marginBottom: 28}}
          initial={reduced ? false : {opacity: 0, y: -10}}
          animate={{opacity: 1, y: 0}}
          transition={{duration: 0.5, ease: EASE}}
        >
          <span className={block !== null ? "tag tag--live" : "tag tag--idle"}>
            <span className="row" style={{gap: 7}}>
              {block !== null ? <Pulse /> : null}
              {block !== null ? "indexing" : configured ? "unreachable" : "not configured"}
            </span>
          </span>
          {network ? <span className="tag tag--idle">{network}</span> : null}
          {block !== null ? (
            <span className="tag tag--idle num">block {block.toLocaleString()}</span>
          ) : null}
          {hasErrors ? (
            <span className="tag" style={{color: "var(--maroon-lit)"}}>
              indexing errors
            </span>
          ) : null}
        </motion.div>

        <h1 className="hero__title">
          <SplitText text="ZYRO" />
          <motion.span
            className="hero__dot"
            initial={reduced ? false : {scale: 0}}
            animate={{scale: 1}}
            transition={{duration: 0.45, delay: 0.42, ease: EASE}}
          >
            .
          </motion.span>
        </h1>

        <motion.p
          className="hero__lede"
          initial={reduced ? false : {opacity: 0, y: 20}}
          animate={{opacity: 1, y: 0}}
          transition={{duration: 0.6, delay: 0.5, ease: EASE}}
        >
          Inventory-aware dynamic liquidity, as a native{" "}
          <span className="hero__mark">1inch SwapVM instruction</span>. Every shipped
          position publishes the reservation price it is actually quoting at — so a solver
          can route on it without re-implementing Avellaneda–Stoikov.
        </motion.p>

        <motion.div
          className="hero__formula"
          style={{y: formulaY, opacity: formulaOpacity}}
          initial={reduced ? false : {opacity: 0}}
          animate={{opacity: 1}}
          transition={{duration: 0.5, delay: 0.62, ease: EASE}}
        >
          <Formula />
        </motion.div>

        <motion.div
          className="hero__actions"
          initial={reduced ? false : {opacity: 0, y: 16}}
          animate={{opacity: 1, y: 0}}
          transition={{duration: 0.5, delay: 1.05, ease: EASE}}
        >
          <a className="btn btn--active" href="#live">
            See it live ↓
          </a>
          <a className="btn" href="#mechanism">
            How it works
          </a>
          <a
            className="btn"
            href="https://github.com/mithileshofficial06/zyro"
            target="_blank"
            rel="noreferrer"
          >
            Source ↗
          </a>
        </motion.div>
      </div>

      <div className="hero__band">
        <Marquee items={BAND} />
      </div>
    </section>
  );
}

/**
 * `r = s − q · γ · σ² · (T − t)`, assembled term by term.
 *
 * @dev `q` is highlighted and the rest is not. Every other symbol here is
 *      standard and has been since 2008; `q` — this maker's signed inventory
 *      imbalance — is the input no on-chain venue exposed before Aqua, and is
 *      therefore the whole reason this project exists rather than being a
 *      paper. The colour is the argument.
 */
function Formula() {
  const reduced = useReducedMotion();

  const terms = [
    {text: "r", kind: "sym" as const},
    {text: "=", kind: "op" as const},
    {text: "s", kind: "sym" as const},
    {text: "−", kind: "op" as const},
    {text: "q", kind: "hot" as const},
    {text: "·", kind: "op" as const},
    {text: "γ", kind: "sym" as const},
    {text: "·", kind: "op" as const},
    {text: "σ²", kind: "sym" as const},
    {text: "·", kind: "op" as const},
    {text: "(T−t)", kind: "sym" as const}
  ];

  return (
    <div className="formula" role="img" aria-label="r equals s minus q times gamma times sigma squared times T minus t">
      {terms.map((term, i) => (
        <motion.span
          key={i}
          className={`formula__${term.kind}`}
          initial={reduced ? false : {opacity: 0, y: 18}}
          animate={{opacity: 1, y: 0}}
          transition={{duration: 0.45, delay: 0.7 + i * 0.05, ease: EASE}}
        >
          {term.text}
        </motion.span>
      ))}

      <motion.span
        className="formula__note"
        initial={reduced ? false : {opacity: 0}}
        animate={{opacity: 1}}
        transition={{duration: 0.6, delay: 1.35, ease: EASE}}
      >
        <span className="formula__arrow">↑</span>
        the input no pool AMM has
      </motion.span>
    </div>
  );
}
