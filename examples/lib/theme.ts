/** Colors, type and motion shared by every surface of the example desktops. */

import { spring, type Border } from "proscenium";

export const colors = {
  ink: "#17171a",
  muted: "#17171a99",
  paper: "#ecebe6",
  accent: "#2f6fed",
  danger: "#e0443e",
};

export const font = "Noto Sans, sans-serif";

/** The light edge of frosted glass: bright at the top, faint at the bottom. */
export const glassBorder: Border = {
  width: 1,
  color: { from: "#ffffffee", to: "#00000017", angle: 90 },
};

/** One-shot springs. Nothing loops, so a still desktop costs nothing to show. */
export const motion = {
  glide: spring({ duration: 0.34, bounce: 0.14 }),
  pop: spring({ duration: 0.26, bounce: 0.08 }),
  roll: spring({ duration: 0.42, bounce: 0.06 }),
  arrive: spring({ duration: 0.7, bounce: 0.16 }),
  slide: spring({ duration: 0.42, bounce: 0.04 }),
};
