/**
 * niri's defaults: its default-config.kdl and built-in values, in logical
 * pixels. Every spring is niri's: critically damped unless stated, by stiffness.
 */

import { spring, tween, type Motion } from "proscenium";

export const gaps = 16;
export const presetWidths = [1 / 3, 1 / 2, 2 / 3];
export const presetHeights = [1 / 3, 1 / 2, 2 / 3];
export const defaultWidth = 0.5;

export const focusRing = { width: 4, active: "#7fc8ff", inactive: "#505050" };
export const insertHintColor = "#7fc8ff80";
/** Behind the workspaces, showing between them as they switch. */
export const backdropColor = "#262626";
/** Each workspace's own fill. */
export const workspaceColor = "#404040";
/** Space between stacked workspaces, as a fraction of the output height. */
export const workspaceGap = 0.1;

export const overview = {
  zoom: 0.5,
  /** At 1080 logical pixels of output height; scaled with it. */
  shadow: { blur: 40, spread: 10, y: 10, color: "#00000050" },
};

export const tabIndicator = { gap: 5, width: 4, length: 0.5 };

/** Floating windows step this far with the move keys. */
export const floatingStep = 50;
/** A tiled window leaves the layout once dragged this far. */
export const pullOutDistance = 256;
/** A press becomes a drag after this much movement. */
export const dragThreshold = 8;
export const draggedOpacity = 0.75;

export const screenshotPath = "~/Pictures/Screenshots/Screenshot from %Y-%m-%d %H-%M-%S.png";

/** niri's spring by stiffness and damping ratio, with unit mass. */
function nirispring(stiffness: number, dampingRatio = 1): Motion {
  return spring({ stiffness, damping: dampingRatio * 2 * Math.sqrt(stiffness), mass: 1 });
}

export const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t));
export const easeOutQuad = (t: number) => 1 - (1 - t) ** 2;
export const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

export const motion = {
  workspaceSwitch: nirispring(1000),
  view: nirispring(800),
  windowMovement: nirispring(800),
  windowResize: nirispring(800),
  overview: nirispring(800),
  exitDialog: nirispring(500, 0.6),
  windowOpen: tween(0.15, easeOutExpo),
  windowClose: tween(0.15, easeOutQuad),
  screenshotOpen: tween(0.2, easeOutQuad),
};

/** Seconds niri's 800-stiffness springs take to settle, from rest. */
export const settleTime = 0.33;
