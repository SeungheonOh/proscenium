/**
 * niri's layout model and the geometry derived from it. Each output owns a
 * vertical stack of workspaces; each workspace is an endless horizontal strip
 * of columns, each a vertical stack of tiles, plus a floating layer above.
 *
 * Positions on a strip are absolute: column 0 starts at the workspace's
 * `shift`, the rest follow with `gaps` between, and `view` is the strip
 * position of the output's left edge. Columns removed or inserted left of the
 * active one move `shift` instead of the view, so the focused column stays put
 * on screen, as it does in niri.
 */

import type { Rectangle } from "proscenium";
import { gaps, presetHeights } from "./config.js";

export type Width = { proportion: number } | { fixed: number };
/** A window's height in its column: a share of what is left, window pixels, or a preset. */
export type Height = { auto: number } | { fixed: number } | { preset: number };
/** Fullscreen fills the output; maximized fills its work area, edge to edge. */
export type Sizing = "normal" | "fullscreen" | "maximized";

export interface Tile {
  window: number;
  height: Height;
}

export interface Column {
  tiles: Tile[];
  active: number;
  width: Width;
  /** Index into the preset widths while the width is one of them. */
  preset: number | null;
  /** Maximized column: as wide as the work area allows, keeping its gaps. */
  fullWidth: boolean;
  tabbed: boolean;
  sizing: Sizing;
}

/** A floating window: its top left in output pixels, and its size or null for the client's own. */
export interface Floater {
  window: number;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
}

export interface Workspace {
  id: number;
  columns: Column[];
  active: number;
  shift: number;
  view: number;
  /** The view, relative to the previous column, to return to if the column just opened closes. */
  restoreOnRemoval: number | null;
  /** The view, relative to the column, from before it went fullscreen. */
  restoreOnUnfullscreen: number | null;
  /** Bottom to top; the top one is the active floating window. */
  floating: Floater[];
  floatingActive: boolean;
}

export interface Monitor {
  workspaces: Workspace[];
  active: number;
  /** Id of the workspace shown before the current one. */
  previous: number | null;
}

export interface OutputEnv {
  name: string;
  x: number;
  width: number;
  height: number;
  workArea: Rectangle;
}

export interface WindowEnv {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
  parent: number | null;
  appId: string;
  title: string;
}

/** What the compositor reports that layout depends on. */
export interface Env {
  /** Left to right. */
  outputs: OutputEnv[];
  windows: Record<number, WindowEnv>;
}

const noLimits: WindowEnv = {
  width: 0, height: 0, minWidth: 0, minHeight: 0, maxWidth: 0, maxHeight: 0,
  parent: null, appId: "", title: "",
};

export function windowEnv(env: Env, window: number): WindowEnv {
  return env.windows[window] ?? noLimits;
}

export function hasFixedHeight(window: WindowEnv): boolean {
  return window.minHeight > 0 && window.minHeight === window.maxHeight;
}

export function resolveWidth(width: Width, area: Rectangle): number {
  return "proportion" in width ? (area.width - gaps) * width.proportion - gaps : width.fixed;
}

/** The width COLUMN's windows are given on OUTPUT, within their size limits. */
export function columnWidth(column: Column, output: OutputEnv, env: Env): number {
  if (column.sizing === "fullscreen") return output.width;
  if (column.sizing === "maximized") return output.workArea.width;
  let width = resolveWidth(column.fullWidth ? { proportion: 1 } : column.width, output.workArea);
  let least = 1;
  let most = Infinity;
  for (const tile of column.tiles) {
    const limits = windowEnv(env, tile.window);
    least = Math.max(least, limits.minWidth);
    if (limits.maxWidth > 0) most = Math.min(most, limits.maxWidth);
  }
  width = Math.max(Math.min(width, most), least);
  return Math.floor(width);
}

/** Where COLUMN's first tile starts. */
export function tileOrigin(column: Column, output: OutputEnv): number {
  if (column.sizing === "fullscreen") return 0;
  if (column.sizing === "maximized") return output.workArea.y;
  return output.workArea.y + gaps;
}

function requestedHeight(height: Height, area: Rectangle): number | null {
  if ("fixed" in height) return height.fixed;
  if ("preset" in height) return (area.height - gaps) * presetHeights[height.preset]! - gaps;
  return null;
}

/**
 * The height of each of COLUMN's tiles. Fixed and preset heights come first,
 * leaving room for the others' minimums; auto tiles share the rest by weight,
 * any too small for its window taking its minimum instead.
 */
export function tileHeights(column: Column, output: OutputEnv, env: Env): number[] {
  if (column.sizing === "fullscreen") return column.tiles.map(() => output.height);
  if (column.sizing === "maximized") return column.tiles.map(() => output.workArea.height);
  const area = output.workArea;
  const count = column.tiles.length;
  const tallest = Math.max(1, area.height - 2 * gaps);
  const limits = column.tiles.map((tile) => windowEnv(env, tile.window));
  if (column.tabbed) {
    const chosen = column.tiles.map((tile) => requestedHeight(tile.height, area)).find((h) => h !== null);
    const least = Math.max(1, ...limits.map((limit) => limit.minHeight));
    const height = Math.min(Math.max(chosen ?? tallest, least), tallest);
    return column.tiles.map(() => Math.round(height));
  }
  const heights: (number | null)[] = column.tiles.map(() => null);
  let left = area.height - gaps * (count + 1);
  column.tiles.forEach((tile, index) => {
    const limit = limits[index]!;
    let height = hasFixedHeight(limit) ? limit.minHeight : requestedHeight(tile.height, area);
    if (height === null) return;
    if (!hasFixedHeight(limit)) {
      const others = limits.reduce((sum, other, j) =>
        j === index ? sum : sum + Math.max(1, other.minHeight) + gaps, 0);
      height = Math.min(height, tallest - others);
      height = Math.max(Math.min(height, limit.maxHeight > 0 ? limit.maxHeight : Infinity), limit.minHeight);
    }
    heights[index] = Math.max(1, Math.round(height));
    left -= heights[index]!;
  });
  const weightOf = (index: number) => {
    const height = column.tiles[index]!.height;
    return "auto" in height ? height.auto : 1;
  };
  let weight = 0;
  heights.forEach((height, index) => { if (height === null) weight += weightOf(index); });
  // Tiles whose share is below their minimum take the minimum, and the rest share again.
  for (let again = true; again;) {
    again = false;
    for (let index = 0; index < count; index++) {
      if (heights[index] !== null) continue;
      const share = left * weightOf(index) / weight;
      if (limits[index]!.minHeight > share) {
        heights[index] = limits[index]!.minHeight;
        left -= heights[index]!;
        weight -= weightOf(index);
        again = true;
        break;
      }
    }
  }
  const autos = heights.flatMap((height, index) => (height === null ? [index] : []));
  autos.forEach((index, order) => {
    const share = order === autos.length - 1 ? left : Math.round(left * weightOf(index) / weight);
    heights[index] = Math.max(1, Math.round(share));
    left -= heights[index]!;
    weight -= weightOf(index);
  });
  return heights as number[];
}

export interface Strip {
  /** Each column's x, and one past the last. */
  xs: number[];
  widths: number[];
}

export function strip(workspace: Workspace, output: OutputEnv, env: Env): Strip {
  const widths = workspace.columns.map((column) => columnWidth(column, output, env));
  const xs = [workspace.shift];
  for (const width of widths) xs.push(xs[xs.length - 1]! + width + gaps);
  return { xs, widths };
}

/**
 * niri's view fit: where the area starting at CURRENT (strip position of its
 * left edge, VIEW wide) should start, relative to the column at X, WIDTH wide,
 * to show it with up to PAD of margin. A column already in full view keeps the
 * view where it is; otherwise the view moves the least it can.
 */
export function fitOffset(current: number, view: number, x: number, width: number, pad: number): number {
  if (view <= width) return 0;
  const margin = Math.min(Math.max((view - width) / 2, 0), pad);
  const left = x - margin;
  const right = x + width + margin;
  if (current <= left && right <= current + view) return current - x;
  const toLeft = Math.abs(current - left);
  const toRight = Math.abs(current + view - right);
  return toLeft <= toRight ? -margin : -(view - margin - width);
}

/** The view that shows column INDEX, moving the least from FROM. */
export function fitView(workspace: Workspace, index: number, output: OutputEnv, env: Env,
                        from = workspace.view): number {
  const column = workspace.columns[index];
  if (!column) return from;
  const { xs, widths } = strip(workspace, output, env);
  const x = xs[index]!;
  if (column.sizing === "fullscreen") return x;
  const area = output.workArea;
  const pad = column.sizing === "maximized" ? 0 : gaps;
  return x + fitOffset(from + area.x, area.width, x, widths[index]!, pad) - area.x;
}

/** The view with column INDEX centered in the work area, if it fits. */
export function centerView(workspace: Workspace, index: number, output: OutputEnv, env: Env): number {
  const column = workspace.columns[index];
  if (!column) return workspace.view;
  const { xs, widths } = strip(workspace, output, env);
  const area = output.workArea;
  if (column.sizing === "fullscreen" || area.width <= widths[index]!) {
    return fitView(workspace, index, output, env);
  }
  return xs[index]! - (area.width - widths[index]!) / 2 - area.x;
}

/** Columns wholly in view, with the leftmost's x and the width they and their gaps take. */
export function visibleColumns(workspace: Workspace, output: OutputEnv, env: Env) {
  const { xs, widths } = strip(workspace, output, env);
  const area = output.workArea;
  const indices: number[] = [];
  let leftmost: number | null = null;
  let taken = 0;
  for (let index = 0; index < widths.length; index++) {
    const x = xs[index]!;
    const width = widths[index]!;
    if (x < workspace.view + area.x + gaps) continue;
    if (workspace.view + area.x + area.width < x + width + gaps) break;
    leftmost ??= x;
    taken += width + gaps;
    indices.push(index);
  }
  return { indices, leftmost, taken };
}

/** The window a workspace focuses: its top floating window while that layer is active. */
export function workspaceFocus(workspace: Workspace): number | null {
  const column = workspace.columns[workspace.active];
  const top = workspace.floating[workspace.floating.length - 1];
  if (top && (workspace.floatingActive || !column)) return top.window;
  return column ? column.tiles[column.active]!.window : null;
}

export function isEmpty(workspace: Workspace): boolean {
  return workspace.columns.length === 0 && workspace.floating.length === 0;
}

export interface PlacedTile {
  window: number;
  column: number;
  /** Strip x, and output y. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** A background tab, faded out. */
  hidden: boolean;
}

/** Every tile's box on the strip. */
export function placeTiles(workspace: Workspace, output: OutputEnv, env: Env): PlacedTile[] {
  const { xs, widths } = strip(workspace, output, env);
  const placed: PlacedTile[] = [];
  workspace.columns.forEach((column, index) => {
    const heights = tileHeights(column, output, env);
    let y = tileOrigin(column, output);
    column.tiles.forEach((tile, row) => {
      placed.push({
        window: tile.window, column: index, x: xs[index]!, y, width: widths[index]!,
        height: heights[row]!, hidden: column.tabbed && row !== column.active,
      });
      if (!column.tabbed) y += heights[row]! + gaps;
    });
  });
  return placed;
}

/** A floating window's box: its own size until it is given one. */
export function floaterBox(floater: Floater, env: Env): Rectangle {
  const window = windowEnv(env, floater.window);
  return {
    x: floater.x,
    y: floater.y,
    width: floater.width ?? window.width,
    height: floater.height ?? window.height,
  };
}

/** Where a window dropped at (X, Y) on the workspace's output joins its layout. */
export type DropTarget = { kind: "column"; index: number } | { kind: "tile"; column: number; index: number };

/** Tops of each tile of COLUMN, and one past the last, in output pixels. */
function tileTops(column: Column, output: OutputEnv, env: Env): number[] {
  const heights = tileHeights(column, output, env);
  const origin = tileOrigin(column, output);
  if (column.tabbed) return [origin, origin + heights[column.active]! + gaps];
  const tops = [origin];
  for (const height of heights) tops.push(tops[tops.length - 1]! + height + gaps);
  return tops;
}

function closest(values: readonly number[], to: number): number {
  let best = 0;
  values.forEach((value, index) => {
    if (Math.abs(value - to) < Math.abs(values[best]! - to)) best = index;
  });
  return best;
}

/**
 * niri's insert position: the gap nearest the pointer, between columns or
 * between the tiles of the column under it, aiming for the gaps' centers.
 */
export function dropTarget(workspace: Workspace, output: OutputEnv, env: Env, x: number, y: number): DropTarget {
  if (!workspace.columns.length) return { kind: "column", index: 0 };
  const { xs } = strip(workspace, output, env);
  const stripX = x + workspace.view + gaps / 2;
  const stripY = y + gaps / 2;
  if (stripX < xs[0]!) return { kind: "column", index: 0 };
  const nearest = closest(xs, stripX);
  const under = xs.findLastIndex((edge) => edge <= stripX);
  const column = workspace.columns[under];
  if (!column) return { kind: "column", index: nearest };
  const tops = tileTops(column, output, env);
  const tile = closest(tops, stripY);
  if (Math.abs(xs[nearest]! - stripX) <= Math.abs(tops[tile]! - stripY)) return { kind: "column", index: nearest };
  const index = column.tabbed ? column.active + tile : tile;
  return { kind: "tile", column: under, index };
}

/** The insert hint for TARGET, in strip coordinates. */
export function hintBox(workspace: Workspace, output: OutputEnv, env: Env, target: DropTarget): Rectangle {
  const area = output.workArea;
  const { xs, widths } = strip(workspace, output, env);
  const count = workspace.columns.length;
  if (target.kind === "column") {
    const height = area.height - 2 * gaps;
    const y = area.y + gaps;
    let x: number;
    if (!count) x = workspace.view + area.x + gaps;
    else if (target.index === 0) x = xs[0]! - 300 - gaps;
    else if (target.index >= count) x = xs[count]!;
    else x = xs[target.index]! - 150 - gaps / 2;
    // At least half of a hint at either end stays in view.
    x = Math.min(Math.max(x, workspace.view - 150), workspace.view + output.width - 150);
    return { x, y, width: 300, height };
  }
  const column = workspace.columns[target.column]!;
  const tops = tileTops(column, output, env);
  const width = widths[target.column]!;
  const x = xs[target.column]!;
  if (column.tabbed) {
    const atTop = target.index <= column.active;
    return { x, y: atTop ? tops[0]! : tops[1]! - gaps - 150, width, height: 150 };
  }
  if (target.index === 0) return { x, y: tops[0]!, width, height: 150 };
  if (target.index >= column.tiles.length) {
    return { x, y: tops[column.tiles.length]! - gaps - 150, width, height: 150 };
  }
  return { x, y: tops[target.index]! - gaps / 2 - 150, width, height: 300 };
}

/**
 * Where a view gesture released at CURRENT, heading for TARGET, comes to rest:
 * the column edge nearest the target, never beyond the first or last column,
 * focusing the furthest column wholly in view in the gesture's direction.
 */
export function snapView(workspace: Workspace, output: OutputEnv, env: Env, current: number,
                         target: number): { view: number; active: number } {
  const count = workspace.columns.length;
  if (!count) return { view: current, active: 0 };
  const { xs, widths } = strip(workspace, output, env);
  const area = output.workArea;
  const leftStrut = area.x;
  const rightStrut = output.width - area.width - area.x;
  const padding = (index: number) => workspace.columns[index]!.sizing === "maximized"
    ? 0 : Math.min(Math.max((area.width - widths[index]!) / 2, 0), gaps);
  const edges = (index: number): [number, number] => {
    const x = xs[index]!;
    const width = widths[index]!;
    if (workspace.columns[index]!.sizing === "fullscreen") return [x, x + width];
    return [x - padding(index) - leftStrut, x + width + padding(index) + rightStrut];
  };
  const leftmost = edges(0)[0];
  const rightmost = edges(count - 1)[1] - output.width;
  const snaps = [{ view: leftmost, column: 0 }, { view: rightmost, column: count - 1 }];
  for (let index = 0; index < count; index++) {
    const [left, right] = edges(index);
    for (const view of [left, right - output.width]) {
      if (leftmost < view && view < rightmost) snaps.push({ view, column: index });
    }
  }
  snaps.sort((a, b) => a.view - b.view);
  let snap = snaps[0]!;
  for (const candidate of snaps) {
    if (Math.abs(candidate.view - target) < Math.abs(snap.view - target)) snap = candidate;
  }
  let active = snap.column;
  const inView = (index: number) => {
    const x = xs[index]!;
    const width = widths[index]!;
    if (workspace.columns[index]!.sizing === "fullscreen") {
      return x >= snap.view && x + width <= snap.view + output.width;
    }
    return x - padding(index) >= snap.view + leftStrut
      && x + width + padding(index) <= snap.view + leftStrut + area.width;
  };
  if (target >= current) {
    while (active + 1 < count && inView(active + 1)) active += 1;
  } else {
    while (active > 0 && inView(active - 1)) active -= 1;
  }
  // A snap that does not fit the newly focused column, as one wider than the view, gives way to a fit.
  const fitted = fitView({ ...workspace, active }, active, output, env, snap.view);
  return { view: Math.abs(fitted - snap.view) < 1 ? snap.view : fitted, active };
}
