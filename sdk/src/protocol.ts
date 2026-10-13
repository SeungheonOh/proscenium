// Wire protocol between a director and the Stage World.
//
// Messages are newline-delimited JSON objects over a local stream socket.
// The director sends `hello`, receives a `welcome` snapshot, then streams
// scene `commit`s. Every scene value on the wire is canonical: colors are
// straight-alpha [r, g, b, a] in 0..1, angles are radians and durations are
// seconds. The compositor validates every field and never trusts it further.
// docs/PROTOCOL.md specifies every message in full.

import type { Modifier } from "./events.js";

export const PROTOCOL_VERSION = 3;

/** FNV-1a: a short, stable id for some wire content. */
export function contentId(text: string): string {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    value = Math.imul(value ^ text.charCodeAt(index), 0x01000193);
  }
  return (value >>> 0).toString(36);
}

export type WireColor = [number, number, number, number];
export type WireValue = number | string | boolean | null | WireValue[] | { [key: string]: WireValue };
export type WireProps = Record<string, WireValue>;

export interface WireWindow {
  id: number;
  title: string;
  app: string;
  mapped: boolean;
  width: number;
  height: number;
  parent: number | null;
  "min-width": number;
  "min-height": number;
  "max-width": number;
  "max-height": number;
}

export interface WireRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WireOutput {
  name: string;
  x: number;
  width: number;
  height: number;
  scale: number;
  "work-area": WireRect;
}

export interface WireFocus {
  seat: string;
  window: number | null;
}

/** The modifiers a seat holds. */
export interface WireModifiers {
  seat: string;
  modifiers: Modifier[];
}

/** Where an output's camera is headed: world point at its center, zoom and rotation. */
export interface WireCamera {
  output: string;
  x: number;
  y: number;
  zoom: number;
  rotation: number;
}

/** A screen-sharing request, pending until accepted with a source. */
export interface WireShare {
  id: number;
  /** The requesting application, as the portal names it. */
  app: string;
  /** What the client accepts. */
  types: ("screen" | "window")[];
  source: "screen" | "window" | null;
  window: number | null;
  output: string | null;
}

/** Event fields arrive in kebab-case, e.g. `screen-x`. */
export interface WireEvent {
  type: "event";
  node: number;
  name: string;
  [field: string]: WireValue;
}

export type ServerMessage =
  | {
      type: "welcome";
      protocol: number;
      instance: string;
      display: string;
      outputs: WireOutput[];
      windows: WireWindow[];
      cameras: WireCamera[];
      focus: WireFocus[];
      shares: WireShare[];
      modifiers: WireModifiers[];
    }
  | { type: "window"; window: WireWindow }
  | { type: "window-removed"; id: number }
  | { type: "output"; output: WireOutput }
  | { type: "output-removed"; name: string }
  | ({ type: "focus" } & WireFocus)
  /** The modifiers a seat holds, whenever they change. */
  | ({ type: "modifiers" } & WireModifiers)
  | ({ type: "camera" } & WireCamera)
  | { type: "clipboard"; text: string }
  | { type: "shares"; shares: WireShare[] }
  /** A screenshot's raw RGBA pixels, in a file the director now owns. */
  | { type: "captured"; id: number; path?: string; width?: number; height?: number; error?: string }
  /** Text sizes for a `measure` request, by its keys. */
  | { type: "measured"; results: { key: number; width: number; height: number }[] }
  | WireEvent
  | { type: "error"; message: string; fatal?: boolean };

/**
 * Scene mutation. `reset` removes every top-level node within the commit;
 * `shader` defines a shader nodes then use in their `shaders`.
 */
export type Op =
  | { op: "reset" }
  | { op: "shader"; id: string; stage: "paint" | "filter" | "effect"; source: string;
      uniforms: Record<string, number>; reads?: WireProps; extent?: WireValue; opaque?: WireProps;
      hole?: WireProps; gate?: WireValue }
  | { op: "create"; id: number; type: string; props: WireProps }
  | { op: "set"; id: number; props: WireProps }
  | { op: "insert"; parent: number; id: number; before: number | null }
  | { op: "remove"; parent: number; id: number };

export type ClientMessage =
  | { type: "hello"; protocol: number; client: string }
  | { type: "commit"; ops: Op[] }
  | { type: "focus"; window: number | null }
  | { type: "close"; window: number }
  | { type: "set-clipboard"; text: string }
  | { type: "share-accept"; id: number; window?: number; output?: string; region?: WireRect }
  | { type: "share-cancel"; id: number }
  | { type: "capture"; id: number; window?: number; output?: string; region?: WireRect }
  /** Ask how Pango sizes each text, as a text node with these props would show it. */
  | { type: "measure"; requests: { key: number; props: WireProps }[] }
  | { type: "camera"; output: string | null; x?: number; y?: number; zoom?: number;
      rotation?: number; transition?: WireValue };
