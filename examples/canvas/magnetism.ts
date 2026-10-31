/**
 * Magnet mode: windows push each other out of the way on the canvas, after
 * Sunlight's "Windows push each other" (spacefarm-digital/sunlight,
 * Magnetism.swift). The window in hand is fixed where the hand holds it; the
 * others are shoved out of its way along the shortest route, and shove the ones
 * behind them in turn. Canvas coordinates throughout.
 *
 * `resolve` makes a target layout with nothing overlapping, afresh on every
 * pointer move, so it never tunnels or drifts. With polarity (Sunlight's
 * Polarity.swift) every window is + or −: like poles push as before, opposite
 * poles pull the other in to the gap, and it bonds into a group that moves as
 * one body (`resolveBodies`); pushed windows ease after their
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

/** A window's magnetic pole, with polarity on: like poles push, opposite poles pull and bond. */
export type Pole = "plus" | "minus";

/** What two poles do to each other: either without one (polarity off), the push as it always was. */
export function relation(a: Pole | null, b: Pole | null): "repel" | "attract" | "neutral" {
  if (!a || !b) return "neutral";
  return a === b ? "repel" : "attract";
}

/**
 * How near, on screen, an opposite pole has to come before the pull starts: a
 * little further than the guides' snap distance, so the two don't compete at
 * one radius. Divide by the zoom for the canvas.
 */
export const attractDistance = 16;

/** A rigid set of windows: a bonded group, or one window. POLES[i] is RECTS[i]'s pole. */
export interface Body {
  rects: Rectangle[];
  poles: (Pole | null)[];
}

/**
 * Opposite poles pulling together: the pull starts within REACH and leaves
 * them GAP apart, the push's reach, so a bonded pair sits as a pushed one does.
 */
export interface Attraction {
  reach: number;
  gap: number;
}

export interface BodyResolution {
  /** How far each body moved, as one piece. */
  offsets: Point[];
  moved: Set<number>;
  /** The bodies the hand is pulling in: held at the gap, never shoved, and bonding when let go. */
  pulled: Set<number>;
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
  const r = resolveBodies(body(fixed), others.map((o) => body(o)), reach);
  return { rects: others.map((o, i) => offset(o, r.offsets[i]!)), moved: r.moved };
}

/** One window as a body. */
export function body(rect: Rectangle, pole: Pole | null = null): Body {
  return { rects: [rect], poles: [pole] };
}

/**
 * The same for bodies, with polarity, as Sunlight's. Every pass first finds
 * whom the hand pulls: an opposite pole within ATTRACTION's reach of one of the
 * hand's windows goes to the gap and is held there. Everything else is pushed
 * out of the hand and what it holds, as one wall, and then pushes what is
 * behind it. Without ATTRACTION every pole is neutral.
 */
export function resolveBodies(
  fixed: Body,
  others: readonly Body[],
  reach: number,
  attraction?: Attraction | null,
): BodyResolution {
  const offsets = others.map(() => ({ x: 0, y: 0 }));
  const moved = new Set<number>();
  let pulled = new Set<number>();
  if (others.length === 0 || fixed.rects.length === 0) return { offsets, moved, pulled };
  const bodies = others.map((b) => ({ rects: b.rects.map((r) => ({ ...r })), poles: b.poles }));
  reach = Math.max(0, reach);
  // Nearest to the hand first: the push travels outwards.
  const hand = bounds(fixed.rects);
  const order = others
    .map((_, i) => i)
    .sort((a, b) => distance(bounds(others[a]!.rects), hand) - distance(bounds(others[b]!.rects), hand));
  const n = others.length;
  const stacked = new Set<number>();
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) if (bodiesOverlap(others[i]!, others[j]!)) stacked.add(i * n + j);
  const areStacked = (i: number, j: number) => stacked.has(Math.min(i, j) * n + Math.max(i, j));

  for (let pass = 0; pass < maxPasses; pass++) {
    let largest = 0;
    const shift = (i: number, d: Point) => {
      bodies[i] = { rects: bodies[i]!.rects.map((r) => offset(r, d)), poles: bodies[i]!.poles };
      offsets[i] = { x: offsets[i]!.x + d.x, y: offsets[i]!.y + d.y };
      moved.add(i);
      largest = Math.max(largest, Math.abs(d.x), Math.abs(d.y));
    };
    // Whom the hand pulls, and where to.
    pulled = new Set();
    if (attraction)
      for (const i of order) {
        const pull = attachment(bodies[i]!, fixed, attraction, reach);
        if (!pull) continue;
        pulled.add(i);
        if (pull.x || pull.y) shift(i, pull);
      }
    // The hand and what it holds: one wall everyone else is clear of.
    const wall: Body = { rects: [...fixed.rects], poles: [...fixed.poles] };
    for (const i of pulled) {
      wall.rects.push(...bodies[i]!.rects);
      wall.poles.push(...bodies[i]!.poles);
    }
    for (const i of order) {
      if (pulled.has(i)) continue;
      const d = bodyDisplacement(bodies[i]!, wall, reach);
      if (d.x || d.y) shift(i, d);
    }
    // What moved shoves what is behind it, except what the hand holds.
    for (const i of order) {
      if (!moved.has(i)) continue;
      for (const j of order) {
        if (j === i || pulled.has(j) || areStacked(i, j)) continue;
        const d = bodyDisplacement(bodies[j]!, bodies[i]!, reach);
        if (d.x || d.y) shift(j, d);
      }
    }
    if (largest < tolerance) break;
  }
  return { offsets, moved, pulled };
}

/**
 * How far BODY moves, as one piece, to be clear of PUSHER grown by REACH: along
 * the axis that takes less, away from the pusher. The distance is what the
 * deepest member actually in the way needs; zero when none is, so a window in
 * the notch of an L is left alone though the L's bounds cover it.
 */
export function bodyDisplacement(b: Body, pusher: Body, reach: number): Point {
  const grown = pusher.rects.map((p) => grow(p, reach));
  let right = 0;
  let left = 0;
  let down = 0;
  let up = 0;
  let inTheWay = false;
  for (const r of b.rects)
    for (const p of grown) {
      if (!overlap(r, p)) continue;
      inTheWay = true;
      right = Math.max(right, p.x + p.width - r.x);
      left = Math.max(left, r.x + r.width - p.x);
      down = Math.max(down, p.y + p.height - r.y);
      up = Math.max(up, r.y + r.height - p.y);
    }
  if (!inTheWay) return { x: 0, y: 0 };
  const bb = bounds(b.rects);
  const pb = grow(bounds(pusher.rects), reach);
  const dx = bb.x + bb.width / 2 >= pb.x + pb.width / 2 ? right : -left;
  const dy = bb.y + bb.height / 2 >= pb.y + pb.height / 2 ? down : -up;
  return Math.abs(dx) <= Math.abs(dy) ? { x: dx, y: 0 } : { x: 0, y: dy };
}

/**
 * How far R goes to sit GAP from FIXED, if the two are within REACH: in when
 * apart, out the shorter way when on top of each other. They have to face each
 * other, and R keeps its other coordinate, arriving lined up as it came. Null
 * corner to corner, or further than REACH apart.
 */
export function attach(r: Rectangle, fixed: Rectangle, gap: number, reach: number): Point | null {
  const exitX = Math.min(fixed.x + fixed.width - r.x, r.x + r.width - fixed.x);
  const exitY = Math.min(fixed.y + fixed.height - r.y, r.y + r.height - fixed.y);
  const rightOf = r.x + r.width / 2 >= fixed.x + fixed.width / 2;
  const below = r.y + r.height / 2 >= fixed.y + fixed.height / 2;
  if (exitX > epsilon && exitY > epsilon) {
    if (exitX <= exitY) return { x: rightOf ? exitX + gap : -(exitX + gap), y: 0 };
    return { x: 0, y: below ? exitY + gap : -(exitY + gap) };
  }
  if (exitY > epsilon) {
    const apart = -exitX;
    if (apart > reach) return null;
    return { x: rightOf ? gap - apart : apart - gap, y: 0 };
  }
  if (exitX > epsilon) {
    const apart = -exitY;
    if (apart > reach) return null;
    return { x: 0, y: below ? gap - apart : apart - gap };
  }
  return null;
}

/**
 * How far B moves, as one piece, to attach to FIXED: the nearest pair of its
 * members and the hand's with opposite poles that `attach` accepts. Null if
 * none, or if it would sit on another of the hand's windows (grown by REACH): a
 * ragged group would otherwise pull it in and shove it out by turns.
 */
export function attachment(b: Body, fixed: Body, a: Attraction, reach: number): Point | null {
  let best: { v: Point; partner: number } | null = null;
  let bestTravel = Infinity;
  b.rects.forEach((r, i) =>
    fixed.rects.forEach((f, j) => {
      if (relation(b.poles[i] ?? null, fixed.poles[j] ?? null) !== "attract") return;
      const v = attach(r, f, a.gap, a.reach);
      if (!v) return;
      const travel = Math.hypot(v.x, v.y);
      if (travel < bestTravel) {
        best = { v, partner: j };
        bestTravel = travel;
      }
    }),
  );
  if (!best) return null;
  const { v, partner } = best as { v: Point; partner: number };
  const placed = b.rects.map((r) => offset(r, v));
  for (let j = 0; j < fixed.rects.length; j++) {
    if (j === partner) continue;
    const g = grow(fixed.rects[j]!, reach);
    if (placed.some((r) => overlap(r, g))) return null;
  }
  return v;
}

/**
 * Whether two windows sit together: side by side or one above the other, no
 * more than GAP apart (half a unit of slack), or on top of each other. What
 * keeps a group in one piece.
 */
export function adjacent(a: Rectangle, b: Rectangle, gap: number): boolean {
  const exitX = Math.min(a.x + a.width - b.x, b.x + b.width - a.x);
  const exitY = Math.min(a.y + a.height - b.y, b.y + b.height - a.y);
  if (exitX > epsilon && exitY > epsilon) return true;
  if (exitY > epsilon) return -exitX <= gap + 0.5;
  if (exitX > epsilon) return -exitY <= gap + 0.5;
  return false;
}

/**
 * The gap between two windows that face each other, as a line across it midway
 * along their shared span: drawn while the hand pulls one in. Null if they
 * don't face each other.
 */
export function gapLine(a: Rectangle, b: Rectangle): { from: Point; to: Point } | null {
  const exitX = Math.min(a.x + a.width - b.x, b.x + b.width - a.x);
  const exitY = Math.min(a.y + a.height - b.y, b.y + b.height - a.y);
  if (exitX > epsilon && exitY > epsilon) return null;
  if (exitY > epsilon) {
    const y = (Math.max(a.y, b.y) + Math.min(a.y + a.height, b.y + b.height)) / 2;
    const [l, r] = a.x + a.width / 2 <= b.x + b.width / 2 ? [a, b] : [b, a];
    return { from: { x: l.x + l.width, y }, to: { x: r.x, y } };
  }
  if (exitX > epsilon) {
    const x = (Math.max(a.x, b.x) + Math.min(a.x + a.width, b.x + b.width)) / 2;
    const [t, u] = a.y + a.height / 2 <= b.y + b.height / 2 ? [a, b] : [b, a];
    return { from: { x, y: t.y + t.height }, to: { x, y: u.y } };
  }
  return null;
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

export function offset(r: Rectangle, d: Point): Rectangle {
  return { x: r.x + d.x, y: r.y + d.y, width: r.width, height: r.height };
}

function grow(r: Rectangle, d: number): Rectangle {
  return { x: r.x - d, y: r.y - d, width: r.width + 2 * d, height: r.height + 2 * d };
}

/** Overlap with some area to it; edges that merely touch don't count. */
function overlap(a: Rectangle, b: Rectangle): boolean {
  return (
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > epsilon &&
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > epsilon
  );
}

function bodiesOverlap(a: Body, b: Body): boolean {
  return a.rects.some((r) => b.rects.some((o) => overlap(r, o)));
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
