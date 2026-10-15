/**
 * Trellis's state: the arrangement, what the view frames, where it has been, and
 * the views saved on number keys. Kept across reloads and restarts; window ids
 * start over with the compositor, so a new instance starts the arrangement over.
 */

import {
  desk,
  dock,
  find,
  moveSeam,
  normalize,
  panelHolding,
  panelOf,
  removeWindow,
  replace,
  sameTarget,
  type Drop,
  type Float,
  type Node,
  type Panel,
  type Rect,
  type Side,
  type Split,
  type Target,
} from "./model.js";

/** A minimized window and where it goes back to. */
export interface Minimized {
  window: number;
  /**
   * The tab group it was in; the split and place its own panel had, and the neighbour it
   * goes beside if that split is gone; or its box on the Desktop.
   */
  tabOf?: string;
  split?: string;
  index?: number;
  weight?: number;
  beside?: string;
  side?: Side;
  float?: Rect;
}

export interface TrellisState {
  instance: string | null;
  root: Node;
  /** Panels floating on the Desktop, bottom first. */
  floating: Float[];
  minimized: Minimized[];
  framed: Target;
  /** Where the view has been, and which of those it is at. */
  history: Target[];
  at: number;
  saved: Record<string, Target>;
}

const everything: Target = { node: "desktop" };

export const initialTrellis: TrellisState = {
  instance: null,
  root: desk,
  floating: [],
  minimized: [],
  framed: everything,
  history: [everything],
  at: 0,
  saved: {},
};

export type TrellisAction =
  /** The windows to arrange now, and a box on the Desktop for each that is new. */
  | { type: "sync"; instance: string | null; windows: number[]; opened: { window: number; rect: Rect }[] }
  | { type: "frame"; target: Target }
  | { type: "back" }
  | { type: "forward" }
  | { type: "save"; slot: number }
  | { type: "recall"; slot: number }
  /** WINDOW dropped as DROP says; a float drop lands at RECT on the Desktop. */
  | { type: "drop"; window: number; drop: Drop; rect?: Rect }
  | { type: "moveFloat"; window: number; rect: Rect }
  | { type: "seam"; split: string; index: number; at: number }
  | { type: "evenSeam"; split: string; index: number }
  | { type: "activate"; window: number }
  | { type: "minimize"; window: number }
  | { type: "restore"; window: number; rect: Rect };

export function trellisReducer(state: TrellisState, action: TrellisAction): TrellisState {
  switch (action.type) {
    case "sync": {
      let next = state.instance === action.instance ? state : { ...initialTrellis, instance: action.instance };
      const present = new Set(action.windows);
      const known = new Set(windowsOf(next));
      for (const window of known) if (!present.has(window)) next = take(next, window);
      const floating = [...next.floating];
      for (const { window, rect } of action.opened) {
        if (!known.has(window)) floating.push({ panel: panelOf([window]), rect });
      }
      return settle(floating.length === next.floating.length ? next : { ...next, floating });
    }
    case "frame":
      return visit(state, action.target);
    case "back":
    case "forward": {
      const at = state.at + (action.type === "back" ? -1 : 1);
      if (at < 0 || at >= state.history.length) return state;
      return settle({ ...state, at, framed: state.history[at]! });
    }
    case "save":
      return { ...state, saved: { ...state.saved, [action.slot]: state.framed } };
    case "recall": {
      const target = state.saved[action.slot];
      return target ? visit(state, target) : state;
    }
    case "drop":
      return settle(place(take(state, action.window), action.window, action.drop, action.rect));
    case "moveFloat":
      return {
        ...state,
        floating: state.floating.map((float) =>
          float.panel.windows.includes(action.window) ? { ...float, rect: action.rect } : float),
      };
    case "seam":
    case "evenSeam": {
      const entry = find(state.root, action.split);
      if (!entry || entry.node.kind !== "split") return state;
      const split = entry.node;
      const weights = action.type === "seam"
        ? moveSeam(split, action.index, action.at)
        : evened(split, action.index);
      return { ...state, root: replace(state.root, split.id, () => ({ ...split, weights })) };
    }
    case "activate": {
      const docked = panelHolding(state.root, action.window);
      if (docked) {
        if (docked.active === action.window) return state;
        return { ...state, root: replace(state.root, docked.id, () => ({ ...docked, active: action.window })) };
      }
      const float = state.floating.find((each) => each.panel.windows.includes(action.window));
      if (!float) return state;
      const raised = { ...float, panel: { ...float.panel, active: action.window } };
      if (state.floating.at(-1) === float && float.panel.active === action.window) return state;
      return { ...state, floating: [...state.floating.filter((each) => each !== float), raised] };
    }
    case "minimize": {
      const where = whereIs(state, action.window);
      if (!where) return state;
      return settle({ ...take(state, action.window), minimized: [...state.minimized, where] });
    }
    case "restore": {
      const kept = state.minimized.find((each) => each.window === action.window);
      if (!kept) return state;
      const without = { ...state, minimized: state.minimized.filter((each) => each !== kept) };
      return settle(restore(without, kept, action.rect));
    }
  }
}

/** Every window the state arranges. */
export function windowsOf(state: TrellisState): number[] {
  const ids: number[] = [];
  const visit = (node: Node) => {
    if (node.kind === "panel") ids.push(...node.windows);
    else if (node.kind === "split") node.children.forEach(visit);
  };
  visit(state.root);
  for (const float of state.floating) ids.push(...float.panel.windows);
  for (const kept of state.minimized) ids.push(kept.window);
  return ids;
}

/** STATE without WINDOW, as the layout shows while it is being dragged. */
export function withoutWindow(state: TrellisState, window: number): TrellisState {
  return settle(take(state, window));
}

/** STATE framing TARGET, remembered in its history. */
function visit(state: TrellisState, target: Target): TrellisState {
  if (sameTarget(state.framed, target)) return state;
  const history = [...state.history.slice(Math.max(0, state.at - 48), state.at + 1), target];
  return settle({ ...state, framed: target, history, at: history.length - 1 });
}

/** STATE without WINDOW anywhere: docked, floating or minimized. */
function take(state: TrellisState, window: number): TrellisState {
  const floating: Float[] = [];
  for (const float of state.floating) {
    const windows = float.panel.windows.filter((id) => id !== window);
    if (!windows.length) continue;
    floating.push(windows.length === float.panel.windows.length ? float : {
      ...float,
      panel: { ...float.panel, windows, active: windows.includes(float.panel.active) ? float.panel.active : windows[0]! },
    });
  }
  return {
    ...state,
    root: removeWindow(state.root, window),
    floating,
    minimized: state.minimized.filter((kept) => kept.window !== window),
  };
}

/** STATE with WINDOW, taken out first, placed as DROP says. */
function place(state: TrellisState, window: number, drop: Drop, rect?: Rect): TrellisState {
  const panel = panelOf([window]);
  if (drop.kind === "float") {
    return { ...state, floating: [...state.floating, { panel, rect: rect ?? { x: 0, y: 0, width: 640, height: 420 } }] };
  }
  if (drop.kind === "tab") {
    const float = state.floating.find((each) => each.panel.id === drop.panel);
    if (float) {
      const into: Panel = { ...float.panel, windows: [...float.panel.windows, window], active: window };
      return { ...state, floating: [...state.floating.filter((each) => each !== float), { ...float, panel: into }] };
    }
  }
  const { root, framed } = dock(state.root, drop, panel, state.framed);
  return { ...state, root, framed, history: state.history.map((target, at) => (at === state.at ? framed : target)) };
}

/** Where WINDOW is, to go back there. */
function whereIs(state: TrellisState, window: number): Minimized | null {
  const docked = panelHolding(state.root, window);
  if (docked) {
    if (docked.windows.length > 1) return { window, tabOf: docked.id };
    const entry = find(state.root, docked.id)!;
    const parent = entry.parent;
    if (!parent) return { window };
    const total = parent.weights.reduce((sum, weight) => sum + weight, 0);
    const after = entry.index > 0;
    const side: Side = parent.axis === "x" ? (after ? "right" : "left") : after ? "bottom" : "top";
    return {
      window,
      split: parent.id,
      index: entry.index,
      weight: parent.weights[entry.index]! / total,
      beside: parent.children[entry.index + (after ? -1 : 1)]!.id,
      side,
    };
  }
  const float = state.floating.find((each) => each.panel.windows.includes(window));
  return float ? { window, float: float.rect } : null;
}

/** WINDOW back where it was, or floating at RECT when that place is gone. */
function restore(state: TrellisState, kept: Minimized, rect: Rect): TrellisState {
  const window = kept.window;
  if (kept.tabOf && find(state.root, kept.tabOf)) {
    return place(state, window, { kind: "tab", panel: kept.tabOf });
  }
  const split = kept.split ? find(state.root, kept.split)?.node : undefined;
  if (split?.kind === "split" && kept.index !== undefined && kept.weight !== undefined) {
    const total = split.weights.reduce((sum, weight) => sum + weight, 0);
    const children = [...split.children];
    const weights = split.weights.map((weight) => (weight / total) * (1 - kept.weight!));
    const at = Math.min(kept.index, children.length);
    children.splice(at, 0, panelOf([window]));
    weights.splice(at, 0, kept.weight);
    return { ...state, root: replace(state.root, split.id, () => ({ ...split, children, weights })) };
  }
  if (kept.beside && kept.side && find(state.root, kept.beside)) {
    return place(state, window, { kind: "beside", node: kept.beside, side: kept.side });
  }
  return { ...state, floating: [...state.floating, { panel: panelOf([window]), rect: kept.float ?? rect }] };
}

/** SPLIT's weights with children INDEX - 1 and INDEX sharing their room evenly. */
function evened(split: Split, index: number): number[] {
  const weights = [...split.weights];
  const pair = weights[index - 1]! + weights[index]!;
  weights[index - 1] = weights[index] = pair / 2;
  return weights;
}

/** STATE with the tree normalized and every target naming something that still exists. */
function settle(state: TrellisState): TrellisState {
  const root = normalize(state.root) ?? desk;
  const alive = (target: Target) => {
    if ("node" in target) return Boolean(find(root, target.node));
    const split = find(root, target.split)?.node;
    return split?.kind === "split" && target.to < split.children.length && target.from < target.to;
  };
  const framed = alive(state.framed) ? state.framed : { node: root.id };
  const history = state.history.map((target) => (alive(target) ? target : { node: root.id }));
  const saved = Object.fromEntries(Object.entries(state.saved).filter(([, target]) => alive(target)));
  return { ...state, root, framed, history, saved };
}
