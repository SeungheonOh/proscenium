import { dwindle, masterStack, type OutputInfo, type Rectangle } from "proscenium";
import type { HyprState } from "./state.js";

export const workspaceNumbers = [1, 2, 3, 4, 5, 6, 7, 8, 9];

const gaps = { gap: 10, outer: 18 };

/** A window's box in its output's logical pixels, and that output. */
export type PlacedBox = Rectangle & { output: OutputInfo };

/** The workspace an output shows. */
export function shownWorkspace(
  state: HyprState,
  outputs: readonly OutputInfo[],
  output: OutputInfo,
): number {
  return state.shown[output.name] ?? outputs.indexOf(output) + 1;
}

/** The windows that tile or float on a workspace, in order. */
export function workspaceWindows(
  state: HyprState,
  workspace: number,
  present: ReadonlySet<number>,
): number[] {
  return state.order.filter(
    (id) =>
      present.has(id) &&
      state.workspaces[id] === workspace &&
      !state.scratchpad.includes(id) &&
      id !== state.fullscreen,
  );
}

/** Boxes for the windows on every shown workspace. */
export function placeWindows(
  state: HyprState,
  outputs: readonly OutputInfo[],
  present: ReadonlySet<number>,
): Map<number, PlacedBox> {
  const boxes = new Map<number, PlacedBox>();
  for (const output of outputs) {
    const workspace = shownWorkspace(state, outputs, output);
    const windows = workspaceWindows(state, workspace, present);
    const layout = state.layouts[workspace] === "master" ? masterStack : dwindle;
    const tiled = windows.filter((id) => !state.floating[id]);

    for (const { key, ...box } of layout(tiled, output.workArea, gaps)) {
      boxes.set(key, { ...box, output });
    }
    for (const id of windows) {
      const box = state.floating[id];
      if (box) boxes.set(id, { ...box, output });
    }
  }
  return boxes;
}

/** Boxes in desktop coordinates, so directions work across outputs. */
export function onDesktop(boxes: ReadonlyMap<number, PlacedBox>): Map<number, Rectangle> {
  return new Map(
    [...boxes].map(([id, { output, ...box }]) => [id, { ...box, x: box.x + output.x }]),
  );
}
