import { useEffect } from "react";
import {
  getCamera,
  moveCamera,
  usePersistentState,
  type CameraInfo,
  type OutputInfo,
  type Rectangle,
} from "proscenium";
import { union } from "../lib/geometry.js";

/**
 * Camera moves for the canvas: flying to a window, and an overview of every
 * window that returns to where it was. The camera is read when an action runs;
 * subscribing to it here would re-render the world on every pan.
 */
export function useCameraActions(
  places: ReadonlyMap<number, Rectangle>,
  output: OutputInfo | undefined,
  focused: number | null,
) {
  // The camera to return to while the overview shows every window.
  const [overview, setOverview] = usePersistentState<CameraInfo | null>("canvas.overview", null);

  function flyTo(window: number, zoom = Math.max(getCamera()?.zoom ?? 1, 0.6)) {
    const target = places.get(window);
    if (!target) return;
    setOverview(null);
    moveCamera({ x: target.x + target.width / 2, y: target.y + target.height / 2, zoom });
  }

  function toggleOverview() {
    if (overview) {
      moveCamera(overview);
      setOverview(null);
      return;
    }
    const everything = union(places.values());
    const camera = getCamera();
    if (!everything || !camera || !output) return;
    setOverview(camera);
    const fit = 0.85 * Math.min(output.width / everything.width, output.height / everything.height);
    moveCamera({
      x: everything.x + everything.width / 2,
      y: everything.y + everything.height / 2,
      zoom: Math.min(fit, 1),
    });
  }

  // Clicking a window in the overview dives into it.
  useEffect(() => {
    if (focused !== null && overview) flyTo(focused, overview.zoom);
  }, [focused]);

  return { flyTo, toggleOverview };
}
