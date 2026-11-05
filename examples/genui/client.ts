// A program's side of the generated UI protocol (protocol.ts), with nothing to
// install: connect, open interfaces, change them, hear what the person does.
//
//     const ui = new UIClient({ name: "Monitor" });
//     ui.open("cpu", { mode: "overlay", place: { anchor: "top-right" }, title: "CPU", spec });
//     ui.on("action", ({ id, action, params, state }) => …);
//     setInterval(() => ui.state("cpu", { "/load": load() }), 1000);
//
// It reconnects when the world reloads or restarts and opens its interfaces
// again as they were, with what the person last changed in them.

import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";
import { socketPath, type ClientMessage, type HostMessage, type Mode, type Place } from "./protocol.js";
import type { JsonPatch, Spec } from "proscenium/genui";

export type { JsonPatch, Mode, Place, Spec };

export interface OpenOptions {
  mode?: Mode;
  place?: Place;
  title?: string;
  /** Pixels; the mode's own by default. */
  width?: number;
  theme?: "light" | "dark";
  /** The whole spec at once. */
  spec?: Partial<Spec>;
  /** Patches building it, as a model streams them. */
  patches?: JsonPatch[];
  /** The assistant's: the chat message an inline interface belongs to. */
  message?: string;
}

export interface Result {
  ok: boolean;
  problems?: string[];
  error?: string;
  spec?: Spec;
  mode?: Mode;
  place?: Place;
  prompt?: string;
  components?: string[];
}

/** A change since an interface was opened: the program's patches or state, or the person's state. */
type Change = { patches: JsonPatch[] } | { set: Record<string, unknown> };

/**
 * What a program keeps of an interface, to open it again as it was: the spec it
 * was opened with (or last compacted to, state included), and every change
 * since, in the order it was made, so a reload replays them in that order.
 */
export interface Record_ {
  options: Omit<OpenOptions, "spec" | "patches">;
  spec?: Partial<Spec>;
  changes: Change[];
}

interface Kept extends Record_ {
  /** While a compaction is on its way: how many changes it covers, which later ones must not merge into. */
  compactAt?: number;
}

/** Changes kept before the log is folded into a fresh copy of the spec from the world. */
const compactAfter = 48;

type Events = {
  connect: [];
  disconnect: [];
  welcome: [Extract<HostMessage, { type: "welcome" }>];
  action: [Extract<HostMessage, { type: "action" }>];
  state: [Extract<HostMessage, { type: "state" }>];
  placed: [Extract<HostMessage, { type: "placed" }>];
  closed: [Extract<HostMessage, { type: "closed" }>];
  prompt: [string];
  abort: [];
  reset: [];
  error: [string];
  /** The world will not have this program (another assistant took the chat): it stops reconnecting. */
  fatal: [string];
};

export interface ClientOptions {
  name: string;
  /** This program is the assistant, which keeps the chat. */
  agent?: boolean;
  socket?: string;
  /** Keep trying to connect when there is no world yet or it goes away (default true). */
  reconnect?: boolean;
}

export class UIClient extends EventEmitter<Events> {
  private socket: Socket | null = null;
  private buffered = "";
  private connected = false;
  private closed = false;
  private retry = 200;
  private nextRequest = 1;
  private readonly waiting = new Map<number, (result: Result) => void>();
  private readonly kept = new Map<string, Kept>();
  readonly name: string;

  constructor(private readonly options: ClientOptions) {
    super();
    this.name = options.name;
    this.connect();
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Open interface ID, or change it if it is open: its options, spec and patches. */
  open(id: string, options: OpenOptions = {}): Promise<Result> {
    const { spec, patches, ...rest } = options;
    const kept = this.kept.get(id);
    if (kept && !spec) {
      kept.options = settle({ ...kept.options, ...rest });
      if (patches?.length) this.record(id, kept, { patches });
    } else {
      this.kept.set(id, { options: settle({ ...kept?.options, ...rest }), spec,
                          changes: patches?.length ? [{ patches: [...patches] }] : [] });
    }
    return this.request({ op: "open", id, ...options });
  }

  /** Apply json-render patches to ID; the answer lists what is wrong with its spec now. */
  patch(id: string, patches: JsonPatch[]): Promise<Result> {
    const kept = this.kept.get(id);
    if (kept && patches.length) this.record(id, kept, { patches });
    return this.request({ op: "patch", id, patches });
  }

  /** Set values in ID's state, by JSON pointer: `{ "/load": 0.4 }`. */
  state(id: string, set: Record<string, unknown>): void {
    const kept = this.kept.get(id);
    if (kept) this.record(id, kept, { set });
    this.send({ op: "state", id, set });
  }

  /** Move ID to another mode. */
  place(id: string, mode: Mode, place?: Place): void {
    const kept = this.kept.get(id);
    if (kept) kept.options = { ...kept.options, mode, place };
    this.send({ op: "place", id, mode, place });
  }

  /** Change ID's title, width or theme; the assistant also unlinks it from its chat message with `message: null`. */
  update(id: string, change: { title?: string; width?: number; theme?: "light" | "dark"; message?: string | null }): void {
    const kept = this.kept.get(id);
    if (kept) kept.options = settle({ ...kept.options, ...change });
    this.send({ op: "update", id, ...change });
  }

  close(id: string): void {
    this.kept.delete(id);
    this.send({ op: "close", id });
  }

  /** What this program keeps of its interfaces, to save and give back to restore() after a restart. */
  records(): Record<string, Record_> {
    return Object.fromEntries([...this.kept].map(([id, { options, spec, changes }]) => [id, { options, spec, changes }]));
  }

  /** Interfaces saved by records(), opened again on the next connection (now, if connected). */
  restore(records: Record<string, Record_>): void {
    for (const [id, record] of Object.entries(records)) {
      this.kept.set(id, { options: record.options, spec: record.spec, changes: record.changes ?? [] });
      if (this.connected) this.reopen(id, this.kept.get(id)!);
    }
  }

  /** CHANGE to ID, merged into the last change when both set state, and the log folded when long. */
  private record(id: string, kept: Kept, change: Change): void {
    const last = kept.changes.at(-1);
    const mergeable = last !== undefined && (kept.compactAt === undefined || kept.changes.length > kept.compactAt);
    if (mergeable && "patches" in change && "patches" in last) last.patches.push(...change.patches);
    else if (mergeable && "set" in change && "set" in last) {
      // Setting the whole state ("") makes every earlier value moot.
      kept.changes[kept.changes.length - 1] = { set: "" in change.set ? { ...change.set } : { ...last.set, ...change.set } };
    } else {
      kept.changes.push("patches" in change ? { patches: [...change.patches] } : { set: { ...change.set } });
    }
    if (kept.changes.length > compactAfter && kept.compactAt === undefined) void this.compact(id, kept);
  }

  /** Fold ID's change log into the spec and state the world has now, which every change sent so far is in. */
  private async compact(id: string, kept: Kept): Promise<void> {
    if (!this.connected) return;
    const covered = kept.changes.length;
    kept.compactAt = covered;
    const result = await this.get(id);
    kept.compactAt = undefined;
    // Closed or opened anew meanwhile: nothing to fold.
    if (!result.ok || !result.spec || this.kept.get(id) !== kept) return;
    kept.spec = result.spec;
    kept.changes.splice(0, covered);
  }

  /** Open ID in a world that does not know it: its spec, then its changes in order. */
  private reopen(id: string, kept: Kept): void {
    this.send({ op: "open", id, ...kept.options, spec: kept.spec });
    for (const change of kept.changes) {
      if ("patches" in change) this.send({ op: "patch", id, patches: change.patches });
      else this.send({ op: "state", id, set: change.set });
    }
  }

  /** ID's spec and state as the world has them now, with where it is. */
  get(id: string): Promise<Result> {
    return this.request({ op: "get", id, request: 0 });
  }

  /** The catalog prompt: how to write specs for the components the world draws. */
  catalog(): Promise<Result> {
    return this.request({ op: "catalog", request: 0 });
  }

  /** Whether ID is open, as far as this program knows. */
  has(id: string): boolean {
    return this.kept.has(id);
  }

  /** Send MESSAGE as it is (the assistant's chat messages). */
  send(message: ClientMessage): void {
    if (this.connected) this.socket?.write(JSON.stringify(message) + "\n");
  }

  disconnect(): void {
    this.closed = true;
    this.socket?.destroy();
  }

  private request(message: ClientMessage): Promise<Result> {
    if (!this.connected) return Promise.resolve({ ok: false, error: "Not connected to a world" });
    const request = this.nextRequest++;
    return new Promise((resolve) => {
      this.waiting.set(request, resolve);
      this.send({ ...message, request } as ClientMessage);
    });
  }

  private connect(): void {
    const socket = createConnection(this.options.socket ?? socketPath());
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      this.connected = true;
      this.retry = 200;
      this.send({ op: "hello", name: this.name, agent: this.options.agent });
      // A new world knows none of this program's interfaces: open them again.
      for (const [id, kept] of this.kept) this.reopen(id, kept);
      this.emit("connect");
    });
    socket.on("data", (chunk: string) => {
      this.buffered += chunk;
      let newline: number;
      while ((newline = this.buffered.indexOf("\n")) >= 0) {
        const line = this.buffered.slice(0, newline);
        this.buffered = this.buffered.slice(newline + 1);
        if (line.trim()) this.receive(JSON.parse(line) as HostMessage);
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      const was = this.connected;
      this.connected = false;
      this.buffered = "";
      for (const resolve of this.waiting.values()) resolve({ ok: false, error: "Disconnected" });
      this.waiting.clear();
      if (was) this.emit("disconnect");
      if (this.closed || this.options.reconnect === false) return;
      setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 2000);
    });
  }

  private receive(message: HostMessage): void {
    switch (message.type) {
      case "welcome":
        return void this.emit("welcome", message);
      case "result": {
        const resolve = this.waiting.get(message.request);
        this.waiting.delete(message.request);
        const { type: _, request: __, ...result } = message;
        return resolve?.(result);
      }
      case "action":
        return void this.emit("action", message);
      case "state": {
        // Kept in order with the program's own changes, so the person's survive the world reloading.
        const kept = this.kept.get(message.id);
        if (kept) this.record(message.id, kept, { set: { "": message.state } });
        return void this.emit("state", message);
      }
      case "placed": {
        const kept = this.kept.get(message.id);
        if (kept) kept.options = { ...kept.options, mode: message.mode, place: message.place };
        return void this.emit("placed", message);
      }
      case "closed":
        this.kept.delete(message.id);
        return void this.emit("closed", message);
      case "prompt":
        return void this.emit("prompt", message.text);
      case "abort":
        return void this.emit("abort");
      case "reset":
        return void this.emit("reset");
      case "error":
        if (message.fatal) {
          this.closed = true;
          return void this.emit("fatal", message.message);
        }
        return void this.emit("error", message.message);
    }
  }
}

/** OPTIONS with a cleared chat link (`message: null`) gone. */
function settle(options: Omit<OpenOptions, "spec" | "patches" | "message"> & { message?: string | null }):
    Omit<OpenOptions, "spec" | "patches"> {
  const { message, ...rest } = options;
  return message === null || message === undefined ? rest : { ...rest, message };
}
