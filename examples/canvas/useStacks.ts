import { useMemo } from "react";
import { useCompositorInstance, usePersistentState, type Rectangle } from "proscenium";
import { pruneStacks, stackOf } from "./stacks.js";

interface Saved {
  /** The compositor instance the window ids belong to. */
  instance: string | null;
  /** Each stack's windows, bottom first. */
  stacks: number[][];
}

export interface Stacks {
  /** Every stack, bottom first, of windows still open. */
  all: readonly (readonly number[])[];
  /** The stack WINDOW is in, bottom first, or just WINDOW. */
  of: (window: number) => readonly number[];
  /** WINDOWS, bottom first, become one stack; any stack they were in loses them. */
  make: (windows: readonly number[]) => void;
  /** WINDOW leaves its stack. */
  leave: (window: number) => void;
  /** WINDOW's stack comes apart. */
  dissolve: (window: number) => void;
  /** Undo: the stacks as they were. */
  restore: (stacks: readonly (readonly number[])[]) => void;
}

/** Which windows are piled into stacks, kept with the canvas. */
export function useStacks(places: ReadonlyMap<number, Rectangle>): Stacks {
  const instance = useCompositorInstance();
  const [saved, setSaved] = usePersistentState<Saved>("canvas.stacks", { instance: null, stacks: [] });
  const ids = useMemo(() => new Set(places.keys()), [places]);
  const stored = saved.instance === instance ? saved.stacks : [];
  const all = useMemo(() => pruneStacks(stored, ids), [stored, ids]);

  const update = (change: (stacks: number[][]) => number[][]) =>
    setSaved((s) => ({ instance, stacks: change(s.instance === instance ? s.stacks : []) }));

  return {
    all,
    of: (window) => stackOf(all, window) ?? [window],
    make: (windows) =>
      update((stacks) => [...stacks.map((s) => s.filter((id) => !windows.includes(id))), [...windows]].filter((s) => s.length > 1)),
    leave: (window) => update((stacks) => stacks.map((s) => s.filter((id) => id !== window)).filter((s) => s.length > 1)),
    dissolve: (window) => update((stacks) => stacks.filter((s) => !s.includes(window))),
    restore: (stacks) => update(() => stacks.map((s) => [...s])),
  };
}
