/**
 * Move & Resize and Arrange, after Sunlight's (spacefarm-digital/sunlight,
 * Tiling.swift): a window takes a slot of a screen-sized area of the canvas, a
 * half, a quarter, a third, and the windows of one area share it in columns.
 * Canvas coordinates throughout.
 *
 * At 100% the area is the screen in view. Zoomed out it is the page the window
 * is on: pages are screen-sized areas in a grid from where the camera starts,
 * a gutter apart, so a tiled page reads as one desktop among many from further
 * out.
 */
import type { Rectangle } from "proscenium";
import { tileGap } from "./magnetism.js";
import type { Point } from "./snapping.js";

export { tileGap };

/** Between pages, so zoomed out they read as separate areas. */
export const pageGutter = 240;

export type Preset =
  | "leftHalf"
  | "rightHalf"
  | "topHalf"
  | "bottomHalf"
  | "topLeft"
  | "topRight"
  | "bottomLeft"
  | "bottomRight"
  | "leftThird"
  | "centerThird"
  | "rightThird"
  | "leftTwoThirds"
  | "centerTwoThirds"
  | "rightTwoThirds"
  | "full"
  | "center";

const t = 1 / 3;

/** Each slot in a unit area: (0, 0, 0.5, 1) is the left half. Centre keeps the window's size. */
export const units: Record<Exclude<Preset, "center">, Rectangle> = {
  leftHalf: { x: 0, y: 0, width: 0.5, height: 1 },
  rightHalf: { x: 0.5, y: 0, width: 0.5, height: 1 },
  topHalf: { x: 0, y: 0, width: 1, height: 0.5 },
  bottomHalf: { x: 0, y: 0.5, width: 1, height: 0.5 },
  topLeft: { x: 0, y: 0, width: 0.5, height: 0.5 },
  topRight: { x: 0.5, y: 0, width: 0.5, height: 0.5 },
  bottomLeft: { x: 0, y: 0.5, width: 0.5, height: 0.5 },
  bottomRight: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
  leftThird: { x: 0, y: 0, width: t, height: 1 },
  centerThird: { x: t, y: 0, width: t, height: 1 },
  rightThird: { x: 2 * t, y: 0, width: 1 - 2 * t, height: 1 },
  leftTwoThirds: { x: 0, y: 0, width: 2 * t, height: 1 },
  centerTwoThirds: { x: t / 2, y: 0, width: 2 * t, height: 1 },
  rightTwoThirds: { x: t, y: 0, width: 1 - t, height: 1 },
  full: { x: 0, y: 0, width: 1, height: 1 },
};

/** Sunlight's keys, on Ctrl+Alt as its ⌃⌥: Rectangle's arrows and letters. */
export const presetKeys: readonly (readonly [key: string, preset: Preset])[] = [
  ["Left", "leftHalf"],
  ["Right", "rightHalf"],
  ["Up", "topHalf"],
  ["Down", "bottomHalf"],
  ["U", "topLeft"],
  ["I", "topRight"],
  ["J", "bottomLeft"],
  ["K", "bottomRight"],
  ["D", "leftThird"],
  ["F", "centerThird"],
  ["G", "rightThird"],
  ["E", "leftTwoThirds"],
  ["T", "rightTwoThirds"],
  ["Return", "full"],
  ["C", "center"],
];

/** Arrange: the windows of one area in this many columns, on Ctrl+Alt with the digit. */
export const arrangements = [2, 3, 4] as const;

/**
 * Pressing the same slot again steps through its widths, as in Rectangle: a
 * half, then two-thirds, then a third, then a half again.
 */
const next: Partial<Record<Preset, Preset>> = {
  leftHalf: "leftTwoThirds",
  leftTwoThirds: "leftThird",
  leftThird: "leftHalf",
  rightHalf: "rightTwoThirds",
  rightTwoThirds: "rightThird",
  rightThird: "rightHalf",
  centerThird: "centerTwoThirds",
  centerTwoThirds: "centerThird",
};

/** The slot a repeat press starts from, so left half on a window at left two-thirds carries on the cycle. */
const cycleRoot: Partial<Record<Preset, Preset>> = {
  leftTwoThirds: "leftHalf",
  leftThird: "leftHalf",
  rightTwoThirds: "rightHalf",
  rightThird: "rightHalf",
  centerTwoThirds: "centerThird",
};

/** The slot REQUESTED gives a window last tiled at LAST: the next width when it is a repeat. */
export function cycled(requested: Preset, last: Preset | undefined): Preset {
  if (!last || (cycleRoot[last] ?? last) !== requested) return requested;
  return next[last] ?? last;
}

/** A window's place in an area, kept so a repeat press can cycle. */
export interface Tile {
  area: Rectangle;
  preset: Preset | null;
}

/**
 * The rect a unit slot takes in AREA: GAP from the area's edges and GAP between
 * neighbours (half on each side of a shared edge), in whole units.
 */
export function slotRect(unit: Rectangle, area: Rectangle, gap = tileGap): Rectangle {
  const edge = (u: number, origin: number, length: number, leading: boolean) => {
    const v = origin + u * length;
    const inset = u <= 0.0001 || u >= 0.9999 ? gap : gap / 2;
    return Math.round(leading ? v + inset : v - inset);
  };
  const x = edge(unit.x, area.x, area.width, true);
  const right = edge(unit.x + unit.width, area.x, area.width, false);
  const y = edge(unit.y, area.y, area.height, true);
  const bottom = edge(unit.y + unit.height, area.y, area.height, false);
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

/** Where PRESET puts a window of SIZE in AREA. Centre keeps the size, no larger than the area allows. */
export function presetRect(preset: Preset, size: Size, area: Rectangle, gap = tileGap): Rectangle {
  if (preset !== "center") return slotRect(units[preset], area, gap);
  const room = { x: area.x + gap, y: area.y + gap, width: area.width - 2 * gap, height: area.height - 2 * gap };
  const width = Math.min(size.width, room.width);
  const height = Math.min(size.height, room.height);
  return {
    x: Math.round(room.x + (room.width - width) / 2),
    y: Math.round(room.y + (room.height - height) / 2),
    width,
    height,
  };
}

export interface Size {
  width: number;
  height: number;
}

/**
 * The corner of a slot a window keeps to when its client won't take the slot's
 * exact size (a minimum width, say): the slot's outer edges, as a unit point. A
 * left slot keeps left, a right one right, a centred one centred.
 */
export function anchor(unit: Rectangle | null): Point {
  if (!unit) return { x: 0.5, y: 0.5 };
  const axis = (lo: number, hi: number) => (lo <= 0.0001 ? 0 : hi >= 0.9999 ? 1 : 0.5);
  return { x: axis(unit.x, unit.x + unit.width), y: axis(unit.y, unit.y + unit.height) };
}

export function presetUnit(preset: Preset): Rectangle | null {
  return preset === "center" ? null : units[preset];
}

/** Sizes a client accepts; 0 leaves a bound free. */
export interface Limits {
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
}

/** A window held to LIMITS, in SLOT, against ANCHOR: the slot itself when the client takes its size. */
export function fit(slot: Rectangle, limits: Limits | undefined, at: Point): Rectangle {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo || 0, hi > 0 ? Math.min(v, hi) : v);
  const width = limits ? clamp(slot.width, limits.minWidth, limits.maxWidth) : slot.width;
  const height = limits ? clamp(slot.height, limits.minHeight, limits.maxHeight) : slot.height;
  return {
    x: Math.round(slot.x + (slot.width - width) * at.x),
    y: Math.round(slot.y + (slot.height - height) * at.y),
    width,
    height,
  };
}

/** The page POINT is on. SCREEN is the usable screen where the camera starts: page 0. */
export function page(point: Point, screen: Rectangle, gutter = pageGutter): Rectangle {
  const pitchX = screen.width + gutter;
  const pitchY = screen.height + gutter;
  // Half the gutter belongs to each page beside it.
  const i = Math.floor((point.x - screen.x + gutter / 2) / pitchX);
  const j = Math.floor((point.y - screen.y + gutter / 2) / pitchY);
  return { x: screen.x + i * pitchX, y: screen.y + j * pitchY, width: screen.width, height: screen.height };
}

/** The unit cells of an arrangement, in reading order: COLUMNS across and ROWS down. */
export function cells(columns: number, rows: number): Rectangle[] {
  const out: Rectangle[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < columns; c++)
      out.push({ x: c / columns, y: r / rows, width: 1 / columns, height: 1 / rows });
  return out;
}

/** The order windows at RECTS fill a row of columns: left to right, by their middles. */
export function arrangeOrder(rects: readonly Rectangle[]): number[] {
  const mid = (r: Rectangle) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  return rects
    .map((_, i) => i)
    .sort((a, b) => {
      const ma = mid(rects[a]!);
      const mb = mid(rects[b]!);
      return ma.x !== mb.x ? ma.x - mb.x : ma.y - mb.y;
    });
}

export function contains(r: Rectangle, p: Point): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

export function middle(r: Rectangle): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}
