// The world's side of the generated UI protocol (protocol.ts): a Unix socket
// programs connect to, the interfaces they own, and the assistant's chat. The
// world draws what this holds (Surfaces.tsx, Chat.tsx); nothing here draws.
//
// A program's interfaces close when it disconnects. A world reload starts a new
// host; programs that reconnect send their interfaces again (client.ts does).
// Apps (apps.ts) are programs too: the host starts and stops them when asked,
// and knows which connection is which app by its hello.

import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { copyData, getCamera } from "proscenium";
import { catalogPrompt, componentNames, Surface, type JsonPatch } from "proscenium/genui";
import { appEnded, appLog, appPid, appRunning, findApp, listApps, restartApp, runningApps, startApp, stopApp,
  subscribeApps, type AppManifest } from "./apps.js";
import { modes, protocolVersion, type AppInfo, type ChatMessage, type ClientMessage, type HostMessage, type Mode,
  type Place } from "./protocol.js";

export interface HostSurface {
  /** Unique across programs: the program's number and the id it gave. */
  key: string;
  id: string;
  client: number;
  /** The program's name, as it said hello. */
  owner: string;
  /** Made by the assistant, which can take it back into its chat. */
  agent: boolean;
  mode: Mode;
  place: Place;
  title?: string;
  width: number;
  theme: "light" | "dark";
  /** For an inline interface: the chat message it belongs to. */
  message?: string;
  surface: Surface;
  /** Rises each time it opens or moves, so the newest is on top. */
  raised: number;
  /** Counts its moves: a moved interface is drawn afresh where it lands. */
  placed: number;
}

export interface ChatSnapshot {
  /** An assistant is connected. */
  connected: boolean;
  messages: readonly ChatMessage[];
  busy: boolean;
  model?: string;
  error?: string | null;
}

/** A running app, for the chat to show. */
export interface AppStatus {
  name: string;
  interfaces: number;
}

export interface HostSnapshot {
  surfaces: readonly HostSurface[];
  chat: ChatSnapshot;
  /** The apps running now. */
  apps: readonly AppStatus[];
}

interface Client {
  id: number;
  socket: Socket;
  name: string;
  agent: boolean;
  /** The app it is, and its process, as it said hello. */
  app?: string;
  pid?: number;
  /** When it last opened or patched an interface: an app that just started has settled once this is a moment ago. */
  changedAt: number;
  /** Messages it has sent that were handled: a state event says how many it covers. */
  received: number;
  surfaces: Set<string>;
}

/** A program's message for an app, on its way or waiting for the app's answer. */
interface Ask {
  id: number;
  /** The program that told it, and its request to answer. */
  from: number;
  request: number;
  app: string;
  message: unknown;
  reply: boolean;
  /** The app's connection it went to; none while it waits for the app. */
  to?: number;
  /** Times it was handed to the app: one that keeps failing on it is not handed it forever. */
  tries: number;
}

const widths: Record<Mode, number> = { inline: 0, floating: 360, overlay: 300, dock: 320, canvas: 380, dialog: 420 };
const maxWidth = 900;

let raises = 0;

export class UIHost {
  private server: Server | null = null;
  private path = "";
  private readonly clients = new Map<number, Client>();
  private readonly surfaces = new Map<string, HostSurface>();
  private readonly unsubscribe = new Map<string, () => void>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly asks = new Map<number, Ask>();
  private nextAsk = 1;
  private nextClient = 1;
  /** While a program changes an interface's state, which is not news to it. */
  private quiet = false;
  private chat: ChatSnapshot = { connected: false, messages: [], busy: false };
  private snapshot: HostSnapshot = { surfaces: [], chat: this.chat, apps: [] };
  private stopWatchingApps: (() => void) | null = null;
  private readonly listeners = new Set<() => void>();
  screen = { width: 1280, height: 720 };
  /** Output whose camera canvas cards open under. */
  output: string | undefined;

  listen(path: string): void {
    this.path = path;
    rmSync(path, { force: true });
    this.server = createServer((socket) => this.serve(socket));
    this.server.on("error", (error) => console.error(`[genui] ${error.message}`));
    this.server.listen(path);
    this.stopWatchingApps = subscribeApps(() => this.changed());
  }

  close(): void {
    for (const client of this.clients.values()) client.socket.destroy();
    this.clients.clear();
    this.server?.close();
    this.server = null;
    if (this.path) rmSync(this.path, { force: true });
    for (const timer of this.pending.values()) clearTimeout(timer);
    for (const stop of this.unsubscribe.values()) stop();
    this.stopWatchingApps?.();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): HostSnapshot => this.snapshot;

  // What the person does.

  /** Move an interface to MODE, telling its program. */
  place(key: string, mode: Mode, place: Place = {}): void {
    const found = this.surfaces.get(key);
    if (!found) return;
    // Only the assistant's interfaces can live in its chat.
    if (mode === "inline" && !(found.agent && found.message)) return;
    found.mode = mode;
    found.place = this.defaultPlace(mode, place, found.width);
    found.raised = ++raises;
    found.placed++;
    this.send(found.client, { type: "placed", id: found.id, mode, place: found.place });
    this.changed();
  }

  /**
   * Move a card pinned to the canvas to (X, Y) in the world, telling its program. It stays
   * the same card, carried there rather than drawn afresh, so it doesn't fade in again.
   */
  carry(key: string, x: number, y: number): void {
    const found = this.surfaces.get(key);
    if (!found || found.mode !== "canvas") return;
    found.place = { x: Math.round(x), y: Math.round(y) };
    found.raised = ++raises;
    this.send(found.client, { type: "placed", id: found.id, mode: found.mode, place: found.place });
    this.changed();
  }

  private move(found: HostSurface, mode: Mode, place: Place): void {
    found.mode = mode;
    found.place = this.defaultPlace(mode, place, found.width);
    found.raised = ++raises;
    found.placed++;
  }

  /** Bring an interface to the top of its layer. */
  raise(key: string): void {
    const found = this.surfaces.get(key);
    if (!found || found.raised === raises) return;
    found.raised = ++raises;
    this.changed();
  }

  /** The person closed an interface. */
  dismiss(key: string): void {
    const found = this.surfaces.get(key);
    if (!found) return;
    this.remove(key);
    this.send(found.client, { type: "closed", id: found.id, by: "person" });
    this.changed();
  }

  /** An action from an interface that it does not handle itself. */
  act(key: string, action: string, params: Record<string, unknown>): void {
    const found = this.surfaces.get(key);
    if (!found) return;
    if (action === "close") return this.dismiss(key);
    if (action === "copy") {
      void copyData("text/plain;charset=utf-8", new TextEncoder().encode(String(params.text ?? "")));
      return;
    }
    this.flushState(key);
    this.send(found.client, { type: "action", id: found.id, action, params, state: found.surface.state.getSnapshot(),
                              seen: this.clients.get(found.client)?.received ?? 0 });
  }

  prompt(text: string): void {
    const agent = this.agent();
    if (agent) this.send(agent.id, { type: "prompt", text });
  }

  abort(): void {
    const agent = this.agent();
    if (agent) this.send(agent.id, { type: "abort" });
  }

  resetChat(): void {
    const agent = this.agent();
    if (agent) this.send(agent.id, { type: "reset" });
  }

  get agentConnected(): boolean {
    return this.agent() !== undefined;
  }

  /** Start app NAME, as the person asked, or have it show itself if it runs. */
  startApp(name: string): void {
    const app = appRunning(name) ? this.appClient(name) : undefined;
    if (app) return this.send(app.id, { type: "show" });
    const started = startApp(name);
    if (!started.ok) console.error(`[genui] ${name}: ${started.error}`);
  }

  /** Stop app NAME, as the person asked. */
  stopApp(name: string): void {
    void stopApp(name);
  }

  // Apps.

  private appInfo(manifest: AppManifest): AppInfo {
    const interfaces: AppInfo["interfaces"] = [];
    for (const client of this.clients.values()) {
      if (client.app !== manifest.name) continue;
      for (const key of client.surfaces) {
        const found = this.surfaces.get(key);
        if (found) interfaces.push({ id: found.id, title: found.title, mode: found.mode,
                                     problems: found.surface.problems(componentNames) });
      }
    }
    return { name: manifest.name, title: manifest.title, description: manifest.description, builtin: manifest.builtin,
             dir: manifest.dir, running: appRunning(manifest.name), pid: appPid(manifest.name), interfaces,
             ended: appEnded(manifest.name) };
  }

  /**
   * The connection of app NAME's current process, once it has said hello; or
   * the latest by that name, for an app whose program is not the process
   * started (`sh -c`, `npm start`).
   */
  private appClient(name: string): Client | undefined {
    const pid = appPid(name);
    let named: Client | undefined;
    for (const client of this.clients.values()) {
      if (client.app !== name) continue;
      if (pid && client.pid === pid) return client;
      named = client;
    }
    return named;
  }

  /**
   * Start app NAME (again, with RESTART) and answer once it has shown what it
   * shows at first: its interfaces have stopped changing for a moment, it ended,
   * or six seconds went by (an app that shows nothing yet).
   */
  private async launch(client: Client, name: string, restart: boolean, request: number): Promise<void> {
    const manifest = findApp(name);
    if (!manifest) return this.send(client.id, { type: "result", request, ok: false, error: `No app "${name}"` });
    // Asked for again while it runs: it shows itself, as it decides.
    const wasRunning = appRunning(name);
    if (wasRunning && !restart) {
      const app = this.appClient(name);
      if (app) this.send(app.id, { type: "show" });
    }
    const started = restart ? await restartApp(name) : startApp(name);
    if (!started.ok) return this.send(client.id, { type: "result", request, ok: false, error: started.error });
    const since = Date.now();
    while (Date.now() - since < 6000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!appRunning(name)) break;
      const app = this.appClient(name);
      if (app && app.surfaces.size > 0 && Date.now() - app.changedAt > 600) break;
    }
    const info = this.appInfo(manifest);
    this.send(client.id, { type: "result", request, ok: info.running, app: info, log: appLog(name),
                           error: info.running ? undefined : `It ${info.ended ?? "ended"}` });
  }

  // Programs.

  private agent(): Client | undefined {
    for (const client of this.clients.values()) if (client.agent) return client;
    return undefined;
  }

  private serve(socket: Socket): void {
    const client: Client = { id: this.nextClient++, socket, name: "program", agent: false, changedAt: 0, received: 0,
                             surfaces: new Set() };
    this.clients.set(client.id, client);
    socket.setEncoding("utf8");
    let buffered = "";
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      if (buffered.length > 32 * 1024 * 1024) return void socket.destroy();
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (!line.trim()) continue;
        client.received++;
        let message: ClientMessage;
        try {
          message = JSON.parse(line) as ClientMessage;
        } catch {
          this.send(client.id, { type: "error", message: `Not JSON: ${line.slice(0, 80)}` });
          continue;
        }
        try {
          this.receive(client, message);
        } catch (error) {
          this.send(client.id, { type: "error", message: error instanceof Error ? error.message : String(error) });
        }
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => this.drop(client));
    this.send(client.id, { type: "welcome", protocol: protocolVersion, modes, screen: this.screen });
  }

  private drop(client: Client): void {
    if (!this.clients.delete(client.id)) return;
    for (const key of client.surfaces) this.remove(key);
    for (const ask of [...this.asks.values()]) {
      if (ask.from === client.id) {
        // What needs no answer still reaches the app; a question goes with the one who asked.
        if (!ask.reply) continue;
        this.asks.delete(ask.id);
        if (ask.to !== undefined) this.send(ask.to, { type: "untold", ask: ask.id });
      } else if (ask.to === client.id) {
        // The app went before it answered: the next one it starts as gets the question.
        ask.to = undefined;
        if (ask.tries >= 3) this.settle(ask, { ok: false, error: `${ask.app} ended three times without answering` });
        else {
          // It quit with a question left: start it again to answer it, once its end is known.
          setTimeout(() => {
            if (this.asks.get(ask.id) === ask && ask.to === undefined && !appRunning(ask.app)) startApp(ask.app);
          }, 1500).unref();
        }
      }
    }
    if (client.agent) this.chat = { ...this.chat, connected: this.agent() !== undefined, busy: false };
    this.changed();
  }

  private receive(client: Client, message: ClientMessage): void {
    switch (message.op) {
      case "hello":
        client.name = String(message.name || "program").slice(0, 60);
        if (typeof message.app === "string" && message.app) client.app = message.app;
        if (typeof message.pid === "number") client.pid = message.pid;
        if (client.app) this.deliver(client.app);
        if (message.agent) {
          // One assistant keeps the chat; a newer one replaces it, as a newer director does.
          const older = this.agent();
          if (older && older !== client) {
            this.send(older.id, { type: "error", message: "Another assistant took the chat.", fatal: true });
            older.socket.end();
            this.drop(older);
          }
          client.agent = true;
          // Nothing of the one before is this one's: it says its own model and chat.
          this.chat = { connected: true, messages: [], busy: false };
          this.changed();
        }
        return;
      case "catalog":
        this.send(client.id, { type: "result", request: message.request, ok: true, prompt: catalogPrompt(),
                               components: componentNames });
        return;
      case "open":
        client.changedAt = Date.now();
        return this.open(client, message);
      case "apps":
        this.send(client.id, { type: "result", request: message.request, ok: true,
                               apps: listApps().map((manifest) => this.appInfo(manifest)) });
        return;
      case "launch":
        void this.launch(client, String(message.app ?? ""), message.restart === true, message.request)
          .catch((error) => this.send(client.id, { type: "result", request: message.request, ok: false,
                                                   error: error instanceof Error ? error.message : String(error) }));
        return;
      case "stop": {
        const name = String(message.app ?? "");
        // One whose folder went while it ran can still be stopped.
        if (!findApp(name) && !appRunning(name)) {
          return this.send(client.id, { type: "result", request: message.request, ok: false, error: `No app "${name}"` });
        }
        void stopApp(name).then(() => this.send(client.id, { type: "result", request: message.request, ok: true }));
        return;
      }
      case "tell":
        return this.tell(client, message);
      case "answer": {
        const ask = this.asks.get(message.ask);
        if (!ask || ask.to !== client.id) return;
        this.settle(ask, message.error === undefined ? { ok: true, value: message.value }
          : { ok: false, error: String(message.error) });
        return;
      }
      case "patch": {
        const found = this.own(client, message.id);
        client.changedAt = Date.now();
        const problems = this.patch(found, message.patches);
        if (message.request !== undefined) {
          this.send(client.id, { type: "result", request: message.request, ok: true,
                                 problems: [...problems, ...found.surface.problems(componentNames)] });
        }
        return;
      }
      case "state": {
        const found = this.own(client, message.id);
        this.quietly(() => found.surface.state.update(message.set ?? {}));
        return;
      }
      case "update": {
        const found = this.own(client, message.id);
        if (message.title !== undefined) found.title = String(message.title);
        if (message.width !== undefined) found.width = clampWidth(message.width);
        if (message.theme !== undefined) found.theme = message.theme === "dark" ? "dark" : "light";
        if (message.message === null) {
          found.message = undefined;
          // Nothing in the chat shows it any more: it floats instead.
          if (found.mode === "inline") this.move(found, "floating", {});
        } else if (message.message !== undefined && client.agent) {
          found.message = String(message.message);
        }
        this.changed();
        return;
      }
      case "place": {
        const found = this.own(client, message.id);
        if (!modes.includes(message.mode)) throw new Error(`No mode "${message.mode}"`);
        if (message.mode === "inline" && !(found.agent && found.message)) throw new Error("Only the assistant's interfaces live in its chat");
        found.mode = message.mode;
        found.place = this.defaultPlace(message.mode, message.place ?? {}, found.width);
        found.raised = ++raises;
        found.placed++;
        this.changed();
        return;
      }
      case "close": {
        const key = `${client.id}:${message.id}`;
        if (!this.surfaces.has(key)) return;
        this.remove(key);
        this.changed();
        return;
      }
      case "get": {
        const found = this.surfaces.get(`${client.id}:${message.id}`);
        if (!found) return this.send(client.id, { type: "result", request: message.request, ok: false, error: `No interface "${message.id}"` });
        this.send(client.id, { type: "result", request: message.request, ok: true, spec: found.surface.toJSON(),
                               mode: found.mode, place: found.place });
        return;
      }
      case "chat": {
        if (!client.agent) throw new Error("Only the assistant keeps the chat");
        this.chat = { ...this.chat, messages: message.messages ?? [] };
        // An interface whose message is gone stays where the person put it, with no chat to go back to.
        const kept = new Set(this.chat.messages.map((each) => each.id));
        for (const key of client.surfaces) {
          const found = this.surfaces.get(key);
          if (found?.message && !kept.has(found.message)) {
            if (found.mode === "inline") this.remove(key);
            else found.message = undefined;
          }
        }
        this.changed();
        return;
      }
      case "message": {
        if (!client.agent) throw new Error("Only the assistant keeps the chat");
        const messages = [...this.chat.messages];
        const at = messages.findIndex((existing) => existing.id === message.message.id);
        if (at >= 0) messages[at] = message.message;
        else messages.push(message.message);
        this.chat = { ...this.chat, messages };
        this.changed();
        return;
      }
      case "status":
        if (!client.agent) throw new Error("Only the assistant keeps the chat");
        this.chat = { ...this.chat, busy: message.busy, model: message.model ?? this.chat.model,
                      error: message.error === undefined ? this.chat.error : message.error };
        this.changed();
        return;
      default:
        throw new Error(`Unknown op "${(message as { op?: string }).op}"`);
    }
  }

  /** Hand a program's message to an app, starting the app if it does not run. */
  private tell(client: Client, message: Extract<ClientMessage, { op: "tell" }>): void {
    const name = String(message.app ?? "");
    if (!findApp(name) && !appRunning(name)) {
      return this.send(client.id, { type: "result", request: message.request, ok: false, error: `No app "${name}"` });
    }
    const ask: Ask = { id: this.nextAsk++, from: client.id, request: message.request, app: name, message: message.message,
                       reply: message.reply === true, tries: 0 };
    this.asks.set(ask.id, ask);
    if (!appRunning(name)) {
      const started = startApp(name);
      if (!started.ok) return this.settle(ask, { ok: false, error: started.error });
    }
    this.deliver(name);
    // An app that never comes to take it.
    setTimeout(() => {
      if (this.asks.get(ask.id) === ask && ask.to === undefined) this.settle(ask, { ok: false, error: `${name} did not start` });
    }, 15_000).unref();
  }

  /** Hand app NAME what waits for it, once it is connected. */
  private deliver(name: string): void {
    const app = this.appClient(name);
    if (!app) return;
    for (const ask of [...this.asks.values()]) {
      if (ask.app !== name || ask.to !== undefined) continue;
      ask.to = app.id;
      ask.tries++;
      this.send(app.id, { type: "told", ask: ask.id, from: this.clients.get(ask.from)?.name ?? "program",
                          message: ask.message, reply: ask.reply });
      if (!ask.reply) this.settle(ask, { ok: true });
    }
  }

  private settle(ask: Ask, result: { ok: boolean; value?: unknown; error?: string }): void {
    this.asks.delete(ask.id);
    this.send(ask.from, { type: "result", request: ask.request, ...result });
  }

  private open(client: Client, message: Extract<ClientMessage, { op: "open" }>): void {
    const id = String(message.id ?? "");
    if (!id) throw new Error("open needs an id");
    const key = `${client.id}:${id}`;
    let found = this.surfaces.get(key);
    const mode: Mode = message.mode && modes.includes(message.mode) ? message.mode
      : found?.mode ?? (client.agent && message.message ? "inline" : "floating");
    if (mode === "inline" && !(client.agent && (message.message ?? found?.message))) {
      throw new Error("Only the assistant's interfaces live in its chat, in a message");
    }
    if (!found) {
      const width = clampWidth(message.width ?? widths[mode]);
      found = {
        key, id, client: client.id, owner: client.name, agent: client.agent, mode,
        place: this.defaultPlace(mode, message.place ?? {}, width),
        title: message.title, width, theme: message.theme === "dark" ? "dark" : "light",
        message: message.message, surface: new Surface(), raised: ++raises, placed: 0,
      };
      this.surfaces.set(key, found);
      client.surfaces.add(key);
      const surface = found;
      this.unsubscribe.set(key, surface.surface.state.subscribe(() => this.stateChanged(surface)));
    } else {
      if (message.mode && message.mode !== found.mode) {
        found.mode = mode;
        found.place = this.defaultPlace(mode, message.place ?? {}, found.width);
        found.raised = ++raises;
        found.placed++;
      } else if (message.place) {
        found.place = this.defaultPlace(mode, message.place, found.width);
      }
      if (message.title !== undefined) found.title = message.title;
      if (message.width !== undefined) found.width = clampWidth(message.width);
      if (message.theme !== undefined) found.theme = message.theme === "dark" ? "dark" : "light";
      if (message.message !== undefined) found.message = message.message;
    }
    const surface = found;
    if (message.spec) this.quietly(() => surface.surface.reset(message.spec!));
    const problems = message.patches ? this.patch(surface, message.patches) : [];
    if (message.request !== undefined) {
      this.send(client.id, { type: "result", request: message.request, ok: true, mode: surface.mode, place: surface.place,
                             problems: [...problems, ...surface.surface.problems(componentNames)] });
    }
    this.changed();
  }

  private patch(found: HostSurface, patches: JsonPatch[] | undefined): string[] {
    if (!Array.isArray(patches)) return ["patches must be a list"];
    let problems: string[] = [];
    this.quietly(() => (problems = found.surface.apply(patches)));
    return problems;
  }

  private own(client: Client, id: string): HostSurface {
    const found = this.surfaces.get(`${client.id}:${id}`);
    if (!found) throw new Error(`No interface "${id}"; open it first`);
    return found;
  }

  private quietly(change: () => void): void {
    const was = this.quiet;
    this.quiet = true;
    try {
      change();
    } finally {
      this.quiet = was;
    }
  }

  /** The person changed an interface's state: tell its program soon, once. */
  private stateChanged(found: HostSurface): void {
    if (this.quiet) return;
    clearTimeout(this.pending.get(found.key));
    this.pending.set(found.key, setTimeout(() => this.flushState(found.key), 120));
  }

  private flushState(key: string): void {
    const timer = this.pending.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.pending.delete(key);
    const found = this.surfaces.get(key);
    if (found) {
      this.send(found.client, { type: "state", id: found.id, state: found.surface.state.getSnapshot(),
                                seen: this.clients.get(found.client)?.received ?? 0 });
    }
  }

  private remove(key: string): void {
    const found = this.surfaces.get(key);
    if (!found) return;
    this.surfaces.delete(key);
    this.clients.get(found.client)?.surfaces.delete(key);
    this.unsubscribe.get(key)?.();
    this.unsubscribe.delete(key);
    clearTimeout(this.pending.get(key));
    this.pending.delete(key);
  }

  /** PLACE with what MODE needs filled in: floating cards cascade from the middle, canvas cards open in view. */
  private defaultPlace(mode: Mode, place: Place, width: number): Place {
    const { width: screenWidth, height: screenHeight } = this.screen;
    const count = [...this.surfaces.values()].filter((surface) => surface.mode === mode).length % 6;
    switch (mode) {
      // Whole pixels, so a card's text is sharp wherever a program puts it.
      case "floating":
        return { x: Math.round(place.x ?? (screenWidth - width) / 2 + 28 * count),
                 y: Math.round(place.y ?? screenHeight * 0.2 + 28 * count) };
      case "canvas": {
        if (place.x !== undefined && place.y !== undefined) return { x: Math.round(place.x), y: Math.round(place.y) };
        const camera = getCamera(this.output);
        return { x: Math.round((camera?.x ?? screenWidth / 2) - width / 2 + 28 * count),
                 y: Math.round((camera?.y ?? screenHeight / 2) - 120 + 28 * count) };
      }
      case "overlay":
        return { anchor: place.anchor ?? "top-right" };
      case "dock":
        return { side: place.side === "left" ? "left" : "right" };
      default:
        return {};
    }
  }

  private send(client: number, message: HostMessage): void {
    const socket = this.clients.get(client)?.socket;
    if (socket && !socket.destroyed) socket.write(JSON.stringify(message) + "\n");
  }

  /** The running apps and how many interfaces each shows: the same list as before while that holds. */
  private appStatus(): readonly AppStatus[] {
    const counts = new Map<string, number>(runningApps().map((name) => [name, 0]));
    for (const client of this.clients.values()) {
      if (client.app && counts.has(client.app)) counts.set(client.app, counts.get(client.app)! + client.surfaces.size);
    }
    const apps = [...counts].map(([name, interfaces]) => ({ name, interfaces })).sort((a, b) => a.name.localeCompare(b.name));
    const before = this.snapshot.apps;
    const same = before.length === apps.length
      && apps.every((app, index) => app.name === before[index]!.name && app.interfaces === before[index]!.interfaces);
    return same ? before : apps;
  }

  /** The copies last shown, so an interface that did not change keeps its object and its card does not render. */
  private readonly shown = new Map<string, HostSurface>();

  private changed(): void {
    let same = this.shown.size === this.surfaces.size;
    const surfaces: HostSurface[] = [];
    for (const surface of [...this.surfaces.values()].sort((a, b) => a.raised - b.raised)) {
      const before = this.shown.get(surface.key);
      if (before && sameRecord(before, surface)) surfaces.push(before);
      else {
        const copy = { ...surface, place: { ...surface.place } };
        this.shown.set(surface.key, copy);
        surfaces.push(copy);
        same = false;
      }
    }
    for (const key of this.shown.keys()) if (!this.surfaces.has(key)) this.shown.delete(key);
    same &&= surfaces.every((surface, index) => surface === this.snapshot.surfaces[index]);
    this.snapshot = { surfaces: same ? this.snapshot.surfaces : surfaces, chat: this.chat, apps: this.appStatus() };
    for (const listener of [...this.listeners]) listener();
  }
}

function sameRecord(a: HostSurface, b: HostSurface): boolean {
  return a.mode === b.mode && a.raised === b.raised && a.placed === b.placed && a.title === b.title && a.width === b.width
    && a.theme === b.theme && a.message === b.message && a.owner === b.owner
    && a.place.x === b.place.x && a.place.y === b.place.y && a.place.anchor === b.place.anchor && a.place.side === b.place.side;
}

function clampWidth(width: unknown): number {
  const value = Number(width);
  return Number.isFinite(value) && value > 0 ? Math.min(Math.max(Math.round(value), 160), maxWidth) : widths.floating;
}

// The assistant runs as a program of its own, started once per director and
// kept across world reloads, which only make it reconnect.

interface Kept {
  child?: ChildProcess;
  exitHooked?: boolean;
  /** Started by this director and not stopped: a crash starts it again. */
  wanted?: boolean;
  /** Seconds before the next start after a crash, doubling to a limit, and when the last one started. */
  backoff?: number;
  startedAt?: number;
  restart?: ReturnType<typeof setTimeout>;
}

const kept = ((globalThis as Record<string, unknown>).__prosceniumAssistant ??= {}) as Kept;

/**
 * Start the assistant (PROGRAM, through RUNNER under node) unless it is running.
 * It belongs to this director: it stops when the director exits, and starts
 * again if it crashes. An assistant that exits cleanly (stopped, or replaced by
 * another that took the chat) is left stopped.
 */
export function startAssistant(runner: string, program: string, socket: string): void {
  kept.wanted = true;
  if (kept.child && kept.child.exitCode === null && kept.child.signalCode === null) return;
  clearTimeout(kept.restart);
  const child = spawn(process.execPath, [runner, program], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, PROSCENIUM_UI_SOCKET: socket, NODE_ENV: "production" },
  });
  child.on("error", (error) => console.error(`[genui] assistant: ${error.message}`));
  child.on("exit", (code, signal) => {
    if (kept.child === child) kept.child = undefined;
    const crashed = code !== 0 && signal !== "SIGTERM";
    if (!crashed || !kept.wanted) return;
    // A run that lasted a minute was not a crash loop: start again soon.
    const lasted = Date.now() - (kept.startedAt ?? 0);
    kept.backoff = lasted > 60_000 ? 1 : Math.min((kept.backoff ?? 0.5) * 2, 30);
    console.error(`[genui] the assistant stopped (${signal ?? `exit ${code}`}); starting it again in ${kept.backoff} s`);
    kept.restart = setTimeout(() => startAssistant(runner, program, socket), kept.backoff * 1000);
  });
  kept.child = child;
  kept.startedAt = Date.now();
  if (!kept.exitHooked) {
    kept.exitHooked = true;
    process.on("exit", () => {
      kept.wanted = false;
      kept.child?.kill();
    });
  }
}

/** Stop the assistant this director started, for good. */
export function stopAssistant(): void {
  kept.wanted = false;
  clearTimeout(kept.restart);
  kept.child?.kill();
  kept.child = undefined;
}
