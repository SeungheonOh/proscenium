import { useCallback, useRef } from "react";
import { moveCamera, useWindows, type OutputInfo, type Rectangle, type WindowInfo } from "proscenium";
import { body, bounds, offset, reach, resolveBodies } from "./magnetism.js";
import { closure, pile, spread } from "./stacks.js";
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
import { useArrangeSettings } from "./useArrange.js";
import type { PlaceWindows } from "./usePlaces.js";
import type { Links } from "./useArrange.js";
import type { Polarity } from "./usePolarity.js";
import type { Stacks } from "./useStacks.js";
import { atActualSize, framing, homeArea, visibleArea } from "./view.js";

/** How many placements undo remembers. */
const historyLength = 32;

interface Entry {
  rects: ReadonlyMap<number, Rectangle>;
  /** Put back where they were but keep the size they have now, as after a push. */
  positionsOnly: boolean;
  /** Whatever else the placement changed, put back: the groups a drag bonded or broke. */
  also?: () => void;
}

export interface History {
  /** Remember where WINDOWS are now, before they move, and what ALSO puts back. */
  record: (windows: Iterable<number>, positionsOnly?: boolean, also?: () => void) => void;
  /** Put back what the last placement moved; false when there was nothing to undo. */
  undo: () => boolean;
}

/**
 * Undo for placements, as Sunlight's ⌘Z: a push, Move & Resize, Arrange and
 * Tidy each put every window they touched back where it was.
 */
export function useHistory(places: ReadonlyMap<number, Rectangle>, placeWindows: PlaceWindows): History {
  const stack = useRef<Entry[]>([]);
  const current = useRef({ places, placeWindows });
  current.current = { places, placeWindows };

  const record = useCallback((windows: Iterable<number>, positionsOnly = false, also?: () => void) => {
    const rects = new Map<number, Rectangle>();
    for (const id of windows) {
      const place = current.current.places.get(id);
      if (place) rects.set(id, place);
    }
    if (rects.size === 0 && !also) return;
    stack.current.push({ rects, positionsOnly, also });
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
      if (back.size === 0 && !entry.also) continue;
      if (back.size) placeWindows(back);
      entry.also?.();
      return true;
    }
    return false;
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
  polarity: Polarity,
  stacks: Stacks,
  links: Links,
) {
  const windows = useWindows();
  const [settings] = useArrangeSettings();
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

  /** WINDOW and the windows it is tied to for good: its bonded group and its stack. */
  const bound = (window: number) => closure(window, [polarity.groupOf, stacks.of]);

  /**
   * NEXT with, in magnet mode, the windows in its way pushed aside, as a
   * window grown by hand pushes them: the placed windows hold, the rest are
   * shoved along the shortest route, a group as one, shoving the ones behind.
   */
  function withPushes(next: ReadonlyMap<number, Rectangle>): Map<number, Rectangle> {
    const out = new Map(next);
    if (!settings.magnet) return out;
    const bodies: number[][] = [];
    const seen = new Set(next.keys());
    for (const id of places.keys()) {
      if (seen.has(id)) continue;
      const group = bound(id).filter((m) => !seen.has(m));
      for (const m of group) seen.add(m);
      bodies.push(group);
    }
    const at = (id: number) => out.get(id) ?? places.get(id)!;
    // A window one placed rect pushes may land on another: go round until all are clear.
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      for (const rect of next.values()) {
        const result = resolveBodies(
          body(rect),
          bodies.map((ids) => ({ rects: ids.map(at), poles: ids.map(() => null) })),
          reach(settings.strength),
        );
        for (const i of result.moved) for (const id of bodies[i]!) out.set(id, offset(at(id), result.offsets[i]!));
        moved ||= result.moved.size > 0;
      }
      if (!moved) break;
    }
    return out;
  }

  /**
   * Move the windows in NEXT, and what they push, remembering where they all
   * were for undo. Placed on their own, they leave their groups and stacks, as
   * in Sunlight, unless KEEP says they stay tied.
   */
  function place(next: ReadonlyMap<number, Rectangle>, keep = false) {
    const all = withPushes(next);
    const leaving = keep ? [] : [...next.keys()].filter((id) => links.together(id).length > 1);
    history.record(all.keys(), false, links.snapshot());
    for (const id of leaving) links.leave(id);
    placeWindows(all);
  }

  /** WINDOWS, bottom first, piled behind the last one into a stack that moves as one. */
  function stack(windows: readonly number[]) {
    const ids = windows.filter((id) => places.has(id));
    if (ids.length < 2) return false;
    place(pile(ids, places), true);
    stacks.make(ids);
    return true;
  }

  /** WINDOW's stack laid out side by side where it sits, and no longer a stack; the windows it spread over. */
  function expand(window: number): number {
    const ids = stacks.of(window);
    if (ids.length < 2) return 0;
    place(spread(ids, places), true);
    stacks.dissolve(window);
    return ids.length;
  }

  /** Put the target window in REQUESTED's slot, or the next width on a repeat; the slot it took. */
  function tile(requested: Preset): Preset | null {
    if (target === undefined || !output || !places.has(target)) return null;
    const now = places.get(target)!;
    const last = tiles.current.get(target);
    // A window moved by hand since starts the cycle over.
    const stillThere = last && same(last.rect, now);
    const preset = cycled(requested, stillThere ? last.preset ?? undefined : undefined);
    const area = areaOf(target, output);
    const rect = fit(presetRect(preset, now, area), limits(target), anchor(presetUnit(preset)));
    tiles.current.set(target, { area, preset, rect });
    place(new Map([[target, rect]]));
    return preset;
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
    place(next);
  }

  function tidy() {
    if (!output || places.size === 0) return;
    const screen = screenInView(output);
    // A bonded group goes as one block, not taken apart.
    const blocks: number[][] = [];
    const seen = new Set<number>();
    for (const id of places.keys()) {
      if (seen.has(id)) continue;
      const group = bound(id).filter((m) => !seen.has(m));
      for (const m of group) seen.add(m);
      blocks.push(group);
    }
    const outlines = blocks.map((ids) => bounds(ids.map((id) => places.get(id)!)));
    const laid = tidyLayout(outlines, { x: screen.x, y: screen.y });
    const next = new Map<number, Rectangle>();
    blocks.forEach((ids, i) => {
      const d = { x: laid.rects[i]!.x - outlines[i]!.x, y: laid.rects[i]!.y - outlines[i]!.y };
      for (const id of ids) {
        const to = offset(places.get(id)!, d);
        if (!same(to, places.get(id)!)) next.set(id, to);
        tiles.current.delete(id);
      }
    });
    if (next.size > 0) {
      history.record(next.keys());
      placeWindows(next);
    }
    moveCamera(framing(laid.bounds, output));
  }

  return { tile, arrange, tidy, stack, expand };
}

function same(a: Rectangle, b: Rectangle) {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
