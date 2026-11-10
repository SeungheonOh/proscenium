/**
 * Warlock's typefaces: Inter for the interface, Space Grotesk for titles and
 * JetBrains Mono for paths. The compositor draws text with the fonts
 * fontconfig knows, so any of the three that is missing is copied from this
 * world's assets into the user's fonts, once; text shows in it from the
 * compositor's next start.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import inter from "./assets/fonts/inter-variable.woff2?url";
import jetbrains from "./assets/fonts/jetbrains-mono-regular.woff2?url";
import grotesk from "./assets/fonts/space-grotesk-bold.woff2?url";

const families: readonly { family: string; file: string; name: string }[] = [
  { family: "Inter", file: inter, name: "inter-variable.woff2" },
  { family: "Space Grotesk", file: grotesk, name: "space-grotesk-bold.woff2" },
  { family: "JetBrains Mono", file: jetbrains, name: "jetbrains-mono-regular.woff2" },
];

/** Copy the typefaces fontconfig does not have yet into the user's fonts. */
export function installFonts(): void {
  try {
    const known = execFileSync("fc-list", [":", "family"], { encoding: "utf8", timeout: 5000 });
    const has = (family: string) =>
      known.split("\n").some((line) => line.split(",").includes(family));
    const directory = join(
      process.env.XDG_DATA_HOME || join(homedir(), ".local/share"),
      "fonts",
      "proscenium-warlock",
    );
    for (const { family, file, name } of families) {
      if (has(family) || existsSync(join(directory, name))) continue;
      mkdirSync(directory, { recursive: true });
      copyFileSync(file, join(directory, name));
    }
  } catch {
    // Without fontconfig's tools, text falls back to the fonts there are.
  }
}
