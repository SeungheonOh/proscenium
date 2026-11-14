// herdr (herdr.dev) as the world sees it: every herdr session on this machine,
// and for each running one its live snapshot of workspaces, tabs, panes and the
// agents in them. The director speaks herdr's socket API directly: newline-
// delimited JSON, one request per connection, and a long-lived connection per
// session subscribed to its events. Any event re-reads the session's snapshot,
// so the sidebar follows herdr as it changes instead of polling it.
// Sessions themselves (started, stopped, new) come from `herdr session list`,
// asked every few seconds. HERDR_SESSIONS=a,b shows only those sessions.
//
// Mutations go through the herdr CLI, which validates them the way herdr's
// own tools do.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { useSyncExternalStore } from "react";
import { Source } from "../lib/system/source.js";

/** herdr's agent lifecycle; `unknown` also stands for a pane with no agent. */
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface Workspace {
  workspace_id: string;
  label: string;
  number: number;
  active_tab_id: string;
  agent_status: AgentStatus;
  focused: boolean;
}

export interface Tab {
  tab_id: string;
  workspace_id: string;
  label: string;
  number: number;
  pane_count: number;
  agent_status: AgentStatus;
}

export interface Pane {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  terminal_id: string;
  cwd: string | null;
  foreground_cwd: string | null;
  agent_status: AgentStatus;
  label?: string | null;
  terminal_title_stripped?: string | null;
  revision: number;
}

export interface Agent {
  pane_id: string;
  agent: string | null;
  name: string | null;
  display_agent: string | null;
  agent_status: AgentStatus;
}

export interface Snapshot {
  workspaces: Workspace[];
  tabs: Tab[];
  panes: Pane[];
  agents: Agent[];
  layouts: { tab_id: string; focused_pane_id: string; panes: { pane_id: string }[] }[];
}

export interface Session {
  name: string;
  default: boolean;
  running: boolean;
  socket: string;
  snapshot: Snapshot | null;
  error: string | null;
}

export interface HerdrState {
  sessions: Session[];
  /** Why herdr could not be asked at all, e.g. that it is not installed. */
  error: string | null;
  loaded: boolean;
}

/** The herdr binary: $HERDR, else the installer's ~/.local/bin/herdr, else PATH. */
export const herdr = (() => {
  if (process.env.HERDR) return process.env.HERDR;
  const installed = join(homedir(), ".local/bin/herdr");
  return existsSync(installed) ? installed : "herdr";
})();

/** The CLI's arguments that pick SESSION; the default session needs none. */
export function sessionArgs(session: Pick<Session, "name" | "default">): string[] {
  return session.default ? [] : ["--session", session.name];
}

export function cli(args: string[], timeout = 20_000): Promise<{ out: string; err: string; ok: boolean }> {
  return new Promise((resolve) => {
    execFile(herdr, args, { timeout, maxBuffer: 16 << 20 }, (error, out, err) =>
      resolve({ out: String(out), err: String(err), ok: !error }),
    );
  });
}

/** One request on its own connection, as herdr's socket API takes them. */
export function request<T>(socket: string, method: string, params: object = {}, timeout = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const connection = createConnection(socket);
    let buffer = "";
    const timer = setTimeout(() => fail(new Error(`${method} timed out`)), timeout);
    function fail(error: Error) {
      clearTimeout(timer);
      connection.destroy();
      reject(error);
    }
    connection.on("error", fail);
    connection.on("connect", () => connection.write(`${JSON.stringify({ id: method, method, params })}\n`));
    connection.on("data", (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      clearTimeout(timer);
      connection.destroy();
      const reply = JSON.parse(buffer.slice(0, end)) as { result?: T; error?: { message: string } };
      if (reply.error) reject(new Error(reply.error.message));
      else resolve(reply.result as T);
    });
  });
}

// Events that change what the sidebar shows; none of them needs a parameter.
const sessionEvents = [
  "workspace.created", "workspace.updated", "workspace.renamed", "workspace.moved", "workspace.reordered",
  "workspace.closed", "tab.created", "tab.closed", "tab.renamed", "tab.moved", "pane.created", "pane.closed",
  "pane.updated", "pane.moved", "pane.exited", "pane.agent_detected", "layout.updated",
];

/** Follows one running session: its snapshot, re-read after each event. */
class Follower {
  snapshot: Snapshot | null = null;
  error: string | null = null;
  private events: Socket | null = null;
  private watchedPanes = "";
  private refreshTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(readonly socket: string, private readonly changed: () => void) {
    this.refresh();
  }

  stop(): void {
    this.stopped = true;
    this.events?.destroy();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  /** Re-reads the snapshot a moment after a burst of events. */
  refresh = (): void => {
    if (this.stopped || this.refreshTimer) return;
    this.refreshTimer = setTimeout(async () => {
      this.refreshTimer = null;
      try {
        const { snapshot } = await request<{ snapshot: Snapshot }>(this.socket, "session.snapshot");
        if (this.stopped) return;
        this.snapshot = snapshot;
        this.error = null;
        this.subscribe(snapshot.panes.map((pane) => pane.pane_id));
      } catch (error) {
        this.error = (error as Error).message;
        this.retry();
      }
      this.changed();
    }, 80);
  };

  /**
   * Agent status changes are subscribed per pane, so the subscription is made
   * again whenever the panes change.
   */
  private subscribe(panes: string[]): void {
    const key = panes.join(" ");
    if (this.events && key === this.watchedPanes) return;
    this.watchedPanes = key;
    this.events?.destroy();
    const subscriptions = [
      ...sessionEvents.map((type) => ({ type })),
      ...panes.map((pane_id) => ({ type: "pane.agent_status_changed", pane_id })),
    ];
    const connection = createConnection(this.socket);
    this.events = connection;
    let buffer = "";
    connection.on("connect", () =>
      connection.write(`${JSON.stringify({ id: "events", method: "events.subscribe", params: { subscriptions } })}\n`));
    connection.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message: { event?: string; error?: { message: string } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.error) {
          this.error = `events: ${message.error.message}`;
          this.changed();
        } else if (message.event) this.refresh();
      }
    });
    const lost = () => {
      if (this.events !== connection || this.stopped) return;
      this.events = null;
      this.retry();
    };
    connection.on("error", lost);
    connection.on("close", lost);
  }

  private retry(): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.watchedPanes = "";
      this.refresh();
    }, 2000);
  }
}

const empty: HerdrState = { sessions: [], error: null, loaded: false };

const source = new Source<HerdrState>(empty, (self) => {
  const followers = new Map<string, Follower>();
  let listed: Omit<Session, "snapshot" | "error">[] = [];
  let listError: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const publish = () => {
    if (stopped) return;
    self.set({
      sessions: listed.map((session) => {
        const follower = followers.get(session.name);
        return { ...session, snapshot: follower?.snapshot ?? null, error: follower?.error ?? null };
      }),
      error: listError,
      loaded: true,
    });
  };

  const list = async () => {
    const { out, err, ok } = await cli(["session", "list", "--json"]);
    if (stopped) return;
    if (ok) {
      try {
        const parsed = JSON.parse(out) as {
          sessions: { name: string; default: boolean; running: boolean; socket_path: string }[];
        };
        const only = process.env.HERDR_SESSIONS?.split(",").map((name) => name.trim()).filter(Boolean);
        listed = parsed.sessions.filter((session) => !only?.length || only.includes(session.name)).map((session) => ({
          name: session.name,
          default: session.default,
          running: session.running,
          socket: session.socket_path,
        }));
        listError = null;
      } catch {
        listError = "herdr session list printed something other than JSON";
      }
    } else {
      listError = err.trim() || `${herdr} session list failed`;
    }
    // Follow running sessions; let go of the ones that stopped or went away.
    for (const session of listed) {
      const follower = followers.get(session.name);
      if (session.running && (!follower || follower.socket !== session.socket)) {
        follower?.stop();
        followers.set(session.name, new Follower(session.socket, publish));
      }
    }
    for (const [name, follower] of followers) {
      if (!listed.some((session) => session.name === name && session.running)) {
        follower.stop();
        followers.delete(name);
      }
    }
    publish();
    timer = setTimeout(list, 4000);
  };

  void list();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    for (const follower of followers.values()) follower.stop();
  };
});

/** herdr's sessions and their live state, followed while a component reads them. */
export function useHerdr(): HerdrState {
  return useSyncExternalStore(source.subscribe, source.read);
}

/** What a pane shows as its name: its agent's, else its label, else its terminal's title. */
export function paneName(pane: Pane, agent: Agent | undefined): string {
  return (
    agent?.name ||
    agent?.display_agent ||
    agent?.agent ||
    pane.label ||
    pane.terminal_title_stripped ||
    pane.pane_id
  );
}

/** Starts SESSION's server in the background, as a systemd user unit that outlives the world. */
export function startSession(session: Session): void {
  execFile("systemd-run", [
    "--user", "--collect", `--unit=herdr-session-${session.name.replace(/[^A-Za-z0-9_-]/g, "_")}`,
    herdr, ...sessionArgs(session), "server",
  ], () => undefined);
}

/** Prompts the agent in PANE, or runs TEXT as a command in a pane without one. */
export async function sendToPane(session: Session, pane: string, text: string, agent: boolean): Promise<string | null> {
  const args = agent
    ? [...sessionArgs(session), "agent", "prompt", pane, text]
    : [...sessionArgs(session), "pane", "run", pane, text];
  const { ok, err } = await cli(args);
  if (ok) return null;
  try {
    return (JSON.parse(err) as { error: { message: string } }).error.message;
  } catch {
    return err.trim() || "herdr refused";
  }
}

/** Opens a new tab in WORKSPACE, in DIRECTORY; resolves to its pane. */
export async function newTab(session: Session, workspace: string, directory: string | null): Promise<string> {
  const { out, err, ok } = await cli([
    ...sessionArgs(session), "tab", "create", "--workspace", workspace, "--no-focus",
    ...(directory ? ["--cwd", directory] : []),
  ]);
  if (!ok) throw new Error(err.trim() || "herdr tab create failed");
  return (JSON.parse(out) as { result: { root_pane: { pane_id: string } } }).result.root_pane.pane_id;
}

/** Opens a new workspace in DIRECTORY, labelled LABEL; resolves to its first pane. */
export async function newWorkspace(session: Session, directory: string, label: string): Promise<string> {
  const { out, err, ok } = await cli([
    ...sessionArgs(session), "workspace", "create", "--cwd", directory, "--label", label, "--no-focus",
  ]);
  if (!ok) throw new Error(err.trim() || "herdr workspace create failed");
  return (JSON.parse(out) as { result: { root_pane: { pane_id: string } } }).result.root_pane.pane_id;
}

/** Closes PANE, ending what runs in it; a tab left without panes closes with it. */
export async function closePane(session: Session, pane: string): Promise<void> {
  const { err, ok } = await cli([...sessionArgs(session), "pane", "close", pane]);
  if (!ok) throw new Error(err.trim() || "herdr pane close failed");
}

/** Closes WORKSPACE, ending every tab and pane in it, and the agents running there. */
export async function closeWorkspace(session: Session, workspace: string): Promise<void> {
  const { err, ok } = await cli([...sessionArgs(session), "workspace", "close", workspace]);
  if (!ok) throw new Error(err.trim() || "herdr workspace close failed");
}

const roots = new Map<string, Promise<string>>();

/** The repository a directory belongs to, for the code viewer; the directory itself outside git. */
export function projectRoot(directory: string): Promise<string> {
  let root = roots.get(directory);
  if (!root) {
    root = new Promise((resolve) => {
      execFile("git", ["-C", directory, "rev-parse", "--show-toplevel"], { timeout: 5000 }, (error, out) =>
        resolve(error ? directory : String(out).trim()),
      );
    });
    roots.set(directory, root);
  }
  return root;
}

/** The branch checked out in a directory, or null. */
export function branchOf(directory: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["-C", directory, "branch", "--show-current"], { timeout: 5000 }, (error, out) =>
      resolve(error ? null : String(out).trim() || null),
    );
  });
}

export const statusLook: Record<AgentStatus, { color: string; label: string }> = {
  working: { color: "#1a7f37", label: "working" },
  blocked: { color: "#bf8700", label: "blocked" },
  done: { color: "#0969da", label: "done" },
  idle: { color: "#8c959f", label: "idle" },
  unknown: { color: "#afb8c1", label: "shell" },
};

export function looks(status: AgentStatus | undefined): { color: string; label: string } {
  return statusLook[status ?? "unknown"] ?? statusLook.unknown;
}
