import type { Animation } from "proscenium";
import type { Direction } from "./geometry.js";

/** A short push toward `direction` and back, for an action with nowhere to go. KEY replays it. */
export function bump([dx, dy]: Direction, key: number): Animation {
  const path = (distance: number) => [0, distance * 14, distance * -4, 0];
  return {
    ...(dx ? { x: path(dx) } : { y: path(dy) }),
    composite: "add",
    duration: 0.32,
    ease: "ease-out",
    key,
  };
}
