/**
 * A Hyprland room's tiles with splits of its own: Hyprland's dwindle and master
 * layouts, as `proscenium`'s are, but each dwindle split keeps the ratio a resize
 * left it at, and the master area the width, so a tile resized by its edge stays
 * that size and its neighbours give way.
 */

import { inset, masterStack, type Rectangle } from "proscenium";
import type { HyprState } from "../hypr/state.js";
import { workspaceWindows } from "../hypr/tiling.js";
import { hyprWorkspace } from "../meta/worlds.js";

/** Hyprland's gaps, as the hypr world's. */
const gaps = { gap: 10, outer: 18 };
const fallbackRatio = 0.5;
const masterRatio = 0.55;

/** What a room's resizes have set: each dwindle split's share by the window that opens it, and the master area's. */
export interface Splits {
  dwindle: Record<number, number>;
  master?: number;
}

export const noSplits: Splits = { dwindle: {} };

interface Split {
  /** The window that takes the first part. */
  key: number;
  /** The space split. */
  rest: Rectangle;
  vertical: boolean;
}

function divide(area: Rectangle, ratio: number, vertical: boolean): [Rectangle, Rectangle] {
  const { gap } = gaps;
  if (vertical) {
    const first = Math.max(0, (area.height - gap) * ratio);
    return [{ ...area, height: first }, { ...area, y: area.y + first + gap, height: Math.max(0, area.height - first - gap) }];
  }
  const first = Math.max(0, (area.width - gap) * ratio);
  return [{ ...area, width: first }, { ...area, x: area.x + first + gap, width: Math.max(0, area.width - first - gap) }];
}

/** Dwindle over KEYS in AREA, each split at its own ratio; and the splits, in order. */
function dwindle(keys: readonly number[], area: Rectangle, splits: Splits) {
  const boxes = new Map<number, Rectangle>();
  const made: Split[] = [];
  let rest = inset(area, gaps.outer);
  keys.forEach((key, index) => {
    if (index === keys.length - 1) {
      boxes.set(key, rest);
      return;
    }
    const vertical = rest.height > rest.width;
    made.push({ key, rest, vertical });
    const [first, remaining] = divide(rest, splits.dwindle[key] ?? fallbackRatio, vertical);
    boxes.set(key, first);
    rest = remaining;
  });
  return { boxes, made };
}

/** The tiled and floating windows of a hypr room's world, in the room's coordinates. */
export function hyprRoomBoxes(state: HyprState, area: Rectangle, members: ReadonlySet<number>,
                              splits: Splits): Map<number, Rectangle> {
  const windows = workspaceWindows(state, hyprWorkspace, members);
  const tiled = windows.filter((id) => !state.floating[id]);
  const boxes = state.layouts[hyprWorkspace] === "master"
    ? new Map(masterStack(tiled, area, { ...gaps, ratio: splits.master ?? masterRatio }).map(({ key, ...box }) => [key, box]))
    : dwindle(tiled, area, splits).boxes;
  for (const id of windows) {
    const box = state.floating[id];
    if (box) boxes.set(id, box);
  }
  return boxes;
}

const clamp = (ratio: number) => Math.min(0.9, Math.max(0.1, ratio));

/**
 * The splits after WINDOW, tiled, is resized to SIZE: the nearest split along the axis that changed
 * most moves by as much, so its edge follows. Unchanged when nothing on that axis borders it.
 */
export function resizedSplits(state: HyprState, area: Rectangle, members: ReadonlySet<number>, splits: Splits,
                              window: number, size: { width: number; height: number }): Splits {
  const tiled = workspaceWindows(state, hyprWorkspace, members).filter((id) => !state.floating[id]);
  const at = tiled.indexOf(window);
  if (at < 0 || tiled.length < 2) return splits;
  if (state.layouts[hyprWorkspace] === "master") {
    // Only the width between master and stack moves.
    const inner = inset(area, gaps.outer);
    const span = inner.width - gaps.gap;
    if (span <= 0) return splits;
    return { ...splits, master: clamp(at === 0 ? size.width / span : 1 - size.width / span) };
  }
  const { boxes, made } = dwindle(tiled, area, splits);
  const now = boxes.get(window)!;
  const dWidth = size.width - now.width;
  const dHeight = size.height - now.height;
  const vertical = Math.abs(dHeight) > Math.abs(dWidth);
  const delta = vertical ? dHeight : dWidth;
  if (Math.abs(delta) < 1) return splits;
  // Its own split first, if it opens one; then up the splits whose remaining part holds it.
  for (let index = Math.min(at, made.length - 1); index >= 0; index--) {
    const split = made[index]!;
    if (split.vertical !== vertical) continue;
    const span = (vertical ? split.rest.height : split.rest.width) - gaps.gap;
    if (span <= 0) return splits;
    const ratio = splits.dwindle[split.key] ?? fallbackRatio;
    const first = ratio * span + (index === at ? delta : -delta);
    return { ...splits, dwindle: { ...splits.dwindle, [split.key]: clamp(first / span) } };
  }
  return splits;
}
