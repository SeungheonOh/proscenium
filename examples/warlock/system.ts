/**
 * What the System panel reads and changes: the default output's volume, whether
 * networking is on, what the machine may do about power, and this login
 * session. Each is asked of its own service with the desktop's command-line
 * tools (`pactl`, else `wpctl`; `busctl` to NetworkManager and logind on the
 * system bus) and is null where that service is missing, so the four degrade
 * one by one. Nothing is ever asked twice: a change that cannot be confirmed
 * is reported as such.
 */

import { execFile } from "node:child_process";

export interface AudioState {
  /** The loudest channel, 0..1600: an amplified output reads over 100. */
  percent: number;
  muted: boolean;
  /** The default output's description. */
  label: string;
  /** How to reach that output again: pactl's sink index, or wpctl's default sink. */
  sink: { tool: "pactl"; index: number } | { tool: "wpctl" };
}

export interface NetworkState {
  enabled: boolean;
  /** NetworkManager's state, in words. */
  state: string;
  /** Whether this user may turn networking on and off. */
  permission: "yes" | "no" | "auth";
}

/** logind's answer to "can this be done": yes, no, not applicable, or after authorization. */
export type Capability = "yes" | "no" | "na" | "challenge";

export interface PowerState {
  suspend: Capability;
  reboot: Capability;
  poweroff: Capability;
}

export interface SessionState {
  /** The user's name. */
  name: string;
  state: string;
  locked: boolean;
  id: string;
  /** Its object on the bus. */
  path: string;
}

export interface SystemSnapshot {
  volume: AudioState | null;
  network: NetworkState | null;
  power: PowerState | null;
  session: SessionState | null;
}

export type Operation =
  "volume" | "mute" | "network" | "suspend" | "reboot" | "poweroff" | "lock" | "logout";

/** One change: volume takes a percent, mute and network 1 for on, the rest 0. */
export interface Change {
  operation: Operation;
  value: number;
}

/**
 * How a change ended: seen in the state read back, accepted by its service,
 * turned down, or not known either way.
 */
export type Outcome = "committed" | "submitted" | "refused" | "unknown";

/** What the status line calls each operation. */
export const operationNames: Record<Operation, string> = {
  volume: "Volume",
  mute: "Mute",
  network: "Network",
  suspend: "Suspend",
  reboot: "Restart",
  poweroff: "Shut down",
  lock: "Lock session",
  logout: "Log out",
};

/** The volumes the panel offers. */
export const volumePresets = [0, 25, 50, 75, 100] as const;

/** Changes that may cost work or connections are confirmed first. */
export function needsConfirmation({ operation, value }: Change): boolean {
  return (
    operation === "reboot" ||
    operation === "poweroff" ||
    operation === "logout" ||
    (operation === "network" && value === 0)
  );
}

/** Whether a change can be asked for in the state SNAPSHOT shows. */
export function supported(snapshot: SystemSnapshot, { operation, value }: Change): boolean {
  const { volume, network, power, session } = snapshot;
  const may = (capability: Capability) => capability === "yes" || capability === "challenge";
  switch (operation) {
    case "volume":
      return volume !== null && value >= 0 && value <= 100 && value !== volume.percent;
    case "mute":
      return volume !== null && (value === 1) !== volume.muted;
    case "network":
      return network !== null && network.permission !== "no" && (value === 1) !== network.enabled;
    case "suspend":
    case "reboot":
    case "poweroff":
      return power !== null && may(power[operation]);
    case "lock":
      return session !== null && !session.locked;
    case "logout":
      return session !== null && session.state !== "closing";
  }
}

// ---------------------------------------------------------------------------
// Running the tools

const readDeadline = 2000;
const changeDeadline = 3000;

interface Ran {
  ok: boolean;
  /** The tool is not installed. */
  missing: boolean;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** Nothing ran: the change was only logged. */
  dry?: boolean;
}

function exec(command: string, args: readonly string[], deadline: number): Promise<Ran> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { timeout: deadline, env: { ...process.env, LC_ALL: "C" } },
      (error, stdout, stderr) => {
        const failure = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        resolve({
          ok: !failure,
          missing: failure?.code === "ENOENT",
          timedOut: failure?.killed === true,
          stdout,
          stderr,
        });
      },
    );
  });
}

/**
 * The one way a change to power, the session or networking is made. With
 * `WARLOCK_DRY_RUN` set, as tests set it, the command is logged and reported
 * as accepted without being run.
 */
function act(what: string, command: string, args: readonly string[]): Promise<Ran> {
  if (process.env.WARLOCK_DRY_RUN) {
    console.log("warlock dry run:", what, "·", command, ...args);
    return Promise.resolve({
      ok: true,
      missing: false,
      timedOut: false,
      stdout: "",
      stderr: "",
      dry: true,
    });
  }
  return exec(command, args, changeDeadline);
}

/** A change its tool did not carry out: turned down if the service said so, else unknown. */
function failed(ran: Ran): Outcome {
  if (ran.missing) return "refused";
  if (ran.timedOut) return "unknown";
  const said =
    /denied|not authori[sz]ed|authentication|no such|unknown (object|method|interface|property)|does not exist|not provided|not activatable|not supported/i;
  return said.test(ran.stderr) ? "refused" : "unknown";
}

/** NAME as shown: one line, single spaces, no longer than LIMIT. */
function shown(value: unknown, limit = 128): string {
  return typeof value === "string"
    ? value.split(/\s+/).filter(Boolean).join(" ").slice(0, limit)
    : "";
}

// ---------------------------------------------------------------------------
// The system bus, through busctl. Calls never start a service that is not running.

function busctl(seconds: number): string[] {
  return ["--system", "--json=short", "--auto-start=no", `--timeout=${seconds}`];
}

/** A method's reply, as its list of values; null if the call failed. */
async function call(
  service: string,
  path: string,
  interface_: string,
  method: string,
  args: readonly string[] = [],
): Promise<unknown[] | null> {
  const ran = await exec(
    "busctl",
    [...busctl(readDeadline / 1000), "call", service, path, interface_, method, ...args],
    readDeadline,
  );
  if (!ran.ok) return null;
  try {
    const reply = JSON.parse(ran.stdout) as { data?: unknown };
    return Array.isArray(reply.data) ? reply.data : null;
  } catch {
    return null;
  }
}

/** Every property of an object's interface, by name. */
async function properties(
  service: string,
  path: string,
  interface_: string,
): Promise<Record<string, unknown> | null> {
  const reply = await call(service, path, "org.freedesktop.DBus.Properties", "GetAll", [
    "s",
    interface_,
  ]);
  const all = reply?.[0];
  if (typeof all !== "object" || all === null) return null;
  const values: Record<string, unknown> = {};
  for (const [name, variant] of Object.entries(all as Record<string, { data?: unknown }>))
    values[name] = variant?.data;
  return values;
}

// ---------------------------------------------------------------------------
// Audio

async function readPactl(): Promise<AudioState | null> {
  const [info, sinks] = await Promise.all([
    exec("pactl", ["--format=json", "info"], readDeadline),
    exec("pactl", ["--format=json", "list", "sinks"], readDeadline),
  ]);
  if (!info.ok || !sinks.ok) return null;
  try {
    const name = (JSON.parse(info.stdout) as { default_sink_name?: unknown }).default_sink_name;
    const rows = JSON.parse(sinks.stdout) as Record<string, unknown>[];
    const row = Array.isArray(rows) ? rows.find((candidate) => candidate.name === name) : undefined;
    if (!row || typeof row.mute !== "boolean" || typeof row.index !== "number") return null;
    const channels = Object.values((row.volume ?? {}) as Record<string, { value?: unknown }>).map(
      (channel) => channel?.value,
    );
    if (
      channels.length === 0 ||
      !channels.every((value): value is number => typeof value === "number" && value >= 0)
    )
      return null;
    return {
      percent: Math.min(Math.round((Math.max(...channels) * 100) / 65536), 1600),
      muted: row.mute,
      label: shown(row.description) || shown(row.name),
      sink: { tool: "pactl", index: row.index },
    };
  } catch {
    return null;
  }
}

const defaultSink = "@DEFAULT_AUDIO_SINK@";

async function readWpctl(): Promise<AudioState | null> {
  const [level, details] = await Promise.all([
    exec("wpctl", ["get-volume", defaultSink], readDeadline),
    exec("wpctl", ["inspect", defaultSink], readDeadline),
  ]);
  const match = level.ok ? level.stdout.match(/Volume:\s*([\d.]+)/) : null;
  if (!match) return null;
  const fact = (name: string) => details.stdout.match(new RegExp(`${name} = "([^"]*)"`))?.[1];
  return {
    percent: Math.min(Math.round(Number(match[1]) * 100), 1600),
    muted: level.stdout.includes("[MUTED]"),
    label: shown(fact("node\\.description")) || shown(fact("node\\.name")) || "Output",
    sink: { tool: "wpctl" },
  };
}

async function readAudio(): Promise<AudioState | null> {
  return (await readPactl()) ?? (await readWpctl());
}

async function changeAudio(audio: AudioState, { operation, value }: Change): Promise<Outcome> {
  const loudness = operation === "volume";
  const ran =
    audio.sink.tool === "pactl"
      ? await exec(
          "pactl",
          loudness
            ? ["set-sink-volume", String(audio.sink.index), `${value}%`]
            : ["set-sink-mute", String(audio.sink.index), String(value)],
          changeDeadline,
        )
      : await exec(
          "wpctl",
          loudness
            ? ["set-volume", defaultSink, (value / 100).toFixed(2)]
            : ["set-mute", defaultSink, String(value)],
          changeDeadline,
        );
  if (!ran.ok) return failed(ran);
  const now = await readAudio();
  if (!now) return "unknown";
  return (loudness ? now.percent === value : now.muted === (value === 1)) ? "committed" : "unknown";
}

// ---------------------------------------------------------------------------
// NetworkManager

const networkManager = "org.freedesktop.NetworkManager";
const networkManagerPath = "/org/freedesktop/NetworkManager";

const networkStates: Record<number, string> = {
  0: "Unknown",
  10: "Sleeping",
  20: "Disconnected",
  30: "Disconnecting",
  40: "Connecting",
  50: "Local connection",
  60: "Site connection",
  70: "Connected",
};

async function readNetwork(): Promise<NetworkState | null> {
  const [facts, permissions] = await Promise.all([
    properties(networkManager, networkManagerPath, networkManager),
    call(networkManager, networkManagerPath, networkManager, "GetPermissions"),
  ]);
  const enabled = facts?.NetworkingEnabled;
  const state = facts?.State;
  if (typeof enabled !== "boolean" || typeof state !== "number") return null;
  const granted = (permissions?.[0] as Record<string, unknown> | undefined)?.[
    `${networkManager}.enable-disable-network`
  ];
  return {
    enabled,
    state: networkStates[state] ?? "Unknown",
    permission: granted === "yes" || granted === "auth" ? granted : "no",
  };
}

// ---------------------------------------------------------------------------
// logind: power and the session

const login = "org.freedesktop.login1";
const loginPath = "/org/freedesktop/login1";
const loginManager = "org.freedesktop.login1.Manager";
const loginSession = "org.freedesktop.login1.Session";

async function readPower(): Promise<PowerState | null> {
  const can = async (method: string): Promise<Capability | null> => {
    const answer = (await call(login, loginPath, loginManager, method))?.[0];
    return answer === "yes" || answer === "no" || answer === "na" || answer === "challenge"
      ? answer
      : null;
  };
  const [suspend, reboot, poweroff] = await Promise.all([
    can("CanSuspend"),
    can("CanReboot"),
    can("CanPowerOff"),
  ]);
  return suspend && reboot && poweroff ? { suspend, reboot, poweroff } : null;
}

/** The session this world runs in: the one its process belongs to, else the one its environment names. */
async function readSession(): Promise<SessionState | null> {
  const named = process.env.XDG_SESSION_ID;
  const found =
    (await call(login, loginPath, loginManager, "GetSessionByPID", ["u", String(process.pid)])) ??
    (named ? await call(login, loginPath, loginManager, "GetSession", ["s", named]) : null);
  const path = found?.[0];
  if (typeof path !== "string") return null;
  const facts = await properties(login, path, loginSession);
  if (!facts) return null;
  const { Id: id, LockedHint: locked, User: user } = facts;
  // Only ever this user's own session.
  const own = Array.isArray(user) && user[0] === process.getuid?.();
  if (typeof id !== "string" || id === "" || typeof locked !== "boolean" || !own) return null;
  return { name: shown(facts.Name), state: shown(facts.State, 32), locked, id, path };
}

// ---------------------------------------------------------------------------

/** Read all four, each within two seconds. */
export async function readSystem(): Promise<SystemSnapshot> {
  const [volume, network, power, session] = await Promise.all([
    readAudio(),
    readNetwork(),
    readPower(),
    readSession(),
  ]);
  return { volume, network, power, session };
}

/** Ask for CHANGE once, against the state SNAPSHOT showed. */
export async function changeSystem(snapshot: SystemSnapshot, change: Change): Promise<Outcome> {
  if (!supported(snapshot, change)) return "refused";
  const { operation, value } = change;
  const name = operationNames[operation];
  const bus = [...busctl(changeDeadline / 1000), "call"];
  switch (operation) {
    case "volume":
    case "mute":
      return changeAudio(snapshot.volume!, change);
    case "network": {
      const on = value === 1;
      const ran = await act(name, "busctl", [
        ...bus,
        networkManager,
        networkManagerPath,
        networkManager,
        "Enable",
        "b",
        String(on),
      ]);
      if (!ran.ok) return failed(ran);
      if (ran.dry) return "submitted";
      const facts = await properties(networkManager, networkManagerPath, networkManager);
      return facts?.NetworkingEnabled === on ? "committed" : "unknown";
    }
    case "suspend":
    case "reboot":
    case "poweroff": {
      const method = { suspend: "Suspend", reboot: "Reboot", poweroff: "PowerOff" }[operation];
      // `true`: logind may ask the user to authorize it.
      const ran = await act(name, "busctl", [
        ...bus,
        login,
        loginPath,
        loginManager,
        method,
        "b",
        "true",
      ]);
      return ran.ok ? "submitted" : failed(ran);
    }
    case "lock": {
      const { path } = snapshot.session!;
      const ran = await act(name, "busctl", [...bus, login, path, loginSession, "Lock"]);
      if (!ran.ok) return failed(ran);
      const facts = ran.dry ? null : await properties(login, path, loginSession);
      return facts?.LockedHint === true ? "committed" : "submitted";
    }
    case "logout": {
      const ran = await act(name, "busctl", [
        ...bus,
        login,
        loginPath,
        loginManager,
        "TerminateSession",
        "s",
        snapshot.session!.id,
      ]);
      return ran.ok ? "submitted" : failed(ran);
    }
  }
}
