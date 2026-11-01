/**
 * Where a window being dragged lines up with its neighbours: Sunlight's
 * alignment guides (spacefarm-digital/sunlight, Snapping.swift). There is no
 * drop grid: a window stays where it is let go. Canvas coordinates throughout.
 */
import type { Rectangle } from "proscenium";

export interface Point {
  x: number;
  y: number;
}

/**
 * What a drag is lined up with, drawn while it is held there: an edge or centre
 * shared with a neighbour (`line`), or the standard gap to a neighbour side by
 * side (`gap`).
 */
export interface Guide {
  kind: "line" | "gap";
  from: Point;
  to: Point;
}

export interface Alignment {
  x: number;
  y: number;
  /** Whether a neighbour holds the window on that axis. */
  snappedX: boolean;
  snappedY: boolean;
  guides: Guide[];
}

/** How near, on screen, an edge comes before a guide catches it. */
export const snapDistance = 8;

/** The gap a guide holds a window at beside a neighbour. */
const neighbourGap = 16;

type Axis = "x" | "y";

interface Candidate {
  delta: number;
  other: Rectangle;
  kind: Guide["kind"];
  at: number;
}

interface Span {
  min: number;
  mid: number;
  max: number;
}

/** R's extent along AXIS. */
function span(r: Rectangle, axis: Axis): Span {
  return axis === "x"
    ? { min: r.x, mid: r.x + r.width / 2, max: r.x + r.width }
    : { min: r.y, mid: r.y + r.height / 2, max: r.y + r.height };
}

/**
 * Lines MOVING up with the nearest of OTHERS on each axis, if one is within
 * THRESHOLD: left, right and centre with theirs, or GAP away from a neighbour
 * beside it. Called with the raw pointer position on every move, so the window
 * sticks until the pointer pulls THRESHOLD away.
 */
export function align(
  moving: Rectangle,
  others: readonly Rectangle[],
  threshold: number,
  gap = neighbourGap,
): Alignment {
  const onX = nearest(candidates("x", moving, others, gap), threshold);
  const onY = nearest(candidates("y", moving, others, gap), threshold);
  const snapped = { ...moving, x: moving.x + (onX[0]?.delta ?? 0), y: moving.y + (onY[0]?.delta ?? 0) };
  return {
    x: snapped.x,
    y: snapped.y,
    snappedX: onX.length > 0,
    snappedY: onY.length > 0,
    guides: [
      ...onX.map((c) => guide(c, "x", snapped, gap)),
      ...onY.map((c) => guide(c, "y", snapped, gap)),
    ],
  };
}

/**
 * Edges with edges and centre with centre (an edge to a centre is too sticky to
 * be useful), plus the gap either side of a neighbour that overlaps the window
 * across the axis.
 */
function candidates(axis: Axis, moving: Rectangle, others: readonly Rectangle[], gap: number): Candidate[] {
  const cross = axis === "x" ? "y" : "x";
  const m = span(moving, axis);
  const across = span(moving, cross);
  const list: Candidate[] = [];
  for (const o of others) {
    const t = span(o, axis);
    for (const mv of [m.min, m.max]) {
      for (const tv of [t.min, t.max]) list.push({ delta: tv - mv, other: o, kind: "line", at: tv });
    }
    list.push({ delta: t.mid - m.mid, other: o, kind: "line", at: t.mid });

    const theirs = span(o, cross);
    if (!(across.min < theirs.max && theirs.min < across.max)) continue;
    list.push({ delta: t.max + gap - m.min, other: o, kind: "gap", at: t.max });
    list.push({ delta: t.min - gap - m.max, other: o, kind: "gap", at: t.min - gap });
  }
  return list;
}

/** The closest candidate within reach, and every other one it lines the window up with too. */
function nearest(list: readonly Candidate[], threshold: number): Candidate[] {
  let best: Candidate | undefined;
  for (const c of list) {
    if (Math.abs(c.delta) > threshold) continue;
    if (!best || Math.abs(c.delta) < Math.abs(best.delta)) best = c;
  }
  if (!best) return [];
  const { delta } = best;
  return list.filter((c) => Math.abs(c.delta - delta) < 0.5);
}

/**
 * A line runs along the shared coordinate across both windows. A gap is marked
 * across it, halfway along where the two overlap.
 */
function guide(c: Candidate, axis: Axis, r: Rectangle, gap: number): Guide {
  const o = c.other;
  if (c.kind === "line") {
    return axis === "x"
      ? {
          kind: "line",
          from: { x: c.at, y: Math.min(r.y, o.y) },
          to: { x: c.at, y: Math.max(r.y + r.height, o.y + o.height) },
        }
      : {
          kind: "line",
          from: { x: Math.min(r.x, o.x), y: c.at },
          to: { x: Math.max(r.x + r.width, o.x + o.width), y: c.at },
        };
  }
  if (axis === "x") {
    const y = (Math.max(r.y, o.y) + Math.min(r.y + r.height, o.y + o.height)) / 2;
    return { kind: "gap", from: { x: c.at, y }, to: { x: c.at + gap, y } };
  }
  const x = (Math.max(r.x, o.x) + Math.min(r.x + r.width, o.x + o.width)) / 2;
  return { kind: "gap", from: { x, y: c.at }, to: { x, y: c.at + gap } };
}
