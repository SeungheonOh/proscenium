import { useCallback, useEffect, useMemo } from "react";
import {
  useCompositorInstance,
  usePersistentState,
  useWindows,
  type OutputInfo,
  type Rectangle,
} from "proscenium";
import { spot } from "./newWindowSpot.js";
import { spacing } from "./tidy.js";
import { visibleArea } from "./view.js";

const minimumSize = { width: 960, height: 620 };
/** Where to open windows before any output is known: where the camera starts on a small screen. */
const fallbackView = { x: 0, y: 0, width: 1280, height: 800 };

export type PlaceWindow = (window: number, next: Partial<Rectangle>) => void;
/** Moves several windows at once, as an arrangement that pushed some does. */
export type PlaceWindows = (next: ReadonlyMap<number, Partial<Rectangle>>) => void;

interface Saved {
  /** The compositor instance the window ids belong to. */
  instance: string | null;
  places: Record<number, Rectangle>;
}

/**
 * Where each window sits on the canvas, and functions that move them. A new
 * window opens in the middle of the view if that is clear, else in the free
 * spot nearest it beside the windows in the way, as on Sunlight's canvas.
 */
export function usePlaces(
  output: OutputInfo | undefined,
): [ReadonlyMap<number, Rectangle>, PlaceWindow, PlaceWindows] {
  const windows = useWindows();
  const instance = useCompositorInstance();
  const [saved, setSaved] = usePersistentState<Saved>("canvas.places", {
    instance: null,
    places: {},
  });
  // Window ids start over with the compositor: places kept for the old ones name nothing now.
  const stored = saved.instance === instance ? saved.places : {};

  const places = useMemo(() => {
    const view = output ? visibleArea(output) : fallbackView;
    const taken = windows.flatMap((window) => stored[window.id] ?? []);
    return new Map(
      windows.map((window) => {
        const known = stored[window.id];
        if (known) return [window.id, known];
        const size = {
          width: Math.max(window.width, minimumSize.width),
          height: Math.max(window.height, minimumSize.height),
        };
        // Each new one keeps clear of those opened before it, too.
        const opening = spot(size, taken, view, spacing);
        taken.push(opening);
        return [window.id, opening];
      }),
    );
  }, [windows, stored]);

  // New windows keep the place they opened at; closed ones are forgotten.
  useEffect(() => {
    if (instance !== null && windows.some((window) => !stored[window.id]))
      setSaved({ instance, places: Object.fromEntries(places) });
  }, [places]);

  const place = useCallback<PlaceWindow>(
    (window, next) =>
      setSaved({
        instance,
        places: { ...Object.fromEntries(places), [window]: { ...places.get(window)!, ...next } },
      }),
    [places, instance, setSaved],
  );

  const placeAll = useCallback<PlaceWindows>(
    (next) => {
      const all = Object.fromEntries(places);
      for (const [window, change] of next) if (all[window]) all[window] = { ...all[window], ...change };
      setSaved({ instance, places: all });
    },
    [places, instance, setSaved],
  );

  return [places, place, placeAll];
}
