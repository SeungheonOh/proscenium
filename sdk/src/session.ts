// One director session: the compositor connection, mirrored state, and the
// React root rendering into it. A process hosts a single session, which hooks
// and actions reach through `currentSession`.

import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReactNode } from "react";
import { Connection } from "./connection.js";
import { Container, createRoot, reconciler } from "./host.js";
import type { StageInputEvent, StageKeyEvent } from "./events.js";
import type { ServerMessage } from "./protocol.js";
import { type Motion, wireMotion } from "./motion.js";
import { Store, type Rectangle } from "./store.js";

export interface CameraMove {
  x?: number;
  y?: number;
  zoom?: number;
  /** Degrees. */
  rotation?: number;
}

/** A window, or an output or a region of it in its logical pixels. */
export type ShareSource = { window: number } | { output?: string; region?: Rectangle };

/** Straight-alpha RGBA pixels, top row first. */
export interface Screenshot {
  width: number;
  height: number;
  pixels: Uint8Array;
}

export interface SessionOptions {
  socket: string;
  /** Exit once this process is no longer our parent, i.e. the compositor died. */
  parentPid?: number;
  onError?: (error: unknown) => void;
  /** The compositor refused this director for good, e.g. a newer one replaced it. */
  onRejected?: (reason: string) => void;
}

let current: Session | null = null;

export function currentSession(): Session {
  if (!current) throw new Error("No Stage session is running; start one with run().");
  return current;
}

export class Session {
  readonly store = new Store();
  private readonly container: Container;
  private readonly root: ReturnType<typeof createRoot>;
  private readonly connection: Connection;
  private readonly onError: (error: unknown) => void;
  private readonly onRejected: (reason: string) => void;
  private readonly screenshots = new Map<number, {
    resolve: (shot: Screenshot) => void; reject: (error: Error) => void }>();
  private nextScreenshot = 1;
  private nextClipboardFile = 1;
  /** Whoever holds the keyboard, latest last: only the latest hears keys. */
  private readonly grabs: ((event: StageKeyEvent) => void)[] = [];
  private readonly watchers = new Set<(event: StageInputEvent) => void>();

  constructor(options: SessionOptions) {
    if (current) throw new Error("A Stage session is already running.");
    current = this;
    this.onError = options.onError ?? ((error) => console.error("[stage]", error));
    this.onRejected = options.onRejected ?? (() => undefined);
    this.container = new Container({
      send: (ops) => this.connection.send({ type: "commit", ops }),
      measure: (requests) => this.connection.send({ type: "measure", requests }),
      onError: this.onError,
    });
    this.root = createRoot(this.container, this.onError);
    this.connection = new Connection(options.socket, {
      message: (message) => this.receive(message),
      // Whatever is committed while disconnected is replayed on reconnect.
      closed: () => {
        this.container.requestResync();
        for (const { reject } of this.screenshots.values()) reject(new Error("The compositor went away."));
        this.screenshots.clear();
      },
      orphaned: () => this.onRejected("The compositor exited."),
    }, options.parentPid);
  }

  start(): void {
    this.connection.start();
  }

  /** Disconnect and unmount the world now, so its effects clean up, e.g. stop child processes. */
  stop(): void {
    this.connection.stop();
    reconciler.flushSyncFromReconciler(() =>
      reconciler.updateContainer(null, this.root, null, () => undefined));
    current = null;
  }

  render(element: ReactNode): void {
    reconciler.updateContainer(element, this.root, null, () => undefined);
  }

  focus(window: number | null): void {
    this.connection.send({ type: "focus", window });
  }

  close(window: number): void {
    this.connection.send({ type: "close", window });
  }

  /** Share WINDOW, or OUTPUT (or a REGION of it), for screen-sharing request ID. */
  acceptShare(id: number, source: ShareSource): void {
    this.connection.send({ type: "share-accept", id, ...source });
  }

  /** Decline a screen-sharing request, or stop a running share. */
  cancelShare(id: number): void {
    this.connection.send({ type: "share-cancel", id });
  }

  /** Capture SOURCE at full resolution, as the outputs show it now. */
  screenshot(source: ShareSource = {}): Promise<Screenshot> {
    if (!this.connection.connected) return Promise.reject(new Error("Not connected to the compositor."));
    const id = this.nextScreenshot++;
    return new Promise((resolve, reject) => {
      this.screenshots.set(id, { resolve, reject });
      this.connection.send({ type: "capture", id, ...source });
    });
  }

  private async receiveScreenshot(message: Extract<ServerMessage, { type: "captured" }>): Promise<void> {
    const pending = this.screenshots.get(message.id);
    this.screenshots.delete(message.id);
    if (!message.path) {
      pending?.reject(new Error(message.error ?? "The compositor could not take the screenshot."));
      return;
    }
    try {
      const pixels = await readFile(message.path);
      pending?.resolve({ width: message.width ?? 0, height: message.height ?? 0, pixels });
    } catch (error) {
      pending?.reject(error as Error);
    } finally {
      await rm(message.path, { force: true });
    }
  }

  /** Put TEXT on the clipboard, as if a client had copied it. */
  copy(text: string): void {
    this.store.rememberClipboard(text);
    this.connection.send({ type: "set-clipboard", text });
  }

  /** Put DATA on the clipboard as MIME, e.g. a PNG as "image/png". */
  async copyData(mime: string, data: Uint8Array): Promise<void> {
    // The compositor reads the file from the runtime directory and deletes it.
    const directory = process.env.XDG_RUNTIME_DIR ?? tmpdir();
    const path = join(directory, `proscenium-clipboard-${process.pid}-${this.nextClipboardFile++}`);
    await writeFile(path, data, { mode: 0o600 });
    if (this.connection.connected) this.connection.send({ type: "set-clipboard", mime, path });
    else await rm(path, { force: true });
  }

  /**
   * Take the keyboard: until released, keys no shortcut takes go to HANDLER
   * instead of windows and pages, which lose keyboard focus meanwhile. A later
   * grab takes over from an earlier one until it is released.
   */
  grabKeyboard(handler: (event: StageKeyEvent) => void): () => void {
    this.grabs.push(handler);
    if (this.grabs.length === 1) this.sendGrab();
    return () => {
      const index = this.grabs.lastIndexOf(handler);
      if (index < 0) return;
      this.grabs.splice(index, 1);
      if (this.grabs.length === 0) this.sendGrab();
    };
  }

  /** Hear of every key and button press, scroll and gesture start, which still reach their targets. */
  watchInput(handler: (event: StageInputEvent) => void): () => void {
    this.watchers.add(handler);
    if (this.watchers.size === 1) this.sendWatch();
    return () => {
      if (this.watchers.delete(handler) && this.watchers.size === 0) this.sendWatch();
    };
  }

  private sendGrab(): void {
    if (this.connection.connected) this.connection.send({ type: "grab-keyboard", grab: this.grabs.length > 0 });
  }

  private sendWatch(): void {
    if (this.connection.connected) this.connection.send({ type: "watch-input", watch: this.watchers.size > 0 });
  }

  /** Move the pointer to (X, Y) on OUTPUT, in its logical pixels. */
  warpPointer(output: string, x: number, y: number): void {
    this.connection.send({ type: "warp-pointer", output, x, y });
  }

  moveCamera(move: CameraMove, options: { output?: string; transition?: Motion } = {}): void {
    this.connection.send({
      type: "camera", output: options.output ?? null, x: move.x, y: move.y, zoom: move.zoom,
      rotation: move.rotation === undefined ? undefined : move.rotation * Math.PI / 180,
      transition: options.transition ? wireMotion(options.transition) : undefined,
    });
  }

  /** Start a client of this compositor, detached from the director's lifetime. */
  launch(command: string | readonly string[]): void {
    const [file, ...args] = typeof command === "string" ? ["/bin/sh", "-c", command] : command;
    if (!file) throw new TypeError("launch() needs a command.");
    const child = spawn(file, args, {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, WAYLAND_DISPLAY: this.store.display || process.env.WAYLAND_DISPLAY },
    });
    child.on("error", this.onError);
    child.unref();
  }

  private receive(message: ServerMessage): void {
    try {
      switch (message.type) {
        case "event":
          this.container.dispatch(message);
          break;
        case "error":
          console.error(`[stage] compositor: ${message.message}`);
          if (message.fatal) {
            this.connection.stop();
            this.onRejected(message.message);
          }
          break;
        case "captured":
          void this.receiveScreenshot(message);
          break;
        case "measured":
          this.container.receiveMeasurements(message.results);
          break;
        case "key": {
          const { type: _, ...event } = message;
          this.grabs[this.grabs.length - 1]?.(event);
          break;
        }
        case "input": {
          const { type: _, ...event } = message;
          for (const watcher of [...this.watchers]) watcher(event);
          break;
        }
        case "welcome":
          this.store.apply(message);
          // A new connection starts with the keyboard free and nothing watched.
          if (this.grabs.length) this.sendGrab();
          if (this.watchers.size) this.sendWatch();
          this.container.requestResync();
          // Before React's first commit there is nothing to show yet; replaying
          // an empty tree would briefly hide every window.
          if (this.container.committed) this.container.flush();
          break;
        default:
          this.store.apply(message);
      }
    } catch (error) {
      this.onError(error);
    }
  }
}
