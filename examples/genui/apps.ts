// Apps: programs kept in a folder of their own, which the world starts, keeps
// running and starts again when it does. An app owns the interfaces it opens and
// runs their logic itself (app.ts is its library); the world only draws them.
//
// Apps live in two places, the person's folder winning over Proscenium's:
//   $XDG_DATA_HOME/proscenium/apps/NAME/   the person's own, and the ones the assistant writes
//   examples/genui/apps/NAME/              the ones that ship with Proscenium
// Each holds main.ts (or main.js, main.mjs) and an app.json: { "title", "description" },
// or a "command" ([program, ...args], run in the folder) for an app in any language.
//
// Running apps belong to the director: they stop when it exits and start again
// with the next one, from running.json. An app that ends by itself (exit 0, as
// when it shows nothing any more) or is stopped stays stopped; one that crashes
// starts again after a pause that doubles while it keeps crashing (1, 2, 4, 8
// seconds), until it has crashed five times in a row within a minute of starting.
// Each runs in a process group of its own, so a terminal's Ctrl-C reaches only
// the director, which stops them as it goes.

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, copyFileSync, cpSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync,
  renameSync, rmSync, statSync, truncateSync, writeSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appName, appsFolder, appStateFolder } from "./protocol.js";

export interface AppManifest {
  name: string;
  title: string;
  description?: string;
  builtin: boolean;
  dir: string;
  /** The program: run.mjs and the entry for TypeScript and JavaScript, else the manifest's command. */
  entry?: string;
  command?: string[];
}

interface Run {
  child: ChildProcess;
  started: number;
  /** Stopped on purpose: its end is not a crash. */
  stopping?: boolean;
  /** Its end was seen: the process exited, or never started. */
  over?: boolean;
  ended: Promise<void>;
  end: () => void;
}

interface Kept {
  runner?: string;
  socket?: string;
  builtin?: string;
  runs: Map<string, Run>;
  /** Apps that should be running: started and not stopped or ended by themselves. Saved in running.json. */
  wanted: Set<string>;
  backoff: Map<string, number>;
  /** Crashes in a row, each within a minute of starting. */
  crashes: Map<string, number>;
  restarts: Map<string, ReturnType<typeof setTimeout>>;
  /** How each app's last run ended. */
  ended: Map<string, string>;
  listeners: Set<() => void>;
  resumed?: boolean;
  exitHooked?: boolean;
  /** The director is stopping: apps that end now are not stopped or crashed, and come back with the next one. */
  leaving?: boolean;
  logWatch?: ReturnType<typeof setInterval>;
}

// Kept across world reloads, which only make running apps reconnect.
const kept = ((globalThis as Record<string, unknown>).__prosceniumApps ??= {
  runs: new Map(), wanted: new Set(), backoff: new Map(), crashes: new Map(), restarts: new Map(), ended: new Map(),
  listeners: new Set(),
}) as Kept;
// Kept by an older version of this file, before a world reload.
kept.crashes ??= new Map();

const entries = ["main.ts", "main.tsx", "main.mjs", "main.js"];
/** An app's log is moved to log.1 past this, at its start and while it runs. */
const logLimit = 512 * 1024;
/** The line that starts each run in an app's log. */
const startLine = (at: Date) => `=== ${at.toISOString()} started\n`;
const startMark = /(?:^|\n)=== \d{4}-\d\d-\d\dT[\d:.]+Z started\n/g;

/**
 * Where apps run from (RUNNER, run.mjs), what they connect to (SOCKET) and where
 * Proscenium's own are (BUILTIN). The first call also starts the apps that were
 * running when the last director stopped.
 */
export function configureApps(options: { runner: string; socket: string; builtin: string }): void {
  kept.runner = options.runner;
  kept.socket = options.socket;
  kept.builtin = options.builtin;
  if (kept.resumed) return;
  kept.resumed = true;
  let names: unknown = [];
  try {
    names = JSON.parse(readFileSync(runningFile(), "utf8"));
  } catch {}
  for (const name of Array.isArray(names) ? names.filter((each): each is string => typeof each === "string") : []) {
    const started = startApp(name);
    if (!started.ok) console.error(`[genui] ${name}: ${started.error}`);
  }
}

export function subscribeApps(listener: () => void): () => void {
  kept.listeners.add(listener);
  return () => kept.listeners.delete(listener);
}

function changed(): void {
  for (const listener of [...kept.listeners]) listener();
}

/** Every app there is, by name; the person's hide Proscenium's of the same name. */
export function listApps(): AppManifest[] {
  const found = new Map<string, AppManifest>();
  for (const [folder, builtin] of [[kept.builtin, true], [appsFolder(), false]] as const) {
    if (!folder || !existsSync(folder)) continue;
    for (const name of readdirSync(folder).sort()) {
      if (!appName.test(name)) continue;
      const manifest = readManifest(join(folder, name), name, builtin);
      if (manifest) found.set(name, manifest);
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findApp(name: string): AppManifest | undefined {
  if (!appName.test(name)) return undefined;
  const own = readManifest(join(appsFolder(), name), name, false);
  if (own) return own;
  return kept.builtin ? readManifest(join(kept.builtin, name), name, true) : undefined;
}

function readManifest(dir: string, name: string, builtin: boolean): AppManifest | undefined {
  try {
    if (!statSync(dir).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(readFileSync(join(dir, "app.json"), "utf8")) as Record<string, unknown>;
  } catch {}
  const command = Array.isArray(json.command) && json.command.length && json.command.every((word) => typeof word === "string")
    ? json.command as string[] : undefined;
  const named = typeof json.entry === "string" ? [json.entry] : entries;
  const entry = command ? undefined : named.map((file) => join(dir, file)).find((file) => existsSync(file));
  if (!command && !entry) return undefined;
  return {
    name, builtin, dir, entry, command,
    title: typeof json.title === "string" && json.title ? json.title : name.replace(/^./, (first) => first.toUpperCase()),
    description: typeof json.description === "string" ? json.description : undefined,
  };
}

export function appRunning(name: string): boolean {
  return kept.runs.has(name);
}

export function appPid(name: string): number | undefined {
  return kept.runs.get(name)?.child.pid;
}

export function appEnded(name: string): string | undefined {
  return kept.ended.get(name);
}

/** The names of the apps running now. */
export function runningApps(): string[] {
  return [...kept.runs.keys()];
}

/** Start app NAME unless it runs. */
export function startApp(name: string): { ok: boolean; error?: string } {
  if (kept.runs.has(name)) return { ok: true };
  if (kept.leaving) return { ok: false, error: "The world is stopping" };
  // Started anew, not again after a crash: its crashes so far are forgiven.
  if (!kept.wanted.has(name)) {
    kept.crashes.delete(name);
    kept.backoff.delete(name);
  }
  clearTimeout(kept.restarts.get(name));
  kept.restarts.delete(name);
  const manifest = findApp(name);
  const failed = (error: string) => {
    // One that should be running and can't be (its folder went, its program is missing) stays stopped.
    if (kept.wanted.delete(name)) saveRunning();
    if (manifest) kept.ended.set(name, error);
    changed();
    return { ok: false, error };
  };
  if (!manifest) return failed(`No app "${name}"`);
  if (!manifest.command && !kept.runner) return failed("No world is running apps");
  const state = appStateFolder(name);
  const log = join(state, "log");
  const [program, ...args] = manifest.command ?? [process.execPath, kept.runner!, manifest.entry!];
  let fd: number | undefined;
  let child: ChildProcess;
  try {
    mkdirSync(state, { recursive: true });
    rotate(log);
    fd = openSync(log, "a");
    writeSync(fd, startLine(new Date()));
    child = spawn(program!, args, {
      cwd: manifest.dir, stdio: ["ignore", fd, fd], detached: true,
      env: { ...process.env, PROSCENIUM_UI_SOCKET: kept.socket, PROSCENIUM_APP: name, PROSCENIUM_APP_TITLE: manifest.title,
             PROSCENIUM_APP_DIR: manifest.dir, PROSCENIUM_APP_DATA: state, NODE_ENV: "production" },
    });
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  let end!: () => void;
  const run: Run = { child, started: Date.now(), ended: new Promise((resolve) => (end = resolve)), end };
  child.on("error", (error) => {
    // A program that is not there, or can't be run, never exits: this is its end.
    if (child.pid === undefined) finish(name, run, { failure: error.message });
    else appendLog(name, error.message);
  });
  child.on("exit", (code, signal) => finish(name, run, { code, signal }));
  kept.runs.set(name, run);
  kept.ended.delete(name);
  kept.wanted.add(name);
  saveRunning();
  hookDirector();
  changed();
  return { ok: true };
}

/** RUN of app NAME is over: stopped, ended by itself, crashed (to start again soon) or never started. */
function finish(name: string, run: Run, how: { code?: number | null; signal?: NodeJS.Signals | null; failure?: string }): void {
  if (run.over) return;
  run.over = true;
  if (kept.runs.get(name) === run) kept.runs.delete(name);
  run.end();
  // The director is going, and its apps with it: they run again with the next one.
  if (kept.leaving) return;
  const { code, signal, failure } = how;
  // run.mjs turns SIGTERM into exit 143, and the app library into exit 0.
  const stopped = run.stopping || signal === "SIGTERM" || code === 143;
  const crash = failure ? `could not start: ${failure}` : signal ? `killed by ${signal}` : `exited with ${code}`;
  kept.ended.set(name, stopped ? "stopped" : code === 0 ? "ended by itself" : crash);
  appendLog(name, kept.ended.get(name)!);
  if (stopped || code === 0 || failure) {
    kept.wanted.delete(name);
    saveRunning();
  } else if (kept.wanted.has(name)) {
    // A run that lasted a minute was not a crash loop: start again soon.
    const lasted = Date.now() - run.started;
    const crashes = lasted > 60_000 ? 1 : (kept.crashes.get(name) ?? 0) + 1;
    kept.crashes.set(name, crashes);
    if (crashes >= 5) {
      kept.wanted.delete(name);
      saveRunning();
      kept.ended.set(name, `${crash}, five times in a row; left stopped`);
      appendLog(name, "crashed five times in a row; left stopped");
      return changed();
    }
    const backoff = lasted > 60_000 ? 1 : Math.min((kept.backoff.get(name) ?? 0.5) * 2, 30);
    kept.backoff.set(name, backoff);
    appendLog(name, `starting again in ${backoff} s`);
    kept.restarts.set(name, setTimeout(() => {
      kept.restarts.delete(name);
      if (kept.wanted.has(name)) startApp(name);
    }, backoff * 1000));
  }
  changed();
}

/** Once per director: its apps go with it, and their logs are kept short while they run. */
function hookDirector(): void {
  if (kept.exitHooked) return;
  kept.exitHooked = true;
  // Stopping, it unmounts and then exits: what ends meanwhile is not the person's doing.
  const leave = () => void (kept.leaving = true);
  process.on("SIGTERM", leave);
  process.on("SIGINT", leave);
  // The director's apps go with it; running.json brings them back with the next one.
  process.on("exit", () => {
    kept.leaving = true;
    for (const each of kept.runs.values()) signalGroup(each.child, "SIGTERM");
  });
  kept.logWatch = setInterval(() => {
    for (const name of kept.runs.keys()) rotate(join(appStateFolder(name), "log"), true);
  }, 30_000);
  kept.logWatch.unref();
}

/** SIGNAL to CHILD and what it started: it leads a process group of its own. */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

/** Move LOG to log.1 once it is long. One that is open (RUNNING) is copied and emptied: the app keeps writing to it. */
function rotate(log: string, running = false): void {
  try {
    if (statSync(log).size <= logLimit) return;
    if (!running) return renameSync(log, `${log}.1`);
    copyFileSync(log, `${log}.1`);
    truncateSync(log, 0);
    writeFileSync(log, "--- the log was long: what came before is in log.1\n", { flag: "a" });
  } catch {}
}

/** Stop app NAME, for good: politely, then by force after three seconds. */
export async function stopApp(name: string): Promise<void> {
  kept.wanted.delete(name);
  clearTimeout(kept.restarts.get(name));
  kept.restarts.delete(name);
  saveRunning();
  const run = kept.runs.get(name);
  if (!run) return changed();
  run.stopping = true;
  signalGroup(run.child, "SIGTERM");
  const force = setTimeout(() => signalGroup(run.child, "SIGKILL"), 3000);
  await run.ended;
  clearTimeout(force);
}

/** Start app NAME again, as after its code changed. */
export async function restartApp(name: string): Promise<{ ok: boolean; error?: string }> {
  await stopApp(name);
  kept.backoff.delete(name);
  kept.crashes.delete(name);
  return startApp(name);
}

/** The end of app NAME's log, at most CHARS of it (all of it with Infinity), from its last start. */
export function appLog(name: string, chars = 2000): string {
  let text: string;
  try {
    text = tail(join(appStateFolder(name), "log"), Number.isFinite(chars) ? Math.max(64 * 1024, chars * 4) : Infinity);
  } catch {
    return "";
  }
  let start = -1;
  for (const match of text.matchAll(startMark)) start = match.index + match[0].length;
  const run = (start >= 0 ? text.slice(start) : text).trimEnd();
  return run.length > chars ? `…${run.slice(-chars)}` : run;
}

/** The last BYTES of FILE, read without the rest. */
function tail(file: string, bytes: number): string {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Delete app NAME, one of the person's, which must be stopped: its folder and
 * its state (data, places, log) move to the apps folder's .trash, kept rather
 * than gone. Returns where they went.
 */
export function trashApp(name: string): string {
  const manifest = findApp(name);
  if (!manifest) throw new Error(`No app "${name}"`);
  if (manifest.builtin) throw new Error("That app ships with Proscenium: it can be stopped, not deleted");
  const kept = join(appsFolder(), ".trash", `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(kept, { recursive: true });
  move(manifest.dir, join(kept, "app"));
  if (existsSync(appStateFolder(name))) move(appStateFolder(name), join(kept, "state"));
  return kept;
}

/** Move FROM to TO, copying where they are on different file systems. */
function move(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}

function appendLog(name: string, line: string): void {
  try {
    writeFileSync(join(appStateFolder(name), "log"), `--- ${line}\n`, { flag: "a" });
  } catch {}
}

function runningFile(): string {
  return join(appStateFolder(), "running.json");
}

function saveRunning(): void {
  try {
    mkdirSync(appStateFolder(), { recursive: true });
    writeFileSync(`${runningFile()}.new`, JSON.stringify([...kept.wanted]));
    renameSync(`${runningFile()}.new`, runningFile());
  } catch (error) {
    console.error(`[genui] could not save the running apps: ${error instanceof Error ? error.message : error}`);
  }
}
