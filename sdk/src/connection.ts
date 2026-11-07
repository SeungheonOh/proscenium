// Director side of the Stage socket: newline-delimited JSON with automatic
// reconnection. A timer exists only while disconnected; a connected, idle
// director wakes for nothing but compositor messages. A send reports when the
// socket holds more than it takes at once, so a director producing faster than
// the compositor reads can wait for `drained` instead of queueing without end.

import { connect, type Socket } from "node:net";
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from "./protocol.js";

export interface ConnectionHandlers {
  message(message: ServerMessage): void;
  closed(): void;
  /** The compositor that launched this director died, so it will never return. */
  orphaned(): void;
  /** Everything sent has reached the socket, after a send that returned false. */
  drained(): void;
}

const RETRY_MIN_MS = 100;
const RETRY_MAX_MS = 2000;

export class Connection {
  private socket: Socket | null = null;
  private ready = false;
  private buffer = "";
  private retryMs = RETRY_MIN_MS;
  private retry: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly path: string, private readonly handlers: ConnectionHandlers,
              private readonly parentPid?: number) {}

  get connected(): boolean {
    return this.ready;
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.socket?.destroy();
  }

  /**
   * Send MESSAGE, unless not connected. False when the socket already holds more
   * than it takes at once: what follows waits in memory until `drained`.
   */
  send(message: ClientMessage): boolean {
    if (!this.ready) return true;
    return this.socket!.write(JSON.stringify(message) + "\n");
  }

  private open(): void {
    // A compositor that launched this director and then died will never
    // return; stopping avoids an orphan retrying forever.
    if (this.parentPid !== undefined && process.ppid !== this.parentPid) {
      this.stopped = true;
      this.handlers.orphaned();
      return;
    }
    const socket = connect(this.path);
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      this.retryMs = RETRY_MIN_MS;
      this.buffer = "";
      const hello: ClientMessage = { type: "hello", protocol: PROTOCOL_VERSION, client: "proscenium" };
      socket.write(JSON.stringify(hello) + "\n");
    });
    socket.on("data", (chunk: string) => this.receive(chunk));
    socket.on("drain", () => this.handlers.drained());
    socket.on("error", () => undefined);
    socket.on("close", () => {
      const wasReady = this.ready;
      this.ready = false;
      this.socket = null;
      if (wasReady) this.handlers.closed();
      if (!this.stopped) {
        this.retry = setTimeout(() => { this.retry = null; this.open(); }, this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
      }
    });
  }

  private receive(chunk: string): void {
    const lines = (this.buffer + chunk).split("\n");
    this.buffer = lines.pop()!;
    for (const line of lines) {
      if (line.length === 0) continue;
      const message = JSON.parse(line) as ServerMessage;
      // Scene commits are only meaningful after the compositor's snapshot.
      if (message.type === "welcome") this.ready = true;
      this.handlers.message(message);
    }
  }
}
