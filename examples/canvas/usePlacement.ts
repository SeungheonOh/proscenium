import { useCallback, useRef } from "react";
import { moveCamera, useWindows, type OutputInfo, type Rectangle, type WindowInfo } from "proscenium";
import { tidy as tidyLayout } from "./tidy.js";
import {
  anchor,
  arrangeOrder,
  cells,
  contains,
  cycled,
  fit,
  middle,
  page,
  presetRect,
  presetUnit,
  slotRect,
  type Limits,
  type Preset,
  type Tile,
} from "./tiling.js";
import type { PlaceWindows } from "./usePlaces.js";
import { atActualSize, framing, homeArea, visibleArea } from "./view.js";

/** How many placements undo remembers. */
const historyLength = 32;

interface Entry {
  rects: ReadonlyMap<number, Rectangle>;
  /** Put back where they were but keep the size they have now, as after a push. */
  positionsOnly: boolean;
}

export interface History {
  /** Remember where WINDOWS are now, before they move. */
  record: (windows: Iterable<number>, positionsOnly?: boolean) => void;
  /** Put back what the last placement moved. */
  undo: () => void;
}

/**
 * Undo for placements, as Sunlight's ⌘Z: a push, Move & Resize, Arrange and
 * Tidy each put every window they touched back where it was.
 */
export function useHistory(places: ReadonlyMap<number, Rectangle>, placeWindows: PlaceWindows): History {
  const stack = useRef<Entry[]>([]);
  const current = useRef({ places, placeWindows });
  current.current = { places, placeWindows };

  const record = useCallback((windows: Iterable<number>, positionsOnly = false) => {
    const rects = new Map<number, Rectangle>();
    for (const id of windows) {
      const place = current.current.places.get(id);
      if (place) rects.set(id, place);
    }
    if (rects.size === 0) return;
    stack.current.push({ rects, positionsOnly });
    if (stack.current.length > historyLength) stack.current.shift();
  }, []);

  const undo = useCallback(() => {
    const { places, placeWindows } = current.current;
    // Placements whose windows have all closed have nothing to put back.
    for (let entry = stack.current.pop(); entry; entry = stack.current.pop()) {
      const back = new Map<number, Rectangle>();
      for (const [id, was] of entry.rects) {
        const now = places.get(id);
        if (now) back.set(id, entry.positionsOnly ? { ...now, x: was.x, y: was.y } : was);
      }
      if (back.size === 0) continue;
      placeWindows(back);
      return;
    }
  }, []);

  return { record, undo };
}

/**
 * Sunlight's three placement scopes, from the keyboard: Move & Resize puts the
 * focused window in a slot of its area, Arrange lays the windows of one area
 * out in columns, and Tidy lays every window out on one grid, the camera
 * framing the result. See tiling.ts for which area.
 */
export function usePlacement(
  places: ReadonlyMap<number, Rectangle>,
  placeWindows: PlaceWindows,
  output: OutputInfo | undefined,
  /** The window Move & Resize and Arrange act on: the focused one, else the frontmost. */
  target: number | undefined,
  history: History,
) {
  const windows = useWindows();
  // Where each window was last tiled, so a repeat press steps through widths.
  const tiles = useRef(new Map<number, Tile & { rect: Rectangle }>());

  const limits = (id: number): Limits | undefined => windows.find((w: WindowInfo) => w.id === id);

  /** The area WINDOW is tiled in: the screen in view at 100%, else where it was tiled, else its page. */
  function areaOf(window: number, output: OutputInfo): Rectangle {
    const centre = middle(places.get(window)!);
    if (atActualSize(output)) {
      const view = visibleArea(output);
      if (contains(view, centre)) return view;
    }
    const tiled = tiles.current.get(window)?.area;
    if (tiled && contains(tiled, centre)) return tiled;
    return page(centre, homeArea(output));
  }

  /** The area a command for every window works in: the screen in view at 100%, else the page in the middle of it. */
  function screenInView(output: OutputInfo): Rectangle {
    const view = visibleArea(output);
    return atActualSize(output) ? view : page(middle(view), homeArea(output));
  }

  function tile(requested: Preset) {
    if (target === undefined || !output || !places.has(target)) return;
    const place = places.get(target)!;
    const last = tiles.current.get(target);
    // A window moved by hand since starts the cycle over.
    const stillThere = last && same(last.rect, place);
    const preset = cycled(requested, stillThere ? last.preset ?? undefined : undefined);
    const area = areaOf(target, output);
    const rect = fit(presetRect(preset, place, area), limits(target), anchor(presetUnit(preset)));
    tiles.current.set(target, { area, preset, rect });
    history.record([target]);
    placeWindows(new Map([[target, rect]]));
  }

  function arrange(columns: number) {
    if (!output) return;
    const area = target !== undefined && places.has(target) ? areaOf(target, output) : screenInView(output);
    const ids = [...places.keys()].filter((id) => contains(area, middle(places.get(id)!)));
    if (ids.length === 0) return;
    // Windows beyond the cells stay where they are.
    const order = arrangeOrder(ids.map((id) => places.get(id)!)).slice(0, columns);
    const next = new Map<number, Rectangle>();
    cells(columns, 1).forEach((cell, i) => {
      const id = ids[order[i]!];
      if (id === undefined) return;
      const rect = fit(slotRect(cell, area), limits(id), anchor(cell));
      next.set(id, rect);
      tiles.current.set(id, { area, preset: null, rect });
    });
    history.record(next.keys());
    placeWindows(next);
  }

  function tidy() {
    if (!output || places.size === 0) return;
    const screen = screenInView(output);
    const ids = [...places.keys()];
    const laid = tidyLayout(
      ids.map((id) => places.get(id)!),
      { x: screen.x, y: screen.y },
    );
    const next = new Map<number, Rectangle>();
    ids.forEach((id, i) => {
      if (!same(laid.rects[i]!, places.get(id)!)) next.set(id, laid.rects[i]!);
      tiles.current.delete(id);
    });
    if (next.size > 0) {
      history.record(next.keys());
      placeWindows(next);
    }
    moveCamera(framing(laid.bounds, output));
  }

  return { tile, arrange, tidy };
}

function same(a: Rectangle, b: Rectangle) {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
