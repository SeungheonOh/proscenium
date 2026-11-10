/**
 * One output's canvas: the windows of the workspace it shows, in their frames,
 * under a camera that pans and zooms. Windows are moved about it as on the
 * canvas world (examples/canvas), whose hooks run here on the frames as
 * Warlock places them: whatever they move becomes a floating window. Around
 * them Warlock's own rules hold: a window let go of at a screen edge snaps, a
 * snapped one dragged away takes back its size, dialogs go with their parents.
 */

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  Camera,
  focus,
  getCamera,
  instant,
  moveCamera,
  spring,
  usePersistentState,
  type OutputInfo,
  type Rectangle,
  type StagePointerEvent,
  type StageResizeEvent,
  type Transition,
} from "proscenium";
import { closure, spread, stackOf } from "../../canvas/stacks.js";
import { useArrange, type ArrangeEvent, type Links } from "../../canvas/useArrange.js";
import { useFan } from "../../canvas/useFan.js";
import { useHistory, usePlacement } from "../../canvas/usePlacement.js";
import type { PlaceWindows } from "../../canvas/usePlaces.js";
import { useSelection, type Selection } from "../../canvas/useSelection.js";
import { useStacks } from "../../canvas/useStacks.js";
import { directions, neighbour, union } from "../../lib/geometry.js";
import { defaultFloat, dropZone, minimumSize, pageAt, pageOf } from "../geometry.js";
import { useTaskbarGroups, type TaskbarGroup } from "../groups.js";
import { Portal } from "../portal.js";
import type { View } from "../state.js";
import { useWarlockTheme, type WarlockTheme, titleBarOf } from "../theme.js";
import {
  useWarlock,
  type CanvasActions,
  type CanvasHandle,
  type FlyRequest,
  type WarlockContextValue,
} from "../WarlockProvider.js";
import {
  glide,
  glideMotion,
  heldMotion,
  minimizeSeconds,
  noEdges,
  restoreSeconds,
  stillMotion,
  WindowFrame,
  type DragController,
  type Edges,
  type Flight,
  type FrameMotion,
  type Veil,
} from "../WindowFrame.js";
import { CameraWatcher, createCameraFeed } from "./CameraFeed.js";
import { Marks } from "./Marks.js";
import { Minimap } from "./Minimap.js";
import {
  atActualSize,
  cameraFor,
  canvasOffset,
  canvasStride,
  centredOn,
  fitting,
  homeView,
  inside,
  middle,
  moveView,
  pageInView,
  pageView,
  shownWorkArea,
  toCanvas,
  toWorld,
  viewFrom,
  viewOf,
  zoomRange,
  type Point,
} from "./view.js";

/** How far a press must travel, on the screen, to be a drag. */
const dragThreshold = 4;
const cameraMotion = spring({ duration: 0.45, bounce: 0.08 });

/** One window opening or closing through Warlock's portal. */
export interface PortalState {
  key: number;
  kind: "open" | "close";
  window: number;
  /** The window's frame on its output's canvas. */
  rect: Rectangle;
  output: string;
}

/** Where a press landed: on its output, and in the world. */
type Press = Pick<StagePointerEvent, "screenX" | "screenY" | "worldX" | "worldY">;

/** A gesture this canvas runs by itself: a dialog moved over its parent, or a frame resized. */
interface Hand {
  window: number;
  kind: "dialog" | "resize";
  edges: Edges;
  press: Press;
  /** The frame as the gesture began, in the world. */
  from: Rectangle;
  /** The frame now; null until the pointer has travelled far enough to be a drag. */
  rect: Rectangle | null;
}

/** A window being moved by the canvas's own hand (useArrange). */
interface Carry {
  window: number;
  press: Press;
  /**
   * A snapped or maximized window comes away at the size it had before: it
   * waits for the pointer to travel, is floated, and is picked up once it shows there.
   */
  unsnap: "waiting" | "floated" | null;
  /** The pointer as it last moved while the float was on its way. */
  last: StagePointerEvent | null;
}

/** The overview: the view that takes in every window, and the one to go back to. */
interface Overview {
  shown: View;
  back: View;
}

/** A frame on its way to its taskbar button, or back from it. */
interface Passage {
  kind: "away" | "arriving";
  /** Where the frame is, or was, in the world. */
  rect: Rectangle;
  flight: Flight;
  at: number;
}

export interface CanvasOutputProps {
  output: OutputInfo;
  /** Which of the outputs this is: its canvas lies that far along the world. */
  index: number;
  /** The portal showing now, on whichever output. */
  portal: PortalState | null;
}

export function CanvasOutput({ output, index, portal }: CanvasOutputProps) {
  const warlock = useWarlock();
  const {
    placed,
    stack,
    windows,
    state,
    focused,
    focusedRoot,
    family,
    label,
    rootOf,
    dispatch,
    notify,
    flyRequest,
  } = warlock;
  const theme = useWarlockTheme();
  const groups = useTaskbarGroups();
  const animated = warlock.motion === "full";
  const offset = useMemo(() => canvasOffset(index), [index]);
  const feed = useMemo(createCameraFeed, []);

  // The frames of the windows this output shows, in the world: what the canvas hooks arrange.
  const frames = useStableRects(
    useMemo(() => {
      const out = new Map<number, Rectangle>();
      for (const entry of placed.values())
        if (entry.output === output && !entry.record.fullscreen && windows.has(entry.id))
          out.set(entry.id, toWorld(entry.rect, offset));
      return out;
    }, [placed, windows, output, offset]),
  );

  const latest = useRef<Latest | null>(null);
  /** Whatever the canvas moves floats where it was put. */
  const placeFrames = useCallback<PlaceWindows>(
    (next) => {
      const now = latest.current;
      if (!now) return;
      const rects: Record<number, Rectangle> = {};
      for (const [id, change] of next) {
        const frame = now.frames.get(id);
        if (!frame) continue;
        const rect = toCanvas({ ...frame, ...change }, offset);
        rects[id] = { ...rect, x: Math.round(rect.x), y: Math.round(rect.y) };
      }
      dispatch({ type: "place", rects });
    },
    [offset, dispatch],
  );

  const stacks = useStacks(frames);
  const selection = useSelection(frames, () => viewOf(output, index).zoom);
  const selected = (id: number) => (selection.has(id) ? [...selection.ids] : []);
  // What moves with a window: its stack, and the selection it is in.
  const links: Links = {
    together: (window) => closure(window, [stacks.of, selected]),
    release: (window) => {
      const inSelection = selection.has(window);
      selection.remove(window);
      return inSelection;
    },
    leave: (window) => {
      links.release(window);
      stacks.leave(window);
    },
    snapshot: () => {
      const all = stacks.all;
      return () => stacks.restore(all);
    },
  };
  const history = useHistory(frames, placeFrames);
  // A window held at a screen edge is about to snap there, so the canvas stays put under it.
  const arrange = useArrange(frames, placeFrames, output, history, links, stacks, onArranged, {
    edgePan: false,
  });
  const placement = usePlacement(
    frames,
    placeFrames,
    output,
    focusedRoot ?? undefined,
    history,
    stacks,
    links,
  );
  const fan = useFan(arrange.shown, bringToFront, reorder, "logo");

  const [hand, drawHand] = useState<Hand | null>(null);
  const handNow = useRef<Hand | null>(null);
  const carried = useRef<Carry | null>(null);
  /** A snapped or maximized window pressed on: it hears the pointer until it is picked up or let go. */
  const [held, setHeld] = useState<number | null>(null);
  /** Where each dialog was dragged to, from the middle of its parent. */
  const [offsets, setOffsets] = useState<ReadonlyMap<number, Point>>(new Map());
  const selecting = useRef(false);
  const [, redraw] = useState(0);

  /** Say what the hand just did. */
  function onArranged(event: ArrangeEvent) {
    switch (event.type) {
      case "pulledOut":
        notify("Pulled out of the selection.", 4);
        break;
      case "joined": {
        const what = { added: "Added to the stack", started: "New stack", merged: "Stacks merged" }[
          event.how
        ];
        notify(`${what}: ${event.stack.length} windows. Super+\` fans them out.`, 5);
        break;
      }
      case "left":
        notify("Out of the stack.", 4);
        break;
    }
  }

  /** WINDOW to the front of its stack, the others keeping their turn, and focused. */
  function bringToFront(window: number) {
    placement.bringToFront(window);
    focus(window);
  }

  /** A frame dragged along the fan: the stack takes the fan's ORDER, left to right, the leftmost in front. */
  function reorder(order: readonly number[]) {
    const turned = [...order].reverse();
    placement.restack(turned);
    focus(turned.at(-1)!);
  }

  // A stack holds floating windows: one that was tiled, snapped or maximized since has left it.
  useEffect(() => {
    for (const ids of stacks.all)
      for (const id of ids)
        if (state.windows[id] && state.windows[id].placement !== "floating") stacks.leave(id);
  }, [stacks.all, state.windows]);

  // The camera: every workspace's canvas lies in this output's own stretch of the world.
  const [overview, setOverview] = usePersistentState<Overview | null>(
    `warlock.overview.${output.name}`,
    null,
  );
  const reported = useSyncExternalStore(feed.subscribe, () => feed.camera() !== null);
  useLayoutEffect(() => {
    const camera = getCamera(output.name);
    if (!camera) return;
    const stretch = Math.round(camera.y / canvasStride);
    if (stretch !== index)
      moveCamera(
        { y: camera.y + (index - stretch) * canvasStride },
        { output: output.name, transition: instant },
      );
  }, [output.name, index, reported]);

  /** Bring WINDOW into view: its page at 100%, or a floating window to the middle; unless it is all in view already. */
  function bringIntoView(
    window: number,
    options: { always?: boolean; immediately?: boolean } = {},
  ) {
    const entry = placed.get(window);
    if (!entry || entry.output !== output || entry.record.fullscreen) return;
    if (!options.always && inside(shownWorkArea(output, viewOf(output, index)), entry.rect)) return;
    const floating = entry.record.placement === "floating";
    setOverview(null);
    moveView(
      output,
      index,
      floating ? centredOn(output, entry.rect) : pageView(output, pageOf(entry.record)),
      options.immediately ? instant : undefined,
    );
  }

  // Activating, snapping and opening a window ask for it to be in view.
  const answered = useRef(flyRequest?.serial ?? 0);
  const answer = useEffectEvent((request: FlyRequest) => {
    if (request.serial <= answered.current) return;
    answered.current = request.serial;
    bringIntoView(request.window, { immediately: request.instant });
  });
  useEffect(() => {
    if (flyRequest) answer(flyRequest);
  }, [flyRequest]);

  // A window focused from the overview is dived in to.
  const dive = useEffectEvent((window: number) => {
    if (overview && frames.has(window)) bringIntoView(window, { always: true });
  });
  useEffect(() => {
    if (focusedRoot !== null) dive(focusedRoot);
  }, [focusedRoot]);

  // The overview lasts while the view stays as it put it: panned or zoomed by hand, it is just the canvas again.
  const overviewNow = useEffectEvent(() => overview);
  const endOverview = useEffectEvent(() => setOverview(null));
  const inOverview = overview !== null;
  useEffect(() => {
    if (!inOverview) return;
    return feed.subscribe(() => {
      const camera = feed.camera();
      const shown = overviewNow()?.shown;
      if (!camera || !shown) return;
      const view = viewFrom(output, index, camera);
      const moved =
        Math.abs(view.x - shown.x) > 1 ||
        Math.abs(view.y - shown.y) > 1 ||
        Math.abs(view.zoom - shown.zoom) > 0.001;
      if (moved) endOverview();
    });
  }, [inOverview, feed, output, index]);

  // An overview is of one workspace.
  const workspace = warlock.workspaceOf(output);
  const overviewOf = useRef(workspace);
  useEffect(() => {
    if (overviewOf.current === workspace) return;
    overviewOf.current = workspace;
    setOverview(null);
  }, [workspace]);

  const order = useMemo(
    () =>
      drawOrder(
        stack.filter((id) => frames.has(id)),
        stacks.all,
        focusedRoot,
      ),
    [stack, frames, stacks.all, focusedRoot],
  );

  // Where each frame shows now: at its place, in the hand, pushed, fanned out or under a resize.
  const poses = fan.poses;
  const boxes = new Map(arrange.shown);
  for (const [id, pose] of poses ?? []) boxes.set(id, pose.rect);
  if (hand?.kind === "resize" && hand.rect && boxes.has(hand.window))
    boxes.set(hand.window, hand.rect);
  const picked = fan.fan?.order[fan.fan.at];
  // A fan lies over everything.
  const layers = fan.layers;
  const drawn = layers ? [...order.filter((id) => !layers.includes(id)), ...layers] : order;

  /** A dialog's frame: its own size, over the middle of the window it belongs to, wherever it was dragged from there. */
  function dialogRect(id: number, parent: Rectangle, moved: ReadonlyMap<number, Point>): Rectangle {
    const info = windows.get(id);
    const bar = titleBarOf(theme, info);
    const width = Math.max(minimumSize.width, (info?.width ?? 0) + 2);
    const height = Math.max(minimumSize.height, (info?.height ?? 0) + bar + 2);
    const by = moved.get(id) ?? { x: 0, y: 0 };
    return {
      x: Math.round(parent.x + (parent.width - width) / 2 + by.x),
      y: Math.round(parent.y + (parent.height - height) / 2 + by.y),
      width,
      height,
    };
  }

  /** Where the point (X, Y) of the world shows on this output. */
  const onScreen = useCallback(
    (x: number, y: number): Point => {
      const camera = cameraFor(output, index, viewOf(output, index));
      return {
        x: output.width / 2 + (x - camera.x) * camera.zoom,
        y: output.height / 2 + (y - camera.y) * camera.zoom,
      };
    },
    [output, index],
  );

  /** How the frame at RECT is drawn at WINDOW's taskbar button: over it, and as wide. */
  function toButton(window: number, rect: Rectangle): Flight {
    const camera = cameraFor(output, index, viewOf(output, index));
    const onRect = onScreen(rect.x + rect.width / 2, 0).x;
    const spot = buttonSpot(groups, window, theme.textScale / 100) ?? { x: onRect, width: 104 };
    const centre = middle(rect);
    return {
      x: camera.x + (Math.min(spot.x, output.width) - output.width / 2) / camera.zoom - centre.x,
      y: camera.y + (theme.barHeight / 2 - output.height / 2) / camera.zoom - centre.y,
      scale: Math.min(0.5, Math.max(0.04, spot.width / camera.zoom / rect.width)),
    };
  }

  // Frames on their way to the taskbar and back: found while rendering, so a frame's last and first frames show it.
  const passages = useRef(new Map<number, Passage>());
  const seen = useRef<{
    frames: ReadonlyMap<number, Rectangle>;
    records: typeof state.windows;
  } | null>(null);
  const now = performance.now();
  for (const [id, passage] of passages.current) {
    const lasts = (passage.kind === "away" ? minimizeSeconds : restoreSeconds) * 1000 + 40;
    if (now - passage.at > lasts || !windows.has(id)) passages.current.delete(id);
  }
  if (seen.current?.frames !== frames || seen.current.records !== state.windows) {
    const before = seen.current;
    if (before && animated) {
      for (const [id, rect] of before.frames) {
        const minimized = state.windows[id]?.minimized && !before.records[id]?.minimized;
        if (!frames.has(id) && windows.has(id) && minimized)
          passages.current.set(id, { kind: "away", rect, flight: toButton(id, rect), at: now });
      }
      for (const [id, rect] of frames) {
        if (before.frames.has(id)) continue;
        if (before.records[id]?.minimized && !state.windows[id]?.minimized)
          passages.current.set(id, { kind: "arriving", rect, flight: toButton(id, rect), at: now });
        else passages.current.delete(id);
      }
    }
    seen.current = { frames, records: state.windows };
  }
  const leaving = [...passages.current].filter(
    ([id, passage]) => passage.kind === "away" && !frames.has(id),
  );
  const lastLeft = Math.max(0, ...leaving.map(([, passage]) => passage.at));
  useEffect(() => {
    if (lastLeft === 0) return;
    const timer = setTimeout(() => redraw((count) => count + 1), minimizeSeconds * 1000 + 60);
    return () => clearTimeout(timer);
  }, [lastLeft]);

  /** How frame ID gets to where it is drawn. */
  function motionOf(id: number): FrameMotion {
    if (!animated || hand?.window === id || fan.dragging === id) return stillMotion;
    if (arrange.inHand.has(id)) return heldMotion;
    // Flung or pushed, it moves as the canvas has it.
    const own = arrange.motionOf(id);
    if (!("type" in own) && own.x && own.y) return { x: own.x, y: own.y, size: glide };
    return glideMotion;
  }
  const markMotion = (id: number) => markTransition(motionOf(id));

  const controller = useMemo<DragController>(() => {
    const setHand = (next: Hand | null) => {
      handNow.current = next;
      drawHand(next);
    };
    const travelled = (press: Press, event: StagePointerEvent) =>
      Math.hypot(event.screenX - press.screenX, event.screenY - press.screenY);

    /** A window let go of at a screen edge takes that half or quarter; at the top, the whole work area. */
    const dropAtEdge = (window: number, event: StagePointerEvent) => {
      const { output, index, warlock } = latest.current!;
      if (event.output !== output.name) return;
      const zone = dropZone(output, event.screenX, event.screenY);
      if (!zone) return;
      // On the page in view at 100%; zoomed, on the page it was dropped on.
      const view = viewOf(output, index);
      const at = canvasOffset(index);
      const page = atActualSize(view)
        ? pageInView(output, view)
        : pageAt(output, event.worldX - at.x, event.worldY - at.y);
      if (zone === "maximize") warlock.maximize(window, page);
      else warlock.snap(window, zone, page);
    };

    const api: DragController = {
      begin(kind, window, event, edges = noEdges) {
        const { placed, frames, rootOf, offsets, arrange, dialogRect } = latest.current!;
        const { screenX, screenY, worldX, worldY } = event;
        if (
          screenX === undefined ||
          screenY === undefined ||
          worldX === undefined ||
          worldY === undefined
        )
          return;
        const press = { screenX, screenY, worldX, worldY };
        const root = rootOf(window);
        const entry = placed.get(root);
        const frame = frames.get(root);
        if (!entry || !frame) return;
        const dialog = root !== window;
        if (kind === "resize") {
          if (dialog || entry.record.placement !== "floating") return;
          setHand({ window, kind, edges, press, from: frame, rect: null });
        } else if (dialog) {
          setHand({
            window,
            kind: "dialog",
            edges: noEdges,
            press,
            from: dialogRect(window, frame, offsets),
            rect: null,
          });
        } else if (entry.record.placement === "snapped" || entry.record.placement === "maximized") {
          carried.current = { window: root, press, unsnap: "waiting", last: null };
          setHeld(root);
        } else {
          carried.current = { window: root, press, unsnap: null, last: null };
          // Its stack and the selection it is in go with it.
          arrange.startDrag(root, press);
        }
      },

      move(event) {
        const { output, state, frames, windows, theme, arrange, dispatch } = latest.current!;
        // On another output the pointer is in another canvas.
        if (event.output !== output.name) return;
        const own = handNow.current;
        if (own) {
          if (!own.rect && travelled(own.press, event) < dragThreshold) return;
          const dx = event.worldX - own.press.worldX;
          const dy = event.worldY - own.press.worldY;
          const from = own.from;
          if (own.kind === "dialog") {
            setHand({
              ...own,
              rect: { ...from, x: Math.round(from.x + dx), y: Math.round(from.y + dy) },
            });
            return;
          }
          const info = windows.get(own.window);
          const bar = titleBarOf(theme, info);
          const least = {
            width: Math.max(minimumSize.width, (info?.minWidth ?? 0) + 2),
            height: Math.max(minimumSize.height, (info?.minHeight ?? 0) + bar + 2),
          };
          const most = {
            width: info && info.maxWidth > 0 ? info.maxWidth + 2 : Infinity,
            height: info && info.maxHeight > 0 ? info.maxHeight + bar + 2 : Infinity,
          };
          const fit = (value: number, low: number, high: number) =>
            Math.round(Math.min(Math.max(value, low), high));
          let { x, y, width, height } = from;
          if (own.edges.right) width = fit(from.width + dx, least.width, most.width);
          if (own.edges.bottom) height = fit(from.height + dy, least.height, most.height);
          if (own.edges.left) {
            width = fit(from.width - dx, least.width, most.width);
            x = from.x + from.width - width;
          }
          if (own.edges.top) {
            height = fit(from.height - dy, least.height, most.height);
            y = from.y + from.height - height;
          }
          const rect = { x, y, width, height };
          // In magnet mode a growing edge shoves what is in its way.
          if (!own.rect) arrange.startResize(own.window);
          arrange.resize(own.window, rect as StageResizeEvent);
          setHand({ ...own, rect });
          return;
        }

        const carry = carried.current;
        if (!carry) return;
        if (!carry.unsnap) {
          arrange.moveDrag(event);
          return;
        }
        carry.last = event;
        if (carry.unsnap !== "waiting" || travelled(carry.press, event) < dragThreshold) return;
        // A snapped or maximized window comes away at the size it had before, held where it was grabbed.
        const frame = frames.get(carry.window);
        if (!frame) return;
        const size = state.windows[carry.window]?.saved?.rect ?? defaultFloat(output.workArea, 0);
        const along = (carry.press.worldX - frame.x) / frame.width;
        const from = {
          x: carry.press.worldX - along * size.width,
          y: frame.y,
          width: size.width,
          height: size.height,
        };
        carry.unsnap = "floated";
        dispatch({
          type: "place",
          rects: { [carry.window]: toCanvas(from, canvasOffset(latest.current!.index)) },
        });
      },

      end(event) {
        const own = handNow.current;
        if (own) {
          // Moves are reported at most once a frame, so the last one may be short of where the pointer was let go.
          api.move(event);
          const { frames, rootOf, offsets, arrange, dialogRect } = latest.current!;
          const { window, kind, rect } = handNow.current ?? own;
          setHand(null);
          if (!rect) return;
          if (kind === "resize") {
            arrange.endResize(window, rect as StageResizeEvent);
            return;
          }
          const parent = frames.get(rootOf(window));
          if (!parent) return;
          const home = dialogRect(window, parent, new Map());
          const moved = new Map(offsets);
          moved.set(window, { x: rect.x - home.x, y: rect.y - home.y });
          setOffsets(moved);
          return;
        }

        const carry = carried.current;
        carried.current = null;
        if (!carry) return;
        if (carry.unsnap) {
          setHeld(null);
          if (carry.unsnap === "floated") dropAtEdge(carry.window, event);
          return;
        }
        const { output, links, arrange } = latest.current!;
        if (event.output === output.name) arrange.moveDrag(event);
        // Only a window on its own snaps: one that takes others along, or is about to join a stack, stays as it is put.
        const alone = links.together(carry.window).length === 1 || event.modifiers.includes("alt");
        const snaps =
          travelled(carry.press, event) >= dragThreshold && alone && arrange.dropTarget === null;
        arrange.endDrag(event);
        if (snaps) dropAtEdge(carry.window, event);
      },
    };
    return api;
  }, []);

  // A window floated out of its snap is picked up as soon as it shows at its own size.
  useLayoutEffect(() => {
    const carry = carried.current;
    if (carry?.unsnap !== "floated" || state.windows[carry.window]?.placement !== "floating")
      return;
    carry.unsnap = null;
    setHeld(null);
    arrange.startDrag(carry.window, carry.press);
    if (carry.last) arrange.moveDrag(carry.last);
  }, [frames, state.windows]);

  // A fanned frame is picked or dragged along the fan; in the overview a click on a window dives in to it.
  const fanVeil = useCallback(
    (reach: number): Veil => ({
      reach,
      press: (window, event) => latest.current!.fan.press(window, event),
      hover: (window, event) => latest.current!.fan.hover(window, event),
      release: () => latest.current!.fan.release(),
    }),
    [],
  );
  const overviewVeil = useMemo<Veil>(
    () => ({
      press: (window) => {
        latest.current!.warlock.activate(window);
        latest.current!.bringIntoView(window, { always: true });
      },
    }),
    [],
  );

  // What the keys and the modifier-drags do here.
  const handle = useMemo<CanvasHandle>(() => {
    const act = () => latest.current!.actions;
    return {
      toggleOverview: () => act().toggleOverview(),
      centerFocused: () => act().centerFocused(),
      flyHome: () => act().flyHome(),
      focusToward: (arrow) => act().focusToward(arrow),
      turnPage: (columns, rows) => act().turnPage(columns, rows),
      stackOrSpread: () => act().stackOrSpread(),
      fanStack: (step) => act().fanStack(step),
      press(event, what) {
        const { rootOf, frames, selection, frameAt } = latest.current!;
        const window = event.window ?? frameAt(event.worldX, event.worldY);
        if (window === null) {
          // On empty desktop Super-drag draws a selection box; a click clears the selection.
          if (what !== "select") return;
          selecting.current = true;
          selection.begin(event.worldX, event.worldY);
          return;
        }
        focus(window);
        if (what !== "resize") {
          controller.begin("move", window, event);
          return;
        }
        // The corner nearest the pointer is the one a right-drag pulls.
        const frame = frames.get(rootOf(window));
        if (!frame) return;
        const left = event.worldX < frame.x + frame.width / 2;
        const top = event.worldY < frame.y + frame.height / 2;
        controller.begin("resize", window, event, { left, right: !left, top, bottom: !top });
      },
      drag(event) {
        if (!selecting.current) controller.move(event);
        else if (event.output === latest.current!.output.name)
          latest.current!.selection.move(event.worldX, event.worldY);
      },
      release(event) {
        if (!selecting.current) controller.end(event);
        else {
          selecting.current = false;
          latest.current!.selection.end();
        }
      },
    };
  }, [controller]);
  const { registerCanvas } = warlock;
  useEffect(() => {
    registerCanvas(output.name, handle);
    return () => registerCanvas(output.name, null);
  }, [output.name, handle, registerCanvas]);

  const actions: CanvasActions = {
    toggleOverview() {
      if (overview) {
        setOverview(null);
        moveView(output, index, overview.back);
        return;
      }
      const everything = union(frames.values());
      if (!everything) return;
      const shown = fitting(output, toCanvas(everything, offset));
      setOverview({ shown, back: viewOf(output, index) });
      moveView(output, index, shown);
    },
    centerFocused() {
      const frame = focusedRoot === null ? undefined : frames.get(focusedRoot);
      if (!frame) return;
      setOverview(null);
      moveView(output, index, centredOn(output, toCanvas(frame, offset)));
    },
    flyHome() {
      setOverview(null);
      moveView(output, index, homeView);
    },
    focusToward(arrow) {
      const from = focusedRoot !== null && frames.has(focusedRoot) ? focusedRoot : null;
      const next = from === null ? order.at(-1) : neighbour(frames, from, directions[arrow]!);
      if (next !== undefined && next !== null) warlock.activate(next);
    },
    turnPage(columns, rows) {
      const [column, row] = pageInView(output, viewOf(output, index));
      setOverview(null);
      moveView(output, index, pageView(output, [column + columns, row + rows]));
    },
    stackOrSpread() {
      if (focusedRoot !== null && stacks.of(focusedRoot).length > 1) {
        // Side by side they may reach past the screen: the view takes them all in.
        const laid = union(spread(stacks.of(focusedRoot), frames).values());
        const count = placement.expand(focusedRoot);
        if (laid && !inside(shownWorkArea(output, viewOf(output, index)), toCanvas(laid, offset))) {
          setOverview(null);
          moveView(output, index, fitting(output, toCanvas(laid, offset)));
        }
        notify(`Spread out: ${count} windows.`, 4);
        return;
      }
      // Bottom to top as they are now, the focused one on top if it is selected.
      const ids = order.filter((id) => selection.has(id) && id !== focusedRoot);
      if (focusedRoot !== null && selection.has(focusedRoot)) ids.push(focusedRoot);
      if (ids.length < 2) {
        notify("Select windows to stack: Super-drag a box over the desktop.", 5);
        return;
      }
      placement.stack(ids);
      focus(ids.at(-1)!);
      selection.clear();
      notify(`Stacked ${ids.length} windows. Super+S spreads them out.`, 5);
    },
    fanStack(step) {
      if (fan.fan) {
        fan.step(step);
        return;
      }
      const ids = focusedRoot === null ? [] : stacks.of(focusedRoot);
      if (ids.length < 2) {
        notify("This window is in no stack: Super+S stacks the selected windows.", 5);
        return;
      }
      // Left to right from the front window; it starts on the next one.
      const turn = [...ids].reverse();
      fan.open(turn, step === 1 ? 1 : turn.length - 1, "keys");
    },
  };

  const focusedApp = focused === null ? undefined : windows.get(focused)?.appId;
  const nodes: ReactNode[] = [];
  /** Every frame drawn, bottom first: what a press bound with a modifier lands on. */
  const hits: { id: number; rect: Rectangle }[] = [];
  for (const id of drawn) {
    const entry = placed.get(id);
    const info = windows.get(id);
    const live = boxes.get(id);
    if (!entry || !info || !live) continue;
    const pose = poses?.get(id);
    const opening = portal?.kind === "open" && portal.window === id ? portal : null;
    const passage = passages.current.get(id);
    nodes.push(
      <WindowFrame
        key={id}
        id={id}
        rect={live}
        title={label(id)}
        // In a fan the window that would be picked wears the focus.
        focused={poses ? id === picked : focusedRoot === id && focused === id}
        active={focusedApp !== undefined && focusedApp !== "" && info.appId === focusedApp}
        maximized={entry.record.placement === "maximized"}
        resizable={entry.record.placement === "floating" && !pose}
        dialog={false}
        grabbed={arrange.grabbed === id || held === id || hand?.window === id}
        controller={controller}
        onScreen={onScreen}
        motion={motionOf(id)}
        tilt={pose && { angle: pose.angle, scale: pose.scale }}
        veil={pose ? fanVeil(pose.reach.height) : overview ? overviewVeil : undefined}
        arriving={passage?.kind === "arriving" ? passage.flight : undefined}
      >
        {opening && (
          <Portal
            key={opening.key}
            kind="open"
            rect={{ x: 0, y: 0, width: live.width, height: live.height }}
          />
        )}
      </WindowFrame>,
    );
    hits.push({ id, rect: live });
    if (pose) continue;
    for (const child of family(id).slice(1)) {
      const rect =
        hand?.window === child && hand.rect ? hand.rect : dialogRect(child, live, offsets);
      nodes.push(
        <WindowFrame
          key={child}
          id={child}
          rect={rect}
          title={label(child)}
          focused={focused === child}
          active={false}
          maximized={false}
          resizable={false}
          dialog
          grabbed={hand?.window === child}
          controller={controller}
          onScreen={onScreen}
          motion={hand?.window === child ? stillMotion : motionOf(id)}
        />,
      );
      hits.push({ id: child, rect });
    }
  }
  // A minimized window's frame shows a moment longer, on its way to its taskbar button.
  for (const [id, passage] of leaving) {
    nodes.push(
      <WindowFrame
        key={id}
        id={id}
        rect={passage.rect}
        title={label(id)}
        focused={false}
        active={false}
        maximized={state.windows[id]?.placement === "maximized"}
        resizable={false}
        dialog={false}
        grabbed={false}
        controller={controller}
        onScreen={onScreen}
        motion={stillMotion}
        away={passage.flight}
      />,
    );
  }

  /** The topmost frame at the point (X, Y) of the world. */
  const frameAt = (x: number, y: number): number | null => {
    for (let at = hits.length - 1; at >= 0; at--) {
      const { id, rect } = hits[at]!;
      if (x >= rect.x && y >= rect.y && x <= rect.x + rect.width && y <= rect.y + rect.height)
        return id;
    }
    return null;
  };

  latest.current = {
    output,
    index,
    warlock,
    placed,
    frames,
    state,
    windows,
    theme,
    offsets,
    rootOf,
    dispatch,
    links,
    arrange,
    selection,
    fan,
    actions,
    dialogRect,
    frameAt,
    bringIntoView,
  };

  const closing = portal?.kind === "close" && portal.output === output.name ? portal : null;
  // A fanned stack shows no pill.
  const withPills = poses ? stacks.all.filter((ids) => !poses.has(ids[0]!)) : stacks.all;

  return (
    <>
      <Camera
        output={output.name}
        minZoom={zoomRange.min}
        maxZoom={zoomRange.max}
        transition={animated ? cameraMotion : instant}
      />
      <CameraWatcher output={output.name} feed={feed} />
      {nodes}
      <Marks
        feed={feed}
        places={boxes}
        selected={selection.ids}
        box={selection.box}
        stacks={withPills}
        dropTarget={arrange.dropTarget}
        dropping={arrange.dropping}
        leaving={arrange.leaving}
        guides={arrange.guides}
        motionOf={markMotion}
        animated={animated}
        onPickUpStack={arrange.startDrag}
        onOpenStack={(top) => fan.open([...stacks.of(top)].reverse(), 0, "pill")}
        onCarry={arrange.moveDrag}
        onLetGo={arrange.endDrag}
      />
      {closing && <Portal key={closing.key} kind="close" rect={toWorld(closing.rect, offset)} />}
      {/* A fan is a passing arrangement: the map keeps to where the windows are. */}
      <Minimap
        output={output}
        index={index}
        feed={feed}
        places={poses ? arrange.shown : boxes}
        focused={focusedRoot}
        animated={animated}
      />
    </>
  );
}

/** What this canvas's handlers read when they run: the latest render's. */
interface Latest extends Pick<
  WarlockContextValue,
  "placed" | "state" | "windows" | "rootOf" | "dispatch"
> {
  output: OutputInfo;
  index: number;
  warlock: WarlockContextValue;
  frames: ReadonlyMap<number, Rectangle>;
  theme: WarlockTheme;
  offsets: ReadonlyMap<number, Point>;
  links: Links;
  arrange: ReturnType<typeof useArrange>;
  selection: Selection;
  fan: ReturnType<typeof useFan>;
  actions: CanvasActions;
  dialogRect: (id: number, parent: Rectangle, moved: ReadonlyMap<number, Point>) => Rectangle;
  frameAt: (x: number, y: number) => number | null;
  bringIntoView: (window: number, options?: { always?: boolean; immediately?: boolean }) => void;
}

/**
 * NEXT, or the map given before if every rectangle is as it was: frames that
 * have not moved keep their identity, so what is drawn from them keeps still.
 */
function useStableRects(next: Map<number, Rectangle>): ReadonlyMap<number, Rectangle> {
  const kept = useRef<ReadonlyMap<number, Rectangle>>(next);
  const before = kept.current;
  if (before === next) return next;
  let same = before.size === next.size;
  for (const [id, rect] of next) {
    const was = before.get(id);
    if (
      was &&
      was.x === rect.x &&
      was.y === rect.y &&
      was.width === rect.width &&
      was.height === rect.height
    )
      next.set(id, was);
    else same = false;
  }
  if (!same) kept.current = next;
  return kept.current;
}

/**
 * ORDER, bottom first, with every stack drawn together where its topmost
 * window was: in the stack's own order, the focused window over the rest of it.
 */
function drawOrder(
  order: readonly number[],
  stacks: readonly (readonly number[])[],
  focused: number | null,
): number[] {
  if (stacks.length === 0) return [...order];
  const top = new Map<readonly number[], number>();
  order.forEach((id, at) => {
    const pile = stackOf(stacks, id);
    if (pile) top.set(pile, at);
  });
  const out: number[] = [];
  order.forEach((id, at) => {
    const pile = stackOf(stacks, id);
    if (!pile) out.push(id);
    else if (top.get(pile) === at) {
      out.push(...pile.filter((member) => member !== focused && order.includes(member)));
      if (focused !== null && pile.includes(focused)) out.push(focused);
    }
  });
  return out;
}

const markTransitions = new Map<FrameMotion, Transition>();

/** How a mark on a frame moving by MOTION moves with it. */
function markTransition(motion: FrameMotion): Transition {
  const made = (): Transition => ({
    default: instant,
    x: motion.x,
    y: motion.y,
    width: motion.size,
    height: motion.size,
  });
  if (motion !== stillMotion && motion !== glideMotion && motion !== heldMotion) return made();
  let known = markTransitions.get(motion);
  if (!known) markTransitions.set(motion, (known = made()));
  return known;
}

/**
 * Where WINDOW's taskbar button is, along the bar: the bar is not this
 * module's, so its buttons are reckoned from their order and their labels (104
 * to 200 pixels wide from 10, 4 apart). Null for a window with no button.
 */
function buttonSpot(
  groups: readonly TaskbarGroup[],
  window: number,
  textScale: number,
): { x: number; width: number } | null {
  let x = 10;
  for (const group of groups) {
    const width = Math.min(200, Math.max(104, 32 + 7.6 * textScale * group.label.length));
    if (group.windows.includes(window)) return { x: x + width / 2, width };
    x += width + 4;
  }
  return null;
}
