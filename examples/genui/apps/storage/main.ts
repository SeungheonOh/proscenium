// Storage: where the disk space went. How full each disk is, then the largest
// folders and files in a folder, measured by du in a process of its own;
// pressing a folder measures inside it, and folders measured once come back at
// once.
//
//     proscenium-ui start storage

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname } from "node:path";
import { app } from "proscenium-app";

const ui = app({ name: "storage", title: "Storage" });
const home = homedir();

/** Bytes for people: 1000s, as file managers count them. */
function size(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** SIZE's share of TOTAL, in whole percents; a sliver is under one. */
const share = (size: number, total: number) => {
  const percent = total ? (size / total) * 100 : 0;
  return percent > 0 && percent < 1 ? "under 1%" : `${Math.round(percent)}%`;
};

const shortPath = (path: string) => (path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);
const folderName = (path: string) => (path === home ? "Home" : path === "/" ? "Computer" : basename(path));

/** File systems that hold no files of the person's: memory, packages, portals. */
const virtual = new Set(["tmpfs", "devtmpfs", "ramfs", "squashfs", "overlay", "efivarfs", "fuse.portal",
  "fuse.gvfsd-fuse", "nsfs"]);

/** Each disk once (a disk mounted twice shows where it is mounted highest), fullest first. */
function disks(): Record<string, unknown>[] {
  let out = "";
  try {
    out = execFileSync("df", ["-B1", "--output=source,fstype,size,used,avail,target"], { encoding: "utf8" });
  } catch (error) {
    // df exits 1 when one mount cannot be read, and still lists the rest.
    out = (error as { stdout?: string }).stdout ?? "";
  }
  const bySource = new Map<string, { mount: string; size: number; used: number; free: number }>();
  for (const line of out.trim().split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 6) continue;
    const [source, type, total, used, free] = fields;
    const mount = fields.slice(5).join(" ");
    if (virtual.has(type!) || !(Number(total) > 0)) continue;
    const known = bySource.get(source!);
    if (known && known.mount.length <= mount.length) continue;
    bySource.set(source!, { mount, size: Number(total), used: Number(used), free: Number(free) });
  }
  return [...bySource.values()]
    .sort((a, b) => b.used / b.size - a.used / a.size)
    .map((disk) => {
      const use = disk.used / disk.size;
      return {
        id: disk.mount,
        name: disk.mount === "/" ? "System" : disk.mount === home ? "Home" : shortPath(disk.mount),
        detail: `${size(disk.free)} free of ${size(disk.size)}`,
        use,
        tone: use > 0.9 ? "danger" : use > 0.8 ? "warning" : "accent",
      };
    });
}

interface Entry {
  path: string;
  size: number;
  folder: boolean;
}

interface Measured {
  total: number;
  entries: Entry[];
}

/** The most entries a folder lists; the rest are summed in a line under them. */
const LISTED = 12;
const measured = new Map<string, Measured>();
let folder = home;
let measuring: ChildProcess | null = null;

/** What the card shows of FOLDER: what is known of it, or that it is being measured. */
function folderState(): Record<string, unknown> {
  const known = measured.get(folder);
  const name = folderName(folder);
  const listed = known?.entries.slice(0, LISTED) ?? [];
  const rest = known ? known.entries.slice(LISTED) : [];
  const restSize = rest.reduce((sum, entry) => sum + entry.size, 0);
  return {
    name,
    folder: shortPath(folder),
    total: known ? size(known.total) : "measuring…",
    measuring: !known,
    listed: listed.length > 0,
    atTop: folder === "/",
    entries: listed.map((entry) => ({
      path: entry.path,
      name: basename(entry.path),
      size: size(entry.size),
      icon: entry.folder ? "📁" : "📄",
      detail: `${share(entry.size, known!.total)} of ${name}`,
    })),
    hasRest: rest.length > 0,
    rest: `${rest.length} smaller ${rest.length === 1 ? "item" : "items"}, ${size(restSize)} in all`,
  };
}

/** Show FOLDER, measuring it unless it was measured already (or AGAIN asks for it fresh). */
function visit(path: string, again = false): void {
  folder = path;
  if (measuring) {
    measuring.kill();
    measuring = null;
  }
  if (again) measured.delete(path);
  view.set(folderState());
  if (measured.has(path)) return;
  // Entries one level down, files too, on this disk only, in bytes; the last line is the folder.
  const child = spawn("du", ["-x", "-a", "-d", "1", "-B1", path], { stdio: ["ignore", "pipe", "ignore"] });
  measuring = child;
  let out = "";
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
  // du says which entries it could not read on stderr and exits 1, with the rest measured.
  child.on("close", () => {
    if (measuring !== child) return;
    measuring = null;
    const entries: Entry[] = [];
    let total = 0;
    for (const line of out.split("\n")) {
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const bytes = Number(line.slice(0, tab));
      const entry = line.slice(tab + 1);
      if (entry === path) {
        total = bytes;
        continue;
      }
      let isFolder = false;
      try {
        isFolder = lstatSync(entry).isDirectory();
      } catch {
        // Gone since du saw it: still counted.
      }
      entries.push({ path: entry, size: bytes, folder: isFolder });
    }
    entries.sort((a, b) => b.size - a.size);
    measured.set(path, { total, entries });
    if (folder === path) view.set(folderState());
  });
}

const view = ui.open("storage", {
  mode: "floating", title: "Storage", width: 420,
  spec: {
    root: "root",
    state: { disks: disks(), ...folderState() },
    elements: {
      root: { type: "Stack", props: { gap: "lg" }, children: ["disks", "divider", "contents"] },
      disks: { type: "Stack", props: { gap: "md" }, repeat: { statePath: "/disks", key: "id" }, children: ["disk"] },
      disk: { type: "Stack", props: { gap: "xs" }, children: ["diskHead", "diskBar"] },
      diskHead: { type: "Stack", props: { direction: "horizontal", justify: "between" }, children: ["diskName", "diskFree"] },
      diskName: { type: "Text", props: { text: { $item: "name" }, weight: "medium" }, children: [] },
      diskFree: { type: "Text", props: { text: { $item: "detail" }, tone: "muted", size: "sm" }, children: [] },
      diskBar: { type: "ProgressBar", props: { value: { $item: "use" }, tone: { $item: "tone" } }, children: [] },
      divider: { type: "Divider", props: {}, children: [] },
      contents: { type: "Stack", props: { gap: "sm" }, children: ["head", "where", "busy", "entries", "rest"] },
      head: { type: "Stack", props: { direction: "horizontal", align: "center", gap: "sm" }, children: ["name", "space", "up", "again"] },
      name: { type: "Heading", props: { text: { $state: "/name" }, level: 3 }, children: [] },
      space: { type: "Spacer", props: {}, children: [] },
      up: { type: "Button", props: { label: "Up", size: "small", disabled: { $state: "/atTop" } }, children: [],
            on: { press: { action: "up" } } },
      again: { type: "Button", props: { label: "Measure again", size: "small", variant: "tinted" }, children: [],
               on: { press: { action: "again" } } },
      where: { type: "Text", props: { text: { $template: "${/folder} · ${/total}" }, tone: "muted", size: "sm", maxLines: 1 },
               children: [] },
      busy: { type: "ProgressBar", props: { value: null, label: "Measuring…" }, visible: { $state: "/measuring" }, children: [] },
      entries: { type: "List", props: {}, visible: { $state: "/listed" }, repeat: { statePath: "/entries", key: "path" },
                 children: ["entry"] },
      entry: { type: "ListItem", children: [],
               props: { title: { $item: "name" }, subtitle: { $item: "detail" }, leading: { $item: "icon" }, trailing: { $item: "size" } },
               on: { press: { action: "open", params: { path: { $item: "path" } } } } },
      rest: { type: "Text", props: { text: { $state: "/rest" }, tone: "muted", size: "sm" }, visible: { $state: "/hasRest" },
              children: [] },
    },
  },
});

// An item's field in an action's params arrives as its state path (json-render's rule, for
// setState): the value is in the state there.
view.on("open", ({ path }, card) => {
  const wanted = card.get(String(path));
  const entry = measured.get(folder)?.entries.find((candidate) => candidate.path === wanted);
  if (entry?.folder) visit(entry.path);
});
view.on("up", () => {
  if (folder !== "/") visit(dirname(folder));
});
view.on("again", () => {
  view.set({ disks: disks() });
  visit(folder, true);
});
view.onClose(() => measuring?.kill());

visit(home);
setInterval(() => view.set({ disks: disks() }), 10_000);
