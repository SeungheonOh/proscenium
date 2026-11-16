// The gallery's sections, in one place. To add one: write a component in its own file,
// wrapping its content in SectionFrame (its `grow` is the section's share of its column's
// height, roughly in pixels), and add a line below naming the column it goes in.

import type { ComponentType } from "react";
import Buttons from "./buttons.js";
import Corners from "./corners.js";
import KitFields from "./kitFields.js";
import KitFloating from "./kitFloating.js";
import KitNav from "./kitNav.js";
import Gradients from "./gradients.js";
import Shadows from "./shadows.js";
import Scroller from "./scroller.js";
import States from "./states.js";
import TextSpecimens from "./text.js";
import Effects from "./effects.js";
import Hairlines from "./hairlines.js";
import Inputs from "./inputs.js";
import Kit from "./kit.js";
import Prose from "./prose.js";
import Scroll from "./scroll.js";
import Surfaces from "./surfaces.js";
import Type from "./type.js";
import TypeDark from "./typeDark.js";

export interface SectionDef {
  /** The name GALLERY_SECTION picks it by. */
  id: string;
  /** 1 (the default), 2 or 3: GALLERY_PAGE picks which page is shown. */
  page?: 1 | 2 | 3;
  /** Left to right, from 0. */
  column: number;
  Component: ComponentType;
}

/**
 * Each column's height, in pixels. The middle one stops short so the toast, which rises
 * at the bottom of the output, has room under it.
 */
export const columnHeights = [776, 680, 776];

/** Page 2 has no toast under it. */
export const page2Heights = [776, 776, 776];

export const sections: SectionDef[] = [
  { id: "type", column: 0, Component: Type },
  { id: "type-dark", column: 0, Component: TypeDark },
  { id: "prose", column: 0, Component: Prose },
  { id: "scroll", column: 0, Component: Scroll },
  { id: "buttons", column: 1, Component: Buttons },
  { id: "inputs", column: 1, Component: Inputs },
  { id: "kit", column: 1, Component: Kit },
  { id: "hairlines", column: 2, Component: Hairlines },
  { id: "surfaces", column: 2, Component: Surfaces },
  { id: "effects", column: 2, Component: Effects },
  // Page 2: the box, text and control primitives.
  { id: "corners", page: 2, column: 0, Component: Corners },
  { id: "shadows", page: 2, column: 0, Component: Shadows },
  { id: "gradients", page: 2, column: 1, Component: Gradients },
  { id: "text-specimens", page: 2, column: 1, Component: TextSpecimens },
  { id: "states", page: 2, column: 2, Component: States },
  { id: "scroller", page: 2, column: 2, Component: Scroller },
  // Page 3: the kit's newer components.
  { id: "kit-nav", page: 3, column: 0, Component: KitNav },
  { id: "kit-floating", page: 3, column: 1, Component: KitFloating },
  { id: "kit-fields", page: 3, column: 2, Component: KitFields },
];
