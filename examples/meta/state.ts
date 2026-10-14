/**
 * What the meta world remembers, and every change to it, as a pure reducer.
 * Rooms sit anywhere on the canvas; windows belong to rooms, and each room's
 * world arranges the windows in it (worlds.ts). Window ids key records, so
 * they come back from JSON as strings.
 */

import type { CameraMove, Rectangle } from "proscenium";
import { initialHyprState, type Layout } from "../hypr/state.js";
import type { Env } from "../niri/model.js";
import { clearSpot, type Room, type Size } from "./geometry.js";
import {
  arranged,
  emptyWorld,
  hyprWorkspace,
  normalizeWorld,
  reduceWorld,
  syncWorld,
  worldFocus,
  type Kind,
  type RoomEnv,
  type World,
  type WorldAction,
} from "./worlds.js";

export interface MetaState {
  /** Rooms in the order they were made, which numbers them. */
  rooms: Room[];
  nextRoom: number;
  /** Each window's room. */
  roomOf: Record<number, number>;
  /** Each room's world: what arranges its windows, and that world's own state. */
  worlds: Record<number, World>;
  /** The room each output shows, by output name; absent or null shows the canvas. */
  entered: Record<string, number | null>;
  /** Where each output was looking on the canvas when it entered a room. */
  canvasView: Record<string, CameraMove>;
  /** The room last entered: new windows join it while no output is in a room. */
  current: number;
  /** The output last worked on, for keyboard actions while no window there has focus. */
  active: string | null;
  /** The compositor instance the window ids belong to. */
  instance: string | null;
}

export const initialMetaState: MetaState = {
  rooms: [{ id: 1, x: 0, y: 0 }],
  nextRoom: 2,
  roomOf: {},
  worlds: {},
  entered: {},
  canvasView: {},
  current: 1,
  active: null,
  instance: null,
};

export type MetaAction =
  /** The mapped windows changed; new ones join `room`, or their parent's room. */
  | { type: "sync"; windows: readonly number[]; room: number; instance: string }
  /** Show `room` on `output`, or the canvas with null; `from` is the canvas view left. */
  | { type: "enter"; output: string; room: number | null; from?: CameraMove }
  | { type: "activate"; output: string }
  /** Make room `state.nextRoom` near (x, y), clear of the others, of `kind` (hypr by default). */
  | { type: "addRoom"; x: number; y: number; size: Size; kind?: Kind }
  /** Put a room near (x, y), clear of the others. */
  | { type: "placeRoom"; room: number; x: number; y: number; size: Size }
  /** Remove an empty room; the last one stays. */
  | { type: "removeRoom"; room: number }
  /** Move a window, with the dialogs that belong to it, to `room`. */
  | { type: "move"; window: number; room: number }
  /** Arrange `room` as `kind` from now on; the new world focuses `focused`, if it is in the room. */
  | { type: "setKind"; room: number; kind: Kind; focused?: number | null }
  /** An action of `room`'s world. */
  | { type: "world"; room: number; action: WorldAction };

/** Actions carry the rooms' environment, which their worlds lay windows out in. */
export type EnvMetaAction = MetaAction & { env: RoomEnv };

function omit<T>(record: Record<number, T>, drop: (id: number) => boolean): Record<number, T> {
  const kept = Object.entries(record).filter(([id]) => !drop(Number(id)));
  return Object.fromEntries(kept) as Record<number, T>;
}

/** The windows in ROOM, oldest first. */
export function windowsIn(state: MetaState, room: number): number[] {
  return Object.keys(state.roomOf)
    .map(Number)
    .filter((id) => state.roomOf[id] === room);
}

/** ROOM's world: a hypr one until it is given another. */
export function worldOf(state: MetaState, room: number): World {
  return normalizeWorld(state.worlds[room]);
}

/** Whether WINDOW is ANCESTOR or belongs to it, through its chain of parents, as its dialogs do. */
function belongsTo(window: number, ancestor: number, env: Env): boolean {
  let id: number | null | undefined = window;
  for (let step = 0; step < 16 && id != null; step++) {
    if (id === ancestor) return true;
    id = env.windows[id]?.parent;
  }
  return false;
}

/** ROOMS' worlds (every room's by default) in step with the windows in them. */
function syncWorlds(state: MetaState, env: RoomEnv, rooms = state.rooms.map((room) => room.id)): MetaState {
  if (state.instance === null) return state;
  let worlds = state.worlds;
  for (const room of rooms) {
    const world = syncWorld(worldOf(state, room), windowsIn(state, room), state.instance, env);
    if (world !== worlds[room]) worlds = { ...worlds, [room]: world };
  }
  return worlds === state.worlds ? state : { ...state, worlds };
}

/**
 * New windows join `room`, or the room of the window they belong to, and closed
 * ones are forgotten. Ids restart with the compositor, so a new instance forgets
 * every window saved; rooms, and what each is, stay.
 */
function sync(state: MetaState, windows: readonly number[], room: number, instance: string,
              env: RoomEnv): MetaState {
  if (state.instance !== instance) state = { ...state, roomOf: {}, instance };
  const live = new Set(windows);
  const stale = Object.keys(state.roomOf).some((id) => !live.has(Number(id)));
  const fresh = windows.filter((id) => state.roomOf[id] === undefined);
  if (stale || fresh.length > 0) {
    const roomOf = omit(state.roomOf, (id) => !live.has(id));
    for (const id of fresh) {
      const parent = env.windows[id]?.parent;
      roomOf[id] = (parent != null ? roomOf[parent] : undefined) ?? room;
    }
    state = { ...state, roomOf };
  }
  return syncWorlds(state, env);
}

export function metaReducer(saved: MetaState, action: EnvMetaAction): MetaState {
  const state = normalizeMeta(saved);
  const { env } = action;
  switch (action.type) {
    case "sync":
      return sync(state, action.windows, action.room, action.instance, env);

    case "enter": {
      const canvasView = action.from
        ? { ...state.canvasView, [action.output]: action.from }
        : state.canvasView;
      return {
        ...state,
        entered: { ...state.entered, [action.output]: action.room },
        canvasView,
        current: action.room ?? state.current,
        active: action.output,
      };
    }

    case "activate":
      return { ...state, active: action.output };

    case "addRoom": {
      const room = clearSpot(
        state.rooms,
        { id: state.nextRoom, x: action.x, y: action.y },
        action.size,
      );
      return {
        ...state,
        rooms: [...state.rooms, room],
        nextRoom: state.nextRoom + 1,
        worlds: { ...state.worlds, [room.id]: emptyWorld(action.kind ?? "hypr") },
      };
    }

    case "placeRoom": {
      const moved = { id: action.room, x: action.x, y: action.y };
      const placed = clearSpot(state.rooms, moved, action.size);
      return {
        ...state,
        rooms: state.rooms.map((room) => (room.id === action.room ? placed : room)),
      };
    }

    case "removeRoom": {
      const occupied = Object.values(state.roomOf).includes(action.room);
      if (occupied || state.rooms.length === 1) return state;
      const rooms = state.rooms.filter((room) => room.id !== action.room);
      const entered = Object.fromEntries(
        Object.entries(state.entered).map(([output, room]) => [
          output,
          room === action.room ? null : room,
        ]),
      );
      const current = state.current === action.room ? rooms[0]!.id : state.current;
      const worlds = omit(state.worlds, (room) => room === action.room);
      return { ...state, rooms, entered, current, worlds };
    }

    case "move": {
      const from = state.roomOf[action.window];
      if (from === undefined || from === action.room) return state;
      const roomOf = { ...state.roomOf };
      for (const id of windowsIn(state, from)) {
        if (belongsTo(id, action.window, env)) roomOf[id] = action.room;
      }
      return syncWorlds({ ...state, roomOf }, env, [from, action.room]);
    }

    case "setKind": {
      const before = worldOf(state, action.room);
      if (before.kind === action.kind) return state;
      let world = emptyWorld(action.kind);
      if (state.instance !== null) {
        // The new world takes the windows in the order the old one kept them,
        // the focused one last, so that the new one focuses it too.
        const windows = windowsIn(state, action.room);
        const focused = action.focused != null && windows.includes(action.focused)
          ? action.focused
          : worldFocus(before, windows, env);
        const order = [...new Set([...arranged(before), ...windows])]
          .filter((id) => windows.includes(id) && id !== focused);
        if (focused !== null) order.push(focused);
        world = syncWorld(world, order, state.instance, env);
      }
      return { ...state, worlds: { ...state.worlds, [action.room]: world } };
    }

    case "world": {
      const world = worldOf(state, action.room);
      const next = reduceWorld(world, action.action, env);
      return next === world ? state : { ...state, worlds: { ...state.worlds, [action.room]: next } };
    }
  }
}

/** What versions before rooms had worlds saved: every room tiled as hypr does. */
interface Legacy {
  order?: number[];
  floating?: Record<number, Rectangle>;
  layouts?: Record<number, Layout>;
  fullscreen?: number | null;
}

/**
 * STATE as saved by any version of this world. Rooms saved before rooms had
 * worlds become hypr rooms, keeping their windows' order, floating places and
 * layout.
 */
export function normalizeMeta(state: MetaState & Legacy): MetaState {
  if (state.worlds && !state.order) return state;
  const { order = [], floating = {}, layouts = {}, fullscreen = null, ...rest } = state;
  const worlds: Record<number, World> = {};
  for (const { id: room } of rest.rooms ?? initialMetaState.rooms) {
    const windows = order.filter((id) => rest.roomOf?.[id] === room);
    const layout = layouts[room];
    worlds[room] = {
      kind: "hypr",
      state: {
        ...initialHyprState,
        order: windows,
        workspaces: Object.fromEntries(windows.map((id) => [id, hyprWorkspace])),
        floating: omit(floating, (id) => !windows.includes(id)),
        layouts: layout ? { [hyprWorkspace]: layout } : {},
        fullscreen: fullscreen !== null && windows.includes(fullscreen) ? fullscreen : null,
        instance: rest.instance ?? null,
      },
    };
  }
  return { ...initialMetaState, ...rest, worlds };
}
