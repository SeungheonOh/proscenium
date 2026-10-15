/**
 * Moving the view: framing a part of the arrangement, stepping out and in a
 * level, along to a neighbour, and settling after a zoom or pan the compositor
 * ran by itself.
 */

import { bestFit, neighbour, panelHolding, sameTarget, stepIn, stepOut, type Target } from "./model.js";
import type { Scene } from "./scene.js";
import type { TrellisAction, TrellisState } from "./state.js";

/** The node a window is framed by: its docked panel, or the Desktop it floats on. */
export function findPanel(state: TrellisState, window: number): string | null {
  const docked = panelHolding(state.root, window);
  if (docked) return docked.id;
  return state.floating.some((float) => float.panel.windows.includes(window)) ? "desktop" : null;
}

/** Frame TARGET; already framed, step back to where the view was. */
export function frameToggle(state: TrellisState, target: Target): TrellisAction {
  return sameTarget(state.framed, target) && state.at > 0 ? { type: "back" } : { type: "frame", target };
}

/** Everything in view; from everything, back to where the view was. */
export function showEverything(state: TrellisState): TrellisAction {
  return frameToggle(state, { node: state.root.id });
}

export function stepOutOf(state: TrellisState): TrellisAction {
  return { type: "frame", target: stepOut(state.root, state.framed) };
}

/** A level in, toward the screen point (X, Y). */
export function stepInto(state: TrellisState, scene: Scene, x: number, y: number): TrellisAction {
  const point = scene.map.point(x, y);
  return { type: "frame", target: stepIn(state.root, scene.boxes, state.framed, point.x, point.y) };
}

/** The neighbouring space, BY places along; at the end of a level, its parent's neighbour. */
export function moveAlong(state: TrellisState, by: number): TrellisAction | null {
  let target: Target | null = state.framed;
  while (target) {
    const next = neighbour(state.root, target, by);
    if (next) return { type: "frame", target: next };
    const out = stepOut(state.root, target);
    if (sameTarget(out, target)) return null;
    target = out;
  }
  return null;
}

/** WINDOW framed on its own, or the view back if it already is. */
export function frameWindow(state: TrellisState, window: number | null): TrellisAction | null {
  if (window === null) return null;
  const panel = findPanel(state, window);
  return panel ? frameToggle(state, { node: panel }) : null;
}

/**
 * The target that best fits what the camera shows after the compositor zoomed
 * or panned it: CAMERA's view of the work area, mapped back into the arrangement.
 */
export function settleCamera(
  state: TrellisState,
  scene: Scene,
  camera: { x: number; y: number; zoom: number },
  output: { width: number; height: number },
): TrellisAction {
  const toWorld = (x: number, y: number) => ({
    x: camera.x + (x - output.width / 2) / camera.zoom,
    y: camera.y + (y - output.height / 2) / camera.zoom,
  });
  const a = toWorld(scene.screen.x, scene.screen.y);
  const b = toWorld(scene.screen.x + scene.screen.width, scene.screen.y + scene.screen.height);
  const from = scene.map.point(a.x, a.y);
  const to = scene.map.point(b.x, b.y);
  const view = { x: from.x, y: from.y, width: to.x - from.x, height: to.y - from.y };
  return { type: "frame", target: bestFit(state.root, scene.boxes, view) };
}
