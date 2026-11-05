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

interface Kept {
  options: Omit<OpenOptions, "spec" | "patches">;
  spec?: Partial<Spec>;
  patches: JsonPatch[];
  state?: Record<string, unknown>;
}

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
      kept.options = { ...kept.options, ...rest };
      if (patches) kept.patches.push(...patches);
    } else {
      this.kept.set(id, { options: { ...kept?.options, ...rest }, spec, patches: [...(patches ?? [])],
                          state: undefined });
    }
    return this.request({ op: "open", id, ...options });
  }

  /** Apply json-render patches to ID; the answer lists what is wrong with its spec now. */
  patch(id: string, patches: JsonPatch[]): Promise<Result> {
    this.kept.get(id)?.patches.push(...patches);
    return this.request({ op: "patch", id, patches });
  }

  /** Set values in ID's state, by JSON pointer: `{ "/load": 0.4 }`. */
  state(id: string, set: Record<string, unknown>): void {
    const kept = this.kept.get(id);
    if (kept) kept.state = { ...kept.state, ...set };
    this.send({ op: "state", id, set });
  }

  /** Move ID to another mode. */
  place(id: string, mode: Mode, place?: Place): void {
    const kept = this.kept.get(id);
    if (kept) kept.options = { ...kept.options, mode, place };
    this.send({ op: "place", id, mode, place });
  }

  /** Change ID's title, width or theme. */
  update(id: string, change: { title?: string; width?: number; theme?: "light" | "dark" }): void {
    const kept = this.kept.get(id);
    if (kept) kept.options = { ...kept.options, ...change };
    this.send({ op: "update", id, ...change });
  }

  close(id: string): void {
    this.kept.delete(id);
    this.send({ op: "close", id });
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
      for (const [id, kept] of this.kept) {
        this.send({ op: "open", id, ...kept.options, spec: kept.spec, patches: kept.patches });
        if (kept.state) this.send({ op: "state", id, set: kept.state });
      }
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
        // Kept, so the person's changes survive the world reloading.
        const kept = this.kept.get(message.id);
        if (kept) kept.state = flatten(message.state);
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
        return void this.emit("error", message.message);
    }
  }
}

/** A whole state as one pointer to replace: the root. */
function flatten(state: Record<string, unknown>): Record<string, unknown> {
  return { "": state };
}
