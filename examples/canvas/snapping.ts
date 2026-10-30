/**
 * Where a window being dragged lines up with its neighbours, and where it lands
 * on the grid when it is let go: Sunlight's alignment guides and drop grid
 * (spacefarm-digital/sunlight, Snapping.swift and Resizing.swift). Canvas
 * coordinates throughout.
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
  /** Whether a neighbour holds the window on that axis; the grid leaves a held axis alone. */
  snappedX: boolean;
  snappedY: boolean;
  guides: Guide[];
}

/** How near, on screen, an edge comes before a guide catches it. */
export const snapDistance = 8;

/** Grid steps to choose from, and the one a canvas starts with. */
export const gridSizes = [20, 40, 80] as const;
export const defaultGridSize = 40;

/** No smaller than this at 1:1 once a resize settles on the grid. */
export const minSize = { width: 160, height: 100 };

type Axis = "x" | "y";

interface Candidate {
  delta: number;
  other: Rectangle;
  kind: Guide["kind"];
  at: number;
}

function span(r: Rectangle, axis: Axis) {
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
  gap: number,
): Alignment {
  const x = nearest(candidates("x", moving, others, gap), threshold);
  const y = nearest(candidates("y", moving, others, gap), threshold);
  const snapped = { ...moving, x: moving.x + (x[0]?.delta ?? 0), y: moving.y + (y[0]?.delta ?? 0) };
  return {
    x: snapped.x,
    y: snapped.y,
    snappedX: x.length > 0,
    snappedY: y.length > 0,
    guides: [
      ...x.map((c) => guide(c, "x", snapped, gap)),
      ...y.map((c) => guide(c, "y", snapped, gap)),
    ],
  };
}

/** The nearest grid point on each axis that no neighbour is holding. */
export function grid(origin: Point, size: number, keepX: boolean, keepY: boolean): Point {
  if (!(size > 0)) return origin;
  return {
    x: keepX ? origin.x : Math.round(origin.x / size) * size,
    y: keepY ? origin.y : Math.round(origin.y / size) * size,
  };
}

/** The edges of a resize that moved. */
export interface Edges {
  left: boolean;
  right: boolean;
  top: boolean;
  bottom: boolean;
}

/** Which edges moved between START and END. */
export function movedEdges(start: Rectangle, end: Rectangle): Edges {
  const moved = (a: number, b: number) => Math.abs(a - b) > 0.5;
  return {
    left: moved(start.x, end.x),
    right: moved(start.x + start.width, end.x + end.width),
    top: moved(start.y, end.y),
    bottom: moved(start.y + start.height, end.y + end.height),
  };
}

/**
 * A resize let go: the edges that moved settle onto the grid, the others stay
 * where they are. An edge that would come closer than MIN to its opposite goes
 * to the next grid line out instead.
 */
export function gridEdges(rect: Rectangle, edges: Edges, size: number, min = minSize): Rectangle {
  if (!(size > 0)) return rect;
  const snap = (v: number) => Math.round(v / size) * size;
  let minX = rect.x;
  let maxX = rect.x + rect.width;
  let minY = rect.y;
  let maxY = rect.y + rect.height;
  if (edges.left) {
    minX = snap(minX);
    if (maxX - minX < min.width) minX = Math.floor((maxX - min.width) / size) * size;
  }
  if (edges.right) {
    maxX = snap(maxX);
    if (maxX - minX < min.width) maxX = Math.ceil((minX + min.width) / size) * size;
  }
  if (edges.top) {
    minY = snap(minY);
    if (maxY - minY < min.height) minY = Math.floor((maxY - min.height) / size) * size;
  }
  if (edges.bottom) {
    maxY = snap(maxY);
    if (maxY - minY < min.height) maxY = Math.ceil((minY + min.height) / size) * size;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Edges with edges and centre with centre (an edge to a centre is too sticky to
 * be useful), plus the gap either side of a neighbour that overlaps the window
 * across the axis.
 */
function candidates(axis: Axis, moving: Rectangle, others: readonly Rectangle[], gap: number) {
  const m = span(moving, axis);
  const list: Candidate[] = [];
  for (const o of others) {
    const t = span(o, axis);
    for (const mv of [m.min, m.max])
      for (const tv of [t.min, t.max]) list.push({ delta: tv - mv, other: o, kind: "line", at: tv });
    list.push({ delta: t.mid - m.mid, other: o, kind: "line", at: t.mid });

    const across = span(moving, axis === "x" ? "y" : "x");
    const theirs = span(o, axis === "x" ? "y" : "x");
    if (!(across.min < theirs.max && theirs.min < across.max)) continue;
    list.push({ delta: t.max + gap - m.min, other: o, kind: "gap", at: t.max });
    list.push({ delta: t.min - gap - m.max, other: o, kind: "gap", at: t.min - gap });
  }
  return list;
}

/** The closest candidate within reach, and every other one it lines the window up with too. */
function nearest(list: Candidate[], threshold: number): Candidate[] {
  let best: Candidate | undefined;
  for (const c of list)
    if (Math.abs(c.delta) <= threshold && (!best || Math.abs(c.delta) < Math.abs(best.delta)))
      best = c;
  if (!best) return [];
  const delta = best.delta;
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
