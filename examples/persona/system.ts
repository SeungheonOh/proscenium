// What the stats menu lists: the system, Wi-Fi networks and Bluetooth devices.
// Each source runs only while the menu shows it.

import { readFile } from "node:fs/promises";
import { useSyncExternalStore } from "react";
import { debounced, follow, run, Source } from "../lib/system/source.js";

export interface SystemStats {
  os: string;
  /** 0..1, over the last two seconds. */
  cpu: number;
  memory: string;
  disk: string;
  users: string;
}

const gigabytes = (used: number, total: number) =>
  `${(used / 1073741824).toFixed(1)} / ${(total / 1073741824).toFixed(1)} GB`;

async function readOs(): Promise<string> {
  const release = await readFile("/etc/os-release", "utf8").catch(() => "");
  return release.match(/^PRETTY_NAME="?([^"\n]*)"?/m)?.[1] ?? "Linux";
}

async function readMemory(): Promise<string> {
  const info = await readFile("/proc/meminfo", "utf8").catch(() => "");
  const total = Number(info.match(/MemTotal:\s+(\d+)/)?.[1] ?? 0) * 1024;
  const available = Number(info.match(/MemAvailable:\s+(\d+)/)?.[1] ?? 0) * 1024;
  return total ? gigabytes(total - available, total) : "";
}

async function readDisk(): Promise<string> {
  const [, line] = (await run("df", ["-B1", "/"]))?.split("\n") ?? [];
  const [, total, used] = line?.split(/\s+/) ?? [];
  return total ? gigabytes(Number(used), Number(total)) : "";
}

async function readUsers(): Promise<string> {
  const who = await run("who", []);
  return String(who?.split("\n").filter(Boolean).length ?? 0);
}

/** Idle and total jiffies of all CPUs. */
async function readTimes(): Promise<{ idle: number; total: number } | null> {
  const stat = await readFile("/proc/stat", "utf8").catch(() => "");
  const fields = stat.match(/^cpu\s+(.*)/m)?.[1]?.split(/\s+/).slice(0, 7).map(Number);
  if (!fields) return null;
  return { idle: fields[3]! + fields[4]!, total: fields.reduce((sum, value) => sum + value, 0) };
}

const stats = new Source<SystemStats | null>(null, (source) => {
  let current: SystemStats = { os: "", cpu: 0, memory: "", disk: "", users: "" };
  let last: { idle: number; total: number } | null = null;
  const update = (changes: Partial<SystemStats>) => source.set(current = { ...current, ...changes });
  const load = async () => {
    const times = await readTimes();
    if (times && last && times.total > last.total) {
      update({ cpu: 1 - (times.idle - last.idle) / (times.total - last.total) });
    }
    last = times;
    update({ memory: await readMemory() });
  };
  const disk = async () => update({ disk: await readDisk() });
  const users = async () => update({ users: await readUsers() });
  void readOs().then((os) => update({ os }));
  void load();
  void disk();
  void users();
  const timers = [setInterval(load, 2000), setInterval(disk, 30_000), setInterval(users, 60_000)];
  return () => timers.forEach(clearInterval);
});

export interface Network {
  ssid: string;
  /** 0..100. */
  strength: number;
  active: boolean;
}

async function readNetworks(): Promise<Network[]> {
  // The last scan's results: asking for a new one can take seconds.
  const output = await run("env", [
    "LC_ALL=C", "nmcli", "-g", "ACTIVE,SIGNAL,FREQ,SSID,BSSID", "device", "wifi", "list", "--rescan", "no",
  ]);
  // The best entry for each access point, by name, address and band.
  const found = new Map<string, Network>();
  for (const line of output?.split("\n") ?? []) {
    const [active, signal, frequency, ssid, bssid] = line.replace(/\\:/g, "\0").split(":")
      .map((part) => part.replace(/\0/g, ":"));
    if (!ssid) continue;
    const network = { ssid, strength: Number.parseInt(signal ?? "0"), active: active === "yes" };
    const key = `${ssid}|${bssid}|${Number.parseInt(frequency ?? "0")}`;
    const known = found.get(key);
    if (!known || (network.active && !known.active) || (!known.active && network.strength > known.strength)) {
      found.set(key, network);
    }
  }
  return [...found.values()];
}

const networks = new Source<Network[]>([], (source) => {
  const refresh = debounced(() => void readNetworks().then((list) => source.set(list)), 200);
  refresh();
  return follow("nmcli", ["monitor"], refresh);
});

export interface BluetoothDevice {
  name: string;
  connected: boolean;
  paired: boolean;
}

export interface BluetoothState {
  /** An adapter exists. */
  available: boolean;
  enabled: boolean;
  /** Connected first, then paired, then found; named ones before bare addresses. */
  devices: BluetoothDevice[];
}

async function readBluetooth(): Promise<BluetoothState> {
  const show = await run("bluetoothctl", ["show"]);
  if (!show || !show.includes("Controller")) return { available: false, enabled: false, devices: [] };
  const listed = async (filter?: string) => {
    const output = await run("bluetoothctl", filter ? ["devices", filter] : ["devices"]);
    return new Map((output ?? "").split("\n").flatMap((line) => {
      const match = line.match(/^Device (\S+) (.*)$/);
      return match ? [[match[1]!, match[2]!] as const] : [];
    }));
  };
  const [all, connected, paired] = await Promise.all([listed(), listed("Connected"), listed("Paired")]);
  const address = /^([0-9A-Fa-f]{2}-){5}[0-9A-Fa-f]{2}$/;
  const rank = (device: BluetoothDevice) => (device.connected ? 0 : device.paired ? 1 : 2);
  const devices = [...all].map(([key, name]) => ({ name, connected: connected.has(key), paired: paired.has(key) }))
    .sort((a, b) => rank(a) - rank(b) || Number(address.test(a.name)) - Number(address.test(b.name))
      || a.name.localeCompare(b.name));
  return { available: true, enabled: /Powered: yes/.test(show), devices };
}

const bluetooth = new Source<BluetoothState | null>(null, (source) => {
  const refresh = debounced(() => void readBluetooth().then((state) => source.set(state)), 300);
  refresh();
  // BlueZ announces adapters and devices coming, going and changing.
  return follow("dbus-monitor", ["--system", "type='signal',sender='org.bluez'"], (line) => {
    if (line.startsWith("signal")) refresh();
  });
});

const idle = () => () => undefined;

/** A source's value while ACTIVE; its feed stops when nothing reads it. */
function useWhile<T>(source: Source<T>, active: boolean, fallback: T): T {
  return useSyncExternalStore(active ? source.subscribe : idle, active ? source.read : () => fallback);
}

export function useSystemStats(active: boolean): SystemStats | null {
  return useWhile(stats, active, null);
}

const noNetworks: Network[] = [];

export function useNetworks(active: boolean): Network[] {
  return useWhile(networks, active, noNetworks);
}

export function useBluetooth(active: boolean): BluetoothState | null {
  return useWhile(bluetooth, active, null);
}
