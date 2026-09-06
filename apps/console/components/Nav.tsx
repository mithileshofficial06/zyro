"use client";

import {AnimatePresence, motion, useReducedMotion, useScroll, useSpring} from "framer-motion";
import {useEffect, useState} from "react";

import {EASE} from "./motion";

/**
 * Sticky section nav, with a reading-progress rule.
 *
 * @dev The page is five sections tall and the previous version gave a reader
 *      no way to tell that. This does three things, in order of importance:
 *      names the sections so they are known to exist, says which one you are
 *      in, and shows how much is left.
 *
 *      It appears only after the hero has been passed. A nav pinned over a
 *      full-viewport hero competes with the one thing that hero exists to say,
 *      and there is nothing to navigate to yet.
 */

const SECTIONS = [
  {id: "mechanism", index: "01", label: "Mechanism"},
  {id: "live", index: "02", label: "Live"},
  {id: "proof", index: "03", label: "Proof"},
  {id: "fills", index: "04", label: "Settlement"},
  {id: "stack", index: "05", label: "Stack"}
];

export function Nav() {
  const reduced = useReducedMotion();
  const [visible, setVisible] = useState(false);
  const [active, setActive] = useState<string | null>(null);

  const {scrollYProgress} = useScroll();
  // Spring on the progress rule only. A raw scroll value tracks the wheel
  // exactly, which on a trackpad reads as jitter rather than as progress.
  const progress = useSpring(scrollYProgress, {stiffness: 260, damping: 40, mass: 0.4});

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > window.innerHeight * 0.75);
    onScroll();
    window.addEventListener("scroll", onScroll, {passive: true});
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    // Sections are tall — often taller than the viewport — so "most visible"
    // is the wrong test; several qualify at once and the highlight flickers
    // between them. The section whose top most recently passed the upper
    // third of the viewport is the one being read.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(entry.target.id);
        }
      },
      {rootMargin: "-33% 0px -60% 0px", threshold: 0}
    );

    for (const section of SECTIONS) {
      const el = document.getElementById(section.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);

  return (
    <AnimatePresence>
      {visible ? (
        <motion.nav
          className="nav"
          initial={reduced ? false : {y: -70}}
          animate={{y: 0}}
          exit={reduced ? undefined : {y: -70}}
          transition={{duration: 0.32, ease: EASE}}
        >
          <div className="nav__inner">
            <a className="nav__brand" href="#top">
              ZYRO<span style={{color: "var(--maroon-lit)"}}>.</span>
            </a>

            <ul className="nav__list">
              {SECTIONS.map((section) => (
                <li key={section.id}>
                  <a
                    className={`nav__link${active === section.id ? " nav__link--on" : ""}`}
                    href={`#${section.id}`}
                    aria-current={active === section.id ? "true" : undefined}
                  >
                    <span className="nav__index">{section.index}</span>
                    <span className="nav__label">{section.label}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>

          <motion.div className="nav__progress" style={{scaleX: progress}} />
        </motion.nav>
      ) : null}
    </AnimatePresence>
  );
}

/**
 * The hero's scroll cue.
 *
 * @dev A full-viewport hero with the fold exactly at the bottom of the
 *      formula gives no signal that anything follows it. The rule travels
 *      downward on a loop rather than bouncing — a bounce is an ease-in-out
 *      gesture and would be the one soft motion on the page.
 */
export function ScrollCue() {
  const reduced = useReducedMotion();
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const onScroll = () => setHidden(window.scrollY > 80);
    window.addEventListener("scroll", onScroll, {passive: true});
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <motion.div
      className="cue"
      aria-hidden
      animate={{opacity: hidden ? 0 : 1}}
      transition={{duration: 0.25}}
    >
      <span className="cue__text">SCROLL</span>
      <span className="cue__rail">
        <motion.span
          className="cue__bar"
          animate={reduced ? undefined : {y: [0, 26, 0]}}
          transition={{duration: 1.9, repeat: Infinity, ease: EASE}}
        />
      </span>
    </motion.div>
  );
}
