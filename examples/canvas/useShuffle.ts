import { useEffect, useRef, useState } from "react";
import type { Rectangle } from "proscenium";

/** How long a window stays slipped out of its stack before it goes to its new end, in milliseconds. */
const swingFor = 130;

/** A window slipped out of its stack, and where it shows meanwhile. */
export interface Swing {
  window: number;
  rect: Rectangle;
}

/**
 * Alt+Tab as a shuffle of cards. The window changing ends of a stack slips
 * a little out of it, lifted, while the others take their new slots; then it goes
 * to its end: tucked in behind them, or laid on top in front.
 */
export function useShuffle(raise: (ids: readonly number[]) => void, focus: (window: number) => void) {
  const [swing, setSwing] = useState<Swing | null>(null);
  const landing = useRef<(() => void) | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  /** The swing under way goes to its end at once. */
  const land = () => {
    clearTimeout(timer.current);
    landing.current?.();
    landing.current = null;
    setSwing(null);
  };

  /**
   * WINDOW swings out to RECT, then the stack, TURNED bottom first, takes its
   * new order, its top window focused. Its places are already set: the window
   * goes from RECT to its slot as it lands.
   */
  const shuffle = (turned: readonly number[], window: number, rect: Rectangle) => {
    // A key held down: each turn lands before the next one starts.
    land();
    setSwing({ window, rect });
    landing.current = () => {
      raise(turned);
      focus(turned.at(-1)!);
    };
    timer.current = setTimeout(land, swingFor);
  };

  return { swing, shuffle };
}
