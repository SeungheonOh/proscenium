import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  focus,
  getCamera,
  instant,
  moveCamera,
  spring,
  type CameraInfo,
  usePersistentState,
  type Motion,
  type OutputInfo,
  type Rectangle,
  type StagePointerEvent,
  type StageResizeEvent,
  type Transition,
} from "proscenium";
import {
  bounds,
  coast,
  coastLimits,
  coastMotion,
  defaultStrength,
  followMotion,
  offset,
  reach,
  resolveBodies,
  Velocity,
  type Body,
} from "./magnetism.js";
import { align, snapDistance, type Guide, type Point } from "./snapping.js";
import { frontOf, pileAt } from "./stacks.js";
import type { History } from "./usePlacement.js";
import type { PlaceWindows } from "./usePlaces.js";
import type { Stacks } from "./useStacks.js";

/** What arranging windows on the canvas does, kept with the canvas. */
export interface ArrangeSettings {
  /** Alignment guides while dragging: edges and centres stick to the neighbours'. */
  snapping: boolean;
  /** Magnet mode: windows push each other out of the way. */
  magnet: boolean;
  /** Gentle (0) to Firm (1). */
  strength: number;
}

const defaults: ArrangeSettings = {
  snapping: true,
  magnet: false,
  strength: defaultStrength,
};

export function useArrangeSettings() {
  return usePersistentState<ArrangeSettings>("canvas.arrange", defaults);
}

/** What ties windows together on the canvas: stacks and the selection. */
export interface Links {
  /** WINDOW and the windows that move with it, WINDOW first: pushed as one, a stack included. */
  together: (window: number) => readonly number[];
  /** WINDOW leaves the selection but stays in its stack; whether it was in it. */
  release: (window: number) => boolean;
  /** WINDOW goes on alone: out of its stack and the selection. */
  leave: (window: number) => void;
  /** The ties as they are now, as a function that puts them back, for undo. */
  snapshot: () => () => void;
}

/** Something the hand did that the canvas says out loud. */
export type ArrangeEvent =
  /** Alt-dragged out of the selection. */
  | { type: "pulledOut" }
  /** Dropped into a stack, or on a window, the two starting one; or a stack dropped on a stack. */
  | { type: "joined"; stack: readonly number[]; how: "added" | "started" | "merged" }
  /** A window was dragged out of its stack and left elsewhere. */
  | { type: "left"; window: number };

/** How far the pointer travels, on screen, before a press on a window moves it. */
const dragSlop = 3;
/**
 * Holding this while dragging places the window freely: no guides, no
 * pushing; from the first move it also takes the window out of its stack or the selection.
 */
const freeModifier = "alt";

const settle = spring({ duration: 0.3 });

/** How near a screen edge, in screen pixels, a window in hand starts the canvas panning that way. */
const edgeMargin = 56;
/** How fast the canvas pans with the pointer at the very edge, in screen pixels a second. */
const edgeSpeed = 1500;
/** How often the canvas pans a step while a window is held at an edge, in milliseconds. */
const edgeTick = 16;

/** What a window being arranged looks like this frame. */
interface Live {
  /** The window pressed on, which hears the pointer until it is let go. */
  grabbed: number | null;
  /** The window in hand, where the hand holds it, and the windows that go with it. */
  held: { window: number; rect: Rectangle; members: ReadonlyMap<number, Rectangle> } | null;
  /** Where windows the hand pushed are heading. */
  pushed: ReadonlyMap<number, Rectangle>;
  guides: Guide[];
  /** Windows just let go with a fling, and the speed their coast starts at (canvas units a second). */
  flung: { windows: ReadonlySet<number>; velocity: Point } | null;
  /** Where the windows of stacks the hand is leaving or about to join are heading: closing up, or making room. */
  restack: ReadonlyMap<number, Rectangle>;
  /** The stack the window in hand drops into if let go now. */
  dropTarget: readonly number[] | null;
  /** How many windows go in if let go now: one, or a whole stack. */
  dropping: number;
  /** A window on its way out of its stack. */
  leaving: number | null;
}

const still: Live = {
  grabbed: null,
  held: null,
  pushed: new Map(),
  guides: [],
  flung: null,
  restack: new Map(),
  dropTarget: null,
  dropping: 0,
  leaving: null,
};

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
  /** The windows that go with it (its stack, the selection), where each was when the drag began. */
  members: Map<number, Rectangle>;
  /** What puts the ties back as they were before the drag, for undo, and whether the drag changed them. */
  restore: () => void;
  regrouped: boolean;
  /** The stack the window is being taken out of, bottom first, as it was. */
  fromStack: readonly number[] | null;
  /** The stack the window drops into if let go now, as it is. */
  target: readonly number[] | null;
  /** The pointer as it last moved: held at an edge, the canvas pans under it. */
  pointer: DragPoint;
}

/** Edge pan under way: the camera it has moved so far, ahead of the compositor's echo, and when it last stepped. */
interface EdgePan {
  timer: ReturnType<typeof setInterval>;
  camera: CameraInfo;
  last: number;
}

interface Resize {
  window: number;
  start: Rectangle;
  pushed: ReadonlyMap<number, Rectangle>;
  /** The windows that go with it: part of the hand, so never shoved. */
  members: ReadonlyMap<number, Rectangle>;
}


/** Where pointer event E is, for picking up a window. */
type Pickup = Pick<StagePointerEvent, "screenX" | "screenY" | "worldX" | "worldY">;

/** Where the pointer is during a drag, and the keys held. */
type DragPoint = Pickup & Pick<StagePointerEvent, "modifiers">;

/** What a world may turn off. */
export interface ArrangeOptions {
  /** A window held near a screen edge pans the canvas that way; on unless false. */
  edgePan?: boolean;
}

/** What the handlers read when they run: the hook's inputs as of the latest render. */
interface Inputs {
  places: ReadonlyMap<number, Rectangle>;
  placeWindows: PlaceWindows;
  output: OutputInfo | undefined;
  history: History;
  links: Links;
  stacks: Stacks;
  settings: ArrangeSettings;
  notify: (event: ArrangeEvent) => void;
  panAtEdges: boolean;
}

/**
 * Moving and resizing windows on the canvas as Sunlight does: a dragged window's
 * edges and centre stick to its neighbours' with a guide drawn while they do,
 * and it stays where it is let go; in magnet mode the windows in the way are
 * pushed aside, a hard fling coasting a little further. What goes with a
 * window (its stack, the selection it is in) moves with it, until Alt-drag
 * takes it out on its own. The world places a window in hand on every pointer
 * move, so a guide can hold it; resizes stay native, and their pushes follow
 * the coalesced progress.
 */
export function useArrange(
  places: ReadonlyMap<number, Rectangle>,
  placeWindows: PlaceWindows,
  output: OutputInfo | undefined,
  history: History,
  links: Links,
  stacks: Stacks,
  notify: (event: ArrangeEvent) => void,
  options: ArrangeOptions = {},
) {
  const [settings] = useArrangeSettings();
  const panAtEdges = options.edgePan !== false;
  const [live, setLive] = useState<Live>(still);
  const drag = useRef<Drag | null>(null);
  const resizing = useRef<Resize | null>(null);
  // Handlers outlive the render that made them while the pointer is captured.
  const current = useRef<Inputs>({ places, placeWindows, output, history, links, stacks, settings, notify, panAtEdges });
  current.current = { places, placeWindows, output, history, links, stacks, settings, notify, panAtEdges };
  const flingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const edgePan = useRef<EdgePan | null>(null);

  const stopEdgePan = useCallback(() => {
    if (edgePan.current) clearInterval(edgePan.current.timer);
    edgePan.current = null;
  }, []);

  // A window closing mid-gesture ends it.
  useEffect(() => {
    if (drag.current && !places.has(drag.current.window)) {
      drag.current = null;
      stopEdgePan();
      setLive(still);
    }
  }, [places, stopEdgePan]);
  useEffect(() => {
    return () => {
      clearTimeout(flingTimer.current);
      stopEdgePan();
    };
  }, [stopEdgePan]);

  /** Lay the windows in MOVES down where they are heading. */
  const commit = useCallback((moves: ReadonlyMap<number, Rectangle>, flung: Live["flung"]) => {
    // Places first: a frame with the new places and the old live state shows nothing amiss.
    current.current.placeWindows(moves);
    setLive({ ...still, flung });
    clearTimeout(flingTimer.current);
    if (!flung) return;
    // A fling's speed applies to the move it starts only.
    flingTimer.current = setTimeout(() => setLive((l) => (l.flung ? { ...l, flung: null } : l)), 100);
  }, []);

  /**
   * What is in hand, a window or a whole stack, goes in at the front of TARGET
   * (a stack, or one window it starts one with), which makes way; the stack a
   * window came from closes up.
   */
  const dropInto = useCallback((d: Drag, target: readonly number[]) => {
    const inputs = current.current;
    const { places, stacks, history, notify } = inputs;
    // A stack in hand goes in whole, in its own order.
    const hand = dropping(stacks, d) ?? [d.window];
    const joined = [...target, ...hand];
    // Back into its own stack it takes the front again, where the top window was.
    const from = d.fromStack;
    const home = from !== null && target.every((id) => from.includes(id));
    const front = frontOf(home ? from : target, places);
    const moves = restackPreview(inputs, { ...d, target: null });
    for (const [id, r] of pileAt(joined, front, places)) moves.set(id, r);
    stacks.make(joined);
    history.record(moves.keys(), true, d.restore);
    commit(moves, null);
    const how = hand.length > 1 ? "merged" : target.length === 1 ? "started" : "added";
    notify({ type: "joined", stack: joined, how });
  }, [commit]);

  /** Picks WINDOW up with what goes with it: its stack, the selection it is in. */
  const startDrag = useCallback((window: number, e: Pickup) => {
    const { places, links } = current.current;
    const place = places.get(window);
    if (!place || resizing.current) return;
    focus(window);
    const velocity = new Velocity();
    velocity.add(e.screenX, e.screenY, now());
    const members = new Map<number, Rectangle>();
    for (const id of links.together(window)) {
      const r = places.get(id);
      if (id !== window && r) members.set(id, r);
    }
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
      restore: links.snapshot(),
      regrouped: false,
      fromStack: null,
      target: null,
      pointer: { screenX: e.screenX, screenY: e.screenY, worldX: e.worldX, worldY: e.worldY, modifiers: [] },
    };
    setLive({ ...still, grabbed: window });
  }, []);

  /** The window in hand follows the pointer to where the drag last had it: held by guides, pushing, over a stack. */
  const follow = useCallback((d: Drag) => {
    const inputs = current.current;
    const { settings, stacks } = inputs;
    const { worldX, worldY, modifiers } = d.pointer;
    const free = modifiers.includes(freeModifier);
    const rect = { ...d.start, x: worldX - d.grab.x, y: worldY - d.grab.y };
    d.target = stackUnder(inputs, d, { x: worldX, y: worldY }, free);
    let guides: Guide[] = [];
    // Over a stack nothing holds the window: it is about to go in.
    if (settings.snapping && !free && !d.target) {
      const a = align(rect, neighbours(inputs, d), snapDistance / zoomOf(inputs.output));
      rect.x = a.x;
      rect.y = a.y;
      guides = a.guides;
    }
    d.rect = rect;
    if (settings.magnet && !free) d.pushed = push(inputs, handOf(d, rect), unpushed(stacks, d), d.pushed);
    setLive({
      grabbed: d.window,
      held: { window: d.window, rect, members: membersAt(d, rect) },
      pushed: d.pushed,
      guides,
      flung: null,
      restack: restackPreview(inputs, d),
      dropTarget: d.target,
      dropping: d.target ? dropping(stacks, d)?.length ?? 1 : 0,
      leaving: d.fromStack ? d.window : null,
    });
  }, []);

  /** A step of edge pan: the canvas moves under the pointer held at an edge, and the window in hand goes with it. */
  const stepEdgePan = useCallback(() => {
    const d = drag.current;
    const pan = edgePan.current;
    const { output } = current.current;
    const speed = d && output ? edgeVelocity(d.pointer, output) : null;
    if (!d || !pan || !output || !speed || (speed.x === 0 && speed.y === 0)) {
      stopEdgePan();
      return;
    }
    const t = now();
    // A late tick doesn't jump: the step covers a few frames at most.
    const dt = Math.min(t - pan.last, 0.05);
    pan.last = t;
    const { zoom } = pan.camera;
    const camera = { ...pan.camera, x: pan.camera.x + (speed.x * dt) / zoom, y: pan.camera.y + (speed.y * dt) / zoom };
    pan.camera = camera;
    moveCamera({ x: camera.x, y: camera.y }, { output: output.name, transition: instant });
    // The pointer stays put on the screen while the canvas under it moves.
    const { screenX, screenY } = d.pointer;
    d.pointer = {
      ...d.pointer,
      worldX: camera.x + (screenX - output.width / 2) / zoom,
      worldY: camera.y + (screenY - output.height / 2) / zoom,
    };
    follow(d);
  }, [follow, stopEdgePan]);

  /** Held near an edge, the window in hand starts the canvas panning that way. */
  const startEdgePan = useCallback((d: Drag) => {
    const { output, panAtEdges } = current.current;
    const camera = getCamera(output?.name);
    if (!panAtEdges || edgePan.current || !output || !camera) return;
    const speed = edgeVelocity(d.pointer, output);
    if (speed.x === 0 && speed.y === 0) return;
    edgePan.current = { timer: setInterval(stepEdgePan, edgeTick), camera, last: now() };
  }, [stepEdgePan]);

  const moveDrag = useCallback((e: StagePointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const inputs = current.current;
    d.velocity.add(e.screenX, e.screenY, now());
    if (!d.moved) {
      if (Math.hypot(e.screenX - d.press.x, e.screenY - d.press.y) < dragSlop) return;
      d.moved = true;
      // Alt from the first move takes a window out of what it goes with: it goes on alone.
      if (e.modifiers.includes(freeModifier) && d.members.size > 0) {
        d.members = new Map();
        // It leaves its stack where it lands, so it can still go back in; the rest close up meanwhile.
        const stack = inputs.stacks.of(d.window);
        if (stack.length > 1) d.fromStack = stack;
        if (inputs.links.release(d.window)) {
          d.regrouped = true;
          inputs.notify({ type: "pulledOut" });
        }
      }
    }
    const { screenX, screenY, worldX, worldY, modifiers } = e;
    d.pointer = { screenX, screenY, worldX, worldY, modifiers };
    // Panning, the canvas moved since the compositor placed this event: the pan's own camera says where it is now.
    const pan = edgePan.current;
    const output = inputs.output;
    if (pan && output) {
      d.pointer.worldX = pan.camera.x + (screenX - output.width / 2) / pan.camera.zoom;
      d.pointer.worldY = pan.camera.y + (screenY - output.height / 2) / pan.camera.zoom;
    }
    follow(d);
    startEdgePan(d);
  }, [follow, startEdgePan]);

  const endDrag = useCallback((e: StagePointerEvent) => {
    const d = drag.current;
    drag.current = null;
    stopEdgePan();
    if (!d) return;
    if (!d.moved) {
      setLive(still);
      return;
    }
    if (d.target) {
      dropInto(d, d.target);
      return;
    }
    const inputs = current.current;
    const { settings, stacks, history, notify } = inputs;
    const free = e.modifiers.includes(freeModifier);
    let landing: Point = { x: d.rect.x, y: d.rect.y };
    let flung: Live["flung"] = null;
    // Flung: it keeps going a little, what goes with it too, shoving what it passes, then drops where it stops.
    const thrown =
      settings.magnet && !free
        ? coast(landing, d.velocity.release(now()), zoomOf(inputs.output), bounds(handOf(d, d.rect).rects).width)
        : null;
    if (thrown) {
      for (let t = 0.03; t < 5 * coastLimits.decay; t += 0.03)
        d.pushed = push(inputs, handOf(d, { ...d.rect, ...thrown.at(t) }), carried(d), d.pushed);
      landing = thrown.end;
      flung = { windows: carried(d), velocity: thrown.velocity };
    }
    const rect = { ...d.rect, ...landing };
    // What it pushed keeps clear of where it lands.
    if (settings.magnet && !free) d.pushed = push(inputs, handOf(d, rect), unpushed(stacks, d), d.pushed);
    const moves = new Map([[d.window, rect], ...membersAt(d, rect), ...d.pushed]);
    // Out of its stack: the rest close up behind the stack's front.
    if (d.fromStack) {
      for (const [id, r] of restackPreview(inputs, d)) moves.set(id, r);
      stacks.leave(d.window);
      d.regrouped = true;
      notify({ type: "left", window: d.window });
    }
    // A push or a stack left can be undone; positions only, as nothing was resized.
    if (d.pushed.size > 0 || d.regrouped) history.record(moves.keys(), true, d.regrouped ? d.restore : undefined);
    commit(moves, flung);
  }, [commit, dropInto, stopEdgePan]);

  const startResize = useCallback((window: number) => {
    const { places, links } = current.current;
    const place = places.get(window);
    if (!place) return;
    const members = new Map<number, Rectangle>();
    for (const id of links.together(window).slice(1)) {
      const r = places.get(id);
      if (r) members.set(id, r);
    }
    resizing.current = { window, start: place, pushed: new Map(), members };
  }, []);

  /** A growing edge shoves what is in its way. */
  const resize = useCallback((window: number, e: StageResizeEvent) => {
    const r = resizing.current;
    const inputs = current.current;
    if (!r || r.window !== window || !inputs.settings.magnet) return;
    const pushed = push(inputs, resizeHand(r, rect(e)), new Set([window, ...r.members.keys()]), r.pushed);
    if (pushed === r.pushed) return;
    r.pushed = pushed;
    setLive({ ...still, pushed });
  }, []);

  /** A resize let go: what it pushed keeps clear of the size it ended at. */
  const endResize = useCallback((window: number, e: StageResizeEvent) => {
    const r = resizing.current?.window === window ? resizing.current : null;
    resizing.current = null;
    const inputs = current.current;
    const next = rect(e);
    let pushed: ReadonlyMap<number, Rectangle> = r?.pushed ?? new Map();
    if (inputs.settings.magnet) {
      const members = r?.members ?? new Map<number, Rectangle>();
      const hand = r ? resizeHand(r, next) : bodyOf([[window, next]]);
      pushed = push(inputs, hand, new Set([window, ...members.keys()]), pushed);
    }
    // A push can be undone; positions only, so the resize itself keeps its size.
    if (pushed.size > 0) inputs.history.record([window, ...pushed.keys()], true);
    commit(new Map([[window, next], ...pushed]), null);
  }, [commit]);

  /** Where each window shows now: in hand, carried along, pushed, or at its place. */
  const shown = useMemo(() => {
    if (!live.held && live.pushed.size === 0) return places;
    const out = new Map(places);
    for (const [id, r] of live.pushed) if (out.has(id)) out.set(id, r);
    for (const [id, r] of live.restack) if (out.has(id)) out.set(id, r);
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
    dropTarget: live.dropTarget,
    dropping: live.dropping,
    leaving: live.leaving,
    motionOf,
    startDrag,
    moveDrag,
    endDrag,
    startResize,
    resize,
    endResize,
  };
}

/** The camera's zoom on OUTPUT. */
/**
 * How fast the canvas pans, in screen pixels a second on each axis, with the
 * pointer at P on OUTPUT: toward an edge it is within the margin of, faster the nearer.
 */
function edgeVelocity(p: Pickup, output: OutputInfo): Point {
  return { x: edgeSpeedAlong(p.screenX, output.width), y: edgeSpeedAlong(p.screenY, output.height) };
}

/** The pan speed on one axis with the pointer AT along a screen SIZE long: back near the start, on near the end. */
function edgeSpeedAlong(at: number, size: number): number {
  const near = (distance: number) => {
    const depth = Math.min(1, Math.max(0, (edgeMargin - distance) / edgeMargin));
    return edgeSpeed * depth * depth;
  };
  return near(size - at) - near(at);
}

function zoomOf(output: OutputInfo | undefined) {
  return getCamera(output?.name)?.zoom ?? 1;
}

/** The time in seconds, for velocities. */
function now() {
  return performance.now() / 1000;
}

/** The windows in RECTS as one body. */
function bodyOf(rects: readonly (readonly [number, Rectangle])[]): Body {
  return { rects: rects.map(([, r]) => r) };
}

/**
 * Everyone but EXCLUDED pushed out of HAND's way, what moves together as one
 * body, from where each is heading; PUSHED grows.
 */
function push(
  { places, settings, links }: Inputs,
  hand: Body,
  excluded: ReadonlySet<number>,
  pushed: ReadonlyMap<number, Rectangle>,
): ReadonlyMap<number, Rectangle> {
  const heading = (id: number) => pushed.get(id) ?? places.get(id)!;
  const bodies: number[][] = [];
  const seen = new Set(excluded);
  for (const id of places.keys()) {
    if (seen.has(id)) continue;
    const group = links.together(id).filter((m) => !seen.has(m) && places.has(m));
    for (const m of group) seen.add(m);
    bodies.push(group);
  }
  const result = resolveBodies(
    hand,
    bodies.map((ids) => bodyOf(ids.map((id) => [id, heading(id)]))),
    reach(settings.strength),
  );
  if (result.moved.size === 0) return pushed;
  const moved = new Map(pushed);
  for (const i of result.moved) for (const id of bodies[i]!) moved.set(id, offset(heading(id), result.offsets[i]!));
  return moved;
}

/** Where the windows that go with the one in hand in D are with it at RECT. */
function membersAt(d: Drag, rect: Rectangle) {
  const delta = { x: rect.x - d.start.x, y: rect.y - d.start.y };
  return new Map([...d.members].map(([id, r]) => [id, offset(r, delta)] as const));
}

/** The hand at RECT: the window in it and what goes with it, as one body. */
function handOf(d: Drag, rect: Rectangle) {
  return bodyOf([[d.window, rect], ...membersAt(d, rect)]);
}

/** The window in hand and what goes with it. */
function carried(d: Drag) {
  return new Set([d.window, ...d.members.keys()]);
}

/** The stack in hand, bottom first, when the hand carries a whole stack and nothing else; else null. */
function handStack(stacks: Stacks, d: Drag): readonly number[] | null {
  if (d.fromStack) return null;
  const s = stacks.of(d.window);
  const whole = s.length > 1 && d.members.size === s.length - 1 && s.every((id) => id === d.window || d.members.has(id));
  return whole ? s : null;
}

/**
 * What the hand drops into a stack: a window on its own (which can always
 * drop into one), or a whole stack; null if it carries anything else.
 */
function dropping(stacks: Stacks, d: Drag): readonly number[] | null {
  return d.members.size === 0 ? [d.window] : handStack(stacks, d);
}

/**
 * What a push leaves alone: what the hand carries and, for a window on its
 * own or a stack, every stack, as stacks are places to drop it, not things
 * in its way.
 */
function unpushed(stacks: Stacks, d: Drag) {
  const out = carried(d);
  if (!dropping(stacks, d)) return out;
  for (const s of stacks.all) for (const id of s) out.add(id);
  return out;
}

/**
 * The stack under the pointer at POINT that what is in hand would drop into,
 * as it would be without it: a window on its own, or a whole stack, which
 * merges. With FREE (Alt held) a window on its own also starts a stack with
 * a window outside any.
 */
function stackUnder({ places, stacks }: Inputs, d: Drag, point: Point, free: boolean): readonly number[] | null {
  const hand = dropping(stacks, d);
  if (!hand) return null;
  for (const s of stacks.all) {
    // A stack in hand never drops into itself; a window taken out of one may go back.
    if (hand.length > 1 && s.includes(d.window)) continue;
    const rest = s.filter((id) => id !== d.window);
    if (rest.length > 0 && contains(bounds(s.flatMap((id) => places.get(id) ?? [])), point)) return rest;
  }
  if (!free || hand.length > 1) return null;
  // Of the windows under the pointer, the one it is nearest the middle of.
  let under: number | null = null;
  let nearest = Infinity;
  for (const [id, r] of places) {
    if (id === d.window || stacks.of(id).length > 1 || !contains(r, point)) continue;
    const distance = Math.hypot(point.x - (r.x + r.width / 2), point.y - (r.y + r.height / 2));
    if (distance < nearest) {
      under = id;
      nearest = distance;
    }
  }
  return under === null ? null : [under];
}

/**
 * Where the stacks touched by the drag D show: the one the window is leaving
 * closes up behind its front, and the one under the pointer makes room at
 * its front for the window.
 */
function restackPreview({ places, stacks }: Inputs, d: Drag): Map<number, Rectangle> {
  const out = new Map<number, Rectangle>();
  if (d.fromStack) {
    const rest = d.fromStack.filter((id) => id !== d.window);
    const home = d.target !== null && d.target.includes(rest[0]!);
    for (const [id, r] of pileAt(rest, frontOf(d.fromStack, places), places, home ? 1 : 0)) out.set(id, r);
    if (home) return out;
  }
  if (d.target) {
    const room = dropping(stacks, d)?.length ?? 1;
    for (const [id, r] of pileAt(d.target, frontOf(d.target, places), places, room)) out.set(id, r);
  }
  return out;
}

/** The windows a guide may hold the hand in D to: the others on screen, not what it carries. */
function neighbours({ places, output }: Inputs, d: Drag): Rectangle[] {
  const camera = getCamera(output?.name);
  const view = camera && output
    ? {
        x: camera.x - output.width / 2 / camera.zoom,
        y: camera.y - output.height / 2 / camera.zoom,
        width: output.width / camera.zoom,
        height: output.height / camera.zoom,
      }
    : null;
  const skip = carried(d);
  const out: Rectangle[] = [];
  for (const [id, place] of places) {
    if (skip.has(id)) continue;
    const r = d.pushed.get(id) ?? place;
    if (!view || intersects(r, view)) out.push(r);
  }
  return out;
}

/** The hand while R's window is resized to RECT: it and what goes with it, which stays put. */
function resizeHand(r: Resize, rect: Rectangle) {
  return bodyOf([[r.window, rect], ...r.members]);
}

function rect({ x, y, width, height }: StageResizeEvent): Rectangle {
  return { x, y, width, height };
}

function contains(r: Rectangle, p: Point) {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

function intersects(a: Rectangle, b: Rectangle) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
