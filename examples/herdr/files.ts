// What the code viewer shows of a session's worktree, read by the director:
// pages run in Chromium and cannot read the disk, so the world reads for them
// and answers the page's requests over herdr/channel.ts.

import { execFile } from "node:child_process";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

/** git's short status of a changed file: M, A, D, R, ? (untracked). */
export type Change = "M" | "A" | "D" | "R" | "?";

export interface Listing {
  root: string;
  files: string[];
  changes: Record<string, Change>;
  /** More files exist than `files` holds. */
  truncated: boolean;
}

export interface OpenFile {
  path: string;
  content: string;
  /** Shown only in part, being larger than the viewer reads. */
  truncated: boolean;
  binary: boolean;
}

const maxFiles = 20_000;
const maxBytes = 512 * 1024;

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((done) => {
    execFile("git", ["-C", cwd, ...args], { timeout: 10_000, maxBuffer: 64 << 20 }, (error, out) =>
      done(error ? null : String(out)),
    );
  });
}

/** Files below ROOT, honouring .gitignore where it is a git checkout, plus what git sees changed. */
export async function listFiles(root: string): Promise<Listing> {
  const tracked = await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  let files = tracked === null ? await walk(root) : tracked.split("\0").filter(Boolean);
  const changes: Record<string, Change> = {};
  const status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status) {
    const entries = status.split("\0");
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      if (entry.length < 4) continue;
      const code = entry.slice(0, 2);
      const path = entry.slice(3);
      // A rename's original path follows as its own entry.
      if (code.includes("R")) index++;
      changes[path] = code === "??" ? "?" : (code.replace(" ", "")[0] as Change);
    }
    // Deleted files are gone from ls-files' worktree view but worth listing.
    for (const [path, change] of Object.entries(changes)) if (change === "D" && !files.includes(path)) files.push(path);
  }
  files.sort();
  const truncated = files.length > maxFiles;
  if (truncated) files = files.slice(0, maxFiles);
  return { root, files, changes, truncated };
}

/** Outside git: a plain walk, skipping hidden directories and the usual build output. */
async function walk(root: string): Promise<string[]> {
  const skip = new Set(["node_modules", "target", "dist", "build", "dist-newstyle"]);
  const out: string[] = [];
  const visit = async (directory: string) => {
    if (out.length > maxFiles) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || skip.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) out.push(relative(root, path));
    }
  };
  await visit(root);
  return out;
}

/** Reads PATH (relative to ROOT) for the viewer; refuses paths that leave ROOT. */
export async function readFile(root: string, path: string): Promise<OpenFile> {
  const full = resolve(root, path);
  if (full !== root && !full.startsWith(root.endsWith(sep) ? root : root + sep)) {
    return { path, content: "outside the worktree", truncated: false, binary: true };
  }
  let handle;
  try {
    handle = await open(full, "r");
  } catch (error) {
    // A deleted file reads as empty; the viewer shows it as its diff.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, content: "", truncated: false, binary: false };
    return { path, content: (error as Error).message, truncated: false, binary: true };
  }
  try {
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    await handle.read(buffer, 0, buffer.length, 0);
    const binary = buffer.subarray(0, 8000).includes(0);
    return {
      path,
      content: binary ? "" : buffer.toString("utf8"),
      truncated: size > maxBytes,
      binary,
    };
  } finally {
    await handle.close();
  }
}

/** PATH as HEAD has it, for the viewer's diff; "" for a file HEAD lacks, as an untracked one. */
export async function originalFile(root: string, path: string): Promise<string> {
  const text = await git(root, ["show", `HEAD:./${path}`]);
  return text === null ? "" : text.slice(0, maxBytes);
}

const imageTypes: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon",
};

/** An image in the project as a data: URL, for a markdown file that shows it. */
export async function readImage(root: string, path: string): Promise<string> {
  const type = imageTypes[path.split(".").pop()?.toLowerCase() ?? ""];
  const full = resolve(root, path);
  if (!type || !full.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error("not an image in the project");
  const handle = await open(full, "r");
  try {
    const { size } = await handle.stat();
    if (size > 4 << 20) throw new Error("image too large");
    const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, 0);
    return `data:${type};base64,${buffer.toString("base64")}`;
  } finally {
    await handle.close();
  }
}

/** One line ripgrep matched, with where in it the first match is. */
export interface Hit {
  path: string;
  line: number;
  /** The match's first character in the line, 0-based, and its length. */
  column: number;
  length: number;
  text: string;
}

const maxHits = 400;

/** Searches the project for PATTERN with ripgrep (smart case, .gitignore honoured), as Projectile's search does. */
export function grepProject(root: string, pattern: string): Promise<{ hits: Hit[]; truncated: boolean }> {
  return new Promise((done, fail) => {
    if (!pattern.trim()) return done({ hits: [], truncated: false });
    execFile("rg", ["--json", "--smart-case", "--max-columns", "400", "--max-count", "50", "--max-filesize", "2M",
                    "-e", pattern, "--", "."],
      { cwd: root, timeout: 15_000, maxBuffer: 64 << 20 },
      (error, out, err) => {
        // rg exits 1 when nothing matched, 2 on a bad pattern.
        if (error && (error as { code?: number }).code === 2 && !out) return fail(new Error(String(err).trim().split("\n").pop()));
        const hits: Hit[] = [];
        let truncated = false;
        for (const line of String(out).split("\n")) {
          if (!line.startsWith('{"type":"match"')) continue;
          if (hits.length >= maxHits) {
            truncated = true;
            break;
          }
          const { data } = JSON.parse(line);
          const text: string = data.lines.text ?? "";
          const first = data.submatches[0];
          // Offsets are in bytes; the page wants characters.
          const bytes = Buffer.from(text);
          const column = first ? bytes.subarray(0, first.start).toString().length : 0;
          const length = first ? bytes.subarray(first.start, first.end).toString().length : 0;
          hits.push({ path: data.path.text.replace(/^\.\//, ""), line: data.line_number, column, length, text: text.replace(/\n$/, "") });
        }
        done({ hits, truncated });
      });
  });
}

/** A typed directory with "~" for the home directory, made absolute. */
export function expandHome(path: string): string {
  const home = homedir();
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return resolve(home, path);
}

/** Whether PATH (as typed) names a directory. */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(expandHome(path))).isDirectory();
  } catch {
    return false;
  }
}

const maxDirectories = 400;

/**
 * Directories to open a workspace in. With PATH typed ("~/fun/pro"): the
 * directories beside it, under the directory it is in. Otherwise the ones
 * zoxide knows, most used first; none without zoxide.
 */
export async function listDirectories(path: string): Promise<{ base: string | null; directories: string[] }> {
  if (path) {
    const typed = expandHome(path);
    const base = path.endsWith("/") ? typed : dirname(typed);
    let entries;
    try {
      entries = await readdir(base, { withFileTypes: true });
    } catch {
      return { base, directories: [] };
    }
    const directories = entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => join(base, entry.name))
      .sort((a, b) => Number(a.includes("/.")) - Number(b.includes("/.")) || a.localeCompare(b))
      .slice(0, maxDirectories);
    return { base, directories };
  }
  const known = await new Promise<string | null>((done) => {
    execFile("zoxide", ["query", "--list"], { timeout: 5000, maxBuffer: 16 << 20 }, (error, out) =>
      done(error ? null : String(out)),
    );
  });
  return { base: null, directories: (known ?? "").split("\n").filter(Boolean).slice(0, maxDirectories) };
}
