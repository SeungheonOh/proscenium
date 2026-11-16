// What every control shares: how its looks move, its focus ring, and its look by state.
//
// A control's look in each state is data the compositor resolves (`states`), made once
// per theme and kept, so hovering, pressing and focusing render nothing. Colors fade
// critically damped (theme.motion.fade), so a hover never overshoots; geometry glides.

import type { Shadow, States, Transition } from "../props.js";
import type { Theme } from "./theme.js";

/** How a control's values move: colors fade, geometry glides, its own small moves press. */
export function controlTransition({ motion }: Theme): Transition {
  return {
    default: motion.fade,
    transform: motion.press,
    x: motion.glide,
    y: motion.glide,
    width: motion.glide,
    height: motion.glide,
  };
}

/**
 * A control's shadows at rest and with the focus ring shown: the ring goes last (drawn
 * first, under the rest) and is there at nothing at rest, so it grows out rather than
 * appearing, and the control's own shadows keep their places in the list as it does.
 */
export function ringed(theme: Theme, shadows: readonly Shadow[] = []): { rest: Shadow[]; focus: Shadow[] } {
  return { rest: [...shadows, ...theme.focus.ringClear], focus: [...shadows, ...theme.focus.ring] };
}

/** Builds each value once per key and keeps it: looks by variant, made on first use. */
export function cache<T>(build: (key: string) => T): (key: string) => T {
  const made = new Map<string, T>();
  return (key) => {
    let value = made.get(key);
    if (value === undefined) made.set(key, (value = build(key)));
    return value;
  };
}

/** States of a node following its control (`stateGroup`), with nothing set where VALUES leave a state out. */
export function groupStates(values: Omit<States, "group">): States {
  return { group: true, ...values };
}
