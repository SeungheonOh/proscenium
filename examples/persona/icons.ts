// Application icons as data URLs, for the search page, which cannot read files.
// Pages take props of under 60 KB, so the page asks for the icons it shows.

import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { iconFile } from "../lib/system/applications.js";

const types: Record<string, string> = { ".png": "image/png", ".svg": "image/svg+xml" };
const known = new Map<string, string>();

/** ICON, a theme icon name or a path, as a data URL; "" when there is none. */
export function iconData(icon: string): string {
  if (!icon) return "";
  let data = known.get(icon);
  if (data === undefined) {
    const path = iconFile(icon);
    const type = path && types[extname(path)];
    // Pages take props of 60 KB at most; a launcher row does without huge icons.
    data = path && type && statSync(path).size < 24 * 1024
      ? `data:${type};base64,${readFileSync(path).toString("base64")}`
      : "";
    known.set(icon, data);
  }
  return data;
}
