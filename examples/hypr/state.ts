/**
 * What the Hypr world remembers, and every change to it, as a pure reducer.
 * Window ids key records, so they come back from JSON as strings.
 */

import type { Rectangle } from "proscenium";

export type Layout = "dwindle" | "master";

export interface HyprState {
  /** Each window's workspace. */
  workspaces: Record<number, number>;
  /** The workspace each output shows, by output name; unset outputs show their own, from 1. */
  shown: Record<string, number>;
  /** Windows in tiling order. */
  order: number[];
  /** Floating windows and where they float. */
  floating: Record<number, Rectangle>;
  layouts: Record<number, Layout>;
  fullscreen: number | null;
  scratchpad: number[];
  /** The output last worked on, for keyboard actions while no window there has focus. */
  active: string | null;
  /** The compositor instance the window ids belong to. */
  instance: string | null;
}

export const initialHyprState: HyprState = {
  workspaces: {},
  shown: {},
  order: [],
  floating: {},
  layouts: {},
  fullscreen: null,
  scratchpad: [],
  active: null,
  instance: null,
};

export type HyprAction =
  /** The mapped windows changed; new ones join `workspace`. */
  | { type: "sync"; windows: readonly number[]; workspace: number; instance: string }
  /** Show `workspace` on `output`, which becomes the active output. */
  | { type: "show"; output: string; workspace: number }
  | { type: "activate"; output: string }
  | { type: "move"; window: number; workspace: number }
  | { type: "swap"; first: number; second: number }
  /** Float the window in `box`, or tile it again with null. */
  | { type: "float"; window: number; box: Rectangle | null }
  | { type: "fullscreen"; window: number | null }
  | { type: "toggleLayout"; workspace: number }
  | { type: "toggleScratchpad"; window: number };

function omit<T>(record: Record<number, T>, drop: (id: number) => boolean): Record<number, T> {
  const kept = Object.entries(record).filter(([id]) => !drop(Number(id)));
  return Object.fromEntries(kept) as Record<number, T>;
}

/**
 * New windows join the end of the order and closed ones are forgotten. Ids
 * restart with the compositor, so a new instance forgets every window saved.
 */
function sync(
  state: HyprState,
  windows: readonly number[],
  workspace: number,
  instance: string,
): HyprState {
  if (state.instance !== instance)
    state = {
      ...state,
      workspaces: {},
      order: [],
      floating: {},
      fullscreen: null,
      scratchpad: [],
      instance,
    };
  const live = new Set(windows);
  const isStale = (id: number) => !live.has(id);
  const fresh = windows.filter((id) => !state.order.includes(id));
  const changed =
    fresh.length > 0 ||
    state.order.some(isStale) ||
    Object.keys(state.workspaces).some((id) => isStale(Number(id)));
  if (!changed) return state;

  return {
    ...state,
    order: [...state.order.filter((id) => !isStale(id)), ...fresh],
    workspaces: {
      ...omit(state.workspaces, isStale),
      ...Object.fromEntries(fresh.map((id) => [id, workspace])),
    },
    floating: omit(state.floating, isStale),
    scratchpad: state.scratchpad.filter((id) => !isStale(id)),
    fullscreen: state.fullscreen !== null && isStale(state.fullscreen) ? null : state.fullscreen,
  };
}

export function hyprReducer(state: HyprState, action: HyprAction): HyprState {
  switch (action.type) {
    case "sync":
      return sync(state, action.windows, action.workspace, action.instance);

    case "show":
      return {
        ...state,
        shown: { ...state.shown, [action.output]: action.workspace },
        active: action.output,
      };

    case "activate":
      return { ...state, active: action.output };

    case "move":
      return {
        ...state,
        workspaces: { ...state.workspaces, [action.window]: action.workspace },
        scratchpad: state.scratchpad.filter((id) => id !== action.window),
      };

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
      const current = state.layouts[action.workspace] ?? "dwindle";
      const next: Layout = current === "dwindle" ? "master" : "dwindle";
      return { ...state, layouts: { ...state.layouts, [action.workspace]: next } };
    }

    case "toggleScratchpad": {
      const stashed = state.scratchpad.includes(action.window);
      const scratchpad = stashed
        ? state.scratchpad.filter((id) => id !== action.window)
        : [...state.scratchpad, action.window];
      return { ...state, scratchpad };
    }
  }
}
