import { useMemo, useRef, useState } from "react";
import type { Rectangle } from "proscenium";
import type { Point } from "./snapping.js";

/** A box smaller than this on the canvas is a click: it clears the selection. */
const clickSize = 4;

export interface Selection {
  /** The selected windows still open. */
  ids: ReadonlySet<number>;
  has: (window: number) => boolean;
  /** The box being drawn, on the canvas, or null. */
  box: Rectangle | null;
  /** Start a box at canvas point (X, Y). */
  begin: (x: number, y: number) => void;
  /** The box's far corner moves to (X, Y); false when no box is being drawn. */
  move: (x: number, y: number) => boolean;
  /** The box is let go: what it touches is selected. False when no box was being drawn. */
  end: () => boolean;
  clear: () => void;
  remove: (window: number) => void;
}

/**
 * Selecting windows by drawing a box over the canvas: every window the box
 * touches is selected, live while it is drawn. A click without a box clears.
 */
export function useSelection(places: ReadonlyMap<number, Rectangle>, zoom: () => number): Selection {
  const [chosen, setChosen] = useState<ReadonlySet<number>>(new Set());
  const [box, setBox] = useState<Rectangle | null>(null);
  const from = useRef<Point | null>(null);
  // The box as it is now: a move and the release can both come before React draws again.
  const latest = useRef<Rectangle | null>(null);
  const current = useRef(places);
  current.current = places;

  const ids = useMemo(() => new Set([...chosen].filter((id) => places.has(id))), [chosen, places]);
  const touched = (r: Rectangle) =>
    new Set([...current.current].filter(([, p]) => intersects(p, r)).map(([id]) => id));
  const boxTo = (x: number, y: number): Rectangle => {
    const a = from.current!;
    return { x: Math.min(a.x, x), y: Math.min(a.y, y), width: Math.abs(x - a.x), height: Math.abs(y - a.y) };
  };

  return {
    ids,
    has: (window) => ids.has(window),
    box,
    begin: (x, y) => {
      from.current = { x, y };
      latest.current = { x, y, width: 0, height: 0 };
      setBox(latest.current);
    },
    move: (x, y) => {
      if (!from.current) return false;
      const r = boxTo(x, y);
      latest.current = r;
      setBox(r);
      setChosen(touched(r));
      return true;
    },
    end: () => {
      if (!from.current) return false;
      const r = latest.current ?? { x: from.current.x, y: from.current.y, width: 0, height: 0 };
      const small = clickSize / zoom();
      setChosen(r.width < small && r.height < small ? new Set() : touched(r));
      from.current = null;
      latest.current = null;
      setBox(null);
      return true;
    },
    clear: () => setChosen(new Set()),
    remove: (window) => setChosen((s) => new Set([...s].filter((id) => id !== window))),
  };
}

function intersects(a: Rectangle, b: Rectangle) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
