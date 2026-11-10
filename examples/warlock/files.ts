/**
 * What the Files panel opens, and how: Home, seven collections and any folder
 * typed as a path, shown in the desktop's file manager (`gio open`, else
 * `xdg-open`), which decides for itself whether to reuse a window. A collection
 * is the folder the desktop keeps for it: Images, Videos, Documents and
 * Downloads are the user's XDG directories, Screenshots the folder of that name
 * in Pictures, Recent the file manager's `recent:///`, and Large files the
 * disk usage analyzer (`baobab`) on the home folder, or the home folder
 * without it. Where the file manager is now is read from
 * org.freedesktop.FileManager1, if it offers that.
 */

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launch } from "proscenium";
import type { GlyphName } from "./glyphs.js";

export interface Collection {
  id: string;
  label: string;
  glyph: GlyphName;
}

/** The collections after Home, in the panel's order. */
export const collections: readonly Collection[] = [
  { id: "recent", label: "Recent", glyph: "recent" },
  { id: "images", label: "Images", glyph: "image" },
  { id: "videos", label: "Videos", glyph: "video" },
  { id: "documents", label: "Documents", glyph: "document" },
  { id: "downloads", label: "Downloads", glyph: "download" },
  { id: "large", label: "Large files", glyph: "largeFile" },
  { id: "screenshots", label: "Screenshots", glyph: "screenshot" },
];

/** Whether TEXT may stand in the path field: at most 512 characters, none of them control characters. */
export function acceptableDraft(text: string): boolean {
  return [...text].length <= 512 && !/[\u0000-\u001f\u007f]/.test(text);
}

/**
 * Whether VALUE names something to open: `home`, `coll:<collection>`, an
 * absolute path, `~` or a path under it. Whether the folder exists is found
 * out when it is opened.
 */
export function validTarget(value: string): boolean {
  if (!acceptableDraft(value)) return false;
  if (value === "home" || collections.some((collection) => value === `coll:${collection.id}`))
    return true;
  return value.trim().startsWith("/") || value === "~" || value.startsWith("~/");
}

/** A typed path as an absolute one, with `~`, `.`, `..` and doubled slashes resolved; null if it is relative. */
function absolutePath(value: string): string | null {
  let path = value.trim();
  if (path === "~") path = homedir();
  else if (path.startsWith("~/")) path = homedir() + path.slice(1);
  if (!path.startsWith("/")) return null;
  const pieces: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") pieces.pop();
    else pieces.push(part);
  }
  return `/${pieces.join("/")}`;
}

/** One of the user's XDG directories, as `user-dirs.dirs` gives it, else FALLBACK in the home folder. */
async function userDirectory(name: string, fallback: string): Promise<string> {
  const home = homedir();
  try {
    const config = process.env.XDG_CONFIG_HOME || join(home, ".config");
    const text = await readFile(join(config, "user-dirs.dirs"), "utf8");
    const value = text
      .match(new RegExp(`^XDG_${name}_DIR="(.*)"\\s*$`, "m"))?.[1]
      ?.replace(/^\$HOME/, home);
    if (value?.startsWith("/")) return value;
  } catch {
    // No such file: the usual names.
  }
  return join(home, fallback);
}

/** Where COMMAND is installed, or null. */
async function installed(command: string): Promise<string | null> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const path = join(directory, command);
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      // Not in this one.
    }
  }
  return null;
}

/** Somewhere a target leads: a folder, a location the file manager knows by URI, or a program of its own. */
type Place = { directory: string } | { uri: string } | { command: readonly string[] };

/** Where Home and each collection lead, by target. */
async function places(): Promise<Map<string, Place>> {
  const home = homedir();
  const [pictures, videos, documents, downloads, analyzer] = await Promise.all([
    userDirectory("PICTURES", "Pictures"),
    userDirectory("VIDEOS", "Videos"),
    userDirectory("DOCUMENTS", "Documents"),
    userDirectory("DOWNLOAD", "Downloads"),
    installed("baobab"),
  ]);
  return new Map<string, Place>([
    ["home", { directory: home }],
    ["coll:recent", { uri: "recent:///" }],
    ["coll:images", { directory: pictures }],
    ["coll:videos", { directory: videos }],
    ["coll:documents", { directory: documents }],
    ["coll:downloads", { directory: downloads }],
    ["coll:large", analyzer ? { command: [analyzer, home] } : { directory: home }],
    ["coll:screenshots", { directory: join(pictures, "Screenshots") }],
  ]);
}

/** The command that shows a folder or URI in the desktop's file manager, or null without one. */
async function opener(): Promise<readonly string[] | null> {
  if (await installed("gio")) return ["gio", "open"];
  if (await installed("xdg-open")) return ["xdg-open"];
  return null;
}

export interface FilesSnapshot {
  /** Whether there is a way to open folders at all. */
  available: boolean;
  /** Where the file manager's window is, as a target; null if none is seen. */
  location: string | null;
}

function busctl(args: readonly string[]): Promise<unknown[] | null> {
  return new Promise((resolve) => {
    // Never starts the file manager just to ask where it is.
    execFile(
      "busctl",
      ["--user", "--json=short", "--auto-start=no", "--timeout=2", "call", ...args],
      { timeout: 2000 },
      (error, stdout) => {
        try {
          const data = error ? null : (JSON.parse(stdout) as { data?: unknown }).data;
          resolve(Array.isArray(data) ? data : null);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

const fileManager = "org.freedesktop.FileManager1";

/** The location of the file manager's window, the most lately used if it has several. */
async function openLocation(): Promise<string | null> {
  const owned = await busctl([
    "org.freedesktop.DBus",
    "/org/freedesktop/DBus",
    "org.freedesktop.DBus",
    "NameHasOwner",
    "s",
    fileManager,
  ]);
  if (owned?.[0] !== true) return null;
  const reply = await busctl([
    fileManager,
    "/org/freedesktop/FileManager1",
    "org.freedesktop.DBus.Properties",
    "Get",
    "ss",
    fileManager,
    "OpenLocations",
  ]);
  const locations = (reply?.[0] as { data?: unknown } | undefined)?.data;
  const first = Array.isArray(locations) ? locations[0] : undefined;
  return typeof first === "string" ? first : null;
}

const sameLocation = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

/** A location as the target that leads to it: `home`, a collection, else its path. */
function targetOf(location: string, known: ReadonlyMap<string, Place>): string {
  for (const [target, place] of known) {
    const uri =
      "uri" in place
        ? place.uri
        : "directory" in place
          ? pathToFileURL(place.directory).href
          : null;
    if (uri !== null && sameLocation(uri, location)) return target;
  }
  try {
    return location.startsWith("file:") ? fileURLToPath(location) : location;
  } catch {
    return location;
  }
}

/** Read whether folders can be opened here, and where the file manager is. */
export async function readFiles(): Promise<FilesSnapshot> {
  const [command, location, known] = await Promise.all([opener(), openLocation(), places()]);
  return {
    available: command !== null,
    location: location === null ? null : targetOf(location, known),
  };
}

/**
 * Show TARGET in the file manager. "refused" if it names nothing that can be
 * opened: not a target, not an existing folder, or no file manager.
 */
export async function openTarget(target: string): Promise<"opened" | "refused"> {
  if (!validTarget(target)) return "refused";
  const [command, known] = await Promise.all([opener(), places()]);
  if (!command) return "refused";
  const path = known.has(target) ? null : absolutePath(target);
  const place = known.get(target) ?? (path === null ? null : { directory: path });
  if (!place) return "refused";
  if ("directory" in place) {
    const found = await stat(place.directory).catch(() => null);
    if (!found?.isDirectory()) return "refused";
  }
  launch(
    "command" in place ? place.command : [...command, "uri" in place ? place.uri : place.directory],
  );
  return "opened";
}
