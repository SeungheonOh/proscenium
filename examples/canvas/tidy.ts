/**
 * Tidy, after Sunlight's (spacefarm-digital/sunlight, Tidy.swift): every window
 * on the canvas laid out on one grid from the top left of the screen in view,
 * none resized. Columns are as wide as their widest window, rows as tall as
 * their tallest, each window at the top left of its cell, in rows by where the
 * windows sit now: the canvas you had, straightened. Canvas coordinates.
 */
import type { Rectangle } from "proscenium";
import { tileGap } from "./tiling.js";
import type { Point } from "./snapping.js";

/** Sunlight's Normal spacing: four tile gaps between windows and from the grid's edge. */
export const spacing = 4 * tileGap;

/**
 * Rows by where RECTS sit, each row left to right. A rect joins the row above
 * when its top is above that row's first rect's middle; otherwise it starts the
 * next row. So windows roughly beside each other read as one row however their
 * tops differ.
 */
export function readingOrder(rects: readonly Rectangle[]): number[] {
  const byTop = rects
    .map((_, i) => i)
    .sort((a, b) => rects[a]!.y - rects[b]!.y || rects[a]!.x - rects[b]!.x);
  const rows: number[][] = [];
  let rowMiddle = 0;
  for (const i of byTop) {
    const r = rects[i]!;
    const row = rows.at(-1);
    if (row && r.y < rowMiddle) {
      row.push(i);
      continue;
    }
    rows.push([i]);
    rowMiddle = r.y + r.height / 2;
  }
  return rows.flatMap((row) => row.sort((a, b) => rects[a]!.x - rects[b]!.x || rects[a]!.y - rects[b]!.y));
}

/** The square root of the count, rounded up. */
export function columnsFor(count: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(Math.max(1, count))));
}

export interface Tidied {
  /** Each rect where it goes, in the order given. */
  rects: Rectangle[];
  /** Around the whole grid, for the camera to frame. */
  bounds: Rectangle;
}

/** RECTS on one grid from ORIGIN, sizes kept. */
export function tidy(rects: readonly Rectangle[], origin: Point, gap = spacing): Tidied {
  if (rects.length === 0) return { rects: [], bounds: { x: origin.x, y: origin.y, width: 0, height: 0 } };
  const order = readingOrder(rects);
  const columns = columnsFor(rects.length);
  const widths = new Array<number>(columns).fill(0);
  const heights = new Array<number>(Math.ceil(order.length / columns)).fill(0);
  order.forEach((i, slot) => {
    widths[slot % columns] = Math.max(widths[slot % columns]!, rects[i]!.width);
    const row = Math.floor(slot / columns);
    heights[row] = Math.max(heights[row]!, rects[i]!.height);
  });
  const xs: number[] = [];
  const ys: number[] = [];
  let x = origin.x + gap;
  for (const w of widths) {
    xs.push(x);
    x += w + gap;
  }
  let y = origin.y + gap;
  for (const h of heights) {
    ys.push(y);
    y += h + gap;
  }
  const out = rects.map((r) => ({ ...r }));
  order.forEach((i, slot) => {
    out[i] = { ...rects[i]!, x: Math.round(xs[slot % columns]!), y: Math.round(ys[Math.floor(slot / columns)]!) };
  });
  return { rects: out, bounds: { x: origin.x, y: origin.y, width: x - origin.x, height: y - origin.y } };
}
