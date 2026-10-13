// Transition descriptions. The compositor runs them on its own frame clock,
// so a prop change costs one message no matter how long it animates.

import type { WireValue } from "./protocol.js";

export type CubicBezier = [number, number, number, number];
/** Progress over time, both 0..1 at the ends; it may overshoot in between. */
export type EasingFunction = (progress: number) => number;
export type Easing =
  | "linear" | "ease" | "ease-in" | "ease-out" | "ease-in-out" | CubicBezier | EasingFunction;

export type Motion =
  | { type: "spring"; stiffness: number; damping: number; mass: number; delay?: number;
      velocity?: number }
  | { type: "tween"; duration: number; ease: CubicBezier | null; delay?: number;
      repeat?: number | "forever" }
  | { type: "curve"; duration: number; points: number[]; delay?: number;
      repeat?: number | "forever" }
  | { type: "instant" };

export interface SpringOptions {
  /** Physical parameters; defaults match react-spring's "default" preset. */
  stiffness?: number;
  damping?: number;
  mass?: number;
  /** Perceptual alternative: settle time in seconds and bounce in -1..1. */
  duration?: number;
  bounce?: number;
  /** Seconds to hold the starting value first, e.g. to stagger a list. */
  delay?: number;
  /**
   * Units per second the value starts moving at, in place of the velocity it
   * had: a fling's, when a gesture lets go. It applies whenever the value is
   * retargeted with this motion, so leave it out once the fling has started.
   */
  velocity?: number;
}

export interface TweenOptions {
  delay?: number;
  /** Extra runs after the first, or Infinity to loop forever (e.g. a spinning border). */
  repeat?: number;
}

const easings: Record<Extract<Easing, string>, CubicBezier | null> = {
  linear: null,
  ease: [0.25, 0.1, 0.25, 1],
  "ease-in": [0.42, 0, 1, 1],
  "ease-out": [0, 0, 0.58, 1],
  "ease-in-out": [0.42, 0, 0.58, 1],
};

export const instant: Motion = { type: "instant" };

export function spring(options: SpringOptions = {}): Motion {
  const mass = options.mass ?? 1;
  if (options.duration !== undefined) {
    // SwiftUI's mapping from duration and bounce to a unit-mass spring.
    const duration = Math.max(options.duration, 0.01);
    const bounce = Math.min(Math.max(options.bounce ?? 0, -0.99), 0.99);
    const stiffness = (2 * Math.PI / duration) ** 2 * mass;
    const damping = bounce >= 0
      ? 4 * Math.PI * (1 - bounce) * mass / duration
      : 4 * Math.PI * mass / (duration * (1 + bounce));
    return { type: "spring", stiffness, damping, mass, delay: options.delay, velocity: options.velocity };
  }
  return { type: "spring", stiffness: options.stiffness ?? 170, damping: options.damping ?? 26, mass,
           delay: options.delay, velocity: options.velocity };
}

/** Samples a sampled easing gets: 120 a second, within the wire's bounds. */
export function sampleCount(duration: number): number {
  return Math.min(511, Math.max(16, Math.ceil(duration * 120)));
}

/** EASING as the compositor runs it: a cubic-bezier, null for linear, or a function to sample. */
export function resolveEasing(easing: Easing): CubicBezier | null | EasingFunction {
  return typeof easing === "string" ? easings[easing] : easing;
}

/** Time-based transition; DURATION is in seconds. */
export function tween(duration: number, ease: Easing = "ease", options: TweenOptions = {}): Motion {
  // A zero-length tween is a jump; the compositor accepts only positive durations.
  if (!(duration > 0)) return instant;
  const repeat = options.repeat === Infinity ? "forever" : options.repeat;
  const resolved = resolveEasing(ease);
  if (typeof resolved === "function") {
    const count = sampleCount(duration);
    const points = Array.from({ length: count + 1 }, (_, index) => resolved(index / count));
    return { type: "curve", duration, points, delay: options.delay, repeat };
  }
  return { type: "tween", duration, ease: resolved, delay: options.delay, repeat };
}

/** Easing functions beyond cubic-bezier, for `tween` and keyframe animations. */
export const ease = {
  /** Pulls back by OVERSHOOT before going. */
  anticipate: (overshoot = 1.7): EasingFunction => (t) => t * t * ((overshoot + 1) * t - overshoot),
  /** Goes past the end by OVERSHOOT, then settles back. */
  back: (overshoot = 1.7): EasingFunction => (t) =>
    1 + (overshoot + 1) * (t - 1) ** 3 + overshoot * (t - 1) ** 2,
  /** Lands like a dropped ball. */
  bounce: ((t) => {
    const n = 7.5625;
    const d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t - 1.5 / d) ** 2 + 0.75;
    if (t < 2.5 / d) return n * (t - 2.25 / d) ** 2 + 0.9375;
    return n * (t - 2.625 / d) ** 2 + 0.984375;
  }) as EasingFunction,
  /** Overshoots and oscillates into place; PERIOD is a fraction of the duration. */
  elastic: (period = 0.3): EasingFunction => (t) =>
    t <= 0 ? 0 : t >= 1 ? 1 : 2 ** (-10 * t) * Math.sin((t - period / 4) * (2 * Math.PI) / period) + 1,
  /** Jumps in COUNT equal steps. */
  steps: (count: number): EasingFunction => (t) => (t >= 1 ? 1 : Math.floor(t * count) / count),
};

export function isMotion(value: unknown): value is Motion {
  return typeof value === "object" && value !== null && "type" in value;
}

export function wireMotion(motion: Motion): WireValue {
  return { ...motion } as WireValue;
}
