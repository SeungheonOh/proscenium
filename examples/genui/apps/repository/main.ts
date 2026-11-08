// Repository: a git checkout at a glance. Its branch and how it stands with its
// upstream, the files changed (press one for its diff) and the latest commits,
// kept current every three seconds. Another checkout is a path away.
//
//     proscenium-ui start repository     (the checkout it showed last, else the one it runs in)
//     node examples/genui/run.mjs examples/genui/apps/repository/main.ts PATH

import { execFileSync } from "node:child_process";
import { openSync, readSync, closeSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { app } from "proscenium-app";

const ui = app({ name: "repository", title: "Repository" });
const home = homedir();
const shortPath = (path: string) => (path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 32 << 20 });
  } catch {
    return null;
  }
}

/** The checkout PATH is in, or null when it is in none. */
const checkoutOf = (path: string) => git(path, ["rev-parse", "--show-toplevel"])?.trim() || null;

interface Change {
  path: string;
  /** Where a renamed or copied file came from. */
  from?: string;
  /** git's two-letter status: the index, then the working tree. */
  code: string;
}

interface Status {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: Change[];
}

function status(root: string): Status | null {
  const out = git(root, ["status", "--porcelain=v1", "--branch", "-z", "--untracked-files=all"]);
  if (out === null) return null;
  const entries = out.split("\0");
  const head = entries[0]?.match(/^## (?:No commits yet on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/);
  const changes: Change[] = [];
  for (let i = 1; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    const change: Change = { code: entry.slice(0, 2), path: entry.slice(3) };
    // A rename or copy names where it came from in the entry after it.
    if (/[RC]/.test(change.code)) change.from = entries[++i];
    changes.push(change);
  }
  return {
    branch: head?.[1] ?? "unknown",
    upstream: head?.[2] ?? null,
    ahead: Number(head?.[3]?.match(/ahead (\d+)/)?.[1] ?? 0),
    behind: Number(head?.[3]?.match(/behind (\d+)/)?.[1] ?? 0),
    changes,
  };
}

/** Lines added and removed in each changed file against the last commit. */
function lineCounts(root: string): Map<string, { added: string; removed: string }> {
  const counts = new Map<string, { added: string; removed: string }>();
  const tokens = (git(root, ["diff", "HEAD", "--numstat", "-z", "-M"]) ?? "").split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const [added, removed, path] = tokens[i]!.split("\t");
    if (added === undefined || removed === undefined) continue;
    // A rename's paths follow in their own tokens: from, then to.
    const name = path || tokens[(i += 2)];
    if (name) counts.set(name, { added: added!, removed: removed! });
  }
  return counts;
}

const conflicts = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

function describe(change: Change, counts: { added: string; removed: string } | undefined): { icon: string; detail: string } {
  const [index, tree] = change.code;
  const lines = counts && counts.added !== "-" ? ` · +${counts.added} −${counts.removed}` : counts ? " · binary" : "";
  const staged = index !== " " && index !== "?" ? (tree !== " " ? ", partly staged" : ", staged") : "";
  if (change.code === "??") return { icon: "➕", detail: "new file, not tracked" };
  if (conflicts.has(change.code)) return { icon: "⚠️", detail: "conflict to resolve" };
  if (index === "R" || index === "C") {
    return { icon: "🔀", detail: `${index === "R" ? "renamed" : "copied"} from ${change.from}${staged}${lines}` };
  }
  if (index === "A") return { icon: "➕", detail: `added${staged}${lines}` };
  if (index === "D" || tree === "D") return { icon: "🗑️", detail: `deleted${staged}${lines}` };
  return { icon: "📝", detail: `modified${staged}${lines}` };
}

function ago(seconds: number): string {
  const elapsed = Date.now() / 1000 - seconds;
  const count = (value: number, unit: string) => `${value} ${unit}${value === 1 ? "" : "s"} ago`;
  if (elapsed < 60) return "just now";
  if (elapsed < 3600) return count(Math.floor(elapsed / 60), "minute");
  if (elapsed < 86400) return count(Math.floor(elapsed / 3600), "hour");
  if (elapsed < 30 * 86400) return count(Math.floor(elapsed / 86400), "day");
  return new Date(seconds * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function commits(root: string): Record<string, unknown>[] {
  const out = git(root, ["log", "-15", "--format=%h%x1f%s%x1f%an%x1f%ct"]) ?? "";
  return out.trim().split("\n").filter(Boolean).map((line) => {
    const [hash, subject, author, time] = line.split("\x1f");
    return { hash, subject, author, detail: `${hash} · ${author} · ${ago(Number(time))}` };
  });
}

/** Whether the start of FILE reads as text: no NUL byte in its first 8 KB. */
function isText(file: string): boolean {
  const buffer = Buffer.alloc(8192);
  const fd = openSync(file, "r");
  try {
    return !buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).includes(0);
  } finally {
    closeSync(fd);
  }
}

/** What the diff part shows for CHANGE: a patch, a new file's text, or why there is neither. */
function diffOf(root: string, change: Change): Record<string, unknown> {
  const none = { patch: null, before: null, after: null };
  if (change.code === "??") {
    const file = join(root, change.path);
    try {
      if (statSync(file).size > 256 * 1024) return { ...none, hasDiff: false, note: "Too large to show." };
      if (!isText(file)) return { ...none, hasDiff: false, note: "A binary file." };
      return { ...none, before: "", after: readFileSync(file, "utf8"), hasDiff: true, note: "" };
    } catch {
      return { ...none, hasDiff: false, note: "It can no longer be read." };
    }
  }
  const paths = change.from ? [change.from, change.path] : [change.path];
  const patch = git(root, ["diff", "HEAD", "-M", "--", ...paths]) ?? git(root, ["diff", "--cached", "--", ...paths]) ?? "";
  if (!patch.trim()) return { ...none, hasDiff: false, note: "No changes to its text: its mode or type changed." };
  if (/^Binary files /m.test(patch)) return { ...none, hasDiff: false, note: "A binary file." };
  return { ...none, patch, hasDiff: true, note: "" };
}

const saved = ui.load<{ path?: string }>({});
let root = checkoutOf(process.argv[2] ? resolve(process.argv[2]) : saved.path ?? process.cwd()) ?? checkoutOf(home);
let picked: string | null = null;

/** Everything the card shows of the checkout, as its state. */
function shown(): Record<string, unknown> {
  const now = root ? status(root) : null;
  if (!root || !now) {
    return { name: "No checkout", where: "Give the path of one below.", branch: "–", sync: "", syncTone: "muted",
             changed: "", changedTone: "muted", isClean: false, files: [], commits: [], hasDiff: false, note: "" };
  }
  const counts = lineCounts(root);
  if (picked && !now.changes.some((change) => change.path === picked)) picked = null;
  const change = now.changes.find((each) => each.path === picked);
  const sync = !now.upstream ? "no upstream"
    : now.ahead || now.behind ? [now.ahead && `↑${now.ahead}`, now.behind && `↓${now.behind}`].filter(Boolean).join(" ")
    : "up to date";
  return {
    name: basename(root),
    where: shortPath(root),
    branch: now.branch,
    sync,
    syncTone: !now.upstream ? "muted" : now.behind ? "warning" : now.ahead ? "accent" : "success",
    changed: now.changes.length ? `${now.changes.length} changed` : "clean",
    changedTone: now.changes.length ? "warning" : "success",
    isClean: now.changes.length === 0,
    files: now.changes.map((each) => ({ path: each.path, selected: each.path === picked, ...describe(each, counts.get(each.path)) })),
    commits: commits(root),
    picked: picked ?? "",
    ...(change ? diffOf(root, change) : { hasDiff: false, note: "" }),
  };
}

/** The state last sent, by key: a refresh sends only what changed. */
const sent = new Map<string, string>();

function refresh(): void {
  const values = shown();
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const text = JSON.stringify(value);
    if (sent.get(key) === text) continue;
    sent.set(key, text);
    changed[key] = value;
  }
  if (Object.keys(changed).length) view.set(changed);
}

const first = shown();
for (const [key, value] of Object.entries(first)) sent.set(key, JSON.stringify(value));

const view = ui.open("repository", {
  mode: "floating", title: "Repository", width: 500,
  spec: {
    root: "root",
    state: { ...first, tab: "changes", pathDraft: "", problem: "", hasProblem: false },
    elements: {
      root: { type: "Stack", props: { gap: "lg" }, children: ["head", "tabs", "changes", "history", "other"] },
      head: { type: "Stack", props: { gap: "sm" }, children: ["name", "where", "badges"] },
      name: { type: "Heading", props: { text: { $state: "/name" }, level: 2 }, children: [] },
      where: { type: "Text", props: { text: { $state: "/where" }, tone: "muted", size: "sm" }, children: [] },
      badges: { type: "Stack", props: { direction: "horizontal", gap: "sm", wrap: true }, children: ["branch", "sync", "changed"] },
      branch: { type: "Badge", props: { text: { $state: "/branch" }, tone: "accent" }, children: [] },
      sync: { type: "Badge", props: { text: { $state: "/sync" }, tone: { $state: "/syncTone" } }, children: [] },
      changed: { type: "Badge", props: { text: { $state: "/changed" }, tone: { $state: "/changedTone" } }, children: [] },
      tabs: { type: "Tabs", children: [],
              props: { options: [{ value: "changes", label: "Changes" }, { value: "history", label: "History" }],
                       value: { $bindState: "/tab" } } },
      // The picked file's diff above the list, where it is seen; pressing the file again hides it.
      changes: { type: "Stack", props: { gap: "md" }, visible: { $state: "/tab", eq: "changes" }, children: ["clean", "diff", "note", "files"] },
      clean: { type: "Text", props: { text: "Nothing to commit: the files match the last commit.", tone: "muted" },
               visible: { $state: "/isClean" }, children: [] },
      files: { type: "List", props: {}, repeat: { statePath: "/files", key: "path" }, children: ["file"] },
      file: { type: "ListItem", children: [],
              props: { title: { $item: "path" }, subtitle: { $item: "detail" }, leading: { $item: "icon" }, selected: { $item: "selected" } },
              on: { press: { action: "pick", params: { path: { $item: "path" } } } } },
      diff: { type: "Diff", children: [], visible: { $state: "/hasDiff" },
              props: { patch: { $state: "/patch" }, before: { $state: "/before" }, after: { $state: "/after" },
                       path: { $state: "/picked" }, maxLines: 40 } },
      note: { type: "Text", props: { text: { $state: "/note" }, tone: "muted", size: "sm" }, visible: { $state: "/note" }, children: [] },
      history: { type: "List", props: {}, visible: { $state: "/tab", eq: "history" }, repeat: { statePath: "/commits", key: "hash" },
                 children: ["commit"] },
      commit: { type: "ListItem", children: [],
                props: { title: { $item: "subject" }, subtitle: { $item: "detail" }, leading: { $item: "author" } } },
      other: { type: "Stack", props: { gap: "xs" }, children: ["path", "problem"] },
      path: { type: "TextField", children: [], on: { submit: { action: "switch" } },
              props: { value: { $bindState: "/pathDraft" }, placeholder: "Another checkout: its path, then Return" } },
      problem: { type: "Text", props: { text: { $state: "/problem" }, tone: "danger", size: "sm" }, visible: { $state: "/hasProblem" },
                 children: [] },
    },
  },
});

// An item's field in an action's params arrives as its state path (json-render's rule, for
// setState): the value is in the state there.
view.on("pick", ({ path }, card) => {
  const wanted = String(card.get(String(path)));
  picked = picked === wanted ? null : wanted;
  refresh();
});

view.on("switch", (_, card) => {
  const typed = String(card.get("/pathDraft") ?? "").trim();
  if (!typed) return;
  const path = resolve(typed.replace(/^~(?=$|\/)/, home));
  const found = checkoutOf(path);
  if (!found) {
    card.set({ problem: `${shortPath(path)} is not in a git checkout.`, hasProblem: true });
    return;
  }
  root = found;
  picked = null;
  ui.save({ path: root });
  card.set({ pathDraft: "", problem: "", hasProblem: false, tab: "changes" });
  refresh();
});

setInterval(refresh, 3000);
