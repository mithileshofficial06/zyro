"use client";

import {
  motion,
  useInView,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
  type Variants
} from "framer-motion";
import {useEffect, useRef, type ReactNode} from "react";

/**
 * Motion primitives.
 *
 * @dev **Brutalist motion is not soft motion.** The easing here is expo-out
 *      with short durations — things arrive fast and stop hard. A long
 *      ease-in-out would read as a different design language than the 4px
 *      borders and flat offset shadows sitting underneath it, and one
 *      mismatched transition undoes the whole page.
 *
 *      Every component below checks `useReducedMotion`. A viewer who has asked
 *      their OS for less motion gets the finished state immediately rather than
 *      a shorter animation — a scroll-triggered reveal that still moves is
 *      still a scroll-triggered reveal.
 */

/** Expo-out. Fast departure, hard landing. */
export const EASE = [0.16, 1, 0.3, 1] as const;

// ---------------------------------------------------------------------------
// Reveal on scroll
// ---------------------------------------------------------------------------

const directions = {
  up: {x: 0, y: 28},
  down: {x: 0, y: -28},
  left: {x: 36, y: 0},
  right: {x: -36, y: 0},
  none: {x: 0, y: 0}
};

/**
 * Reveals its children once, when they scroll into view.
 *
 * @dev `once: true`. Content that re-animates every time it re-enters the
 *      viewport turns an ordinary scroll back up the page into a light show,
 *      and on a page whose job is to be read as evidence that is actively
 *      annoying.
 */
export function Reveal({
  children,
  delay = 0,
  direction = "up",
  className,
  style
}: {
  children: ReactNode;
  delay?: number;
  direction?: keyof typeof directions;
  className?: string;
  style?: React.CSSProperties;
}) {
  const reduced = useReducedMotion();
  const offset = directions[direction];

  return (
    <motion.div
      className={className}
      style={style}
      initial={reduced ? {opacity: 1} : {opacity: 0, ...offset}}
      whileInView={{opacity: 1, x: 0, y: 0}}
      viewport={{once: true, margin: "-60px"}}
      transition={{duration: reduced ? 0 : 0.55, delay: reduced ? 0 : delay, ease: EASE}}
    >
      {children}
    </motion.div>
  );
}

/** Parent that releases its children in sequence. Pair with {StaggerItem}. */
export function Stagger({
  children,
  className,
  delay = 0,
  gap = 0.07,
  style
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  gap?: number;
  style?: React.CSSProperties;
}) {
  const reduced = useReducedMotion();

  const variants: Variants = {
    hidden: {},
    show: {
      transition: {staggerChildren: reduced ? 0 : gap, delayChildren: reduced ? 0 : delay}
    }
  };

  return (
    <motion.div
      className={className}
      style={style}
      variants={variants}
      initial="hidden"
      whileInView="show"
      viewport={{once: true, margin: "-60px"}}
    >
      {children}
    </motion.div>
  );
}

export function StaggerItem({
  children,
  className,
  style
}: {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  const reduced = useReducedMotion();

  const variants: Variants = {
    hidden: reduced ? {opacity: 1} : {opacity: 0, y: 24},
    show: {opacity: 1, y: 0, transition: {duration: reduced ? 0 : 0.5, ease: EASE}}
  };

  return (
    <motion.div className={className} style={style} variants={variants}>
      {children}
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Hero type
// ---------------------------------------------------------------------------

/**
 * Reveals a word one letter at a time, each rising from behind a clip edge.
 *
 * @dev The letters are wrapped in `overflow: hidden` spans so they slide out
 *      from under a hard edge rather than fading in. Fading is the wrong
 *      gesture here — nothing else on this page fades, and a masked slide is
 *      the motion equivalent of the flat offset shadows.
 *
 *      `aria-label` carries the whole word and the spans are hidden from the
 *      accessibility tree, so a screen reader hears "Zyro" rather than four
 *      separate letters.
 */
export function SplitText({
  text,
  className,
  delay = 0,
  style
}: {
  text: string;
  className?: string;
  delay?: number;
  style?: React.CSSProperties;
}) {
  const reduced = useReducedMotion();

  if (reduced) {
    return (
      <span className={className} style={style}>
        {text}
      </span>
    );
  }

  return (
    <span className={className} style={{display: "inline-flex", ...style}} aria-label={text}>
      {text.split("").map((char, i) => (
        <span
          key={i}
          aria-hidden
          style={{display: "inline-block", overflow: "hidden", verticalAlign: "bottom"}}
        >
          <motion.span
            style={{display: "inline-block"}}
            initial={{y: "110%"}}
            animate={{y: 0}}
            transition={{duration: 0.7, delay: delay + i * 0.055, ease: EASE}}
          >
            {char === " " ? " " : char}
          </motion.span>
        </span>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/**
 * Counts a number up when it scrolls into view.
 *
 * @dev Takes `value` as a **string**, and only animates when it parses to a
 *      safe float. Every headline figure on this page is a WAD-scaled integer
 *      around 2e18, well past `Number.MAX_SAFE_INTEGER` — coercing one to
 *      animate it would print a rounded price. When the value is not safely
 *      countable it is rendered as given, immediately, which is the correct
 *      outcome rather than a degraded one.
 */
export function CountUp({
  value,
  decimals = 0,
  duration = 1.1,
  className
}: {
  value: string;
  decimals?: number;
  duration?: number;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, {once: true, margin: "-40px"});

  const target = Number(value.replace(/,/g, ""));
  const countable = Number.isFinite(target) && Math.abs(target) < Number.MAX_SAFE_INTEGER;

  const progress = useMotionValue(0);
  const display = useTransform(progress, (v) =>
    v.toLocaleString("en-US", {minimumFractionDigits: decimals, maximumFractionDigits: decimals})
  );

  useEffect(() => {
    if (!countable || reduced || !inView) return;
    const controls = animateValue(progress, target, duration);
    return controls;
  }, [countable, reduced, inView, progress, target, duration]);

  if (!countable || reduced) {
    return (
      <span ref={ref} className={className}>
        {value}
      </span>
    );
  }

  return (
    <span ref={ref} className={className}>
      <motion.span>{display}</motion.span>
    </span>
  );
}

/** Minimal rAF tween. Framer's `animate()` would do, but this keeps the
 *  import surface to `motion` values only and is a dozen lines. */
function animateValue(value: ReturnType<typeof useMotionValue<number>>, to: number, seconds: number) {
  const start = performance.now();
  let frame = 0;

  const tick = (now: number) => {
    const t = Math.min((now - start) / (seconds * 1000), 1);
    // Expo-out, matching EASE.
    const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
    value.set(to * eased);
    if (t < 1) frame = requestAnimationFrame(tick);
  };

  frame = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Bands
// ---------------------------------------------------------------------------

/**
 * An infinite horizontal band.
 *
 * @dev Two identical copies translated by exactly -50% of the track, so the
 *      seam lands where the second copy's first character sits over the first
 *      copy's — there is no visible restart. Any other offset produces a
 *      periodic jump that reads as a rendering bug.
 *
 *      `aria-hidden`: it is texture, and a screen reader announcing the same
 *      six phrases forever is worse than silence.
 */
export function Marquee({
  items,
  speed = 26,
  reverse = false
}: {
  items: string[];
  speed?: number;
  reverse?: boolean;
}) {
  const reduced = useReducedMotion();
  const track = [...items, ...items];

  return (
    <div className="marquee" aria-hidden>
      <motion.div
        className="marquee__track"
        animate={reduced ? undefined : {x: reverse ? ["-50%", "0%"] : ["0%", "-50%"]}}
        transition={{duration: speed, ease: "linear", repeat: Infinity}}
      >
        {track.map((item, i) => (
          <span key={i} className="marquee__item">
            {item}
            <span className="marquee__dot">◆</span>
          </span>
        ))}
      </motion.div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

/**
 * A panel that presses into its own shadow on hover.
 *
 * @dev The shadow shrinks by exactly the distance the panel moves, so the
 *      element's bottom-right corner stays pinned while the top-left travels.
 *      It reads as physical displacement — the same idea as the buttons — and
 *      it is the only hover state on the page that moves anything.
 */
export function PressPanel({
  children,
  className = "panel",
  style,
  offset = 6
}: {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
  offset?: number;
}) {
  const reduced = useReducedMotion();

  return (
    <motion.div
      className={className}
      style={style}
      initial={false}
      whileHover={
        reduced
          ? undefined
          : {
              x: offset / 2,
              y: offset / 2,
              boxShadow: `${offset / 2}px ${offset / 2}px 0 var(--maroon)`
            }
      }
      transition={{duration: 0.16, ease: EASE}}
    >
      {children}
    </motion.div>
  );
}

/** A thin maroon rule that draws itself across on reveal. */
export function DrawRule({delay = 0}: {delay?: number}) {
  const reduced = useReducedMotion();

  return (
    <motion.div
      style={{height: 4, background: "var(--maroon-lit)", transformOrigin: "left center"}}
      initial={reduced ? {scaleX: 1} : {scaleX: 0}}
      whileInView={{scaleX: 1}}
      viewport={{once: true}}
      transition={{duration: reduced ? 0 : 0.7, delay, ease: EASE}}
    />
  );
}

/**
 * A live "still indexing" pulse.
 *
 * @dev Opacity only, never scale. A scaling dot next to a hard-edged tag would
 *      be the one soft thing on the page, and it sits beside the block number,
 *      which is the element most likely to be photographed.
 */
export function Pulse() {
  const reduced = useReducedMotion();

  return (
    <motion.span
      style={{
        width: 8,
        height: 8,
        background: "var(--white)",
        display: "inline-block",
        flexShrink: 0
      }}
      animate={reduced ? undefined : {opacity: [1, 0.15, 1]}}
      transition={{duration: 1.6, repeat: Infinity, ease: "easeInOut"}}
    />
  );
}

export {motion};
