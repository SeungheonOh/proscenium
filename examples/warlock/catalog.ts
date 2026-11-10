/**
 * Installed applications, as Warlock's catalog reads them from desktop
 * entries: names, keywords, the window class they open under, and their own
 * actions. Search ranks as Warlock's does: the exact name, then names that
 * start with the query, then entries where every word of the query starts some
 * word of the name, generic name or keywords; nothing matches inside a word.
 */

import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { useSyncExternalStore } from "react";
import { launch } from "proscenium";

export interface CatalogAction {
  id: string;
  name: string;
  exec: string;
}

export interface CatalogEntry {
  /** The desktop-entry id: its path under `applications`, `/` as `-`, without `.desktop`. */
  id: string;
  name: string;
  genericName: string;
  keywords: readonly string[];
  /** The window class its windows report, where that is not the id. */
  wmClass: string;
  exec: string;
  path: string;
  /** Whether it can be given files or URLs to open. */
  opensFiles: boolean;
  actions: readonly CatalogAction[];
}

const entryLimit = 2048;

function applicationRoots(): string[] {
  const home = process.env.XDG_DATA_HOME || join(homedir(), ".local/share");
  const data = process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share";
  const roots = [home, ...data.split(":")].filter((root) => root.startsWith("/"));
  return [...new Set(roots)].map((root) => join(root, "applications"));
}

/** The groups of a desktop file, each a map of its keys. */
function parseDesktopFile(text: string): Map<string, Map<string, string>> {
  const groups = new Map<string, Map<string, string>>();
  let current: Map<string, string> | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      current = new Map();
      groups.set(line.slice(1, -1), current);
    } else if (current && !line.startsWith("#")) {
      const equals = line.indexOf("=");
      if (equals > 0) current.set(line.slice(0, equals).trim(), line.slice(equals + 1).trim());
    }
  }
  return groups;
}

/** KEY of GROUP in the user's language where the file has it. */
function localized(group: Map<string, string>, key: string): string {
  const locale = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "";
  const [plain = "", modifier] = locale.split("@");
  const base = plain.split(".")[0] ?? "";
  const language = base.split("_")[0] ?? "";
  const names =
    modifier === undefined
      ? [base, language]
      : [`${base}@${modifier}`, base, `${language}@${modifier}`, language];
  for (const name of names) {
    const value = group.get(`${key}[${name}]`);
    if (value !== undefined) return value;
  }
  return group.get(key) ?? "";
}

async function desktopFiles(root: string, under = ""): Promise<string[]> {
  const entries = await readdir(join(root, under), { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = under ? `${under}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await desktopFiles(root, path)));
    else if (entry.name.endsWith(".desktop")) files.push(path);
  }
  return files;
}

async function scan(): Promise<CatalogEntry[] | null> {
  // Earlier roots win: a user's entry hides, or replaces, a system one with the same id.
  const seen = new Set<string>();
  const entries: CatalogEntry[] = [];
  for (const root of applicationRoots()) {
    for (const file of await desktopFiles(root)) {
      const id = file.slice(0, -".desktop".length).replaceAll("/", "-");
      if (seen.has(id) || id.length > 256) continue;
      const path = join(root, file);
      const groups = parseDesktopFile(await readFile(path, "utf8").catch(() => ""));
      const main = groups.get("Desktop Entry");
      if (!main) continue;
      // An entry marked hidden is gone, and takes the same entry of later roots with it.
      if ((main.get("Hidden") ?? "").toLowerCase() === "true") {
        seen.add(id);
        continue;
      }
      const exec = main.get("Exec");
      if (main.get("Type") !== "Application" || !exec) continue;
      seen.add(id);
      const actions: CatalogAction[] = [];
      for (const action of (main.get("Actions") ?? "").split(";").filter(Boolean).slice(0, 32)) {
        const group = groups.get(`Desktop Action ${action}`);
        const actionExec = group?.get("Exec");
        if (group && actionExec)
          actions.push({ id: action, name: localized(group, "Name") || action, exec: actionExec });
      }
      entries.push({
        id,
        name: (localized(main, "Name") || id).slice(0, 512),
        genericName: localized(main, "GenericName"),
        keywords: localized(main, "Keywords").split(";").filter(Boolean).slice(0, 64),
        wmClass: main.get("StartupWMClass") ?? "",
        exec,
        path,
        opensFiles: /%[fFuU]/.test(exec),
        actions,
      });
    }
  }
  // Too many to list is no list: Warlock never shows part of a catalog.
  if (entries.length > entryLimit) return null;
  // Folded here, so that the first letter typed into a search has nothing to wait for.
  entries.forEach(searchText);
  return entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The catalog: the entries in id order, or null while there are too many to show; `loading` before the first read. */
export interface Catalog {
  entries: readonly CatalogEntry[];
  loading: boolean;
  unavailable: boolean;
}

let catalog: Catalog = { entries: [], loading: true, unavailable: false };
const listeners = new Set<() => void>();
let watchers: FSWatcher[] = [];
let timer: NodeJS.Timeout | null = null;

function publish(next: Catalog): void {
  catalog = next;
  for (const listener of [...listeners]) listener();
}

/** Read the installed applications again, as Refresh does. */
export function refreshCatalog(): Promise<void> {
  return scan().then((entries) =>
    publish({ entries: entries ?? [], loading: false, unavailable: entries === null }),
  );
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    void refreshCatalog();
    // Installing or removing an application changes its directory.
    const later = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refreshCatalog(), 300);
    };
    for (const root of applicationRoots()) {
      try {
        watchers.push(watch(root, later).on("error", () => undefined));
      } catch {
        // A directory that does not exist has nothing to watch.
      }
    }
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      watchers.forEach((watcher) => watcher.close());
      watchers = [];
    }
  };
}

/** Installed applications, kept current while anything reads them. */
export function useCatalog(): Catalog {
  return useSyncExternalStore(subscribe, () => catalog);
}

/** The entry with ID as the catalog was last read, for code that runs outside a render. */
export function catalogEntry(id: string): CatalogEntry | undefined {
  return catalog.entries.find((entry) => entry.id === id);
}

/** The entry whose windows report APP as their application id, if exactly one does. */
export function entryForApp(
  entries: readonly CatalogEntry[],
  app: string,
): CatalogEntry | undefined {
  if (!app) return undefined;
  const lower = app.toLowerCase();
  const matches = entries.filter(
    (entry) =>
      entry.id === app ||
      entry.wmClass === app ||
      entry.id.toLowerCase() === lower ||
      entry.wmClass.toLowerCase() === lower,
  );
  if (matches.length === 1) return matches[0];
  // Reverse-domain ids often end in the name windows report: "org.gnome.Nautilus" for "nautilus".
  const tails = entries.filter((entry) => entry.id.toLowerCase().split(".").pop() === lower);
  return matches[0] ?? (tails.length === 1 ? tails[0] : undefined);
}

/**
 * TEXT with case differences folded away, as Unicode folds them in full: "ß"
 * is "ss", a final sigma is a sigma, a ligature is its letters. Accents stay,
 * as Warlock keeps them: "é" is not "e".
 */
export function fold(text: string): string {
  let folded = "";
  // A letter's capital, made small again, is what its case variants share; dotless i shares it with nothing.
  for (const letter of text.toLowerCase())
    folded += letter === "ı" ? letter : letter.toUpperCase().toLowerCase();
  return folded;
}

/** What search reads of each entry: its folded name, and the folded words of its name, generic name and keywords. */
const searchable = new WeakMap<CatalogEntry, { name: string; tokens: readonly string[] }>();

function searchText(entry: CatalogEntry): { name: string; tokens: readonly string[] } {
  let text = searchable.get(entry);
  if (!text) {
    const tokens = [entry.name, entry.genericName, ...entry.keywords].flatMap((part) =>
      fold(part).split(/\s+/).filter(Boolean),
    );
    searchable.set(entry, (text = { name: fold(entry.name), tokens }));
  }
  return text;
}

/** The entries QUERY finds, best first: Warlock's three ranks, then by id. */
export function searchCatalog(entries: readonly CatalogEntry[], query: string): CatalogEntry[] {
  const q = fold(query.trim());
  if (q === "") return [...entries];
  const words = q.split(/\s+/);
  const ranked: { entry: CatalogEntry; rank: number }[] = [];
  for (const entry of entries) {
    const { name, tokens } = searchText(entry);
    let rank = -1;
    if (name === q) rank = 0;
    else if (name.startsWith(q)) rank = 1;
    else if (words.every((word) => tokens.some((token) => token.startsWith(word)))) rank = 2;
    if (rank >= 0) ranked.push({ entry, rank });
  }
  ranked.sort(
    (a, b) => a.rank - b.rank || (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0),
  );
  return ranked.map((item) => item.entry);
}

/** A desktop entry's command line as arguments, with FILE in place of its file codes. */
function commandLine(exec: string, file: string | null): string[] {
  const parts = exec.match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? [];
  const words: string[] = [];
  for (const part of parts) {
    const word = part.startsWith('"') ? part.slice(1, -1).replace(/\\(.)/g, "$1") : part;
    if (/^%[fFuU]$/.test(word)) {
      if (file !== null) words.push(file);
    } else if (!/^%[a-zA-Z]$/.test(word)) words.push(word.replaceAll("%%", "%"));
  }
  return words;
}

/** Start ENTRY: a new instance, one of its own actions, or with a file to open. */
export function launchEntry(
  entry: CatalogEntry,
  options: { action?: CatalogAction; file?: string } = {},
): void {
  if (options.action) launch(commandLine(options.action.exec, null));
  else if (options.file !== undefined) launch(commandLine(entry.exec, options.file));
  else launch(["gio", "launch", entry.path]);
}

/**
 * What the status chip goes on saying once the popup that started something
 * has closed: how the last launch went, until applications are next read, and
 * how the last application action went, until actions are next read.
 */
const said = { launch: "", action: "" };

/** The chip's notice: how the launch went, or IDLE without one, then how the action went. */
function saying(idle: string): string {
  return [said.launch || idle, said.action].filter(Boolean).join(" · ");
}

/** Note how a launch or an application action went; returns what the status chip should now say. */
export function launchNotice(kind: "launch" | "action", text: string, idle: string): string {
  said[kind] = text;
  return saying(idle);
}

/** Forget how the last launch or action went; returns what the chip should now say, or null if it said nothing of it. */
export function forgetLaunchNotice(kind: "launch" | "action", idle: string): string | null {
  if (said[kind] === "") return null;
  said[kind] = "";
  return saying(idle);
}
