// Network: the connection in use and how it is doing. The interface the default
// route goes through, its address, how fast it receives and sends (counted
// from /proc/net/dev each second), how long a ping to a public resolver takes,
// and the Wi-Fi network and its signal when it is wireless; other connections
// that are up under it.
//
//     proscenium-ui start network

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { app } from "proscenium-app";

const ui = app({ name: "network", title: "Network" });

/** Samples the rate charts keep: the last minute. */
const HISTORY = 60;
/** Where latency is measured to: Cloudflare's resolver answers pings everywhere. */
const PING_HOST = "1.1.1.1";

/** The interface the default route leaves through, if there is one. */
function defaultInterface(): string | undefined {
  for (const line of readFileSync("/proc/net/route", "utf8").trim().split("\n").slice(1)) {
    const [name, destination, , flags] = line.trim().split(/\s+/);
    // RTF_UP is bit 0.
    if (destination === "00000000" && Number.parseInt(flags ?? "0", 16) & 1) return name;
  }
  return undefined;
}

/** Bytes each interface has received and sent since it came up. */
function counters(): Map<string, { received: number; sent: number }> {
  const found = new Map<string, { received: number; sent: number }>();
  for (const line of readFileSync("/proc/net/dev", "utf8").split("\n").slice(2)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const fields = line.slice(colon + 1).trim().split(/\s+/).map(Number);
    found.set(line.slice(0, colon).trim(), { received: fields[0]!, sent: fields[8]! });
  }
  return found;
}

const isUp = (name: string) => {
  try {
    return readFileSync(`/sys/class/net/${name}/operstate`, "utf8").trim() === "up";
  } catch {
    return false;
  }
};

function address(name: string): string {
  const found = networkInterfaces()[name] ?? [];
  return (found.find((each) => each.family === "IPv4") ?? found[0])?.address ?? "no address";
}

/** Bytes as a number and a unit, for a Metric. */
function amount(bytes: number): [string, string] {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return [unit === 0 || value >= 100 ? String(Math.round(value)) : value.toFixed(1), units[unit]!];
}

const rate = (bytes: number) => amount(bytes).join(" ") + "/s";

/** What a command prints, or null when it fails or is not there. */
function run(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) =>
    execFile(command, args, { timeout: 3000, encoding: "utf8" }, (error, out) => resolve(error ? null : out)));
}

/** The Wi-Fi network's name: iwgetid where it is installed, else NetworkManager's. */
async function networkName(name: string): Promise<string | null> {
  const plain = (await run("iwgetid", [name, "-r"]))?.trim();
  if (plain) return plain;
  const listed = await run("nmcli", ["-t", "-f", "ACTIVE,SSID", "device", "wifi"]);
  const active = listed?.split("\n").find((line) => line.startsWith("yes:"));
  return active ? active.slice(4).replace(/\\:/g, ":") : null;
}

/** The link quality of wireless interface NAME, 0 to 1, from /proc/net/wireless (out of 70). */
function signal(name: string): number | null {
  let table = "";
  try {
    table = readFileSync("/proc/net/wireless", "utf8");
  } catch {
    return null;
  }
  const line = table.split("\n").find((each) => each.trim().startsWith(`${name}:`));
  const quality = line ? Number.parseFloat(line.split(/\s+/).filter(Boolean)[2] ?? "") : Number.NaN;
  return Number.isFinite(quality) ? Math.max(0, Math.min(1, quality / 70)) : null;
}

const down = Array<number>(HISTORY).fill(0);
const up = Array<number>(HISTORY).fill(0);
const pings = Array<number>(30).fill(0);
let last = counters();
let lastAt = Date.now();
let wifi: string | null = null;
let online = true;

function sample(): Record<string, unknown> {
  const now = counters();
  const seconds = (Date.now() - lastAt) / 1000;
  const name = defaultInterface();
  const ratesOf = (each: string) => {
    const was = last.get(each);
    const is = now.get(each);
    // A rate needs a stretch of time: the first sample, at the start, has none.
    if (!was || !is || seconds < 0.5) return { received: 0, sent: 0 };
    return { received: Math.max(0, (is.received - was.received) / seconds), sent: Math.max(0, (is.sent - was.sent) / seconds) };
  };
  const main = name ? ratesOf(name) : { received: 0, sent: 0 };
  down.push(main.received);
  down.shift();
  up.push(main.sent);
  up.shift();
  const wireless = name !== undefined && existsSync(`/sys/class/net/${name}/wireless`);
  const quality = wireless ? signal(name) : null;
  const others = [...now.keys()].filter((each) => each !== "lo" && each !== name && isUp(each)).map((each) => {
    const rates = ratesOf(each);
    return { id: each, name: each, address: address(each), rate: `↓ ${rate(rates.received)}  ↑ ${rate(rates.sent)}` };
  });
  last = now;
  lastAt = Date.now();
  const [downValue, downUnit] = amount(main.received);
  const [upValue, upUnit] = amount(main.sent);
  const totals = name ? now.get(name) : undefined;
  return {
    title: !name ? "Not connected" : wireless ? (wifi ?? "Wi-Fi") : "Wired",
    status: name && online ? "Online" : "Offline",
    statusTone: name && online ? "success" : "danger",
    where: name ? `${address(name)} on ${name}` : "No route out of this computer",
    down: downValue, downUnit: `${downUnit}/s`, downHistory: [...down],
    up: upValue, upUnit: `${upUnit}/s`, upHistory: [...up],
    wireless: quality !== null,
    signal: quality ?? 0,
    signalText: quality === null ? "" : `Signal · ${quality > 0.7 ? "strong" : quality > 0.4 ? "fair" : "weak"}`,
    received: totals ? amount(totals.received).join(" ") : "–",
    sent: totals ? amount(totals.sent).join(" ") : "–",
    hasOthers: others.length > 0,
    others,
  };
}

async function measureLatency(): Promise<void> {
  const out = await run("ping", ["-n", "-c", "1", "-W", "2", PING_HOST]);
  const time = out?.match(/time=([\d.]+)/)?.[1];
  online = time !== undefined;
  pings.push(online ? Number(time) : 0);
  pings.shift();
  view.set({
    latency: online ? String(Math.round(Number(time))) : "–",
    latencyCaption: online ? `ping to ${PING_HOST}` : `${PING_HOST} did not answer`,
    pings: [...pings],
  });
}

async function findNetworkName(): Promise<void> {
  const name = defaultInterface();
  wifi = name && existsSync(`/sys/class/net/${name}/wireless`) ? await networkName(name) : null;
}

const view = ui.open("network", {
  mode: "floating", title: "Network", width: 380,
  spec: {
    root: "root",
    state: { ...sample(), latency: "–", latencyCaption: `ping to ${PING_HOST}`, pings: [...pings] },
    elements: {
      root: { type: "Stack", props: { gap: "lg" }, children: ["head", "rates", "latency", "signal", "totals", "others"] },
      head: { type: "Stack", props: { gap: "xs" }, children: ["titleRow", "where"] },
      titleRow: { type: "Stack", props: { direction: "horizontal", justify: "between", align: "center" }, children: ["title", "status"] },
      title: { type: "Heading", props: { text: { $state: "/title" }, level: 2 }, children: [] },
      status: { type: "Badge", props: { text: { $state: "/status" }, tone: { $state: "/statusTone" } }, children: [] },
      where: { type: "Text", props: { text: { $state: "/where" }, tone: "muted", size: "sm" }, children: [] },
      rates: { type: "Grid", props: { columns: 2, gap: "lg" }, children: ["downPart", "upPart"] },
      downPart: { type: "Stack", props: { gap: "sm" }, children: ["down", "downChart"] },
      down: { type: "Metric", props: { label: "Download", value: { $state: "/down" }, unit: { $state: "/downUnit" } }, children: [] },
      downChart: { type: "Sparkline", props: { values: { $state: "/downHistory" }, height: 36, min: 0, tone: "accent" }, children: [] },
      upPart: { type: "Stack", props: { gap: "sm" }, children: ["up", "upChart"] },
      up: { type: "Metric", props: { label: "Upload", value: { $state: "/up" }, unit: { $state: "/upUnit" } }, children: [] },
      upChart: { type: "Sparkline", props: { values: { $state: "/upHistory" }, height: 36, min: 0, tone: "success" }, children: [] },
      latency: { type: "Stack", props: { direction: "horizontal", gap: "lg", align: "end" }, children: ["latencyValue", "latencyChart"] },
      latencyValue: { type: "Metric", props: { label: "Latency", value: { $state: "/latency" }, unit: "ms",
                                               caption: { $state: "/latencyCaption" } }, children: [] },
      latencyChart: { type: "Sparkline", props: { values: { $state: "/pings" }, height: 36, min: 0, tone: "warning" }, children: [] },
      signal: { type: "ProgressBar", props: { value: { $state: "/signal" }, label: { $state: "/signalText" }, showValue: true },
                visible: { $state: "/wireless" }, children: [] },
      totals: { type: "Stack", props: { gap: "xs" }, children: ["received", "sent"] },
      received: { type: "KeyValue", props: { label: "Received since it connected", value: { $state: "/received" } }, children: [] },
      sent: { type: "KeyValue", props: { label: "Sent since it connected", value: { $state: "/sent" } }, children: [] },
      others: { type: "Stack", props: { gap: "sm" }, visible: { $state: "/hasOthers" }, children: ["othersTitle", "otherList"] },
      othersTitle: { type: "Text", props: { text: "Also up", tone: "muted", size: "sm", weight: "bold" }, children: [] },
      otherList: { type: "List", props: {}, repeat: { statePath: "/others", key: "id" }, children: ["other"] },
      other: { type: "ListItem", children: [],
               props: { title: { $item: "name" }, subtitle: { $item: "address" }, trailing: { $item: "rate" } } },
    },
  },
});

void findNetworkName();
void measureLatency();
setInterval(() => view.set(sample()), 1000);
setInterval(() => void measureLatency(), 5000);
setInterval(() => void findNetworkName(), 15_000);
