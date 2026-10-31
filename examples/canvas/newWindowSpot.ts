/**
 * Where a window that just opened goes on the canvas, after Sunlight's
 * (spacefarm-digital/sunlight, NewWindowSpot.swift): in the middle of the view
 * if that is clear of every other window, otherwise the free spot nearest the
 * middle, beside the windows in the way, in view if there is room in view.
 * Canvas coordinates throughout.
 */
import type { Rectangle } from "proscenium";
import type { Size } from "./tiling.js";
import type { Point } from "./snapping.js";

/**
 * What sticking out of view costs: more than any distance, so a free spot fully
 * in view always beats one that isn't, plus this much a unit out, so among
 * those the one least out wins.
 */
const outOfViewPenalty = 1_000_000;
const outOfViewWeight = 4;

/** SIZE's spot clear of OTHERS by GAP, nearest the middle of VIEW (or TARGET). */
export function spot(
  size: Size,
  others: readonly Rectangle[],
  view: Rectangle,
  gap: number,
  target?: Point,
): Rectangle {
  const centre = target ?? { x: view.x + view.width / 2, y: view.y + view.height / 2 };
  let middle = { x: centre.x - size.width / 2, y: centre.y - size.height / 2, ...size };
  if (target) middle = inside(middle, view);
  if (isClear(middle, others, gap)) return middle;
  return beside(others, middle, gap, (r) => score(r, centre, view));
}

/** The lowest-scoring free spot touching any of OTHERS, for a window R's size. */
function beside(
  others: readonly Rectangle[],
  r: Rectangle,
  gap: number,
  scoreOf: (r: Rectangle) => number,
): Rectangle {
  let best: Rectangle | null = null;
  let bestScore = Infinity;
  for (const o of others)
    for (const origin of candidates(o, r, gap, r)) {
      const c = { ...origin, width: r.width, height: r.height };
      if (!isClear(c, others, gap)) continue;
      const s = scoreOf(c);
      if (s < bestScore) {
        best = c;
        bestScore = s;
      }
    }
  if (best) return best;
  // Nothing beside anything is free (it can't happen with finite windows, but): right of them all.
  const right = Math.max(...others.map((o) => o.x + o.width));
  const top = Math.min(...others.map((o) => o.y));
  return { x: right + gap, y: top, width: r.width, height: r.height };
}

/** R moved the least to lie inside VIEW, along each axis it fits on. */
export function inside(r: Rectangle, view: Rectangle): Rectangle {
  let { x, y } = r;
  if (r.width <= view.width) x = Math.min(Math.max(x, view.x), view.x + view.width - r.width);
  if (r.height <= view.height) y = Math.min(Math.max(y, view.y), view.y + view.height - r.height);
  return { ...r, x, y };
}

/** Clear of every window by at least the gap (edges exactly a gap apart are clear). */
export function isClear(r: Rectangle, others: readonly Rectangle[], gap: number): boolean {
  const reach = Math.max(gap - 0.5, 0);
  const grown = { x: r.x - reach, y: r.y - reach, width: r.width + 2 * reach, height: r.height + 2 * reach };
  return !others.some((o) => intersects(grown, o));
}

/**
 * The spots touching O a gap away on each side: lined up with either of its
 * edges along that side, or level with the centred spot (MIDDLE).
 */
function candidates(o: Rectangle, size: Size, gap: number, middle: Point): Point[] {
  const right = o.x + o.width + gap;
  const left = o.x - gap - size.width;
  const below = o.y + o.height + gap;
  const above = o.y - gap - size.height;
  const bottom = o.y + o.height - size.height;
  const end = o.x + o.width - size.width;
  return [
    { x: right, y: o.y },
    { x: right, y: bottom },
    { x: left, y: o.y },
    { x: left, y: bottom },
    { x: o.x, y: below },
    { x: end, y: below },
    { x: o.x, y: above },
    { x: end, y: above },
    { x: right, y: middle.y },
    { x: left, y: middle.y },
    { x: middle.x, y: below },
    { x: middle.x, y: above },
  ];
}

/** Distance from the target to the spot's middle; out of view comes after every spot in view. */
function score(r: Rectangle, target: Point, view: Rectangle): number {
  const distance = Math.hypot(r.x + r.width / 2 - target.x, r.y + r.height / 2 - target.y);
  const out =
    Math.max(0, view.x - r.x) +
    Math.max(0, r.x + r.width - (view.x + view.width)) +
    Math.max(0, view.y - r.y) +
    Math.max(0, r.y + r.height - (view.y + view.height));
  return out > 0 ? outOfViewPenalty + outOfViewWeight * out + distance : distance;
}

function intersects(a: Rectangle, b: Rectangle) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
