/**
 * What a room can be: a Hyprland-style tiler, a niri strip of columns or a deck
 * of cards. Each runs that world's own reducer and layout on the room, as if
 * the room were its only output and the room's windows the only ones, keeping
 * that world's state as the room's.
 */

import type { OutputInfo, Rectangle } from "proscenium";
import { cardOf } from "../deck/DeckProvider.js";
import { hyprReducer, initialHyprState, type HyprAction, type HyprState } from "../hypr/state.js";
import { placeWindows, workspaceWindows } from "../hypr/tiling.js";
import { handReducer, initialHandState, type HandAction, type HandState } from "../lib/hand.js";
import { floaterBox, placeTiles, type Env } from "../niri/model.js";
import {
  allWindows,
  focusedWindow,
  initialNiriState,
  niriReducer,
  normalizeState,
  type EnvAction,
  type NiriAction,
  type NiriState,
} from "../niri/state.js";
import type { Size } from "./geometry.js";

export const kinds = ["hypr", "niri", "deck"] as const;
export type Kind = (typeof kinds)[number];

export type World =
  | { kind: "hypr"; state: HyprState }
  | { kind: "niri"; state: NiriState }
  | { kind: "deck"; state: HandState };

export type WorldAction =
  | { kind: "hypr"; action: HyprAction }
  | { kind: "niri"; action: NiriAction }
  | { kind: "deck"; action: HandAction };

/** A room as its world sees it: its only output, and every window's size limits. */
export interface RoomEnv extends Env {
  room: OutputInfo;
}

/** The output a room is to its world. */
export const roomOutput = "room";
/** The one workspace of a hypr room. */
export const hyprWorkspace = 1;

/** A room of SIZE as an output, windows tiling in AREA. */
export function roomInfo(size: Size, area: Rectangle): OutputInfo {
  return { name: roomOutput, x: 0, ...size, scale: 1, workArea: area };
}

export function emptyWorld(kind: Kind): World {
  switch (kind) {
    case "hypr":
      return { kind, state: initialHyprState };
    case "niri":
      return { kind, state: initialNiriState };
    case "deck":
      return { kind, state: initialHandState };
  }
}

/** The kind after KIND, round again after the last. */
export function nextKind(kind: Kind): Kind {
  return kinds[(kinds.indexOf(kind) + 1) % kinds.length]!;
}

/** WORLD as saved by any version, or a fresh hypr world without one. */
export function normalizeWorld(world: World | undefined): World {
  if (!world || !kinds.includes(world.kind)) return emptyWorld("hypr");
  if (world.kind === "niri" && !world.state?.monitors) return { kind: "niri", state: normalizeState(world.state) };
  return world;
}

/** The windows among WINDOWS that are cards: the deck deals dialogs onto their windows' cards. */
function cards(windows: readonly number[], env: Env): number[] {
  const parents = new Map(windows.map((id) => [id, { parent: env.windows[id]?.parent ?? null }]));
  return windows.filter((id) => cardOf(parents, id) === id);
}

/** The windows WORLD arranges itself, in its order: for a deck, its cards, most recently played first. */
export function arranged(world: World): number[] {
  switch (world.kind) {
    case "hypr":
      return world.state.order;
    case "niri":
      return allWindows(world.state);
    case "deck":
      return world.state.recent;
  }
}

/**
 * WORLD arranging WINDOWS, the room's, of compositor INSTANCE: new ones join
 * it as they would its own world, and gone ones leave. The same world while
 * nothing changed.
 */
export function syncWorld(world: World, windows: readonly number[], instance: string,
                          env: RoomEnv): World {
  const members = world.kind === "deck" ? cards(windows, env) : windows;
  const known = new Set(arranged(world));
  const inStep = world.state.instance === instance && known.size === members.length &&
    members.every((id) => known.has(id));
  if (inStep) return world;
  switch (world.kind) {
    case "hypr": {
      const action = { type: "sync", windows, workspace: hyprWorkspace, instance } as const;
      return { kind: "hypr", state: hyprReducer(world.state, action) };
    }
    case "niri":
      return { kind: "niri", state: niriReducer(world.state, { type: "sync", windows, instance, env }) };
    case "deck":
      return { kind: "deck", state: handReducer(world.state, { type: "sync", windows: members, instance }) };
  }
}

/** WORLD after ACTION, if ACTION is for its kind. */
export function reduceWorld(world: World, action: WorldAction, env: RoomEnv): World {
  if (world.kind === "hypr" && action.kind === "hypr")
    return { kind: "hypr", state: hyprReducer(world.state, action.action) };
  if (world.kind === "niri" && action.kind === "niri")
    return { kind: "niri", state: niriReducer(world.state, { ...action.action, env } as EnvAction) };
  if (world.kind === "deck" && action.kind === "deck")
    return { kind: "deck", state: handReducer(world.state, action.action) };
  return world;
}

/**
 * The window WORLD gives the keyboard, of WINDOWS, the room's: hypr's first or
 * fullscreen one, niri's focused one, or the deck's window in play, or its
 * newest dialog while it has one.
 */
export function worldFocus(world: World, windows: readonly number[], env: Env): number | null {
  switch (world.kind) {
    case "hypr": {
      const { fullscreen } = world.state;
      if (fullscreen !== null && windows.includes(fullscreen)) return fullscreen;
      return workspaceWindows(world.state, hyprWorkspace, new Set(windows))[0] ?? null;
    }
    case "niri":
      return focusedWindow(world.state);
    case "deck": {
      const { played } = world.state;
      if (played === null) return null;
      const parents = new Map(windows.map((id) => [id, { parent: env.windows[id]?.parent ?? null }]));
      const dialogs = windows.filter((id) => id !== played && cardOf(parents, id) === played);
      return dialogs.at(-1) ?? played;
    }
  }
}

/**
 * Where WORLD shows its windows, in the room's coordinates: hypr's tiles and
 * floating windows, the columns niri's view shows, the deck's window in play.
 */
export function worldBoxes(world: World, env: RoomEnv, present: ReadonlySet<number>,
                           table: Rectangle): Map<number, Rectangle> {
  const boxes = new Map<number, Rectangle>();
  switch (world.kind) {
    case "hypr":
      for (const [id, { x, y, width, height }] of placeWindows(world.state, [env.room], present))
        boxes.set(id, { x, y, width, height });
      break;
    case "niri": {
      const monitor = world.state.monitors[roomOutput];
      const workspace = monitor?.workspaces[monitor.active];
      if (!workspace) break;
      for (const { window, x, y, width, height, hidden } of placeTiles(workspace, env.room, env)) {
        if (!hidden) boxes.set(window, { x: x - workspace.view, y, width, height });
      }
      for (const floater of workspace.floating) boxes.set(floater.window, floaterBox(floater, env));
      break;
    }
    case "deck":
      if (world.state.played !== null) boxes.set(world.state.played, table);
      break;
  }
  return boxes;
}
