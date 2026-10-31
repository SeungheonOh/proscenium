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
  attractDistance,
  bounds,
  coast,
  coastLimits,
  coastMotion,
  defaultStrength,
  followMotion,
  gapLine,
  offset,
  reach,
  resolveBodies,
  response,
  Velocity,
  type Body,
} from "./magnetism.js";
import { align, snapDistance, type Guide, type Point } from "./snapping.js";
import type { History } from "./usePlacement.js";
import type { PlaceWindows } from "./usePlaces.js";
import type { Polarity } from "./usePolarity.js";

/** What arranging windows on the canvas does, kept with the canvas. */
export interface ArrangeSettings {
  /** Alignment guides while dragging: edges and centres stick to the neighbours'. */
  snapping: boolean;
  /** Magnet mode: windows push each other out of the way. */
  magnet: boolean;
  /** Gentle (0) to Firm (1). */
  strength: number;
  /** With magnet mode: windows are ⊕ or ⊖, and opposite poles pull together and bond. */
  polarity: boolean;
}

const defaults: ArrangeSettings = {
  snapping: true,
  magnet: false,
  strength: defaultStrength,
  polarity: false,
};

export function useArrangeSettings() {
  return usePersistentState<ArrangeSettings>("canvas.arrange", defaults);
}

/** What ties windows together on the canvas: bonded groups, stacks, the selection. */
export interface Links {
  /** WINDOW and the windows that move with it, WINDOW first. */
  together: (window: number) => readonly number[];
  /** WINDOW goes on alone: out of its group, its stack and the selection. */
  leave: (window: number) => void;
  /** The ties as they are now, as a function that puts them back, for undo. */
  snapshot: () => () => void;
}

/** Something the hand did that the canvas says out loud. */
export type ArrangeEvent = "bonded" | "pulledOut";

/** How far the pointer travels, on screen, before a press on a window moves it. */
const dragSlop = 3;
/**
 * Holding this while dragging places the window freely: no guides, no
 * pushing; from the first move it also pulls a bonded window out of its group.
 */
const freeModifier = "alt";

const settle = spring({ duration: 0.3 });

/** What a window being arranged looks like this frame. */
interface Live {
  /** The window pressed on, which hears the pointer until it is let go. */
  grabbed: number | null;
  /** The window in hand, where the hand holds it, and the windows bonded to it along with it. */
  held: { window: number; rect: Rectangle; members: ReadonlyMap<number, Rectangle> } | null;
  /** Where windows the hand pushed or is pulling in are heading. */
  pushed: ReadonlyMap<number, Rectangle>;
  guides: Guide[];
  /** Windows just let go with a fling, and the speed their coast starts at (canvas units a second). */
  flung: { windows: ReadonlySet<number>; velocity: Point } | null;
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
  velocity: Velocity;
  pushed: ReadonlyMap<number, Rectangle>;
  /** The windows bonded to it, where each was when the drag began: they go where it goes. */
  members: Map<number, Rectangle>;
  /** The bodies (a window, or a group as its ids) the hand is pulling in now. */
  pulled: number[][];
  /** When the hand started pulling each body in, by its first window, in seconds. */
  since: Map<number, number>;
  /** What puts the ties back as they were before the drag, for undo, and whether the drag changed them. */
  restore: () => void;
  regrouped: boolean;
}

interface Resize {
  window: number;
  start: Rectangle;
  pushed: ReadonlyMap<number, Rectangle>;
  /** The windows bonded to it: part of the hand, so never shoved. */
  members: ReadonlyMap<number, Rectangle>;
}

/** Where pointer event E is, for picking up a window. */
type Pickup = Pick<StagePointerEvent, "screenX" | "screenY" | "worldX" | "worldY">;

/**
 * Moving and resizing windows on the canvas as Sunlight does: a dragged window's
 * edges and centre stick to its neighbours' with a guide drawn while they do,
 * and it stays where it is let go; in magnet mode the windows in the way are
 * pushed aside, a hard fling coasting a little further. What goes with a
 * window (its stack, its bonded group, the selection it is in) moves with it. With polarity, a window brought near an
 * opposite pole pulls it in to the gap and bonds with it: from then on the two
 * move as one, until Alt-drag pulls one out. The world places a window in hand
 * on every pointer move, so a guide can hold it; resizes stay native, and their
 * pushes follow the coalesced progress.
 */
export function useArrange(
  places: ReadonlyMap<number, Rectangle>,
  placeWindows: PlaceWindows,
  output: OutputInfo | undefined,
  history: History,
  polarity: Polarity,
  links: Links,
  notify: (event: ArrangeEvent) => void,
) {
  const [settings] = useArrangeSettings();
  const [live, setLive] = useState<Live>(still);
  const drag = useRef<Drag | null>(null);
  const resizing = useRef<Resize | null>(null);
  // Handlers outlive the render that made them while the pointer is captured.
  const { together, leave, snapshot } = links;
  const current = useRef({ places, settings, output, placeWindows, polarity, together, leave, snapshot, notify });
  current.current = { places, settings, output, placeWindows, polarity, together, leave, snapshot, notify };
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
  const now = () => performance.now() / 1000;

  /** The windows in WINDOWS as a body: their rects and, with polarity acting, their poles. */
  const bodyOf = (rects: readonly [number, Rectangle][]): Body => {
    const { polarity } = current.current;
    return {
      rects: rects.map(([, r]) => r),
      poles: rects.map(([id]) => (polarity.active ? polarity.poleOf(id) : null)),
    };
  };

  /**
   * Everyone but EXCLUDED pushed out of HAND's way, a group as one body, from
   * where each is heading; PUSHED grows. With ATTRACT and polarity acting,
   * opposite poles near the hand are pulled in instead.
   */
  const push = (
    hand: Body,
    excluded: ReadonlySet<number>,
    pushed: ReadonlyMap<number, Rectangle>,
    attract: boolean,
  ): { pushed: ReadonlyMap<number, Rectangle>; pulled: number[][] } => {
    const { places, settings, polarity, together } = current.current;
    const heading = (id: number) => pushed.get(id) ?? places.get(id)!;
    const bodies: number[][] = [];
    const seen = new Set(excluded);
    for (const id of places.keys()) {
      if (seen.has(id)) continue;
      const group = together(id).filter((m) => !seen.has(m) && places.has(m));
      for (const m of group) seen.add(m);
      bodies.push(group);
    }
    const gap = reach(settings.strength);
    const attraction = attract && polarity.active ? { reach: attractDistance / zoom(), gap } : null;
    const result = resolveBodies(
      hand,
      bodies.map((ids) => bodyOf(ids.map((id) => [id, heading(id)]))),
      gap,
      attraction,
    );
    let next = pushed;
    if (result.moved.size) {
      const moved = new Map(pushed);
      for (const i of result.moved) for (const id of bodies[i]!) moved.set(id, offset(heading(id), result.offsets[i]!));
      next = moved;
    }
    return { pushed: next, pulled: [...result.pulled].map((i) => bodies[i]!) };
  };

  /** Where the windows bonded to the one in hand are with it at RECT. */
  const membersAt = (d: Drag, rect: Rectangle) => {
    const delta = { x: rect.x - d.start.x, y: rect.y - d.start.y };
    return new Map([...d.members].map(([id, r]) => [id, offset(r, delta)] as const));
  };

  /** The hand at RECT: the window in it and its group, as one body. */
  const handOf = (d: Drag, rect: Rectangle) => bodyOf([[d.window, rect], ...membersAt(d, rect)]);

  const carried = (d: Drag) => new Set([d.window, ...d.members.keys()]);

  /** Bodies the hand has pulled in bond with it, and come along from now on. */
  const bondIn = (d: Drag, bodies: number[][], rect: Rectangle) => {
    if (bodies.length === 0) return;
    const { places, polarity, notify } = current.current;
    const delta = { x: rect.x - d.start.x, y: rect.y - d.start.y };
    const pushed = new Map(d.pushed);
    for (const ids of bodies) {
      polarity.bond(d.window, ids[0]!);
      for (const id of ids) {
        const at = pushed.get(id) ?? places.get(id)!;
        // Kept as where it would have been at the start, so it moves with the rest.
        d.members.set(id, offset(at, { x: -delta.x, y: -delta.y }));
        pushed.delete(id);
      }
      d.since.delete(ids[0]!);
    }
    d.pushed = pushed;
    d.pulled = d.pulled.filter((ids) => !bodies.some((b) => b[0] === ids[0]));
    d.regrouped = true;
    notify("bonded");
  };

  /** Bodies pulled in long enough to have reached the gap bond now. */
  const bondArrived = (d: Drag, rect: Rectangle) => {
    const t = now();
    const since = new Map<number, number>();
    for (const ids of d.pulled) since.set(ids[0]!, d.since.get(ids[0]!) ?? t);
    d.since = since;
    const wait = response(current.current.settings.strength) + 0.05;
    bondIn(d, d.pulled.filter((ids) => t - since.get(ids[0]!)! >= wait), rect);
  };

  /** A line across the gap between the hand and each window it is pulling in. */
  const pullGuides = (d: Drag, rect: Rectangle): Guide[] => {
    const hand = handOf(d, rect).rects;
    const out: Guide[] = [];
    for (const ids of d.pulled) {
      const target = d.pushed.get(ids[0]!);
      const line = target && hand.map((h) => gapLine(h, target)).find((l) => l);
      if (line) out.push({ kind: "gap", ...line });
    }
    return out;
  };

  /** The windows a guide may hold the hand to: the others on screen, not what it carries or pulls in. */
  const neighbours = (d: Drag) => {
    const { places, output } = current.current;
    const camera = getCamera(output?.name);
    const view = camera &&
      output && {
        x: camera.x - output.width / 2 / camera.zoom,
        y: camera.y - output.height / 2 / camera.zoom,
        width: output.width / camera.zoom,
        height: output.height / camera.zoom,
      };
    const skip = carried(d);
    for (const ids of d.pulled) for (const id of ids) skip.add(id);
    const out: Rectangle[] = [];
    for (const [id, place] of places) {
      if (skip.has(id)) continue;
      const r = d.pushed.get(id) ?? place;
      if (!view || intersects(r, view)) out.push(r);
    }
    return out;
  };

  /** Lay the windows in MOVES down where they are heading. */
  const commit = (moves: ReadonlyMap<number, Rectangle>, flung: Live["flung"]) => {
    // Places first: a frame with the new places and the old live state shows nothing amiss.
    current.current.placeWindows(moves);
    setLive({ ...still, flung });
    clearTimeout(flingTimer.current);
    // A fling's speed applies to the move it starts only.
    if (flung) flingTimer.current = setTimeout(() => setLive((l) => (l.flung ? { ...l, flung: null } : l)), 100);
  };

  const startDrag = useCallback((window: number, e: Pickup) => {
    const { places, together } = current.current;
    const place = places.get(window);
    if (!place || resizing.current) return;
    focus(window);
    const velocity = new Velocity();
    velocity.add(e.screenX, e.screenY, now());
    const members = new Map<number, Rectangle>();
    for (const id of together(window).slice(1)) if (places.has(id)) members.set(id, places.get(id)!);
    drag.current = {
      window,
      start: place,
      grab: { x: e.worldX - place.x, y: e.worldY - place.y },
      press: { x: e.screenX, y: e.screenY },
      moved: false,
      rect: place,
      velocity,
      pushed: new Map(),
      members,
      pulled: [],
      since: new Map(),
      restore: current.current.snapshot(),
      regrouped: false,
    };
    setLive({ ...still, grabbed: window });
  }, []);

  const moveDrag = useCallback((e: StagePointerEvent) => {
    const d = drag.current;
    if (!d) return;
    d.velocity.add(e.screenX, e.screenY, now());
    const free = e.modifiers.includes(freeModifier);
    if (!d.moved) {
      if (Math.hypot(e.screenX - d.press.x, e.screenY - d.press.y) < dragSlop) return;
      d.moved = true;
      // Alt from the first move pulls a window out of what it goes with: it goes on alone.
      if (free && d.members.size) {
        const { leave, notify } = current.current;
        leave(d.window);
        d.members = new Map();
        d.regrouped = true;
        notify("pulledOut");
      }
    }
    const { settings } = current.current;
    const rect = { ...d.start, x: e.worldX - d.grab.x, y: e.worldY - d.grab.y };
    let guides: Guide[] = [];
    if (settings.snapping && !free) {
      const a = align(rect, neighbours(d), snapDistance / zoom());
      rect.x = a.x;
      rect.y = a.y;
      guides = a.guides;
    }
    d.rect = rect;
    if (settings.magnet && !free) {
      const r = push(handOf(d, rect), carried(d), d.pushed, true);
      d.pushed = r.pushed;
      d.pulled = r.pulled;
      bondArrived(d, rect);
      guides = [...guides, ...pullGuides(d, rect)];
    } else d.pulled = [];
    setLive({
      grabbed: d.window,
      held: { window: d.window, rect, members: membersAt(d, rect) },
      pushed: d.pushed,
      guides,
      flung: null,
    });
  }, []);

  const endDrag = useCallback((e: StagePointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) {
      setLive(still);
      return;
    }
    const { settings, polarity } = current.current;
    const free = e.modifiers.includes(freeModifier);
    let landing: Point = { x: d.rect.x, y: d.rect.y };
    let flung: Live["flung"] = null;
    // Flung: it keeps going a little, its group with it, shoving what it passes, then drops where it stops.
    const thrown =
      settings.magnet && !free
        ? coast(landing, d.velocity.release(now()), zoom(), bounds(handOf(d, d.rect).rects).width)
        : null;
    if (thrown) {
      for (let t = 0.03; t < 5 * coastLimits.decay; t += 0.03)
        d.pushed = push(handOf(d, { ...d.rect, ...thrown.at(t) }), carried(d), d.pushed, false).pushed;
      landing = thrown.end;
      flung = { windows: carried(d), velocity: thrown.velocity };
    }
    const rect = { ...d.rect, ...landing };
    if (settings.magnet && !free) {
      // What it pushed keeps clear of where it lands, and what it was pulling in bonds there.
      const r = push(handOf(d, rect), carried(d), d.pushed, true);
      d.pushed = r.pushed;
      d.pulled = r.pulled;
      if (polarity.active) bondIn(d, d.pulled, rect);
    }
    const moves = new Map([[d.window, rect], ...membersAt(d, rect), ...d.pushed]);
    // A push or a bond can be undone; positions only, as nothing was resized.
    if (d.pushed.size || d.regrouped)
      history.record(moves.keys(), true, d.regrouped ? d.restore : undefined);
    if (flung) flung = { windows: new Set([...flung.windows, ...d.members.keys()]), velocity: flung.velocity };
    commit(moves, flung);
  }, []);

  const startResize = useCallback((window: number) => {
    const { places, together } = current.current;
    const place = places.get(window);
    if (!place) return;
    const members = new Map<number, Rectangle>();
    for (const id of together(window).slice(1)) if (places.has(id)) members.set(id, places.get(id)!);
    resizing.current = { window, start: place, pushed: new Map(), members };
  }, []);

  /** The hand while WINDOW is resized to RECT: it and its group, which stays put. */
  const resizeHand = (r: Resize, rect: Rectangle) => bodyOf([[r.window, rect], ...r.members]);

  /** A growing edge shoves what is in its way. */
  const resize = useCallback((window: number, e: StageResizeEvent) => {
    const r = resizing.current;
    if (!r || r.window !== window || !current.current.settings.magnet) return;
    const { pushed } = push(resizeHand(r, rect(e)), new Set([window, ...r.members.keys()]), r.pushed, false);
    if (pushed === r.pushed) return;
    r.pushed = pushed;
    setLive({ ...still, pushed });
  }, []);

  /** A resize let go: what it pushed keeps clear of the size it ended at. */
  const endResize = useCallback((window: number, e: StageResizeEvent) => {
    const r = resizing.current?.window === window ? resizing.current : null;
    resizing.current = null;
    const { settings } = current.current;
    const next = rect(e);
    let pushed: ReadonlyMap<number, Rectangle> = r?.pushed ?? new Map();
    if (settings.magnet) {
      const members = r?.members ?? new Map();
      const hand = r ? resizeHand(r, next) : bodyOf([[window, next]]);
      pushed = push(hand, new Set([window, ...members.keys()]), pushed, false).pushed;
    }
    // A push can be undone; positions only, so the resize itself keeps its size.
    if (pushed.size) history.record([window, ...pushed.keys()], true);
    commit(new Map([[window, next], ...pushed]), null);
  }, []);

  /** Where each window shows now: in hand, carried along, pushed, or at its place. */
  const shown = useMemo(() => {
    if (!live.held && live.pushed.size === 0) return places;
    const out = new Map(places);
    for (const [id, r] of live.pushed) if (out.has(id)) out.set(id, r);
    if (live.held) {
      for (const [id, r] of live.held.members) if (out.has(id)) out.set(id, r);
      if (out.has(live.held.window)) out.set(live.held.window, live.held.rect);
    }
    return out;
  }, [places, live]);

  /** The windows that go with the hand this frame. */
  const inHand = useMemo(
    () => new Set(live.held ? [live.held.window, ...live.held.members.keys()] : []),
    [live.held],
  );

  /** How WINDOW moves to where it shows: with the hand, after a push, coasting, or settling. */
  const motionOf = (window: number): Transition => {
    if (inHand.has(window)) return { default: settle, x: instant, y: instant };
    if (live.flung?.windows.has(window)) {
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
    inHand,
    guides: live.guides,
    motionOf,
    startDrag,
    moveDrag,
    endDrag,
    startResize,
    resize,
    endResize,
  };
}

function rect({ x, y, width, height }: StageResizeEvent): Rectangle {
  return { x, y, width, height };
}

function intersects(a: Rectangle, b: Rectangle) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
