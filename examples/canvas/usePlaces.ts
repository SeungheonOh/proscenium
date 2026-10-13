import { useCallback, useEffect, useMemo } from "react";
import {
  getCamera,
  useCompositorInstance,
  usePersistentState,
  useWindows,
  type Rectangle,
} from "proscenium";

const minimumSize = { width: 960, height: 620 };
const cascadeStep = 36;

export type PlaceWindow = (window: number, next: Partial<Rectangle>) => void;

interface Saved {
  /** The compositor instance the window ids belong to. */
  instance: string | null;
  places: Record<number, Rectangle>;
}

/**
 * Where each window sits on the canvas, and a function that moves one. New
 * windows open where the camera looks, cascading so none hides another.
 */
export function usePlaces(): [ReadonlyMap<number, Rectangle>, PlaceWindow] {
  const windows = useWindows();
  const instance = useCompositorInstance();
  const [saved, setSaved] = usePersistentState<Saved>("canvas.places", {
    instance: null,
    places: {},
  });
  // Window ids start over with the compositor: places kept for the old ones name nothing now.
  const stored = saved.instance === instance ? saved.places : {};

  const places = useMemo(() => {
    const center = getCamera() ?? { x: 0, y: 0 };
    return new Map(
      windows.map((window, index) => {
        const width = Math.max(window.width, minimumSize.width);
        const height = Math.max(window.height, minimumSize.height);
        const cascade = cascadeStep * (index % 6);
        const opening = {
          x: center.x - width / 2 + cascade,
          y: center.y - height / 2 + cascade,
          width,
          height,
        };
        return [window.id, stored[window.id] ?? opening];
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

  return [places, place];
}
