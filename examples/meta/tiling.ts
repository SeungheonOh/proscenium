import { dwindle, masterStack, type OutputInfo, type Rectangle } from "proscenium";
import type { Size } from "./geometry.js";
import type { MetaState } from "./state.js";

const gaps = { gap: 10, outer: 18 };

/** Where windows tile in a room: all of it but what the main output reserves, e.g. for the bar. */
export function tilingArea(size: Size, output: OutputInfo | undefined): Rectangle {
  return output?.workArea ?? { x: 0, y: 0, ...size };
}

/** The windows that tile or float in a room, in order. */
export function roomWindows(
  state: MetaState,
  room: number,
  present: ReadonlySet<number>,
): number[] {
  return state.order.filter(
    (id) => present.has(id) && state.roomOf[id] === room && id !== state.fullscreen,
  );
}

/** Boxes for every window, in its room's coordinates. */
export function placeWindows(
  state: MetaState,
  present: ReadonlySet<number>,
  area: Rectangle,
): Map<number, Rectangle> {
  const boxes = new Map<number, Rectangle>();
  for (const { id: room } of state.rooms) {
    const windows = roomWindows(state, room, present);
    const layout = state.layouts[room] === "master" ? masterStack : dwindle;
    const tiled = windows.filter((id) => !state.floating[id]);
    for (const { key, ...box } of layout(tiled, area, gaps)) boxes.set(key, box);
    for (const id of windows) {
      const box = state.floating[id];
      if (box) boxes.set(id, box);
    }
  }
  return boxes;
}
