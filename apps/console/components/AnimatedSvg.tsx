"use client";

import {motion, useReducedMotion} from "framer-motion";

import {EASE} from "./motion";

/**
 * SVG parts that draw themselves when the chart scrolls into view.
 *
 * @dev **The order the chart draws in is the argument it makes.** Both price
 *      series start at the same left-hand point and diverge to the right, so
 *      drawing them left-to-right in step shows the separation *opening* —
 *      which is the claim. Fading both in at once shows a finished picture and
 *      leaves the reader to spot the gap themselves.
 *
 *      Done with `pathLength`, which framer-motion maps onto
 *      `stroke-dasharray`/`stroke-dashoffset` internally. Animating a `d`
 *      attribute instead would interpolate between point sets and briefly
 *      render prices that were never quoted.
 */

export function AnimatedPath({
  d,
  stroke,
  strokeWidth,
  delay = 0,
  duration = 1.2,
  fill = "none"
}: {
  d: string;
  stroke?: string;
  strokeWidth?: number;
  delay?: number;
  duration?: number;
  fill?: string;
}) {
  const reduced = useReducedMotion();

  return (
    <motion.path
      d={d}
      fill={fill}
      stroke={stroke}
      strokeWidth={strokeWidth}
      strokeLinecap="butt"
      initial={reduced ? {pathLength: 1, opacity: 1} : {pathLength: 0, opacity: 1}}
      whileInView={{pathLength: 1}}
      viewport={{once: true, margin: "-40px"}}
      transition={{duration: reduced ? 0 : duration, delay: reduced ? 0 : delay, ease: EASE}}
    />
  );
}

/**
 * A filled area that wipes in from the left.
 *
 * @dev Scaled on X from a left origin rather than drawn, because an area has
 *      no meaningful path length — `pathLength` on a closed shape animates the
 *      outline and leaves the fill popping in whole at frame one.
 */
export function AnimatedArea({
  d,
  fill,
  delay = 0,
  duration = 1.2
}: {
  d: string;
  fill: string;
  delay?: number;
  duration?: number;
}) {
  const reduced = useReducedMotion();

  return (
    <motion.path
      d={d}
      fill={fill}
      stroke="none"
      style={{originX: 0}}
      initial={reduced ? {scaleX: 1} : {scaleX: 0}}
      whileInView={{scaleX: 1}}
      viewport={{once: true, margin: "-40px"}}
      transition={{duration: reduced ? 0 : duration, delay: reduced ? 0 : delay, ease: EASE}}
    />
  );
}

/**
 * A marker that pops in once the line has reached it.
 *
 * @dev `delay` is computed by the caller from the point's own index, so
 *      markers land under the line as it passes rather than all at the end.
 *      A marker arriving before its line segment reads as the chart being
 *      drawn backwards.
 */
export function AnimatedMarker({
  x,
  y,
  size,
  fill,
  stroke,
  strokeWidth,
  delay = 0
}: {
  x: number;
  y: number;
  size: number;
  fill: string;
  stroke?: string;
  strokeWidth?: number;
  delay?: number;
}) {
  const reduced = useReducedMotion();

  return (
    <motion.rect
      x={x - size / 2}
      y={y - size / 2}
      width={size}
      height={size}
      fill={fill}
      stroke={stroke}
      strokeWidth={strokeWidth}
      initial={reduced ? {opacity: 1, scale: 1} : {opacity: 0, scale: 0}}
      whileInView={{opacity: 1, scale: 1}}
      viewport={{once: true, margin: "-40px"}}
      transition={{duration: reduced ? 0 : 0.24, delay: reduced ? 0 : delay, ease: EASE}}
      style={{transformOrigin: `${x}px ${y}px`}}
    />
  );
}

/**
 * A bar that grows out of the zero line.
 *
 * @dev `originY` is set to whichever edge sits on the axis, so a positive bar
 *      grows up and a negative one grows down. Growing every bar from its own
 *      top would send the negative ones the wrong way and quietly invert the
 *      one thing this track exists to show — which side of target the position
 *      is on.
 */
export function AnimatedBar({
  x,
  y,
  width,
  height,
  fill,
  stroke,
  strokeWidth,
  fromBottom,
  delay = 0
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  stroke?: string;
  strokeWidth?: number;
  fromBottom: boolean;
  delay?: number;
}) {
  const reduced = useReducedMotion();

  return (
    <motion.rect
      x={x}
      y={y}
      width={width}
      height={height}
      fill={fill}
      stroke={stroke}
      strokeWidth={strokeWidth}
      style={{originY: fromBottom ? 1 : 0, originX: 0.5}}
      initial={reduced ? {scaleY: 1} : {scaleY: 0}}
      whileInView={{scaleY: 1}}
      viewport={{once: true, margin: "-40px"}}
      transition={{duration: reduced ? 0 : 0.45, delay: reduced ? 0 : delay, ease: EASE}}
    />
  );
}

/** A reference line that extends to its label. */
export function AnimatedRule({
  x1,
  x2,
  y1,
  y2,
  stroke,
  dash,
  delay = 0
}: {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
  stroke: string;
  dash?: string;
  delay?: number;
}) {
  const reduced = useReducedMotion();

  return (
    <motion.line
      x1={x1}
      x2={x2}
      y1={y1}
      y2={y2}
      stroke={stroke}
      strokeWidth={1}
      strokeDasharray={dash}
      initial={reduced ? {pathLength: 1} : {pathLength: 0}}
      whileInView={{pathLength: 1}}
      viewport={{once: true, margin: "-40px"}}
      transition={{duration: reduced ? 0 : 0.5, delay: reduced ? 0 : delay, ease: EASE}}
    />
  );
}

/** Text that fades up after the geometry it annotates has arrived. */
export function AnimatedLabel({
  x,
  y,
  fill,
  fontSize = 11,
  anchor = "start",
  delay = 0,
  children
}: {
  x: number;
  y: number;
  fill: string;
  fontSize?: number;
  anchor?: "start" | "middle" | "end";
  delay?: number;
  children: React.ReactNode;
}) {
  const reduced = useReducedMotion();

  return (
    <motion.text
      x={x}
      y={y}
      textAnchor={anchor}
      fill={fill}
      fontFamily="var(--font-mono)"
      fontSize={fontSize}
      initial={reduced ? {opacity: 1} : {opacity: 0}}
      whileInView={{opacity: 1}}
      viewport={{once: true, margin: "-40px"}}
      transition={{duration: reduced ? 0 : 0.35, delay: reduced ? 0 : delay, ease: EASE}}
    >
      {children}
    </motion.text>
  );
}
