import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  focus,
  getCamera,
  instant,
  spring,
  usePersistentState,
  type Motion,
  type OutputInfo,
  type Rectangle,
  type StagePointerEvent,
  type StageResizeEvent,
  type Transition,
} from "proscenium";
import {
  coast,
  coastLimits,
  coastMotion,
  defaultStrength,
  followMotion,
  reach,
  resolve,
  Velocity,
} from "./magnetism.js";
import {
  align,
  defaultGridSize,
  grid,
  gridEdges,
  movedEdges,
  snapDistance,
  type Guide,
  type Point,
} from "./snapping.js";
import type { PlaceWindows } from "./usePlaces.js";

/** What arranging windows on the canvas does, kept with the canvas. */
export interface ArrangeSettings {
  /** Alignment guides while dragging, and the grid when a window is let go or a resize ends. */
  snapping: boolean;
  gridSize: number;
  /** Magnet mode: windows push each other out of the way. */
  magnet: boolean;
  /** Gentle (0) to Firm (1). */
  strength: number;
}

const defaults: ArrangeSettings = {
  snapping: true,
  gridSize: defaultGridSize,
  magnet: false,
  strength: defaultStrength,
};

export function useArrangeSettings() {
  return usePersistentState<ArrangeSettings>("canvas.arrange", defaults);
}

/** How far the pointer travels, on screen, before a press on a window moves it. */
const dragSlop = 3;
/** Holding this while dragging places the window freely: no guides, no grid, no pushing. */
const freeModifier = "alt";

const settle = spring({ duration: 0.3 });

/** What a window being arranged looks like this frame. */
interface Live {
  /** The window pressed on, which hears the pointer until it is let go. */
  grabbed: number | null;
  /** The window in hand and where the hand holds it. */
  held: { window: number; rect: Rectangle } | null;
  /** Where windows the hand pushed are heading. */
  pushed: ReadonlyMap<number, Rectangle>;
  guides: Guide[];
  /** A window just let go with a fling, and the speed its coast starts at (canvas units a second). */
  flung: { window: number; velocity: Point } | null;
}

const still: Live = { grabbed: null, held: null, pushed: new Map(), guides: [], flung: null };

interface Drag {
  window: number;
  start: Rectangle;
  /** Where on the window the pointer took it, in canvas units from its top left. */
  grab: Point;
  press: Point;
  moved: boolean;
  rect: Rectangle;
  snappedX: boolean;
  snappedY: boolean;
  velocity: Velocity;
  pushed: ReadonlyMap<number, Rectangle>;
}

interface Resize {
  window: number;
  start: Rectangle;
  pushed: ReadonlyMap<number, Rectangle>;
}

/** Where pointer event E is, for picking up a window. */
type Pickup = Pick<StagePointerEvent, "screenX" | "screenY" | "worldX" | "worldY">;

/**
 * Moving and resizing windows on the canvas as Sunlight does: a dragged window's
 * edges and centre stick to its neighbours' with a guide drawn while they do,
 * it settles onto the grid when let go, a resize's moved edges settle onto the
 * grid, and in magnet mode the windows in the way are pushed aside, a hard
 * fling coasting a little further. The world places a window in hand on every
 * pointer move, so a guide can hold it; resizes stay native, and their pushes
 * follow the coalesced progress.
 */
export function useArrange(
  places: ReadonlyMap<number, Rectangle>,
  placeWindows: PlaceWindows,
  output: OutputInfo | undefined,
) {
  const [settings] = useArrangeSettings();
  const [live, setLive] = useState<Live>(still);
  const drag = useRef<Drag | null>(null);
  const resizing = useRef<Resize | null>(null);
  // Handlers outlive the render that made them while the pointer is captured.
  const current = useRef({ places, settings, output, placeWindows });
  current.current = { places, settings, output, placeWindows };
  // The arrangement before the last gesture that pushed windows, for undo.
  const undo = useRef<Map<number, Rectangle> | null>(null);
  const flingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // A window closing mid-gesture ends it.
  useEffect(() => {
    if (drag.current && !places.has(drag.current.window)) {
      drag.current = null;
      setLive(still);
    }
  }, [places]);
  useEffect(() => () => clearTimeout(flingTimer.current), []);

  const zoom = () => getCamera(current.current.output?.name)?.zoom ?? 1;

  /** Every other window from where it is heading, pushed out of RECT's way; PUSHED grows. */
  const push = (window: number, rect: Rectangle, pushed: ReadonlyMap<number, Rectangle>) => {
    const { places, settings } = current.current;
    const ids = [...places.keys()].filter((id) => id !== window);
    const heading = ids.map((id) => pushed.get(id) ?? places.get(id)!);
    const result = resolve(rect, heading, reach(settings.strength));
    if (result.moved.size === 0) return pushed;
    const next = new Map(pushed);
    for (const i of result.moved) next.set(ids[i]!, result.rects[i]!);
    return next;
  };

  /** The windows a guide may hold WINDOW to: the others on screen. */
  const neighbours = (window: number, pushed: ReadonlyMap<number, Rectangle>) => {
    const { places, output } = current.current;
    const camera = getCamera(output?.name);
    const view = camera &&
      output && {
        x: camera.x - output.width / 2 / camera.zoom,
        y: camera.y - output.height / 2 / camera.zoom,
        width: output.width / camera.zoom,
        height: output.height / camera.zoom,
      };
    const out: Rectangle[] = [];
    for (const [id, place] of places) {
      if (id === window) continue;
      const r = pushed.get(id) ?? place;
      if (!view || intersects(r, view)) out.push(r);
    }
    return out;
  };

  /** Lay WINDOW down at RECT, and what it pushed where it is heading. */
  const commit = (window: number, rect: Rectangle, pushed: ReadonlyMap<number, Rectangle>, flung: Live["flung"]) => {
    const { places, placeWindows } = current.current;
    if (pushed.size) {
      undo.current = new Map([[window, places.get(window)!]]);
      for (const id of pushed.keys()) undo.current.set(id, places.get(id)!);
    }
    // Places first: a frame with the new places and the old live state shows nothing amiss.
    placeWindows(new Map([[window, rect], ...pushed]));
    setLive({ ...still, flung });
    clearTimeout(flingTimer.current);
    // A fling's speed applies to the move it starts only.
    if (flung) flingTimer.current = setTimeout(() => setLive((l) => (l.flung ? { ...l, flung: null } : l)), 100);
  };

  const startDrag = useCallback((window: number, e: Pickup) => {
    const place = current.current.places.get(window);
    if (!place || resizing.current) return;
    focus(window);
    const velocity = new Velocity();
    velocity.add(e.screenX, e.screenY, performance.now() / 1000);
    drag.current = {
      window,
      start: place,
      grab: { x: e.worldX - place.x, y: e.worldY - place.y },
      press: { x: e.screenX, y: e.screenY },
      moved: false,
      rect: place,
      snappedX: false,
      snappedY: false,
      velocity,
      pushed: new Map(),
    };
    setLive({ ...still, grabbed: window });
  }, []);

  const moveDrag = useCallback((e: StagePointerEvent) => {
    const d = drag.current;
    if (!d) return;
    d.velocity.add(e.screenX, e.screenY, performance.now() / 1000);
    if (!d.moved) {
      if (Math.hypot(e.screenX - d.press.x, e.screenY - d.press.y) < dragSlop) return;
      d.moved = true;
    }
    const { settings } = current.current;
    const free = e.modifiers.includes(freeModifier);
    const rect = { ...d.start, x: e.worldX - d.grab.x, y: e.worldY - d.grab.y };
    let guides: Guide[] = [];
    d.snappedX = d.snappedY = false;
    if (settings.snapping && !free) {
      const a = align(rect, neighbours(d.window, d.pushed), snapDistance / zoom(), settings.gridSize);
      rect.x = a.x;
      rect.y = a.y;
      d.snappedX = a.snappedX;
      d.snappedY = a.snappedY;
      guides = a.guides;
    }
    d.rect = rect;
    if (settings.magnet && !free) d.pushed = push(d.window, rect, d.pushed);
    setLive({ grabbed: d.window, held: { window: d.window, rect }, pushed: d.pushed, guides, flung: null });
  }, []);

  const endDrag = useCallback((e: StagePointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) {
      setLive(still);
      return;
    }
    const { settings } = current.current;
    const free = e.modifiers.includes(freeModifier);
    let landing: Point = { x: d.rect.x, y: d.rect.y };
    let pushed = d.pushed;
    let flung: Live["flung"] = null;
    // Flung: it keeps going a little, shoving what it passes, then drops where it stops.
    const thrown =
      settings.magnet && !free
        ? coast(landing, d.velocity.release(performance.now() / 1000), zoom(), d.rect.width)
        : null;
    if (thrown) {
      for (let t = 0.03; t < 5 * coastLimits.decay; t += 0.03)
        pushed = push(d.window, { ...d.rect, ...thrown.at(t) }, pushed);
      landing = thrown.end;
      flung = { window: d.window, velocity: thrown.velocity };
    }
    // Onto the grid, except along an axis a guide holds, so what it lined up with stays lined up.
    if (settings.snapping && !free) landing = grid(landing, settings.gridSize, d.snappedX, d.snappedY);
    const rect = { ...d.rect, ...landing };
    // What it pushed keeps clear of where it lands.
    if (settings.magnet && !free) pushed = push(d.window, rect, pushed);
    commit(d.window, rect, pushed, flung);
  }, []);

  const startResize = useCallback((window: number) => {
    const place = current.current.places.get(window);
    if (place) resizing.current = { window, start: place, pushed: new Map() };
  }, []);

  /** A growing edge shoves what is in its way. */
  const resize = useCallback((window: number, e: StageResizeEvent) => {
    const r = resizing.current;
    if (!r || r.window !== window || !current.current.settings.magnet) return;
    const pushed = push(window, rect(e), r.pushed);
    if (pushed === r.pushed) return;
    r.pushed = pushed;
    setLive({ ...still, pushed });
  }, []);

  /** The edges that moved settle onto the grid, as a dropped window does. */
  const endResize = useCallback((window: number, e: StageResizeEvent) => {
    const r = resizing.current;
    resizing.current = null;
    const { settings } = current.current;
    const start = r?.window === window ? r.start : current.current.places.get(window);
    let next = rect(e);
    if (settings.snapping && start) next = gridEdges(next, movedEdges(start, next), settings.gridSize);
    let pushed = r?.window === window ? r.pushed : new Map<number, Rectangle>();
    if (settings.magnet) pushed = push(window, next, pushed);
    commit(window, next, pushed, null);
  }, []);

  /** Put back every window the last push moved, and the one that pushed them. */
  const undoPush = useCallback(() => {
    const before = undo.current;
    if (!before || drag.current) return;
    const { places, placeWindows } = current.current;
    const back = new Map<number, Rectangle>();
    // Positions only: a resize keeps its size, as the window has it.
    for (const [id, place] of before) {
      const now = places.get(id);
      if (now) back.set(id, { ...now, x: place.x, y: place.y });
    }
    undo.current = null;
    placeWindows(back);
  }, []);

  /** Where each window shows now: in hand, pushed, or at its place. */
  const shown = useMemo(() => {
    if (!live.held && live.pushed.size === 0) return places;
    const out = new Map(places);
    for (const [id, r] of live.pushed) if (out.has(id)) out.set(id, r);
    if (live.held && out.has(live.held.window)) out.set(live.held.window, live.held.rect);
    return out;
  }, [places, live]);

  /** How WINDOW moves to where it shows: with the hand, after a push, coasting, or settling. */
  const motionOf = (window: number): Transition => {
    if (live.held?.window === window) return { default: settle, x: instant, y: instant };
    if (live.flung?.window === window) {
      const { x, y } = live.flung.velocity;
      return { default: settle, x: coastMotion(x), y: coastMotion(y) };
    }
    if (live.pushed.has(window)) {
      const follow: Motion = followMotion(settings.strength);
      return { default: settle, x: follow, y: follow };
    }
    return settle;
  };

  return {
    shown,
    grabbed: live.grabbed,
    held: live.held?.window ?? null,
    guides: live.guides,
    motionOf,
    startDrag,
    moveDrag,
    endDrag,
    startResize,
    resize,
    endResize,
    undoPush,
  };
}

function rect({ x, y, width, height }: StageResizeEvent): Rectangle {
  return { x, y, width, height };
}

function intersects(a: Rectangle, b: Rectangle) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
