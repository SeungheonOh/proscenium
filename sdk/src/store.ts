// Compositor state mirrored for React. Snapshots are immutable and replaced
// only when the compositor reports a change, so idle sessions render nothing.
// The store outlives hot reloads; persistent values live here for that reason.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Modifier } from "./events.js";
import type { ServerMessage, WireCamera, WireOutput, WireShare, WireWindow } from "./protocol.js";

export interface WindowInfo {
  readonly id: number;
  readonly title: string;
  readonly appId: string;
  readonly mapped: boolean;
  /** Size the client last committed, in logical pixels. */
  readonly width: number;
  readonly height: number;
  /** The window this one belongs to, as a dialog does, or null. */
  readonly parent: number | null;
  /** Sizes the client accepts, in logical pixels; 0 leaves a bound free. */
  readonly minWidth: number;
  readonly minHeight: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
}

export interface Rectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface OutputInfo {
  readonly name: string;
  /** Position in the horizontal output row, and size in logical pixels. */
  readonly x: number;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  /** Output-local area left for windows after reservations such as a bar. */
  readonly workArea: Rectangle;
}

/** Where an output's camera is headed. Pans and zooms update it as they happen. */
export interface CameraInfo {
  readonly output: string;
  /** World point at the output's center. */
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
  /** Degrees. */
  readonly rotation: number;
}

export type ShareInfo = Readonly<WireShare>;

type Listener = () => void;

function toCamera(camera: WireCamera): CameraInfo {
  return Object.freeze({ output: camera.output, x: camera.x, y: camera.y, zoom: camera.zoom,
                         rotation: camera.rotation * 180 / Math.PI });
}

function toWindow(window: WireWindow): WindowInfo {
  return Object.freeze({ id: window.id, title: window.title, appId: window.app,
                         mapped: window.mapped, width: window.width, height: window.height,
                         parent: window.parent ?? null,
                         minWidth: window["min-width"] ?? 0, minHeight: window["min-height"] ?? 0,
                         maxWidth: window["max-width"] ?? 0, maxHeight: window["max-height"] ?? 0 });
}

function toOutput(output: WireOutput): OutputInfo {
  const { "work-area": workArea, ...rest } = output;
  return Object.freeze({ ...rest, workArea: Object.freeze({ ...workArea }) });
}

const noModifiers: readonly Modifier[] = Object.freeze([]);

export class Store {
  display = "";
  /** The compositor process connected, from its welcome; window ids belong to it. */
  instance: string | null = null;
  private windowMap = new Map<number, WindowInfo>();
  private outputMap = new Map<string, OutputInfo>();
  private focusMap = new Map<string, number | null>();
  private modifierMap = new Map<string, readonly Modifier[]>();
  private cameraMap = new Map<string, CameraInfo>();
  private windowList: readonly WindowInfo[] = [];
  private outputList: readonly OutputInfo[] = [];
  private clipboardList: readonly string[] = [];
  private shareList: readonly ShareInfo[] = [];
  private persistPath: string | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly persistent = new Map<string, unknown>();
  private readonly persistentListeners = new Map<string, Set<Listener>>();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  windows = (): readonly WindowInfo[] => this.windowList;
  outputs = (): readonly OutputInfo[] => this.outputList;
  window = (id: number): WindowInfo | undefined => this.windowMap.get(id);
  camera = (output?: string): CameraInfo | undefined =>
    output === undefined ? this.cameraMap.values().next().value : this.cameraMap.get(output);
  focus = (seat?: string): number | null =>
    seat === undefined ? this.focusMap.values().next().value ?? null : this.focusMap.get(seat) ?? null;
  modifiers = (seat?: string): readonly Modifier[] =>
    (seat === undefined ? this.modifierMap.values().next().value : this.modifierMap.get(seat)) ?? noModifiers;
  /** Screen-sharing requests and running shares. */
  shares = (): readonly ShareInfo[] => this.shareList;
  /** Text copied this session, newest first; kept in memory only. */
  clipboard = (): readonly string[] => this.clipboardList;

  rememberClipboard(text: string): void {
    this.clipboardList = Object.freeze([text, ...this.clipboardList.filter((entry) => entry !== text)]
      .slice(0, 20));
    for (const listener of this.listeners) listener();
  }

  clearClipboard(): void {
    this.clipboardList = Object.freeze([]);
    for (const listener of this.listeners) listener();
  }

  /** Apply a compositor message; returns false for messages the store ignores. */
  apply(message: ServerMessage): boolean {
    let windows = false;
    let outputs = false;
    switch (message.type) {
      case "welcome":
        this.display = message.display;
        this.instance = message.instance;
        this.windowMap = new Map(message.windows.map((window) => [window.id, toWindow(window)]));
        this.outputMap = new Map(message.outputs.map((output) => [output.name, toOutput(output)]));
        this.focusMap = new Map(message.focus.map((focus) => [focus.seat, focus.window]));
        this.cameraMap = new Map(message.cameras.map((camera) => [camera.output, toCamera(camera)]));
        this.modifierMap = new Map(
          message.modifiers.map((held) => [held.seat, Object.freeze(held.modifiers)]),
        );
        this.shareList = Object.freeze(message.shares ?? []);
        windows = outputs = true;
        break;
      case "camera":
        this.cameraMap.set(message.output, toCamera(message));
        break;
      case "window":
        this.windowMap.set(message.window.id, toWindow(message.window));
        windows = true;
        break;
      case "window-removed":
        windows = this.windowMap.delete(message.id);
        break;
      case "output":
        this.outputMap.set(message.output.name, toOutput(message.output));
        outputs = true;
        break;
      case "output-removed":
        outputs = this.outputMap.delete(message.name);
        break;
      case "focus":
        this.focusMap.set(message.seat, message.window);
        break;
      case "modifiers":
        this.modifierMap.set(message.seat, Object.freeze(message.modifiers));
        break;
      case "clipboard":
        this.rememberClipboard(message.text);
        return true;
      case "shares":
        this.shareList = Object.freeze(message.shares);
        break;
      default:
        return false;
    }
    // Unchanged collections keep their identity, so their readers skip rendering.
    if (windows) this.windowList = [...this.windowMap.values()].sort((left, right) => left.id - right.id);
    if (outputs) this.outputList = [...this.outputMap.values()].sort((left, right) => left.x - right.x);
    for (const listener of this.listeners) listener();
    return true;
  }

  getPersistent<T>(key: string, initial: () => T): T {
    if (!this.persistent.has(key)) this.persistent.set(key, initial());
    return this.persistent.get(key) as T;
  }

  setPersistent(key: string, value: unknown): void {
    if (Object.is(this.persistent.get(key), value)) return;
    this.persistent.set(key, value);
    for (const listener of this.persistentListeners.get(key) ?? []) listener();
    if (this.persistPath && !this.persistTimer) {
      // Bursts of changes, such as a drag's progress, write once.
      this.persistTimer = setTimeout(() => this.flushPersistent(), 500);
    }
  }

  /** Keep persistent values in PATH as JSON, starting from what it already holds. */
  persistTo(path: string): void {
    this.persistPath = path;
    try {
      const saved = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      for (const [key, value] of Object.entries(saved)) {
        if (!this.persistent.has(key)) this.persistent.set(key, value);
      }
    } catch {
      // A missing or unreadable file starts empty; the next write replaces it.
    }
  }

  flushPersistent(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    if (!this.persistPath) return;
    mkdirSync(dirname(this.persistPath), { recursive: true });
    const temporary = `${this.persistPath}.tmp`;
    writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.persistent)));
    renameSync(temporary, this.persistPath);
  }

  subscribePersistent(key: string, listener: Listener): () => void {
    let listeners = this.persistentListeners.get(key);
    if (!listeners) this.persistentListeners.set(key, listeners = new Set());
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
}
