/**
 * Motion that changes on every input event, such as a swipe or a drag, kept
 * out of the layout state: each value re-renders only the nodes that read it.
 */

import { useCallback, useSyncExternalStore } from "react";
import { instant, type Motion } from "proscenium";

type Listener = () => void;

/** Values by key, each with its own subscribers. */
export class LiveMap<T> {
  private readonly values = new Map<string | number, T>();
  private readonly listeners = new Map<string | number, Set<Listener>>();

  get(key: string | number): T | undefined {
    return this.values.get(key);
  }

  set(key: string | number, value: T | undefined): void {
    if (this.values.get(key) === value) return;
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, value);
    for (const listener of this.listeners.get(key) ?? []) listener();
  }

  subscribe(key: string | number, listener: Listener): () => void {
    let set = this.listeners.get(key);
    if (!set) this.listeners.set(key, set = new Set());
    set.add(listener);
    return () => set.delete(listener);
  }
}

export function useLive<T>(map: LiveMap<T>, key: string | number): T | undefined {
  const subscribe = useCallback((listener: Listener) => map.subscribe(key, listener), [map, key]);
  return useSyncExternalStore(subscribe, () => map.get(key));
}

/**
 * A value driven by input: it follows the input exactly, then, let go with a
 * velocity in units per second, settles with a spring starting at that velocity.
 */
export interface Driven {
  value: number;
  /** Units a second, the moment the input lets go. */
  velocity?: number;
}

/**
 * The value to show, and the motion to reach it with: SETTLE once let go, its
 * velocity in a prop's units being the value's times SLOPE (the prop's change
 * per unit of value).
 */
export function drivenTarget(driven: Driven, settle: Motion, slope: number): [number, Motion] {
  if (driven.velocity === undefined || settle.type !== "spring") return [driven.value, instant];
  return [driven.value, { ...settle, velocity: driven.velocity * slope }];
}

/**
 * Velocity of input over its last 150 ms, as niri's swipe tracker measures it,
 * and where it would come to rest decelerating as niri's touchpad does.
 */
export class SwipeTracker {
  private history: { time: number; delta: number }[] = [];
  position = 0;

  push(delta: number, time = performance.now()): void {
    this.position += delta;
    this.history.push({ time, delta });
    this.history = this.history.filter((entry) => entry.time >= time - 150);
  }

  /**
   * Ends the motion: its velocity in units per second (none after a pause, as
   * the time since the last event counts) and the position deceleration at
   * 0.997 per millisecond would bring it to.
   */
  release(now = performance.now()): { velocity: number; end: number } {
    this.push(0, now);
    const first = this.history[0]!;
    const last = this.history[this.history.length - 1]!;
    const seconds = (last.time - first.time) / 1000;
    const total = this.history.reduce((sum, entry) => sum + entry.delta, 0);
    const velocity = seconds > 0 ? total / seconds : 0;
    return { velocity, end: this.position - velocity / (1000 * Math.log(0.997)) };
  }
}

/** niri's rubber band: past [MIN, MAX], X moves ever less, to at most LIMIT beyond. */
export function rubberBand(x: number, min: number, max: number, stiffness: number, limit: number): number {
  const clamped = Math.min(Math.max(x, min), max);
  const over = Math.abs(x - clamped);
  const band = (1 - 1 / (over * stiffness / limit + 1)) * limit;
  return clamped + Math.sign(x - clamped) * band;
}

export function rubberBandSlope(x: number, min: number, max: number, stiffness: number, limit: number): number {
  if (x >= min && x <= max) return 1;
  const over = x < min ? min - x : x - max;
  return stiffness * limit * limit / (stiffness * over + limit) ** 2;
}
