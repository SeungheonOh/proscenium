/**
 * Magnet mode: windows push each other out of the way on the canvas, after
 * Sunlight's "Windows push each other" (spacefarm-digital/sunlight,
 * Magnetism.swift). The window in hand is fixed where the hand holds it; the
 * others are shoved out of its way along the shortest route, and shove the ones
 * behind them in turn. Canvas coordinates throughout.
 *
 * `resolve` makes a target layout with nothing overlapping, afresh on every
 * pointer move, so it never tunnels or drifts; pushed windows ease after their
 * targets on a critically damped spring (`followMotion`), and a window flung
 * hard keeps going a little when let go (`coast`).
 */
import { spring, type Motion, type Rectangle } from "proscenium";
import type { Point } from "./snapping.js";

/** The gap a Firm push leaves between windows, as a tiled layout's. */
export const tileGap = 8;

/** Gentle (0), Medium and Firm (1): what the strength cycles through. */
export const strengths = [
  { name: "Gentle", value: 0 },
  { name: "Medium", value: 0.5 },
  { name: "Firm", value: 1 },
] as const;
export const defaultStrength = 0.5;

/**
 * How far before touching a push starts, and so the gap pushed windows are left
 * at: on contact at Gentle, a full tile gap out at Firm.
 */
export function reach(strength: number, gap = tileGap): number {
  return gap * Math.min(1, Math.max(0, strength));
}

/** Seconds for a pushed window to cover most of the way to its target: 0.30 at Gentle, 0.12 at Firm. */
export function response(strength: number): number {
  return 0.3 - 0.18 * Math.min(1, Math.max(0, strength));
}

/**
 * A pushed window's way to its target: critically damped, so it arrives without
 * a bounce, covering ~90% of the way in `response` seconds (ω = 4 / response; a
 * spring of duration d has ω = 2π / d).
 */
export function followMotion(strength: number): Motion {
  return spring({ duration: (2 * Math.PI * response(strength)) / 4 });
}

/** Passes over the pairs before giving up; one to three settle every layout met in practice. */
const maxPasses = 12;
/** A pass that moves nothing further than this is the last one. */
const tolerance = 0.1;
const epsilon = 1e-6;

export interface Resolution {
  /** OTHERS where they go, in the order given. */
  rects: Rectangle[];
  /** Which of them moved. */
  moved: Set<number>;
}

/**
 * Pushes OTHERS out of FIXED's way; FIXED never moves. Each rect it overlaps
 * (FIXED grown by REACH on every side) leaves along the axis where the overlap
 * is smaller, by exactly the overlap, keeping its other coordinate: rows stay
 * rows and columns stay columns. A rect that moved pushes any it now reaches,
 * nearer ones pushing farther ones, until nothing overlaps. Rects that already
 * overlapped each other (a stack the user made) are left to each other: a push
 * never explodes a pile, only moves what is in the way.
 */
export function resolve(fixed: Rectangle, others: readonly Rectangle[], reach: number): Resolution {
  const rects = others.map((r) => ({ ...r }));
  const moved = new Set<number>();
  if (rects.length === 0) return { rects, moved };
  reach = Math.max(0, reach);
  // Nearest to the hand first: the push travels outwards.
  const order = others
    .map((_, i) => i)
    .sort((a, b) => distance(others[a]!, fixed) - distance(others[b]!, fixed));
  const stacked = new Set<number>();
  for (let i = 0; i < others.length; i++)
    for (let j = i + 1; j < others.length; j++)
      if (overlap(others[i]!, others[j]!)) stacked.add(i * others.length + j);
  const areStacked = (i: number, j: number) =>
    stacked.has(Math.min(i, j) * others.length + Math.max(i, j));

  for (let pass = 0; pass < maxPasses; pass++) {
    let largest = 0;
    const shift = (i: number, d: Point) => {
      const r = rects[i]!;
      r.x += d.x;
      r.y += d.y;
      moved.add(i);
      largest = Math.max(largest, Math.abs(d.x), Math.abs(d.y));
    };
    for (const i of order) {
      const d = displacement(rects[i]!, fixed, reach);
      if (d.x || d.y) shift(i, d);
    }
    // What moved shoves what is behind it.
    for (const i of order) {
      if (!moved.has(i)) continue;
      for (const j of order) {
        if (j === i || areStacked(i, j)) continue;
        const d = displacement(rects[j]!, rects[i]!, reach);
        if (d.x || d.y) shift(j, d);
      }
    }
    if (largest < tolerance) break;
  }
  return { rects, moved };
}

/**
 * How far R has to move to be clear of PUSHER grown by REACH: along the axis
 * with the smaller overlap, away from the pusher's centre. Zero when clear.
 */
export function displacement(r: Rectangle, pusher: Rectangle, reach: number): Point {
  const p = { x: pusher.x - reach, y: pusher.y - reach, width: pusher.width + 2 * reach, height: pusher.height + 2 * reach };
  const overlapX = Math.min(p.x + p.width - r.x, r.x + r.width - p.x);
  const overlapY = Math.min(p.y + p.height - r.y, r.y + r.height - p.y);
  if (!(overlapX > epsilon && overlapY > epsilon)) return { x: 0, y: 0 };
  if (overlapX <= overlapY)
    return { x: r.x + r.width / 2 >= p.x + p.width / 2 ? overlapX : -overlapX, y: 0 };
  return { x: 0, y: r.y + r.height / 2 >= p.y + p.height / 2 ? overlapY : -overlapY };
}

/** Overlap with some area to it; edges that merely touch don't count. */
function overlap(a: Rectangle, b: Rectangle): boolean {
  return (
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > epsilon &&
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > epsilon
  );
}

function distance(a: Rectangle, b: Rectangle): number {
  return Math.hypot(a.x + a.width / 2 - (b.x + b.width / 2), a.y + a.height / 2 - (b.y + b.height / 2));
}

/**
 * The pointer's speed on screen, so the feel does not change with the zoom: an
 * exponential average over about 50 ms, steady enough to ignore jitter, short
 * enough to report the last flick.
 */
export class Velocity {
  static readonly window = 0.05;
  /** A pause longer than this before letting go means the hand had stopped: no coast. */
  static readonly stale = 0.08;
  x = 0;
  y = 0;
  private last: { x: number; y: number; time: number } | null = null;

  /** The pointer at screen point (X, Y) at TIME seconds. */
  add(x: number, y: number, time: number) {
    const last = this.last;
    this.last = { x, y, time };
    if (!last || !(time > last.time)) return;
    const dt = time - last.time;
    const a = 1 - Math.exp(-dt / Velocity.window);
    this.x += a * ((x - last.x) / dt - this.x);
    this.y += a * ((y - last.y) / dt - this.y);
  }

  /** The speed to let go with: zero if the pointer had been still for a moment. */
  release(time: number): Point {
    if (!this.last || time - this.last.time >= Velocity.stale) return { x: 0, y: 0 };
    return { x: this.x, y: this.y };
  }
}

/** A window let go while moving fast keeps going, slowing exponentially: a little, never far. */
export const coastLimits = {
  /** Slower than this on screen and it just drops. */
  threshold: 1200,
  /** Time constant of the slow-down; it has all but stopped after five of these. */
  decay: 0.18,
  /** The whole coast is no longer than this on screen… */
  cap: 160,
  /** …nor than this share of the window's own width. */
  widthFraction: 0.25,
};

export interface Coast {
  /** Canvas units per second, already scaled so the coast ends within the cap. */
  velocity: Point;
  /** Where it stops, from ORIGIN. */
  end: Point;
  /** Where it is T seconds in. */
  at(t: number): Point;
}

/**
 * The coast of a window at ORIGIN let go at SCREEN velocity, ZOOM converting
 * screen to canvas, WIDTH its width on the canvas; null when the hand was too
 * slow to matter. It follows v·τ·(1 − e^(−t/τ)).
 */
export function coast(origin: Point, screen: Point, zoom: number, width: number): Coast | null {
  const speed = Math.hypot(screen.x, screen.y);
  if (speed < coastLimits.threshold || !(zoom > 0)) return null;
  const { decay, cap, widthFraction } = coastLimits;
  const allowed = Math.min(cap / zoom, width * widthFraction);
  const full = (speed / zoom) * decay;
  const scale = (full > allowed ? allowed / full : 1) / zoom;
  const velocity = { x: screen.x * scale, y: screen.y * scale };
  const at = (t: number) => {
    const f = decay * (1 - Math.exp(-Math.max(0, t) / decay));
    return { x: origin.x + velocity.x * f, y: origin.y + velocity.y * f };
  };
  return { velocity, end: at(Infinity), at };
}

/**
 * The way a coasting window moves to where it lands: a critically damped spring
 * started at the coast's velocity is the coast itself when it lands at v·τ
 * (x(t) = −D·e^(−t/τ) once v₀ = ωD), with ω = 1/τ.
 */
export function coastMotion(velocity: number): Motion {
  return spring({ duration: 2 * Math.PI * coastLimits.decay, velocity });
}
