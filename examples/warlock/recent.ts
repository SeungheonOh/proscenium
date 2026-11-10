/**
 * The files an application opened lately, from the desktop's shared list
 * (`$XDG_DATA_HOME/recently-used.xbel`): only files on this machine that are
 * still there, and only those the application itself put on the list.
 */

import { createHash } from "node:crypto";
import { lstat, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import type { CatalogEntry } from "./catalog.js";

export interface RecentFile {
  /** Its name in a list: the same file under the same application keeps it. */
  id: string;
  /** What the list calls it: the title its application gave, else the file's name. */
  title: string;
  path: string;
}

export interface RecentFiles {
  files: readonly RecentFile[];
  /** The list is there but cannot be trusted or read. */
  unavailable: boolean;
}

/** How many of an application's files are offered, newest first. */
const fileLimit = 12;
/** A list larger than this, or with more files, is not read. */
const byteLimit = 1048576;
const bookmarkLimit = 4096;

function recentPath(): string {
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "recently-used.xbel");
}

/** TEXT with XML's character references read. */
function unescape(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, name: string) => {
    if (name.startsWith("#x")) return String.fromCodePoint(parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(parseInt(name.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[name] ?? "";
  });
}

/** The attributes of an XML tag's inside. */
function attributes(tag: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const [, name, double, single] of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
    found.set(name!, unescape(double ?? single ?? ""));
  return found;
}

interface Bookmark {
  uri: string;
  title: string;
  modified: number;
  applications: readonly string[];
}

function bookmarks(xml: string): Bookmark[] {
  const found: Bookmark[] = [];
  for (const [, head, body] of xml.matchAll(/<bookmark(\s[^>]*)>([\s\S]*?)<\/bookmark>/g)) {
    const own = attributes(head!);
    const uri = own.get("href");
    if (uri === undefined) continue;
    const title = /<title>([\s\S]*?)<\/title>/.exec(body!)?.[1];
    const applications = [...body!.matchAll(/<bookmark:application(\s[^>]*?)\/?>/g)].map(
      ([, tag]) => attributes(tag!).get("name") ?? "",
    );
    found.push({
      uri,
      title: title === undefined ? "" : unescape(title).trim(),
      modified: Date.parse(own.get("modified") ?? "") || 0,
      applications,
    });
  }
  return found;
}

/** The path a `file://` address of this machine names, or null for any other address. */
function localPath(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (
    url.protocol !== "file:" ||
    (url.hostname !== "" && url.hostname !== "localhost") ||
    url.search ||
    url.hash
  )
    return null;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  return isAbsolute(path) && !path.includes("\0") ? path : null;
}

/** The files ENTRY opened lately, newest first: none for an application that takes no files. */
export async function recentFiles(entry: CatalogEntry): Promise<RecentFiles> {
  if (!entry.opensFiles) return { files: [], unavailable: false };
  const source = recentPath();
  let xml: string;
  try {
    const info = await lstat(source);
    // Only the user's own list, which nobody else can write, says what the user opened.
    const own = info.isFile() && info.uid === process.getuid?.() && (info.mode & 0o022) === 0;
    if (!own || info.size > byteLimit) return { files: [], unavailable: true };
    xml = await readFile(source, "utf8");
  } catch (error) {
    return { files: [], unavailable: (error as NodeJS.ErrnoException).code !== "ENOENT" };
  }
  const all = bookmarks(xml);
  if (all.length > bookmarkLimit) return { files: [], unavailable: true };

  const desktopId = `${entry.id}.desktop`;
  const found: (RecentFile & { modified: number })[] = [];
  for (const bookmark of all) {
    if (!bookmark.applications.includes(desktopId)) continue;
    const path = localPath(bookmark.uri);
    if (
      path === null ||
      !(await stat(path).then(
        (info) => info.isFile(),
        () => false,
      ))
    )
      continue;
    found.push({
      id: createHash("sha256").update(`${desktopId}\0${bookmark.uri}`).digest("hex"),
      title: bookmark.title || basename(path),
      path,
      modified: Math.floor(bookmark.modified / 1000),
    });
  }
  found.sort((a, b) => b.modified - a.modified || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    files: found.slice(0, fileLimit).map(({ id, title, path }) => ({ id, title, path })),
    unavailable: false,
  };
}
