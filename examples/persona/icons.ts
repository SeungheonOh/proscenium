// Application icons as data URLs, for the search page, which cannot read files.
// Pages take props of under 60 KB, so the page asks for the icons it shows.

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";

const dataDirectories = [
  process.env.XDG_DATA_HOME || join(homedir(), ".local/share"),
  ...(process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":"),
];
const roots = [join(homedir(), ".icons"), ...dataDirectories.map((directory) => join(directory, "icons"))];
/** Applications install their icons into hicolor; a few only into a desktop's theme. */
const themes = ["hicolor", "Adwaita"];
const sizes = ["48x48", "64x64", "128x128", "256x256", "scalable", "32x32"];
const types: Record<string, string> = { ".png": "image/png", ".svg": "image/svg+xml" };
const known = new Map<string, string>();

function find(name: string): string | null {
  if (name.startsWith("/")) return existsSync(name) ? name : null;
  for (const root of roots) {
    for (const theme of themes) {
      for (const size of sizes) {
        for (const extension of Object.keys(types)) {
          const path = join(root, theme, size, "apps", name + extension);
          if (existsSync(path)) return path;
        }
      }
    }
  }
  for (const directory of dataDirectories) {
    for (const extension of Object.keys(types)) {
      const path = join(directory, "pixmaps", name + extension);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

/** ICON, a theme icon name or a path, as a data URL; "" when there is none. */
export function iconData(icon: string): string {
  if (!icon) return "";
  let data = known.get(icon);
  if (data === undefined) {
    const path = find(icon);
    const type = path && types[extname(path)];
    // Pages take props of 60 KB at most; a launcher row does without huge icons.
    data = path && type && statSync(path).size < 24 * 1024
      ? `data:${type};base64,${readFileSync(path).toString("base64")}`
      : "";
    known.set(icon, data);
  }
  return data;
}
