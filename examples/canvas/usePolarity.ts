import { useMemo } from "react";
import { useCompositorInstance, usePersistentState, type Rectangle } from "proscenium";
import { tileGap, type Pole } from "./magnetism.js";
import {
  dissolve,
  flipped,
  members,
  merge,
  noGroups,
  prune,
  remove,
  type Grouping,
  type PolarityState,
} from "./polarity.js";

export interface Polarity {
  /** Magnet mode and polarity both on: poles act and groups move together. */
  active: boolean;
  /** The groups, of windows still open. */
  grouping: Grouping;
  poleOf: (window: number) => Pole;
  /** WINDOW and the windows bonded to it, WINDOW first; just WINDOW while polarity is off. */
  groupOf: (window: number) => number[];
  bond: (a: number, b: number) => void;
  /** WINDOW leaves its group; what is left splits into the pieces still side by side at RECTS. */
  release: (window: number, rects: ReadonlyMap<number, Rectangle>) => void;
  /** WINDOW's pole flips, which ejects it from its group. */
  flip: (window: number, rects: ReadonlyMap<number, Rectangle>) => void;
  /** WINDOW's whole group goes free. */
  ungroup: (window: number) => void;
  /** Undo: the groups as they were. */
  restore: (grouping: Grouping) => void;
}

/** Each window's pole and the bonded groups, kept with the canvas. */
export function usePolarity(places: ReadonlyMap<number, Rectangle>, on: boolean): Polarity {
  const instance = useCompositorInstance();
  const [saved, setSaved] = usePersistentState<PolarityState>("canvas.polarity", {
    instance: null,
    poles: {},
    grouping: noGroups,
  });
  // Window ids start over with the compositor: poles and groups kept for the old ones name nothing now.
  const state = saved.instance === instance ? saved : { instance, poles: {}, grouping: noGroups };
  const ids = useMemo(() => new Set(places.keys()), [places]);
  const grouping = useMemo(() => prune(state.grouping, ids), [state.grouping, ids]);

  const update = (change: (s: PolarityState) => PolarityState) =>
    setSaved((s) => change(s.instance === instance ? s : { instance, poles: {}, grouping: noGroups }));

  return {
    active: on,
    grouping,
    poleOf: (window) => state.poles[window] ?? "plus",
    groupOf: (window) => (on ? members(grouping, window).filter((id) => ids.has(id)) : [window]),
    bond: (a, b) => update((s) => ({ ...s, grouping: merge(s.grouping, a, b) })),
    release: (window, rects) => update((s) => ({ ...s, grouping: remove(s.grouping, window, rects, tileGap) })),
    flip: (window, rects) =>
      update((s) => ({
        ...s,
        poles: { ...s.poles, [window]: flipped(s.poles[window] ?? "plus") },
        grouping: remove(s.grouping, window, rects, tileGap),
      })),
    ungroup: (window) => update((s) => ({ ...s, grouping: dissolve(s.grouping, window) })),
    restore: (g) => update((s) => ({ ...s, grouping: g })),
  };
}
