// System state for world UI such as bars, kept in sources that run only while a
// component reads them. Each follows change events instead of polling: the
// clock fires at minute boundaries, sound follows PipeWire (pw-mon), the
// battery UPower (upower --monitor), the power profile and media players D-Bus
// signals, and applications their directories. An idle desktop therefore wakes
// the director once a minute for its clock and otherwise only when something
// changes.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

/** A value shared by every reader, with a feed that runs while anyone reads it. */
export class Source<T> {
  private readonly listeners = new Set<() => void>();
  private stop: (() => void) | null = null;

  constructor(
    public value: T,
    private readonly feed: (source: Source<T>) => () => void,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (!this.stop) this.stop = this.feed(this);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.stop) {
        this.stop();
        this.stop = null;
      }
    };
  };

  read = (): T => this.value;

  set(value: T): void {
    if (JSON.stringify(value) === JSON.stringify(this.value)) return;
    this.value = value;
    for (const listener of this.listeners) listener();
  }
}

/**
 * Run COMMAND for its lifetime, calling ONLINE for each output line, and GONE
 * if it fails or exits by itself; returns a stop function.
 */
export function follow(
  command: string,
  args: string[],
  online: (line: string) => void,
  gone: () => void = () => undefined,
): () => void {
  let stopped = false;
  let child: ChildProcess | null = null;
  try {
    child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    child.on("error", () => undefined);
    child.on("close", () => {
      if (!stopped) gone();
    });
    createInterface({ input: child.stdout! }).on("line", online);
  } catch {
    gone();
  }
  return () => {
    stopped = true;
    child?.kill();
  };
}

/** A sender that runs one request at a time, keeping only the newest value for the next. */
export function latestOnly<T>(send: (value: T) => Promise<unknown>): (value: T) => void {
  let running = false;
  let wanted: { value: T } | null = null;
  const next = (): void => {
    running = wanted !== null;
    if (!wanted) return;
    const { value } = wanted;
    wanted = null;
    void send(value).then(next);
  };
  return (value) => {
    wanted = { value };
    if (!running) next();
  };
}

export function run(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 3000 }, (error, stdout) => resolve(error ? null : stdout));
  });
}

/** Call FUNCTION once, a moment after the last of a burst of calls. */
export function debounced(function_: () => void, milliseconds: number): () => void {
  let timer: NodeJS.Timeout | null = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      function_();
    }, milliseconds);
  };
}
