// Activity: what the computer is busy with. CPU, memory and load, every core's
// last minute, and the processes using the most CPU or memory, read from /proc
// every second and a half and sent as state changes.
//
//     proscenium-ui start activity

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { app } from "proscenium-app";

const ui = app({ name: "activity", title: "Activity" });

const INTERVAL = 1500;
/** Samples a core's chart keeps: its last 45 seconds. */
const HISTORY = 30;
/** Processes the table lists. */
const LISTED = 10;

function getconf(name: string, fallback: number): number {
  try {
    return Number(execFileSync("getconf", [name], { encoding: "utf8" }).trim()) || fallback;
  } catch {
    return fallback;
  }
}

const ticksPerSecond = getconf("CLK_TCK", 100);
const pageSize = getconf("PAGESIZE", 4096);

/** Busy and total time of the whole machine, then of each core, in ticks since boot. */
function cpuTimes(): { busy: number; total: number }[] {
  return readFileSync("/proc/stat", "utf8").split("\n").filter((line) => /^cpu\d* /.test(line)).map((line) => {
    // user nice system idle iowait irq softirq steal; guest time is in user already.
    const fields = line.trim().split(/\s+/).slice(1, 9).map(Number);
    const total = fields.reduce((sum, value) => sum + value, 0);
    return { busy: total - fields[3]! - fields[4]!, total };
  });
}

function memory(): { used: number; total: number } {
  const info: Record<string, number> = {};
  for (const line of readFileSync("/proc/meminfo", "utf8").split("\n")) {
    const [key, value] = line.split(":");
    if (key && value) info[key] = Number.parseInt(value, 10) * 1024;
  }
  return { used: info.MemTotal! - info.MemAvailable!, total: info.MemTotal! };
}

interface Process {
  pid: number;
  /** The kernel's short name for it, at most 15 characters. */
  comm: string;
  ticks: number;
  rss: number;
}

/** Every process's CPU time so far and resident memory. */
function processes(): Map<number, Process> {
  const found = new Map<number, Process>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${entry}/stat`, "utf8");
    } catch {
      continue; // Gone since the folder was read.
    }
    // The name is in parentheses and may hold spaces; fields from the state on follow it.
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).split(" ");
    found.set(Number(entry), {
      pid: Number(entry),
      comm: stat.slice(stat.indexOf("(") + 1, close),
      ticks: Number(fields[11]) + Number(fields[12]),
      rss: Number(fields[21]) * pageSize,
    });
  }
  return found;
}

/** A listed process's name: its program's file name where the kernel's is cut short. */
function processName(process: Process): string {
  try {
    // Some programs (Chromium's helpers) rewrite their arguments as one string: the first word is the program.
    const program = readFileSync(`/proc/${process.pid}/cmdline`, "utf8").split("\0")[0] ?? "";
    const name = basename(program.split(/\s/)[0]!);
    if (name.startsWith(process.comm)) return name;
  } catch {
    // Gone: its short name will do.
  }
  return process.comm;
}

function bytes(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)} GB`;
  if (value >= 1e6) return `${Math.round(value / 1e6)} MB`;
  return `${Math.round(value / 1e3)} KB`;
}

let lastTimes = cpuTimes();
let lastProcesses = processes();
let lastAt = Date.now();
const histories = lastTimes.slice(1).map(() => Array<number>(HISTORY).fill(0));
/** The last sample's processes with their CPU use, for sorting again without waiting. */
let ranked: { process: Process; cpu: number }[] = [];

function rows(sort: unknown): Record<string, unknown>[] {
  const order = sort === "memory"
    ? [...ranked].sort((a, b) => b.process.rss - a.process.rss)
    : [...ranked].sort((a, b) => b.cpu - a.cpu || b.process.rss - a.process.rss);
  return order.slice(0, LISTED).map(({ process, cpu }) => ({
    name: processName(process),
    cpu: `${cpu.toFixed(cpu >= 10 ? 0 : 1)}%`,
    memory: bytes(process.rss),
  }));
}

function sample(): Record<string, unknown> {
  const times = cpuTimes();
  const now = Date.now();
  const share = (index: number) => {
    const busy = times[index]!.busy - lastTimes[index]!.busy;
    const total = times[index]!.total - lastTimes[index]!.total;
    return total > 0 ? Math.max(0, Math.min(1, busy / total)) : 0;
  };
  const cpu = Math.round(share(0) * 100);
  const cores = times.slice(1).map((_, index) => {
    const use = Math.round(share(index + 1) * 100);
    histories[index]!.push(use);
    histories[index]!.shift();
    return { id: `cpu${index}`, name: String(index + 1), value: `${use}%`, history: [...histories[index]!] };
  });

  const current = processes();
  const seconds = (now - lastAt) / 1000;
  ranked = [...current.values()].map((process) => {
    const before = lastProcesses.get(process.pid);
    const ticks = before ? process.ticks - before.ticks : 0;
    return { process, cpu: (ticks / ticksPerSecond / seconds) * 100 };
  });
  lastTimes = times;
  lastProcesses = current;
  lastAt = now;

  const { used, total } = memory();
  const load = readFileSync("/proc/loadavg", "utf8").split(" ")[0]!;
  return {
    cpu: String(cpu),
    memory: (used / 1e9).toFixed(1),
    memoryOf: `of ${(total / 1e9).toFixed(0)} GB in use`,
    load,
    loadOf: `over a minute, ${cores.length} cores`,
    cores,
    rows: rows(view.get("/sort")),
  };
}

const view = ui.open("activity", {
  mode: "floating", title: "Activity", width: 460,
  spec: {
    root: "root",
    state: { cpu: "–", memory: "–", memoryOf: "", load: "–", loadOf: "", cores: [], rows: [], sort: "cpu" },
    elements: {
      root: { type: "Stack", props: { gap: "lg" }, children: ["summary", "coresPart", "processesPart"] },
      summary: { type: "Grid", props: { columns: 3 }, children: ["cpu", "memory", "load"] },
      cpu: { type: "Metric", props: { label: "CPU", value: { $state: "/cpu" }, unit: "%" }, children: [] },
      memory: { type: "Metric", props: { label: "Memory", value: { $state: "/memory" }, unit: "GB",
                                         caption: { $state: "/memoryOf" } }, children: [] },
      load: { type: "Metric", props: { label: "Load", value: { $state: "/load" }, caption: { $state: "/loadOf" } }, children: [] },
      coresPart: { type: "Stack", props: { gap: "sm" }, children: ["coresTitle", "cores"] },
      coresTitle: { type: "Text", props: { text: "Cores", tone: "muted", size: "sm", weight: "bold" }, children: [] },
      cores: { type: "Grid", props: { columns: 4, gap: "md" }, repeat: { statePath: "/cores", key: "id" }, children: ["core"] },
      core: { type: "Stack", props: { gap: "xs" }, children: ["coreHead", "coreChart"] },
      coreHead: { type: "Stack", props: { direction: "horizontal", justify: "between" }, children: ["coreName", "coreUse"] },
      coreName: { type: "Text", props: { text: { $item: "name" }, tone: "muted", size: "sm" }, children: [] },
      coreUse: { type: "Text", props: { text: { $item: "value" }, size: "sm", weight: "medium" }, children: [] },
      coreChart: { type: "Sparkline", props: { values: { $item: "history" }, height: 20, min: 0, max: 100, tone: "accent" },
                   children: [] },
      processesPart: { type: "Stack", props: { gap: "sm" }, children: ["processesHead", "table"] },
      processesHead: { type: "Stack", props: { direction: "horizontal", justify: "between", align: "center" },
                       children: ["processesTitle", "sort"] },
      processesTitle: { type: "Text", props: { text: "Processes", tone: "muted", size: "sm", weight: "bold" }, children: [] },
      sort: { type: "Tabs", children: [], on: { change: { action: "sort" } },
              props: { options: [{ value: "cpu", label: "CPU" }, { value: "memory", label: "Memory" }],
                       value: { $bindState: "/sort" } } },
      table: { type: "Table", children: [], props: {
        columns: [{ key: "name", label: "Process" }, { key: "cpu", label: "CPU", align: "end" },
                  { key: "memory", label: "Memory", align: "end" }],
        rows: { $state: "/rows" },
      } },
    },
  },
});

view.on("sort", (_, card) => card.set({ rows: rows(card.get("/sort")) }));
// Rates are differences between samples: the first comes one interval after the start.
setTimeout(() => {
  view.set(sample());
  setInterval(() => view.set(sample()), INTERVAL);
}, INTERVAL);
