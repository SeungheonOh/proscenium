/**
 * Where windows go, as Warlock's desktop places them: the windows of a page
 * side by side in equal columns, a floating window where it was left, and
 * halves, quarters and the whole of the page's work area for snapped and
 * maximized ones. Rectangles are window frames, title bar included, on the
 * canvas of the workspace: its output's pixels while the view is at home, the
 * other pages lying a screen apart all around.
 */

import type { OutputInfo, Rectangle } from "proscenium";
import {
  homePage,
  type Page,
  type SnapRegion,
  type WarlockState,
  type WindowRecord,
} from "./state.js";

/** Between tiled windows, and between them and the work area's edges. */
export const tileGap = 14;
/** Around and between snapped and maximized windows. */
export const snapGap = 10;
/** How near an edge a dragged window must be let go of to snap, and how near a corner for a quarter. */
export const edgeReach = 6;
export const cornerReach = 80;
/** The smallest frame a resize or a placement leaves. */
export const minimumSize = { width: 160, height: 100 };

/** The workspace an output shows. */
export function shownWorkspace(
  state: WarlockState,
  outputs: readonly OutputInfo[],
  output: OutputInfo,
): number {
  return state.shown[output.name] ?? outputs.indexOf(output) + 1;
}

/** The output showing WORKSPACE, if one does. */
export function outputShowing(
  state: WarlockState,
  outputs: readonly OutputInfo[],
  workspace: number,
): OutputInfo | undefined {
  return outputs.find((output) => shownWorkspace(state, outputs, output) === workspace);
}

/** The page a window tiles, snaps and maximizes on. */
export function pageOf(record: WindowRecord | undefined): Page {
  return record?.page ?? homePage;
}

/** The page of an output's canvas that the point (X, Y) lies on. */
export function pageAt(output: OutputInfo, x: number, y: number): Page {
  return [Math.floor(x / output.width), Math.floor(y / output.height)];
}

/** The whole of PAGE on an output's canvas: a screen's worth. */
export function pageRect(output: OutputInfo, [column, row]: Page): Rectangle {
  return {
    x: column * output.width,
    y: row * output.height,
    width: output.width,
    height: output.height,
  };
}

/** The work area of PAGE: what the taskbar leaves of it with the view on that page. */
export function pageArea(output: OutputInfo, [column, row]: Page): Rectangle {
  const area = output.workArea;
  return { ...area, x: area.x + column * output.width, y: area.y + row * output.height };
}

/** The frame of a snapped window, or of a maximized one without a region. */
export function regionRect(area: Rectangle, region: SnapRegion | null): Rectangle {
  const gap = snapGap;
  const halfWidth = Math.floor((area.width - 3 * gap) / 2);
  const halfHeight = Math.floor((area.height - 3 * gap) / 2);
  const left = area.x + gap;
  const top = area.y + gap;
  const right = left + halfWidth + gap;
  const bottom = top + halfHeight + gap;
  const restWidth = area.width - 3 * gap - halfWidth;
  const restHeight = area.height - 3 * gap - halfHeight;
  const fullHeight = area.height - 2 * gap;
  switch (region) {
    case null:
      return { x: left, y: top, width: area.width - 2 * gap, height: fullHeight };
    case "left":
      return { x: left, y: top, width: halfWidth, height: fullHeight };
    case "right":
      return { x: right, y: top, width: restWidth, height: fullHeight };
    case "top-left":
      return { x: left, y: top, width: halfWidth, height: halfHeight };
    case "top-right":
      return { x: right, y: top, width: restWidth, height: halfHeight };
    case "bottom-left":
      return { x: left, y: bottom, width: halfWidth, height: restHeight };
    case "bottom-right":
      return { x: right, y: bottom, width: restWidth, height: restHeight };
  }
}

/** Where a new or returning floating window goes when it has no place yet. */
export function defaultFloat(area: Rectangle, index: number): Rectangle {
  const step = 24 * (index % 5);
  return {
    x: area.x + 16 + step,
    y: area.y + 16 + step,
    width: Math.max(minimumSize.width, Math.floor(0.65 * area.width) - 32),
    height: Math.max(minimumSize.height, Math.floor(0.75 * area.height) - 32),
  };
}

/**
 * What letting go of a dragged window at (X, Y) on an output does: a half or a
 * quarter at the left and right edges, the whole work area at the top.
 */
export function dropZone(output: OutputInfo, x: number, y: number): SnapRegion | "maximize" | null {
  const atLeft = x <= edgeReach;
  const atRight = x >= output.width - 1 - edgeReach;
  const nearTop = y <= output.workArea.y + cornerReach;
  const nearBottom = y >= output.height - cornerReach;
  if (atLeft || atRight) {
    const side = atLeft ? "left" : "right";
    if (nearTop) return `top-${side}`;
    if (nearBottom) return `bottom-${side}`;
    return side;
  }
  return y <= output.workArea.y + edgeReach ? "maximize" : null;
}

export interface Placed {
  id: number;
  rect: Rectangle;
  output: OutputInfo;
  record: WindowRecord;
}

/** Whether a window shows on WORKSPACE: there and not minimized, or always on top. */
function showsOn(record: WindowRecord, workspace: number, outputIndex: number): boolean {
  if (record.minimized) return false;
  // An always-on-top window shows on every workspace, on the first output.
  return record.onTop
    ? outputIndex === 0 || record.workspace === workspace
    : record.workspace === workspace;
}

/**
 * The frame of every root window an output shows, on the canvas of the
 * workspace it shows; a fullscreen window's is the screen itself.
 */
export function placeWindows(
  state: WarlockState,
  outputs: readonly OutputInfo[],
  roots: readonly number[],
): Map<number, Placed> {
  const placed = new Map<number, Placed>();
  outputs.forEach((output, outputIndex) => {
    const workspace = shownWorkspace(state, outputs, output);
    const here = roots.filter((id) => {
      const record = state.windows[id];
      return record !== undefined && !placed.has(id) && showsOn(record, workspace, outputIndex);
    });
    // The tiled windows of each page share its columns.
    const tiled = new Map<string, number[]>();
    for (const id of here) {
      const record = state.windows[id]!;
      if (record.placement !== "tiled") continue;
      const key = pageOf(record).join();
      const columns = tiled.get(key);
      if (columns) columns.push(id);
      else tiled.set(key, [id]);
    }
    let floating = 0;
    for (const id of here) {
      const record = state.windows[id]!;
      const area = pageArea(output, pageOf(record));
      let rect: Rectangle;
      if (record.fullscreen) rect = { x: 0, y: 0, width: output.width, height: output.height };
      else if (record.placement === "tiled") {
        const columns = tiled.get(pageOf(record).join())!;
        const width = (area.width - tileGap * (columns.length + 1)) / columns.length;
        rect = {
          x: Math.round(area.x + tileGap + columns.indexOf(id) * (width + tileGap)),
          y: area.y + tileGap,
          width: Math.round(width),
          height: area.height - 2 * tileGap,
        };
      } else if (record.placement === "floating")
        rect = record.rect ?? defaultFloat(area, floating++);
      else rect = regionRect(area, record.placement === "snapped" ? record.region : null);
      placed.set(id, { id, rect, output, record });
    }
  });
  return placed;
}

/**
 * Windows from the bottom up: always-on-top ones above the rest, the focused
 * one above its kind, then by how lately each was used.
 */
export function stackingOrder(
  state: WarlockState,
  windows: readonly number[],
  focused: number | null,
): number[] {
  const rank = (id: number): number => {
    const record = state.windows[id];
    const used = state.history.indexOf(id);
    const recency = id === focused ? 10000 : used >= 0 ? 1000 - Math.min(used, 999) : 0;
    return (record?.fullscreen ? 40000 : 0) + (record?.onTop ? 20000 : 0) + recency;
  };
  return [...windows].sort((a, b) => rank(a) - rank(b) || a - b);
}
