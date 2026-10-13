/**
 * What the meta world remembers, and every change to it, as a pure reducer.
 * Rooms sit anywhere on the canvas; windows belong to rooms. Window ids key
 * records, so they come back from JSON as strings.
 */

import type { CameraMove, Rectangle } from "proscenium";
import { clearSpot, type Room, type Size } from "./geometry.js";

export type Layout = "dwindle" | "master";

export interface MetaState {
  /** Rooms in the order they were made, which numbers them. */
  rooms: Room[];
  nextRoom: number;
  /** Each window's room. */
  roomOf: Record<number, number>;
  /** Windows in tiling order. */
  order: number[];
  /** Floating windows and where they float, in their room's coordinates. */
  floating: Record<number, Rectangle>;
  /** Each room's layout; dwindle unless set. */
  layouts: Record<number, Layout>;
  fullscreen: number | null;
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
  order: [],
  floating: {},
  layouts: {},
  fullscreen: null,
  entered: {},
  canvasView: {},
  current: 1,
  active: null,
  instance: null,
};

export type MetaAction =
  /** The mapped windows changed; new ones join `room`. */
  | { type: "sync"; windows: readonly number[]; room: number; instance: string }
  /** Show `room` on `output`, or the canvas with null; `from` is the canvas view left. */
  | { type: "enter"; output: string; room: number | null; from?: CameraMove }
  | { type: "activate"; output: string }
  /** Make room `state.nextRoom` near (x, y), clear of the others. */
  | { type: "addRoom"; x: number; y: number; size: Size }
  /** Put a room near (x, y), clear of the others. */
  | { type: "placeRoom"; room: number; x: number; y: number; size: Size }
  /** Remove an empty room; the last one stays. */
  | { type: "removeRoom"; room: number }
  /** Move a window to `room`, floating at `box` there if given. */
  | { type: "move"; window: number; room: number; box?: Rectangle }
  | { type: "swap"; first: number; second: number }
  /** Float the window in `box`, or tile it again with null. */
  | { type: "float"; window: number; box: Rectangle | null }
  | { type: "fullscreen"; window: number | null }
  | { type: "toggleLayout"; room: number };

function omit<T>(record: Record<number, T>, drop: (id: number) => boolean): Record<number, T> {
  const kept = Object.entries(record).filter(([id]) => !drop(Number(id)));
  return Object.fromEntries(kept) as Record<number, T>;
}

/**
 * New windows join the end of the order and closed ones are forgotten. Ids
 * restart with the compositor, so a new instance forgets every window saved;
 * rooms stay.
 */
function sync(
  state: MetaState,
  windows: readonly number[],
  room: number,
  instance: string,
): MetaState {
  if (state.instance !== instance)
    state = { ...state, roomOf: {}, order: [], floating: {}, fullscreen: null, instance };
  const live = new Set(windows);
  const isStale = (id: number) => !live.has(id);
  const fresh = windows.filter((id) => !state.order.includes(id));
  const changed =
    fresh.length > 0 ||
    state.order.some(isStale) ||
    Object.keys(state.roomOf).some((id) => isStale(Number(id)));
  if (!changed) return state;

  return {
    ...state,
    order: [...state.order.filter((id) => !isStale(id)), ...fresh],
    roomOf: {
      ...omit(state.roomOf, isStale),
      ...Object.fromEntries(fresh.map((id) => [id, room])),
    },
    floating: omit(state.floating, isStale),
    fullscreen: state.fullscreen !== null && isStale(state.fullscreen) ? null : state.fullscreen,
  };
}

export function metaReducer(state: MetaState, action: MetaAction): MetaState {
  switch (action.type) {
    case "sync":
      return sync(state, action.windows, action.room, action.instance);

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
      return { ...state, rooms: [...state.rooms, room], nextRoom: state.nextRoom + 1 };
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
      return { ...state, rooms, entered, current };
    }

    case "move": {
      const rest = omit(state.floating, (id) => id === action.window);
      return {
        ...state,
        roomOf: { ...state.roomOf, [action.window]: action.room },
        floating: action.box ? { ...rest, [action.window]: action.box } : rest,
      };
    }

    case "swap": {
      const { first, second } = action;
      const order = state.order.map((id) => (id === first ? second : id === second ? first : id));
      return { ...state, order };
    }

    case "float": {
      const rest = omit(state.floating, (id) => id === action.window);
      return { ...state, floating: action.box ? { ...rest, [action.window]: action.box } : rest };
    }

    case "fullscreen":
      return { ...state, fullscreen: action.window };

    case "toggleLayout": {
      const current = state.layouts[action.room] ?? "dwindle";
      const next: Layout = current === "dwindle" ? "master" : "dwindle";
      return { ...state, layouts: { ...state.layouts, [action.room]: next } };
    }
  }
}
