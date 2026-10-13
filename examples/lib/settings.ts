/** Choices a user is likely to change, in one place. */

import { homedir } from "node:os";
import { join } from "node:path";

export const terminal = process.env.TERMINAL ?? "foot";

export const wallpaper = "/usr/share/backgrounds/Resolute_Raccoon_Wallpaper_Dimmed_3840x2160.png";

export const screenshotDirectory = join(
  process.env.XDG_PICTURES_DIR ?? join(homedir(), "Pictures"),
  "Screenshots",
);
