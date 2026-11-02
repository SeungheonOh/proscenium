import { useEffect, useMemo, useState } from "react";
import { useCompositorInstance, usePersistentState } from "proscenium";
import { DURATION } from "./isotopyEffect.js";

interface Seen {
  /** The compositor instance the window ids belong to. */
  instance: string | null;
  ids: number[];
}

/**
 * The windows still opening: each window the compositor gives us is new once,
 * for as long as its opening runs. A reload remounts the world but opens nothing
 * again; a restarted compositor starts the ids over.
 */
export function useOpenings(windows: readonly number[]): ReadonlySet<number> {
  const instance = useCompositorInstance();
  const [seen, setSeen] = usePersistentState<Seen>("canvas.opened", { instance: null, ids: [] });
  const [opening, setOpening] = useState<ReadonlySet<number>>(new Set());
  const known = useMemo(
    () => new Set(seen.instance === instance ? seen.ids : []),
    [seen, instance],
  );
  // New ones count as opening in the render that first shows them, so their node starts with it.
  const fresh = instance === null ? [] : windows.filter((id) => !known.has(id) && !opening.has(id));

  useEffect(() => {
    if (fresh.length === 0) return;
    setSeen({ instance, ids: [...known, ...fresh].filter((id) => windows.includes(id)) });
    setOpening((now) => new Set([...now, ...fresh]));
    setTimeout(() => setOpening((now) => new Set([...now].filter((id) => !fresh.includes(id)))),
               DURATION * 1000 + 100);
  }, [fresh.join(",")]);

  return fresh.length === 0 ? opening : new Set([...opening, ...fresh]);
}
