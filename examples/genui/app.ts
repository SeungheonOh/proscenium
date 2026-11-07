// The app library: a program that owns its interfaces and runs their logic.
// An app imports it as "proscenium-app" (run.mjs resolves it here):
//
//     import { app } from "proscenium-app";
//
//     const ui = app();
//     const view = ui.open("main", { mode: "floating", title: "Timer", width: 300, spec });
//     view.on("start", () => view.set({ "/running": true }));
//     setInterval(() => view.set("/left", format(left())), 1000);
//
// An element's `on: { press: { action: "start", params } }` calls the handler
// for "start" with PARAMS; setState, pushState, removeState, close and copy
// still run in the world without a round trip. view.state is the interface's
// state as it is now, with what the person typed or toggled in it.
//
// An app quits once it shows nothing (the person closed the last of it, or its
// last note went); one with background set keeps running with nothing open, and
// ui.onShow says what to do when it is asked for again while it runs. Its data
// (ui.load, ui.save) and where the person last put each interface outlive it.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UIClient, type Change, type JsonPatch, type Mode, type OpenOptions, type Place, type Spec } from "./client.js";
import { appStateFolder, type Anchor } from "./protocol.js";

export type { JsonPatch, Mode, Place, Spec };
export type State = Record<string, unknown>;
export type Element = Spec["elements"][string];

export interface ViewOptions extends Omit<OpenOptions, "spec" | "patches" | "message"> {
  /** The whole interface: root, elements and its starting state. */
  spec: Partial<Spec>;
}

export type ActionHandler = (params: Record<string, unknown>, view: View, action: string) => unknown;

/** What a program told the app: who, and a signal that aborts if it leaves before the answer. */
export interface Told {
  from: string;
  /** It waits for the answer: the handler's return value (or what its promise gives). */
  reply: boolean;
  signal: AbortSignal;
}

export type MessageHandler = (message: unknown, told: Told) => unknown;

export interface AppOptions {
  /** Its name when run by hand; the world's name for it ($PROSCENIUM_APP) when the world started it. */
  name?: string;
  /** Shown beside its interfaces' titles; the app.json title when the world started it. */
  title?: string;
  /** Keep running with nothing open, instead of quitting once it shows nothing. */
  background?: boolean;
}

/** Connect as an app. */
export function app(options: AppOptions = {}): App {
  return new App(options);
}

interface Remembered {
  /** The mode and place the app asked for: the person's choice holds while the app asks the same. */
  asked: string;
  mode: Mode;
  place: Place;
}

export class App {
  readonly name: string;
  readonly title: string;
  readonly client: UIClient;
  /** A folder of its own, kept across runs. */
  readonly data: string;
  /** The screen's size in pixels, once connected. */
  screen = { width: 1280, height: 720 };
  private keepRunning: boolean;
  /** It has shown something: until then, showing nothing is not a reason to quit. */
  private shown = false;
  private readonly views = new Map<string, View>();
  private readonly quits: (() => void)[] = [];
  private readonly shows: (() => unknown)[] = [];
  private readonly messages: MessageHandler[] = [];
  private readonly asked = new Map<number, AbortController>();
  private readonly places: Record<string, Remembered>;
  private notes = 0;

  constructor(options: AppOptions) {
    // The world knows it by its folder's name, whatever it calls itself.
    this.name = process.env.PROSCENIUM_APP || options.name || "app";
    this.keepRunning = options.background === true;
    this.title = options.title ?? (process.env.PROSCENIUM_APP_TITLE || this.name);
    this.data = process.env.PROSCENIUM_APP_DATA || appStateFolder(this.name);
    mkdirSync(this.data, { recursive: true });
    this.places = this.read("places.json", {});
    this.client = new UIClient({ name: this.title, app: this.name });
    const parent = process.ppid;
    this.client.on("welcome", ({ screen }) => (this.screen = screen));
    this.client.on("action", ({ id, action, params, state, pending }) => {
      const view = this.views.get(id);
      if (!view) return;
      view.state = withChanges(state, pending);
      view.dispatch(action, params);
    });
    this.client.on("state", ({ id, state, pending }) => {
      const view = this.views.get(id);
      if (!view) return;
      view.state = withChanges(state, pending);
      view.changed();
    });
    this.client.on("placed", ({ id, mode, place }) => {
      const view = this.views.get(id);
      if (!view?.remember) return;
      this.places[id] = { asked: view.asked, mode, place };
      this.write("places.json", this.places);
    });
    this.client.on("closed", ({ id }) => {
      const view = this.views.get(id);
      if (!view) return;
      this.views.delete(id);
      view.ended();
      this.quitIfIdle();
    });
    this.client.on("show", () => {
      for (const show of this.shows) guard(this.name, show);
    });
    this.client.on("told", ({ ask, from, message, reply }) => void this.told(ask, from, message, reply));
    this.client.on("untold", (ask) => {
      this.asked.get(ask)?.abort();
      this.asked.delete(ask);
    });
    this.client.on("error", (message) => console.error(`[${this.name}] ${message}`));
    this.client.on("disconnect", () => {
      // Started by a world that is gone (it crashed): the next one starts this again.
      if (process.env.PROSCENIUM_APP && process.ppid !== parent) process.exit(0);
    });
    process.on("SIGTERM", () => this.quit());
    process.on("exit", () => {
      for (const quit of this.quits.splice(0)) {
        try {
          quit();
        } catch (error) {
          console.error(error);
        }
      }
    });
    process.on("uncaughtException", (error) => console.error(`[${this.name}]`, error));
    process.on("unhandledRejection", (error) => console.error(`[${this.name}]`, error));
  }

  /**
   * Keep running with nothing open, as a timer that alerts once its card is
   * closed; turned off with nothing open, it quits.
   */
  get background(): boolean {
    return this.keepRunning;
  }

  set background(on: boolean) {
    this.keepRunning = on;
    if (!on) this.quitIfIdle();
  }

  /** Quit if it shows nothing now and has nothing to run for, once what runs now has had its say. */
  private quitIfIdle(): void {
    setImmediate(() => {
      if (this.shown && !this.keepRunning && this.views.size === 0) this.quit();
    });
  }

  /**
   * Open interface ID, or open it anew with a new spec. It opens in the mode
   * asked for, or where the person last put it while the app asks for the same.
   */
  open(id: string, options: ViewOptions, internal: { transient?: boolean } = {}): View {
    const asked = JSON.stringify([options.mode ?? "floating", options.place ?? {}]);
    const remembered = internal.transient ? undefined : this.places[id];
    const where = remembered && remembered.asked === asked ? { mode: remembered.mode, place: remembered.place }
      : { mode: options.mode ?? "floating", place: options.place };
    let view = this.views.get(id);
    if (!view) {
      view = new View(this, id);
      this.views.set(id, view);
    }
    view.asked = asked;
    view.remember = !internal.transient;
    view.state = structuredClone(options.spec.state ?? {});
    this.shown = true;
    void this.client.open(id, { ...options, ...where }).then((result) => {
      for (const problem of result.problems ?? []) console.error(`[${this.name}] ${id}: ${problem}`);
    });
    return view;
  }

  /** @internal VIEW closed: it is no longer the app's. */
  forget(view: View): void {
    if (this.views.get(view.id) === view) this.views.delete(view.id);
    this.quitIfIdle();
  }

  /** Interface ID, while it is open. */
  view(id: string): View | undefined {
    return this.views.get(id);
  }

  /** A note over everything for SECONDS (6 by default), in a corner. */
  notify(text: string, options: { title?: string; seconds?: number; anchor?: Anchor } = {}): void {
    const id = `note-${++this.notes}`;
    const view = this.open(id, {
      mode: "overlay", place: { anchor: options.anchor ?? "top-right" }, title: options.title ?? this.title, width: 300,
      spec: { root: "text", elements: { text: { type: "Markdown", props: { text }, children: [] } } },
    }, { transient: true });
    setTimeout(() => view.close(), (options.seconds ?? 6) * 1000);
  }

  /** The app's saved data, or FALLBACK (merged under it, for an object) before anything was saved. */
  load<T>(fallback: T): T {
    const saved = this.read<T | undefined>("data.json", undefined);
    if (saved === undefined) return fallback;
    if (isObject(fallback) && isObject(saved)) return { ...fallback, ...saved };
    return saved;
  }

  /** Save the app's data, for load() after a restart. */
  save(value: unknown): void {
    this.write("data.json", value);
  }

  /** Run SHOW when the app is asked for again while it runs, as from the chat: open what it shows if it is closed. */
  onShow(show: () => unknown): this {
    this.shows.push(show);
    return this;
  }

  /**
   * Run HANDLER for what programs tell the app (`proscenium-ui tell NAME JSON`,
   * or a client's tell()). What it returns, or its promise gives, is the answer
   * a program that waits gets; told.signal aborts if that program leaves first.
   */
  onMessage(handler: MessageHandler): this {
    this.messages.push(handler);
    return this;
  }

  private async told(ask: number, from: string, message: unknown, reply: boolean): Promise<void> {
    const controller = new AbortController();
    if (reply) this.asked.set(ask, controller);
    let value: unknown;
    let error: string | undefined;
    try {
      for (const handler of this.messages) {
        const answer = await handler(message, { from, reply, signal: controller.signal });
        if (answer !== undefined) value = answer;
      }
      if (!this.messages.length) error = `${this.name} takes no messages`;
    } catch (thrown) {
      console.error(`[${this.name}]`, thrown);
      error = thrown instanceof Error ? thrown.message : String(thrown);
    }
    if (!reply || controller.signal.aborted) return;
    this.asked.delete(ask);
    this.client.answer(ask, value, error);
  }

  /** Run QUIT when the app stops, however it stops; it must not wait for anything. */
  onQuit(quit: () => void): this {
    this.quits.push(quit);
    return this;
  }

  /** Stop: its interfaces close with it. Exit code 0 tells the world it ended by itself. */
  quit(code = 0): never {
    process.exit(code);
  }

  private read<T>(file: string, fallback: T): T {
    try {
      return JSON.parse(readFileSync(join(this.data, file), "utf8")) as T;
    } catch {
      return fallback;
    }
  }

  private write(file: string, value: unknown): void {
    const path = join(this.data, file);
    writeFileSync(`${path}.new`, JSON.stringify(value));
    renameSync(`${path}.new`, path);
  }
}

/** One of an app's interfaces. */
export class View {
  /** The interface's state now: its spec's, the app's changes and the person's. */
  state: State = {};
  /** Whether it is still open. */
  open = true;
  /** @internal */ asked = "";
  /** @internal */ remember = true;
  private readonly actions = new Map<string, ActionHandler[]>();
  private readonly changes: ((state: State, view: View) => unknown)[] = [];
  private readonly closes: ((view: View) => unknown)[] = [];

  constructor(private readonly app: App, readonly id: string) {}

  /** The value at PATH in its state, a JSON pointer such as "/items/0/done". */
  get(path: string): unknown {
    let value: unknown = this.state;
    for (const part of pointer(path)) {
      if (value === null || typeof value !== "object") return undefined;
      value = (value as Record<string, unknown>)[part];
    }
    return value;
  }

  /**
   * Set state by JSON pointer: set("/left", "04:59"), or several at once,
   * set({ "/left": "04:59", "/running": true }). A key without its leading
   * slash is a top-level one, so the object a spec's state starts as can be set
   * as it is: set({ left: "04:59", running: true }). Undefined removes a value.
   */
  set(path: string, value: unknown): void;
  set(values: Record<string, unknown>): void;
  set(path: string | Record<string, unknown>, value?: unknown): void {
    if (!this.open) return;
    const values: Record<string, unknown> = {};
    const removed: JsonPatch[] = [];
    for (const [key, each] of Object.entries(typeof path === "string" ? { [path]: value } : path)) {
      const at = key === "" || key.startsWith("/") ? key : `/${key}`;
      // JSON has no undefined: a removal goes as a patch.
      if (each === undefined && at !== "") removed.push({ op: "remove", path: `/state${at}` });
      else values[at] = each;
    }
    if (Object.keys(values).length) {
      this.state = withChanges(this.state, [{ set: values }]);
      this.app.client.state(this.id, values);
    }
    if (removed.length) this.patch(removed);
  }

  /** Change its spec by JSON patches: /root, /elements/KEY, /state/PATH. */
  patch(patches: JsonPatch[]): void {
    if (!this.open) return;
    this.state = withChanges(this.state, [{ patches }]);
    void this.app.client.patch(this.id, patches).then((result) => {
      for (const problem of result.problems ?? []) console.error(`[${this.app.name}] ${this.id}: ${problem}`);
    });
  }

  /** Put ELEMENT at KEY in its spec, adding it or replacing the one there. */
  element(key: string, element: Element): void {
    this.patch([{ op: "add", path: `/elements/${key}`, value: element }]);
  }

  /** Change its title, width or theme. */
  update(change: { title?: string; width?: number; theme?: "light" | "dark" }): void {
    if (this.open) this.app.client.update(this.id, change);
  }

  /** Move it to MODE, over where the person put it. */
  place(mode: Mode, place?: Place): void {
    if (!this.open) return;
    this.asked = JSON.stringify([mode, place ?? {}]);
    this.app.client.place(this.id, mode, place);
  }

  close(): void {
    if (!this.open) return;
    this.app.client.close(this.id);
    this.app.forget(this);
    this.ended();
  }

  /** Run HANDLER when an element sends ACTION ("*" for any action). */
  on(action: string, handler: ActionHandler): this {
    this.actions.set(action, [...(this.actions.get(action) ?? []), handler]);
    return this;
  }

  /** Run HANDLER when the person changes its state: typing, toggling, choosing. */
  onChange(handler: (state: State, view: View) => unknown): this {
    this.changes.push(handler);
    return this;
  }

  /** Run HANDLER when it closes, by the person or the app. */
  onClose(handler: (view: View) => unknown): this {
    this.closes.push(handler);
    return this;
  }

  /** @internal */
  dispatch(action: string, params: Record<string, unknown>): void {
    const handlers = [...(this.actions.get(action) ?? []), ...(this.actions.get("*") ?? [])];
    if (!handlers.length) console.error(`[${this.app.name}] ${this.id}: nothing handles the action "${action}"`);
    for (const handler of handlers) guard(this.app.name, () => handler(params, this, action));
  }

  /** @internal */
  changed(): void {
    for (const handler of this.changes) guard(this.app.name, () => handler(this.state, this));
  }

  /** @internal */
  ended(): void {
    if (!this.open) return;
    this.open = false;
    for (const handler of this.closes) guard(this.app.name, () => handler(this));
  }
}

/** Run a handler; what it throws goes to the app's log, and the app keeps running. */
function guard(name: string, run: () => unknown): void {
  try {
    const result = run();
    if (result instanceof Promise) result.catch((error) => console.error(`[${name}]`, error));
  } catch (error) {
    console.error(`[${name}]`, error);
  }
}

/** STATE with CHANGES made to it in order: sets by pointer, and patches' changes under /state. */
function withChanges(state: State, changes: readonly Change[]): State {
  let next = state;
  for (const change of changes) {
    if ("set" in change) {
      for (const [at, value] of Object.entries(change.set)) next = setAt(next, at, value);
      continue;
    }
    for (const patch of change.patches) {
      if (patch.path !== "/state" && !patch.path.startsWith("/state/")) continue;
      const at = patch.path.slice("/state".length);
      if (patch.op === "add") next = setAt(next, at, patch.value, true);
      else if (patch.op === "replace") next = setAt(next, at, patch.value);
      else if (patch.op === "remove") next = setAt(next, at, undefined);
    }
  }
  return next;
}

function pointer(path: string): string[] {
  if (path === "" || path === "/") return [];
  return path.replace(/^\//, "").split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** STATE with VALUE at PATH (undefined removes it), copied along the way; INSERT puts it before an array's item, as JSON Patch's add. */
function setAt(state: State, path: string, value: unknown, insert = false): State {
  const parts = pointer(path);
  if (!parts.length) return isObject(value) ? { ...value } : {};
  const root: State = { ...state };
  let node: Record<string, unknown> | unknown[] = root;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    const last = index === parts.length - 1;
    if (Array.isArray(node)) {
      const at = part === "-" ? node.length : Number(part);
      if (last) {
        if (value === undefined) node.splice(at, 1);
        else if (insert) node.splice(at, 0, value);
        else node[at] = value;
        return root;
      }
      const next: unknown = node[at];
      const copy: Record<string, unknown> | unknown[] = Array.isArray(next) ? [...next] : isObject(next) ? { ...next } : {};
      node[at] = copy;
      node = copy;
    } else {
      if (last) {
        if (value === undefined) delete node[part];
        else node[part] = value;
        return root;
      }
      const next: unknown = node[part];
      const copy: Record<string, unknown> | unknown[] = Array.isArray(next) ? [...next] : isObject(next) ? { ...next } : {};
      node[part] = copy;
      node = copy;
    }
  }
  return root;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
