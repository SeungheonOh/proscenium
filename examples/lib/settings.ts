/** Choices a user is likely to change, in one place. */

import { homedir } from "node:os";
import { join } from "node:path";

export const terminal = process.env.TERMINAL ?? "foot";

export const wallpaper = "/usr/share/backgrounds/Resolute_Raccoon_Wallpaper_Dimmed_3840x2160.png";

export const screenshotDirectory = join(
  process.env.XDG_PICTURES_DIR ?? join(homedir(), "Pictures"),
  "Screenshots",
);

/**
 * The launcher and the bar's menus as React DOM pages in Chromium, as they were before the
 * scene could draw them itself: PROSCENIUM_WEB_MENUS=1, to compare. Drawn with proscenium/ui otherwise.
 */
export const webMenus = process.env.PROSCENIUM_WEB_MENUS === "1";

/** The theme of the launcher and the bar's menus, "light" or "dark"; by default the launcher is dark, the menus light. */
export const menuTheme = process.env.PROSCENIUM_THEME === "dark" || process.env.PROSCENIUM_THEME === "light"
  ? process.env.PROSCENIUM_THEME : null;
