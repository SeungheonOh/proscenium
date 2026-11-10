/**
 * The shell's messages as they happen, for the Messages panel: what came in
 * (keys and presses, the compositor's news about windows), each message the
 * update function took and what it changed in the model, and the commands
 * that went out. Warlock's interface is an Elm program; this shell is the same
 * loop in React, `warlockReducer` being its `update`.
 */

import { useSyncExternalStore } from "react";
import type { WarlockAction, WarlockState, WindowRecord } from "./state.js";

/** Where a message comes from: input, the compositor (subscriptions), update, or a command going out. */
export type MessageKind = "input" | "sub" | "msg" | "cmd";

export interface Change {
  path: string;
  from: string;
  to: string;
}

export interface Message {
  serial: number;
  /** When it came, in milliseconds since the world started. */
  at: number;
  kind: MessageKind;
  name: string;
  detail: string;
  changes: readonly Change[];
  /** The same message again straight after: how many times in a row. */
  repeat: number;
}

export interface MessageLog {
  /** The latest first. */
  recent: readonly Message[];
  total: number;
  /** Messages by kind, ever. */
  counts: Readonly<Record<MessageKind, number>>;
  /** When each of the last messages came, for the rate. */
  times: readonly number[];
}

const keep = 48;
const started = performance.now();
let serial = 0;
let log: MessageLog = {
  recent: [],
  total: 0,
  counts: { input: 0, sub: 0, msg: 0, cmd: 0 },
  times: [],
};
const listeners = new Set<() => void>();

/** Write a message down. One the same as the latest, within a moment and changing nothing, counts as a repeat. */
export function post(
  kind: MessageKind,
  name: string,
  detail = "",
  changes: readonly Change[] = [],
): void {
  const at = performance.now() - started;
  const last = log.recent[0];
  const counts = { ...log.counts, [kind]: log.counts[kind] + 1 };
  const times = [...log.times.slice(-199), at];
  if (
    last &&
    last.kind === kind &&
    last.name === name &&
    last.detail === detail &&
    changes.length === 0 &&
    last.changes.length === 0 &&
    at - last.at < 1500
  ) {
    const again = { ...last, at, repeat: last.repeat + 1 };
    log = { recent: [again, ...log.recent.slice(1)], total: log.total + 1, counts, times };
  } else {
    const message: Message = { serial: ++serial, at, kind, name, detail, changes, repeat: 1 };
    log = {
      recent: [message, ...log.recent.slice(0, keep - 1)],
      total: log.total + 1,
      counts,
      times,
    };
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The log, re-rendering as messages come. */
export function useMessageLog(): MessageLog {
  return useSyncExternalStore(subscribe, () => log);
}

/** Milliseconds since the world started, on the log's clock. */
export function sinceStart(): number {
  return performance.now() - started;
}

// ---------------------------------------------------------------------------
// Messages of the update function, in Elm's way of writing them

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
const regionName = (region: string) => region.split("-").map(capital).join("");
const rectText = (rect: { x: number; y: number; width: number; height: number }) =>
  `${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}×${Math.round(rect.height)}`;

/** ACTION as an Elm message: its constructor and its arguments, windows named by NAME. */
export function describeAction(
  action: WarlockAction,
  name: (window: number) => string,
): { name: string; detail: string } {
  const many = (windows: readonly number[]) =>
    windows.length === 1 ? name(windows[0]!) : `[${windows.map(name).join(", ")}]`;
  switch (action.type) {
    case "sync":
      return { name: "Sync", detail: `${action.windows.length} windows` };
    case "activate":
      return { name: "Activate", detail: many(action.windows) };
    case "focused":
      return { name: "Focused", detail: name(action.window) };
    case "minimize":
      return { name: "Minimize", detail: many(action.windows) };
    case "float":
      return { name: "Float", detail: `${name(action.window)} ${rectText(action.rect)}` };
    case "place":
      return { name: "Place", detail: many(Object.keys(action.rects).map(Number)) };
    case "snap":
      return { name: "Snap", detail: `${name(action.window)} ${regionName(action.region)}` };
    case "maximize":
      return { name: "Maximize", detail: name(action.window) };
    case "restoreSize":
      return { name: "Restore", detail: name(action.window) };
    case "fullscreen":
      return { name: "Fullscreen", detail: `${name(action.window)} ${capital(String(action.value))}` };
    case "onTop":
      return { name: "AlwaysOnTop", detail: `${name(action.window)} ${capital(String(action.value))}` };
    case "transfer":
      return { name: "MoveTo", detail: `${many(action.windows)} workspace ${action.workspace}` };
    case "show":
      return { name: "ShowWorkspace", detail: String(action.workspace) };
    case "activateOutput":
      return { name: "ActivateOutput", detail: action.output };
  }
}

const fields: readonly (keyof WindowRecord)[] = [
  "workspace",
  "placement",
  "region",
  "minimized",
  "fullscreen",
  "onTop",
  "page",
  "rect",
];

function show(value: unknown): string {
  if (value === null || value === undefined) return "Nothing";
  if (typeof value === "object" && "width" in (value as object))
    return rectText(value as { x: number; y: number; width: number; height: number });
  if (Array.isArray(value)) return `(${value.join(", ")})`;
  return String(value);
}

/** What changed in the model from BEFORE to AFTER, windows named by NAME. */
export function modelChanges(
  before: WarlockState,
  after: WarlockState,
  name: (window: number) => string,
): Change[] {
  if (before === after) return [];
  const changes: Change[] = [];
  if (before.windows !== after.windows) {
    const ids = new Set([...Object.keys(before.windows), ...Object.keys(after.windows)]);
    for (const key of ids) {
      const was = before.windows[Number(key)];
      const now = after.windows[Number(key)];
      const who = name(Number(key));
      if (!was && now) changes.push({ path: `windows`, from: "", to: `+ ${who}` });
      else if (was && !now) changes.push({ path: `windows`, from: who, to: "" });
      else if (was && now && was !== now)
        for (const field of fields)
          if (show(was[field]) !== show(now[field]))
            changes.push({ path: `${who}.${field}`, from: show(was[field]), to: show(now[field]) });
    }
  }
  if (before.history[0] !== after.history[0])
    changes.push({
      path: "history[0]",
      from: before.history[0] === undefined ? "Nothing" : name(before.history[0]),
      to: after.history[0] === undefined ? "Nothing" : name(after.history[0]),
    });
  for (const output of new Set([...Object.keys(before.shown), ...Object.keys(after.shown)]))
    if (before.shown[output] !== after.shown[output])
      changes.push({
        path: "workspace",
        from: show(before.shown[output] ?? 1),
        to: show(after.shown[output]),
      });
  return changes;
}
