// A program that owns a live interface without being a Wayland client: CPU,
// memory and battery pinned over everything in the top right corner, sent as a
// json-render spec once and then as state changes every two seconds.
//
//     node examples/genui/run.mjs examples/genui/demos/monitor.ts [--mode floating]

import { readdirSync, readFileSync } from "node:fs";
import { UIClient } from "../client.js";
import type { Mode } from "../protocol.js";

const flag = process.argv.indexOf("--mode");
const mode = (flag > 1 ? process.argv[flag + 1] : "overlay") as Mode;
const ui = new UIClient({ name: "Monitor" });

function cpuTimes(): { idle: number; total: number } {
  const fields = readFileSync("/proc/stat", "utf8").split("\n")[0]!.trim().split(/\s+/).slice(1).map(Number);
  const idle = fields[3]! + (fields[4] ?? 0);
  return { idle, total: fields.reduce((sum, value) => sum + value, 0) };
}

function memory(): { used: number; total: number } {
  const info = Object.fromEntries(readFileSync("/proc/meminfo", "utf8").split("\n").map((line) => {
    const [key, value] = line.split(":");
    return [key, Number.parseInt(value ?? "0", 10)];
  }));
  return { used: (info.MemTotal - info.MemAvailable) / 1048576, total: info.MemTotal / 1048576 };
}

function battery(): string | null {
  try {
    const name = readdirSync("/sys/class/power_supply").find((entry) => entry.startsWith("BAT"));
    if (!name) return null;
    const read = (field: string) => readFileSync(`/sys/class/power_supply/${name}/${field}`, "utf8").trim();
    return `${read("capacity")}% · ${read("status").toLowerCase()}`;
  } catch {
    return null;
  }
}

const history: number[] = [];
let last = cpuTimes();

function sample() {
  const now = cpuTimes();
  const load = Math.max(0, 1 - (now.idle - last.idle) / Math.max(1, now.total - last.total));
  last = now;
  history.push(Math.round(load * 100));
  if (history.length > 30) history.shift();
  const { used, total } = memory();
  return {
    "/cpu": `${Math.round(load * 100)}%`,
    "/cpuLoad": load,
    "/history": [...history],
    "/memory": `${used.toFixed(1)} of ${total.toFixed(0)} GB`,
    "/memoryUse": used / total,
    "/battery": battery() ?? "on mains",
  };
}

void ui.open("system", {
  mode, place: { anchor: "top-right" }, title: "System", width: 260, theme: "dark",
  spec: {
    root: "root",
    state: { cpu: "–", cpuLoad: 0, history: [], memory: "–", memoryUse: 0, battery: "–" },
    elements: {
      root: { type: "Stack", props: { gap: "md" }, children: ["cpuRow", "spark", "mem", "power"] },
      cpuRow: { type: "Stack", props: { direction: "horizontal", justify: "between" }, children: ["cpuLabel", "cpuValue"] },
      cpuLabel: { type: "Text", props: { text: "CPU", tone: "muted", size: "sm", weight: "bold" }, children: [] },
      cpuValue: { type: "Text", props: { text: { $state: "/cpu" }, weight: "bold", mono: true }, children: [] },
      spark: { type: "Sparkline", props: { values: { $state: "/history" }, height: 28, tone: "accent" }, children: [] },
      mem: { type: "ProgressBar", props: { label: { $template: "Memory · ${/memory}" }, value: { $state: "/memoryUse" } }, children: [] },
      power: { type: "KeyValue", props: { label: "Battery", value: { $state: "/battery" } }, children: [] },
    },
  },
});

ui.on("connect", () => ui.state("system", sample()));
setInterval(() => ui.state("system", sample()), 2000);
ui.on("closed", () => process.exit(0));
