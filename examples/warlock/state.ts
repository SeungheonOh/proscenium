/**
 * What the Warlock world remembers about windows, and every change to it, as a
 * pure reducer. Warlock asks Hyprland to do these things and waits to hear what
 * happened; here the shell is the window manager, so a change simply happens.
 * Window ids key records, so they come back from JSON as strings.
 */

import type { Rectangle } from "proscenium";

/**
 * Where a window gets its place: a column of its page, its own rectangle
 * anywhere on the canvas, or a region of its page's work area.
 */
export type Placement = "tiled" | "floating" | "snapped" | "maximized";

/** A screen-sized cell of a workspace's canvas, by column and row; the desktop as it starts is page 0, 0. */
export type Page = readonly [column: number, row: number];

export const homePage: Page = [0, 0];

/** A camera over a workspace's canvas: its middle from the middle of the home page, and its zoom. */
export interface View {
  x: number;
  y: number;
  zoom: number;
}

export type SnapRegion =
  "left" | "right" | "top-left" | "top-right" | "bottom-left" | "bottom-right";

export const snapRegions: readonly { region: SnapRegion; label: string }[] = [
  { region: "left", label: "Left half" },
  { region: "right", label: "Right half" },
  { region: "top-left", label: "Top left quarter" },
  { region: "top-right", label: "Top right quarter" },
  { region: "bottom-left", label: "Bottom left quarter" },
  { region: "bottom-right", label: "Bottom right quarter" },
];

export interface WindowRecord {
  workspace: number;
  minimized: boolean;
  placement: Placement;
  /** The region a snapped window fills. */
  region: SnapRegion | null;
  fullscreen: boolean;
  /** Always on top: above every other window, and on every workspace. */
  onTop: boolean;
  /** The page it tiles, snaps and maximizes on. Records kept from before pages have none: the home page. */
  page?: Page;
  /** Where it floats, frame and all, on its workspace's canvas: its output's pixels with the view at home. */
  rect: Rectangle | null;
  /** What a snapped or maximized window goes back to. */
  saved: { placement: "tiled" | "floating"; rect: Rectangle | null } | null;
}

export interface WarlockState {
  /** The compositor instance the window ids belong to. */
  instance: string | null;
  windows: Record<number, WindowRecord>;
  /** Windows by when they were last activated, the latest first. */
  history: number[];
  /** The workspace each output shows, by output name; unset outputs show their own, from 1. */
  shown: Record<string, number>;
  /** The output last worked on. */
  active: string | null;
  /** Where the camera was when each workspace was last left, by workspace; without one it is at home. */
  views?: Record<number, View>;
}

export const initialWarlockState: WarlockState = {
  instance: null,
  windows: {},
  history: [],
  shown: {},
  active: null,
  views: {},
};

export type WarlockAction =
  /** The mapped windows changed; new ones join `workspace`, tiled on `page`. */
  | { type: "sync"; windows: readonly number[]; workspace: number; page: Page; instance: string }
  /** Bring windows back from the taskbar and put the first at the front of the history. */
  | { type: "activate"; windows: readonly number[] }
  /** A window took focus by itself, e.g. by a click. */
  | { type: "focused"; window: number }
  | { type: "minimize"; windows: readonly number[] }
  /** Float the window at `rect`; it remembers nothing to go back to. */
  | { type: "float"; window: number; rect: Rectangle }
  /** Float each window at its rectangle: what moving windows about the canvas comes to. */
  | { type: "place"; rects: Readonly<Record<number, Rectangle>> }
  /** Snap or maximize on `page`, or on the page the window has when none is given. */
  | { type: "snap"; window: number; region: SnapRegion; from: Rectangle | null; page?: Page }
  | { type: "maximize"; window: number; from: Rectangle | null; page?: Page }
  /** Back to what a snapped or maximized window was before. */
  | { type: "restoreSize"; window: number }
  | { type: "fullscreen"; window: number; value: boolean }
  | { type: "onTop"; window: number; value: boolean }
  | { type: "transfer"; windows: readonly number[]; workspace: number }
  /** Show `workspace` on `output`, which becomes the active output; `leaving` is the workspace it showed, and its camera. */
  | { type: "show"; output: string; workspace: number; leaving?: { workspace: number; view: View } }
  | { type: "activateOutput"; output: string };

function fresh(workspace: number, page: Page): WindowRecord {
  return {
    workspace,
    minimized: false,
    placement: "tiled",
    page,
    region: null,
    fullscreen: false,
    onTop: false,
    rect: null,
    saved: null,
  };
}

function update(
  state: WarlockState,
  windows: readonly number[],
  change: (record: WindowRecord) => WindowRecord,
): WarlockState {
  let records = state.windows;
  for (const id of windows) {
    const record = records[id];
    if (!record) continue;
    const next = change(record);
    if (next !== record) records = { ...records, [id]: next };
  }
  return records === state.windows ? state : { ...state, windows: records };
}

/** WINDOW floating at RECT, with nothing to go back to. */
function floated(record: WindowRecord, rect: Rectangle): WindowRecord {
  return { ...record, placement: "floating", region: null, rect, saved: null };
}

/** What a window goes back to once it is no longer snapped or maximized: kept from the first such change. */
function remember(record: WindowRecord, from: Rectangle | null): WindowRecord["saved"] {
  if (record.saved) return record.saved;
  return {
    placement: record.placement === "floating" ? "floating" : "tiled",
    rect: record.placement === "floating" ? record.rect : from,
  };
}

/**
 * New windows join their workspace and closed ones are forgotten. Ids restart
 * with the compositor, so a new instance forgets every window saved.
 */
function sync(
  state: WarlockState,
  windows: readonly number[],
  workspace: number,
  page: Page,
  instance: string,
): WarlockState {
  // Cameras start over at home with the compositor too.
  if (state.instance !== instance)
    state = { ...state, windows: {}, history: [], views: {}, instance };
  const live = new Set(windows);
  const known = Object.keys(state.windows).map(Number);
  const stale = known.filter((id) => !live.has(id));
  const added = windows.filter((id) => !state.windows[id]);
  if (stale.length === 0 && added.length === 0) return state;

  const records: Record<number, WindowRecord> = {};
  for (const id of known) if (live.has(id)) records[id] = state.windows[id]!;
  for (const id of added) records[id] = fresh(workspace, page);
  return { ...state, windows: records, history: state.history.filter((id) => live.has(id)) };
}

export function warlockReducer(state: WarlockState, action: WarlockAction): WarlockState {
  switch (action.type) {
    case "sync":
      return sync(state, action.windows, action.workspace, action.page, action.instance);

    case "activate": {
      const first = action.windows[0];
      const next = update(state, action.windows, (record) =>
        record.minimized ? { ...record, minimized: false } : record,
      );
      if (first === undefined || next.history[0] === first) return next;
      return { ...next, history: [first, ...next.history.filter((id) => id !== first)] };
    }

    case "focused":
      if (state.history[0] === action.window || !state.windows[action.window]) return state;
      return {
        ...state,
        history: [action.window, ...state.history.filter((id) => id !== action.window)],
      };

    case "minimize":
      return update(state, action.windows, (record) =>
        record.minimized ? record : { ...record, minimized: true },
      );

    case "float":
      return update(state, [action.window], (record) => floated(record, action.rect));

    case "place": {
      let records = state.windows;
      for (const [key, rect] of Object.entries(action.rects)) {
        const record = records[Number(key)];
        if (record) records = { ...records, [key]: floated(record, rect) };
      }
      return records === state.windows ? state : { ...state, windows: records };
    }

    case "snap":
      return update(state, [action.window], (record) => ({
        ...record,
        placement: "snapped",
        page: action.page ?? record.page ?? homePage,
        region: action.region,
        saved: remember(record, action.from),
      }));

    case "maximize":
      return update(state, [action.window], (record) => ({
        ...record,
        placement: "maximized",
        page: action.page ?? record.page ?? homePage,
        region: null,
        saved: remember(record, action.from),
      }));

    case "restoreSize":
      return update(state, [action.window], (record) => {
        if (record.placement !== "snapped" && record.placement !== "maximized") return record;
        const saved = record.saved ?? { placement: "tiled" as const, rect: null };
        const floats = saved.placement === "floating" && saved.rect !== null;
        return {
          ...record,
          placement: floats ? "floating" : "tiled",
          rect: floats ? saved.rect : record.rect,
          region: null,
          saved: null,
        };
      });

    case "fullscreen":
      return update(state, [action.window], (record) =>
        record.fullscreen === action.value ? record : { ...record, fullscreen: action.value },
      );

    case "onTop":
      return update(state, [action.window], (record) =>
        record.onTop === action.value ? record : { ...record, onTop: action.value },
      );

    case "transfer":
      return update(state, action.windows, (record) =>
        record.workspace === action.workspace ? record : { ...record, workspace: action.workspace },
      );

    case "show": {
      if (state.shown[action.output] === action.workspace && state.active === action.output)
        return state;
      const views = action.leaving
        ? { ...state.views, [action.leaving.workspace]: action.leaving.view }
        : state.views;
      return {
        ...state,
        shown: { ...state.shown, [action.output]: action.workspace },
        active: action.output,
        views,
      };
    }

    case "activateOutput":
      return state.active === action.output ? state : { ...state, active: action.output };
  }
}
