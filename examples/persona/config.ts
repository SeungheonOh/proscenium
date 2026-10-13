/** The theme's colors, and the springs of its native parts. */

import { spring, type Motion } from "proscenium";

/** Its pywal16 palette. */
export const palette = {
  background: "#0c0f1d",
  foreground: "#c2c3c6",
  color1: "#1788B6",
  color3: "#209FCD",
  color5: "#1CC9D9",
};

/**
 * Qt's SpringAnimation as a spring: each 16 ms step adds `spring` times the
 * distance to the velocity and takes `damping` times the velocity away.
 */
function qtSpring(strength: number, damping: number): Motion {
  return spring({ stiffness: strength / 0.016, damping: damping / 0.016, mass: 1 });
}

export const motion = {
  ball: qtSpring(2.5, 0.2),
  ballHover: qtSpring(3, 0.3),
  blade: qtSpring(2.5, 0.25),
  bladeHover: qtSpring(3.5, 0.3),
  bladeDrag: qtSpring(3, 0.3),
};
