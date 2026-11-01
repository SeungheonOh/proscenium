/**
 * Magnet mode: windows push each other out of the way on the canvas, after
 * Sunlight's "Windows push each other" (spacefarm-digital/sunlight,
 * Magnetism.swift). The window in hand is fixed where the hand holds it; the
 * others are shoved out of its way along the shortest route, and shove the ones
 * behind them in turn. Canvas coordinates throughout.
 *
 * `resolve` makes a target layout with nothing overlapping, afresh on every
 * pointer move, so it never tunnels or drifts; what moves together (a stack,
 * the selection) is pushed as one body (`resolveBodies`). Pushed windows ease
 * after their targets on a critically damped spring (`followMotion`), and a
 * window flung hard keeps going a little when let go (`coast`).
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

/** A rigid set of windows pushed as one: a stack, the selection, or one window. */
export interface Body {
  rects: Rectangle[];
}

export interface BodyResolution {
  /** How far each body moved, as one piece. */
  offsets: Point[];
  /** Which of them moved. */
  moved: Set<number>;
}

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
  const { offsets, moved } = resolveBodies(body(fixed), others.map((o) => body(o)), reach);
  return { rects: others.map((o, i) => offset(o, offsets[i]!)), moved };
}

/** One window as a body. */
export function body(rect: Rectangle): Body {
  return { rects: [rect] };
}

/**
 * The same for bodies, each moving as one piece: everything is pushed out of
 * the hand's way, and then pushes what is behind it.
 */
export function resolveBodies(fixed: Body, others: readonly Body[], reach: number): BodyResolution {
  const offsets = others.map(() => ({ x: 0, y: 0 }));
  const moved = new Set<number>();
  if (others.length === 0 || fixed.rects.length === 0) return { offsets, moved };
  const bodies = [...others];
  const gap = Math.max(0, reach);
  // Nearest to the hand first: the push travels outwards.
  const hand = bounds(fixed.rects);
  const order = others
    .map((_, i) => i)
    .sort((a, b) => distance(bounds(others[a]!.rects), hand) - distance(bounds(others[b]!.rects), hand));
  const n = others.length;
  const stacked = new Set<number>();
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (bodiesOverlap(others[i]!, others[j]!)) stacked.add(i * n + j);
    }
  }
  const areStacked = (i: number, j: number) => stacked.has(Math.min(i, j) * n + Math.max(i, j));

  for (let pass = 0; pass < maxPasses; pass++) {
    let largest = 0;
    const shift = (i: number, d: Point) => {
      bodies[i] = { rects: bodies[i]!.rects.map((r) => offset(r, d)) };
      offsets[i] = { x: offsets[i]!.x + d.x, y: offsets[i]!.y + d.y };
      moved.add(i);
      largest = Math.max(largest, Math.abs(d.x), Math.abs(d.y));
    };
    // Everyone is clear of the hand.
    for (const i of order) {
      const d = bodyDisplacement(bodies[i]!, fixed, gap);
      if (d.x || d.y) shift(i, d);
    }
    // What moved shoves what is behind it.
    for (const i of order) {
      if (!moved.has(i)) continue;
      for (const j of order) {
        if (j === i || areStacked(i, j)) continue;
        const d = bodyDisplacement(bodies[j]!, bodies[i]!, gap);
        if (d.x || d.y) shift(j, d);
      }
    }
    if (largest < tolerance) break;
  }
  return { offsets, moved };
}

/**
 * How far PUSHED moves, as one piece, to be clear of PUSHER grown by REACH:
 * along the axis that takes less, away from the pusher. The distance is what
 * the deepest member actually in the way needs; zero when none is, so a window
 * in the notch of an L is left alone though the L's bounds cover it.
 */
function bodyDisplacement(pushed: Body, pusher: Body, reach: number): Point {
  const grown = pusher.rects.map((p) => grow(p, reach));
  let right = 0;
  let left = 0;
  let down = 0;
  let up = 0;
  let inTheWay = false;
  for (const r of pushed.rects) {
    for (const p of grown) {
      if (!overlap(r, p)) continue;
      inTheWay = true;
      right = Math.max(right, p.x + p.width - r.x);
      left = Math.max(left, r.x + r.width - p.x);
      down = Math.max(down, p.y + p.height - r.y);
      up = Math.max(up, r.y + r.height - p.y);
    }
  }
  if (!inTheWay) return { x: 0, y: 0 };
  const pushedBox = bounds(pushed.rects);
  const pusherBox = grow(bounds(pusher.rects), reach);
  const dx = pushedBox.x + pushedBox.width / 2 >= pusherBox.x + pusherBox.width / 2 ? right : -left;
  const dy = pushedBox.y + pushedBox.height / 2 >= pusherBox.y + pusherBox.height / 2 ? down : -up;
  return Math.abs(dx) <= Math.abs(dy) ? { x: dx, y: 0 } : { x: 0, y: dy };
}

/**
 * How far R has to move to be clear of PUSHER grown by REACH: along the axis
 * with the smaller overlap, away from the pusher's centre. Zero when clear.
 */
export function displacement(r: Rectangle, pusher: Rectangle, reach: number): Point {
  return bodyDisplacement(body(r), body(pusher), reach);
}

/** The union of RECTS. */
export function bounds(rects: readonly Rectangle[]): Rectangle {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
}

/** R moved by D. */
export function offset(r: Rectangle, d: Point): Rectangle {
  return { x: r.x + d.x, y: r.y + d.y, width: r.width, height: r.height };
}

/** R grown by D on every side. */
export function grow(r: Rectangle, d: number): Rectangle {
  return { x: r.x - d, y: r.y - d, width: r.width + 2 * d, height: r.height + 2 * d };
}

/** Overlap with some area to it; edges that merely touch don't count. */
function overlap(a: Rectangle, b: Rectangle): boolean {
  return (
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > epsilon &&
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > epsilon
  );
}

/** Whether any window of A overlaps any of B. */
function bodiesOverlap(a: Body, b: Body): boolean {
  return a.rects.some((r) => b.rects.some((o) => overlap(r, o)));
}

/** Between the middles of A and B. */
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
  add(x: number, y: number, time: number): void {
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
