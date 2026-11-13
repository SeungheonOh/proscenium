/**
 * Rooms on the canvas: windows picked out with a Super+drag box and handed to
 * another world's window management, a Hyprland-style tiler or niri's strip of
 * scrolling columns, as the metaworld's rooms are (meta/worlds.ts). A room is
 * the size of the screen, so entered it fills the screen pixel for pixel. Its
 * world lays its windows out, writing their places on the canvas, so the rest of
 * the canvas (the minimap, the selection, focus by arrows) sees them where they
 * show; the room moves as one.
 */

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import {
  focus,
  instant,
  getCamera,
  moveCamera,
  spring,
  useCompositorInstance,
  useFocusedWindow,
  usePersistentState,
  useWindows,
  type CameraInfo,
  type OutputInfo,
  type Rectangle,
  type Transition,
  type WindowInfo,
} from "proscenium";
import { boxAt, neighbour, union, type Direction } from "../lib/geometry.js";
import { clearSpot, roomCamera, roomRect, roomSize, type Size } from "../meta/geometry.js";
import {
  emptyWorld,
  roomOutput,
  roomInfo,
  reduceWorld,
  syncWorld,
  worldBoxes,
  worldFocus,
  type RoomEnv,
  type World,
  type WorldAction,
} from "../meta/worlds.js";
import type { GestureHost } from "../niri/interaction.js";
import { windowMotion } from "../components/TilingWindow.js";
import { LiveMap, type Driven } from "../niri/live.js";
import { dropTarget, floaterBox, hintBox, placeTiles, type Workspace } from "../niri/model.js";
import { focusedWindow, type NiriAction } from "../niri/state.js";
import type { WindowEnv } from "../niri/model.js";
import { stripSlide } from "./RoomStrip.js";
import { hyprRoomBoxes, noSplits, resizedSplits, type Splits } from "./hyprRoomLayout.js";
import type { PlaceWindows } from "./usePlaces.js";

/** The worlds a room on the canvas can run. */
export const roomKinds = ["hypr", "niri"] as const;
export type RoomKind = (typeof roomKinds)[number];

export const kindNames: Record<RoomKind, string> = { hypr: "Hyprland", niri: "niri" };

export interface CanvasRoom {
  id: number;
  /** Top-left corner on the canvas. */
  x: number;
  y: number;
  /** Its windows, in the order they joined. */
  members: number[];
  world: World;
  /** A hypr room's splits, as resizes left them. */
  splits?: Splits;
}

interface Saved {
  /** The compositor instance the window ids belong to. */
  instance: string | null;
  rooms: CanvasRoom[];
  nextId: number;
  /** The room the camera is in, and the camera to go back to on leaving. */
  entered: number | null;
  before: CameraInfo | null;
}

const empty: Saved = { instance: null, rooms: [], nextId: 1, entered: null, before: null };

/**
 * What is in hand: a whole room, moved by its header, or one window of a room,
 * which follows the pointer until it is let go somewhere in its room's layout,
 * in another room, or out on the canvas. FROM is where the pointer took it, AT
 * where it is now, ORIGIN where the room or the window was.
 */
type RoomDrag =
  | { kind: "room"; room: number; from: Point; origin: Point }
  | { kind: "window"; room: number; window: number; from: Point; at: Point; origin: Rectangle };

interface Point {
  x: number;
  y: number;
}

/**
 * Space between a niri room's stacked workspaces, as a share of the room's height: tighter than niri's
 * own tenth, as on the canvas the whole stack is in view at once.
 */
const roomWorkspaceGap = 0.02;

/** Into a room and back out: as niri's springs are, critically damped, so it lands without overshooting. */
const roomCameraMotion = spring({ duration: 0.45, bounce: 0 });

/** A drag shorter than this, in canvas pixels, is a click. */
const clickDistance = 6;

/** A niri room's strip: where its group is, and each tiled window's box in it. */
export interface Strip {
  room: CanvasRoom;
  x: number;
  y: number;
  /** The shown workspace's view, its index in the stack and its id: what a swipe drives away from. */
  view: number;
  active: number;
  workspace: number;
  /** Its workspaces spread out, as in the room the camera is in. */
  spread: boolean;
  windows: ReadonlyMap<number, Rectangle>;
}

export interface Rooms {
  rooms: readonly CanvasRoom[];
  size: Size;
  entered: number | null;
  /** niri rooms' strips: each one's tiled windows, in one group that scrolls and switches workspaces as one. */
  strips: readonly Strip[];
  stripOf: (room: CanvasRoom) => Strip | undefined;
  /** What swipes drive: niri views by workspace id, and the stack of the room the camera is in. */
  views: LiveMap<Driven>;
  stacks: LiveMap<Driven>;
  /** How far apart a niri room's stacked workspaces are. */
  step: number;
  /** The room being moved by its header, if any. */
  dragging: number | null;
  /** Where the window in hand would go in its layout if let go now, on the canvas. */
  hint: (Rectangle & { niri: boolean }) | null;

  /** The window in hand, lifted. */
  held: number | null;
  /** The space between a niri room's stacked workspaces, on the canvas. */
  spacing: number;
  /**
   * How much of window ID shows: in a niri room, the columns scrolled out of the
   * room are faint, as niri doesn't show them, and the workspaces above and below dimmer.
   */
  opacityOf: (window: number) => number;
  /** Where ROOM's spaces are on the canvas: niri's workspaces, stacked up and down from the room, the shown one first. */
  slotsOf: (room: CanvasRoom) => { rect: Rectangle; shown: boolean; moving: boolean }[];
  roomOf: (window: number) => CanvasRoom | undefined;
  rectOf: (room: CanvasRoom) => Rectangle;
  /** WINDOWS, at BOUNDS on the canvas, into a new room of KIND, which the camera goes into. */
  create: (kind: RoomKind, windows: readonly number[], bounds: Rectangle) => void;
  /** The room's windows to KIND's world, laid out afresh. */
  switchKind: (room: number, kind: RoomKind) => void;
  /** The room gone; its windows stay where they are, free on the canvas again. */
  ungroup: (room: number) => void;
  enter: (room: number) => void;
  leave: () => void;
  /** ACTION in the room's world; the window it focuses after, for niri, which keeps its own focus. */
  act: (room: number, action: WorldAction) => number | null;
  /** How window ID moves to its place, when its room decides: carried with the room, or following fingers. */
  motionOf: (window: number) => Transition | undefined;
  /** What niri's touchpad gestures read and change, for the niri room the camera is in. */
  gestureHost: () => GestureHost | null;
  /** The room nearest the one the camera is in, toward DIRECTION. */
  roomToward: (direction: Direction) => number | null;
  /**
   * WINDOW resized to BOX, on the canvas, by its edges: its room's world sizes it, as that world's own
   * resize would. False when it is in no room.
   */
  resize: (window: number, box: Rectangle) => boolean;
  /** Pick up WINDOW, at canvas point (X, Y), to move it in its room or out of it: false when it is in none. */
  grabWindow: (window: number, x: number, y: number) => boolean;
  /** Pick up ROOM by its header, at canvas point (X, Y), to move it whole. */
  grabRoom: (room: number, x: number, y: number) => void;
  /** What is in hand to canvas point (X, Y): false when nothing is. */
  carry: (x: number, y: number) => boolean;
  /** Let go at canvas point (X, Y): false when nothing was in hand. */
  letGo: (x: number, y: number) => boolean;
}

function windowEnv(window: WindowInfo): WindowEnv {
  return {
    width: window.width,
    height: window.height,
    minWidth: window.minWidth,
    minHeight: window.minHeight,
    maxWidth: window.maxWidth,
    maxHeight: window.maxHeight,
    parent: window.parent,
    appId: window.appId,
    title: window.title,
  };
}

function same(a: Rectangle | undefined, b: Rectangle): boolean {
  return !!a && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
}

export function useRooms(
  places: ReadonlyMap<number, Rectangle>,
  placeWindows: PlaceWindows,
  output: OutputInfo | undefined,
): Rooms {
  const list = useWindows();
  // Before the compositor says which instance it is, rooms are laid out as for none.
  const instance = useCompositorInstance() ?? "";
  const [stored, setSaved] = usePersistentState<Saved>("canvas.rooms", empty);
  // Window ids start over with the compositor: rooms kept for the old ones hold nothing now.
  const saved = stored.instance === instance ? stored : empty;
  const [drag, setDrag] = useState<RoomDrag | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;

  const size = useMemo(() => roomSize(output), [output?.width, output?.height]);
  const area = useMemo(() => output?.workArea ?? { x: 0, y: 0, ...size }, [size, output?.workArea]);
  // Rooms are laid out by size limits only: anything else about a window changing must not lay them out again.
  const limitsKey = list
    .map((w) => [w.id, w.minWidth, w.minHeight, w.maxWidth, w.maxHeight, w.parent].join(":"))
    .join();
  const room = roomInfo(size, area);
  const current: RoomEnv = {
    room,
    outputs: [room],
    windows: Object.fromEntries(list.map((window) => [window.id, windowEnv(window)])),
  };
  const envRef = useRef(current);
  envRef.current = current;
  const env = useMemo(() => current, [limitsKey, size, area]);
  const present = useMemo(() => new Set(list.map((window) => window.id)), [list.map((w) => w.id).join()]);

  // Changes go through the latest saved state, so several in one event all land.
  const latest = useRef(saved);
  latest.current = saved;
  const update = (change: (state: Saved) => Saved) => {
    const next = change(latest.current);
    latest.current = next;
    setSaved({ ...next, instance });
  };

  const rectOf = (r: CanvasRoom) => roomRect(r, size);

  // Members that closed leave their room, and an empty room goes; while a room is entered, new windows open in it.
  const seen = useRef<ReadonlySet<number> | null>(null);
  const keepInStep = useEffectEvent(() => {
    const before = seen.current;
    seen.current = present;
    const opened = before ? [...present].filter((id) => !before.has(id)) : [];
    const state = latest.current;
    const gone = state.rooms.some((r) => r.members.some((id) => !present.has(id)));
    const host = state.entered !== null ? state.rooms.find((r) => r.id === state.entered) : undefined;
    const joining = host ? opened.filter((id) => !state.rooms.some((r) => r.members.includes(id))) : [];
    if (!gone && joining.length === 0) return;
    update((s) => {
      const rooms = s.rooms
        .map((r) => {
          const members = [...r.members.filter((id) => present.has(id)), ...(r.id === host?.id ? joining : [])];
          return members.length === r.members.length && members.every((id, i) => id === r.members[i])
            ? r
            : { ...r, members, world: syncWorld(r.world, members, instance, envRef.current) };
        })
        .filter((r) => r.members.length > 0);
      const entered = rooms.some((r) => r.id === s.entered) ? s.entered : null;
      return { ...s, rooms, entered };
    });
    if (joining.length) focus(joining.at(-1)!);
  });
  useEffect(() => keepInStep(), [present]);

  // A three-finger swipe in a niri room drives its view live, sideways, and its stack of workspaces, up and down, as niri's own do.
  // Only the strips that show them subscribe (RoomStrip.tsx), so a swipe moves one group, not the whole canvas.
  const [views] = useState(() => new LiveMap<Driven>());
  const [stacks] = useState(() => new LiveMap<Driven>());
  /** How far apart a niri room's workspaces are stacked: a room's height and niri's gap between workspaces. */
  const step = size.height * (1 + roomWorkspaceGap);

  /** Each of niri ROOM's workspaces with how far down from the room it is now, live under a swipe. */
  //
  // Only the room the camera is in spreads its workspaces out: from outside, a niri room is one workspace,
  // the shown one, as big as any room, the others folded away behind it unseen.
  const workspacesOf = (r: CanvasRoom): { workspace: Workspace; offset: number; shown: boolean }[] => {
    if (r.world.kind !== "niri") return [];
    const monitor = r.world.state.monitors[roomOutput];
    if (!monitor) return [];
    const spread = r.id === saved.entered;
    const at = monitor.active;
    return monitor.workspaces.map((workspace, index) => ({
      workspace,
      offset: spread ? (index - at) * step : 0,
      shown: index === monitor.active,
    }));
  };

  /** The windows of niri ROOM's shown workspace; null for any other room, all of whose windows show. */
  const shownWindows = (r: CanvasRoom): ReadonlySet<number> | null => {
    if (r.world.kind !== "niri") return null;
    const monitor = r.world.state.monitors[roomOutput];
    const shown = monitor?.workspaces[monitor.active];
    if (!shown) return null;
    return new Set([...shown.columns.flatMap((column) => column.tiles.map((tile) => tile.window)),
                    ...shown.floating.map((floater) => floater.window)]);
  };

  // Each room's world places its windows on the canvas, at the room; niri's every workspace, stacked.
  const target = useMemo(() => {
    const all = new Map<number, Rectangle>();
    for (const r of saved.rooms) {
      const members = new Set(r.members.filter((id) => present.has(id)));
      if (r.world.kind === "niri") {
        for (const { workspace, offset } of workspacesOf(r)) {
          const view = workspace.view;
          for (const tile of placeTiles(workspace, env.room, env)) {
            if (tile.hidden || !members.has(tile.window)) continue;
            all.set(tile.window, { x: Math.round(r.x + tile.x - view), y: Math.round(r.y + tile.y + offset),
                                   width: tile.width, height: tile.height });
          }
          for (const floater of workspace.floating) {
            if (!members.has(floater.window)) continue;
            const box = floaterBox(floater, env);
            all.set(floater.window, { ...box, x: r.x + box.x, y: Math.round(r.y + box.y + offset) });
          }
        }
        continue;
      }
      const boxes = r.world.kind === "hypr"
        ? hyprRoomBoxes(r.world.state, area, members, r.splits ?? noSplits)
        : worldBoxes(r.world, env, members, area);
      for (const [window, box] of boxes) {
        if (members.has(window)) all.set(window, { ...box, x: r.x + box.x, y: r.y + box.y });
      }
    }
    // The window in hand follows the pointer; the rest keep their places until it is let go.
    if (drag?.kind === "window" && all.has(drag.window)) {
      all.set(drag.window, { ...drag.origin, x: Math.round(drag.origin.x + drag.at.x - drag.from.x),
                             y: Math.round(drag.origin.y + drag.at.y - drag.from.y) });
    }
    return all;
  }, [saved.rooms, saved.entered, env, present, area, drag]);

  /**
   * niri ROOM's strip: its tiled windows in one group at the room, less the shown workspace's view and,
   * spread out, the shown workspace's place in the stack, so scrolling the view or switching workspaces
   * moves the group alone, on niri's springs, and a swipe drives it live (RoomStrip.tsx). Floating
   * windows stay out of it, as they stay put on niri's output.
   */
  function stripOf(r: CanvasRoom): Strip | undefined {
    if (r.world.kind !== "niri") return undefined;
    const monitor = r.world.state.monitors[roomOutput];
    const shown = monitor?.workspaces[monitor.active];
    if (!monitor || !shown) return undefined;
    const spread = r.id === saved.entered;
    const x = r.x - shown.view;
    const y = r.y - (spread ? monitor.active * step : 0);
    const floating = new Set(monitor.workspaces.flatMap((w) => w.floating.map((f) => f.window)));
    const windows = new Map<number, Rectangle>();
    for (const id of r.members) {
      const box = target.get(id);
      if (box && !floating.has(id)) windows.set(id, { ...box, x: box.x - x, y: box.y - y });
    }
    return { room: r, x, y, view: shown.view, active: monitor.active, workspace: shown.id, spread, windows };
  }
  const strips = useMemo(() => saved.rooms.flatMap((r) => stripOf(r) ?? []), [saved.rooms, saved.entered, target]);

  // Workspaces a switch left empty go once it has played, as niri's do; one empty one stays at the bottom.
  const shownKey = saved.rooms
    .map((r) => {
      if (r.world.kind !== "niri") return "";
      const monitor = r.world.state.monitors[roomOutput];
      return `${r.id}:${monitor?.workspaces[monitor.active]?.id}:${monitor?.workspaces.length}`;
    })
    .join();
  const cleanUp = useEffectEvent(() => {
    for (const r of latest.current.rooms) {
      if (r.world.kind === "niri") act(r.id, { kind: "niri", action: { type: "cleanWorkspaces", output: roomOutput } });
    }
  });
  useEffect(() => {
    const timer = setTimeout(cleanUp, 400);
    return () => clearTimeout(timer);
  }, [shownKey]);

  /** Where ROOM's spaces are: niri's workspaces stacked, the shown one first; any other room is just itself. */
  function slotsOf(r: CanvasRoom) {
    const rect = roomRect(r, size);
    if (r.world.kind !== "niri") return [{ rect, shown: true, moving: false, workspace: null as number | null, offset: 0 }];
    const moving = false;
    return workspacesOf(r)
      // Folded, only the shown one is a space of its own.
      .filter(({ shown }) => shown || r.id === latest.current.entered)
      .map(({ workspace, offset, shown }) => ({ rect: { ...rect, y: Math.round(rect.y + offset) }, shown, moving,
                                                workspace: workspace.id as number | null, offset }))
      .sort((a, b) => Number(b.shown) - Number(a.shown));
  }

  const inside = (rect: Rectangle, x: number, y: number) =>
    x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;

  /** The room under canvas point (X, Y), the topmost, and the space of it there. */
  const roomAtPoint = (x: number, y: number) => {
    for (const r of [...latest.current.rooms].reverse()) {
      const space = slotsOf(r).find((candidate) => inside(candidate.rect, x, y));
      if (space) return { room: r, space };
    }
    return null;
  };

  /** Where WINDOW goes in ROOM's layout let go at canvas point (X, Y), as an action, and the hint for it. */
  function slot(r: CanvasRoom, window: number, x: number, y: number): { actions: WorldAction[]; hint: Rectangle | null } {
    const local = { x: x - r.x, y: y - r.y };
    if (r.world.kind === "hypr") {
      // A floating window floats where it is let go; a tiled one swaps with the tile under the pointer.
      const box = target.get(window);
      if (r.world.state.floating[window] && box) {
        return { actions: [{ kind: "hypr", action: { type: "float", window, box: { ...box, x: box.x - r.x, y: box.y - r.y } } }], hint: null };
      }
      const tiles = new Map(r.members.filter((id) => id !== window && !(r.world.kind === "hypr" && r.world.state.floating[id]))
        .flatMap((id) => (target.has(id) ? [[id, target.get(id)!] as const] : [])));
      const other = boxAt(tiles, x, y, window);
      return other === null ? { actions: [], hint: null }
        : { actions: [{ kind: "hypr", action: { type: "swap", first: window, second: other } }], hint: tiles.get(other)! };
    }
    if (r.world.kind !== "niri") return { actions: [], hint: null };
    // niri: the gap nearest the pointer, between columns or the tiles of one, as niri's own drag picks.
    const env = envRef.current;
    const monitor = r.world.state.monitors[roomOutput];
    const shown = monitor?.workspaces[monitor.active];
    if (shown?.floating.some((floater) => floater.window === window)) {
      const box = target.get(window);
      return box ? { actions: [{ kind: "niri", action: { type: "placeFloating", window, x: box.x - r.x, y: box.y - r.y } }], hint: null }
        : { actions: [], hint: null };
    }
    // Into the workspace under the pointer, above or below the shown one too.
    const space = slotsOf(r).find((candidate) => inside(candidate.rect, x, y)) ?? slotsOf(r)[0]!;
    const held = reduceWorld(r.world, { kind: "niri", action: { type: "lift", window } }, env);
    if (held.kind !== "niri") return { actions: [], hint: null };
    const heldMonitor = held.state.monitors[roomOutput];
    const workspace = heldMonitor?.workspaces.find((candidate) => candidate.id === space.workspace)
      ?? heldMonitor?.workspaces[heldMonitor.active];
    if (!workspace) return { actions: [], hint: null };
    const at = dropTarget(workspace, env.room, env, local.x, local.y - space.offset);
    const hint = hintBox(workspace, env.room, env, at);
    return {
      actions: [
        { kind: "niri", action: { type: "lift", window } },
        { kind: "niri", action: { type: "drop", output: roomOutput, workspace: workspace.id, target: at } },
      ],
      hint: { ...hint, x: r.x + hint.x - workspace.view, y: Math.round(r.y + hint.y + space.offset) },
    };
  }

  // Where the window in hand would go: lit while it is over a room.
  const hint = useMemo(() => {
    if (drag?.kind !== "window") return null;
    const under = roomAtPoint(drag.at.x, drag.at.y);
    if (!under) return null;
    const niri = under.room.world.kind === "niri";
    if (under.room.id === drag.room) {
      const rect = slot(under.room, drag.window, drag.at.x, drag.at.y).hint;
      return rect && { ...rect, niri };
    }
    // Another room takes it in: the space it would join lights up.
    return { ...under.space.rect, niri };
  }, [drag, target]);
  const layOut = useEffectEvent(() => {
    const changes = new Map<number, Rectangle>();
    for (const [window, box] of target) if (places.has(window) && !same(places.get(window), box)) changes.set(window, box);
    if (changes.size) placeWindows(changes);
  });
  useEffect(() => layOut(), [target, places]);

  // A niri room's focus follows a window clicked in it, so its keys go on from there.
  const focusedId = useFocusedWindow();
  const followFocus = useEffectEvent((window: number) => {
    const r = latest.current.rooms.find((candidate) => candidate.members.includes(window));
    if (!r || r.world.kind !== "niri" || focusedWindow(r.world.state) === window) return;
    act(r.id, { kind: "niri", action: { type: "activate", window } });
  });
  useEffect(() => {
    if (focusedId !== null) followFocus(focusedId);
  }, [focusedId]);

  function enter(id: number) {
    const r = latest.current.rooms.find((candidate) => candidate.id === id);
    if (!r || !output) return;
    const before = latest.current.entered === null ? getCamera(output.name) ?? null : latest.current.before;
    update((s) => ({ ...s, entered: id, before }));
    moveCamera(roomCamera(roomRect(r, size), output), { transition: roomCameraMotion });
    const next = worldFocus(r.world, r.members, envRef.current);
    if (next !== null) focus(next);
  }

  function leave() {
    const { entered, before } = latest.current;
    if (entered === null) return;
    update((s) => ({ ...s, entered: null, before: null }));
    if (before) moveCamera(before, { transition: roomCameraMotion });
  }

  function act(id: number, action: WorldAction): number | null {
    const r = latest.current.rooms.find((candidate) => candidate.id === id);
    if (!r) return null;
    const world = reduceWorld(r.world, action, envRef.current);
    update((s) => ({ ...s, rooms: s.rooms.map((c) => (c.id === id ? { ...c, world } : c)) }));
    return world.kind === "niri" ? focusedWindow(world.state) : null;
  }

  const roomOf = (window: number) => saved.rooms.find((r) => r.members.includes(window));

  /**
   * The window in hand let go at (X, Y): in its own room, it takes the place it was over;
   * in another, it joins that one there; out on the canvas, it leaves its room and stays where it is.
   */
  function dropWindow(d: Extract<RoomDrag, { kind: "window" }>, x: number, y: number) {
    const { window } = d;
    const dest = roomAtPoint(x, y)?.room;
    if (dest?.id === d.room) {
      for (const action of slot(dest, window, x, y).actions) act(dest.id, action);
      return;
    }
    const box = { ...d.origin, x: Math.round(d.origin.x + x - d.from.x), y: Math.round(d.origin.y + y - d.from.y) };
    update((s) => {
      const rooms = s.rooms
        .map((r) => {
          if (r.id === d.room) {
            const members = r.members.filter((id) => id !== window);
            return { ...r, members, world: syncWorld(r.world, members, instance, envRef.current) };
          }
          if (r.id === dest?.id) {
            const members = [...r.members, window];
            return { ...r, members, world: syncWorld(r.world, members, instance, envRef.current) };
          }
          return r;
        })
        .filter((r) => r.members.length > 0);
      return { ...s, rooms, entered: rooms.some((r) => r.id === s.entered) ? s.entered : null };
    });
    if (dest) {
      // In its new room, it goes where it was let go, as it would within its own.
      const joined = latest.current.rooms.find((r) => r.id === dest.id);
      if (joined) for (const action of slot(joined, window, x, y).actions) act(joined.id, action);
      return;
    }
    placeWindows(new Map([[window, box]]));
  }

  return {
    rooms: saved.rooms,
    strips,
    stripOf: (r) => strips.find((strip) => strip.room.id === r.id),
    views,
    stacks,
    step,
    size,
    entered: saved.entered,
    dragging: drag?.kind === "room" ? drag.room : null,
    hint,
    held: drag?.kind === "window" ? drag.window : null,
    spacing: step - size.height,
    opacityOf(window) {
      const r = roomOf(window);
      const box = target.get(window);
      if (!r || !box || r.world.kind !== "niri") return 1;
      if (drag?.kind === "window" && drag.window === window) return 1;
      // On a workspace above or below: dimmer while they are spread out, unseen while folded behind the shown one.
      const onShown = shownWindows(r)?.has(window) ?? true;
      if (!onShown) return r.id === saved.entered ? 0.6 : 0;
      // What scrolls out of the room sideways is cut off at its edges (RoomStrip.tsx), as on niri: nothing fades.
      return 1;
    },
    slotsOf: (r) => slotsOf(r).map(({ rect, shown, moving }) => ({ rect, shown, moving })),
    roomOf,
    rectOf,
    create(kind, windows, bounds) {
      if (windows.length === 0) return;
      // Left to right, then top to bottom, as they lay: hypr tiles and niri columns keep that order.
      const order = [...windows].sort((a, b) => {
        const pa = places.get(a);
        const pb = places.get(b);
        return (pa?.x ?? 0) - (pb?.x ?? 0) || (pa?.y ?? 0) - (pb?.y ?? 0);
      });
      const id = latest.current.nextId;
      const others = latest.current.rooms
        .map((r) => {
          const members = r.members.filter((m) => !windows.includes(m));
          return members.length === r.members.length ? r : { ...r, members, world: syncWorld(r.world, members, instance, envRef.current) };
        })
        .filter((r) => r.members.length > 0);
      // Centred on the windows it takes, clear of the other rooms.
      const spot = clearSpot(
        others,
        { id, x: Math.round(bounds.x + bounds.width / 2 - size.width / 2), y: Math.round(bounds.y + bounds.height / 2 - size.height / 2) },
        size,
      );
      const world = syncWorld(emptyWorld(kind), order, instance, envRef.current);
      update((s) => ({ ...s, rooms: [...others, { id, x: spot.x, y: spot.y, members: order, world }], nextId: id + 1 }));
      enter(id);
    },
    switchKind(id, kind) {
      update((s) => ({
        ...s,
        rooms: s.rooms.map((r) =>
          r.id === id ? { ...r, world: syncWorld(emptyWorld(kind), r.members, instance, envRef.current) } : r,
        ),
      }));
    },
    ungroup(id) {
      if (latest.current.entered === id) leave();
      update((s) => ({ ...s, rooms: s.rooms.filter((r) => r.id !== id) }));
    },
    enter,
    leave,
    act,
    motionOf(window) {
      const r = roomOf(window);
      if (!r) return undefined;
      if (drag?.kind === "room" && drag.room === r.id) return instant;
      if (drag?.kind === "window" && drag.window === window) return { default: windowMotion, x: instant, y: instant };
      if (r.world.kind !== "niri") return windowMotion;
      // In its strip, a window moves on its own only as the layout changes, as briskly as the strip; scrolling moves the strip.
      return stripSlide;
    },
    gestureHost() {
      const r = latest.current.rooms.find((candidate) => candidate.id === latest.current.entered);
      if (!r || r.world.kind !== "niri") return null;
      return {
        state: r.world.state,
        envRef,
        // A swipe that settles on another column gives it the keyboard, as niri does.
        act: (action: NiriAction) => {
          const next = act(r.id, { kind: "niri", action });
          if (next !== null) focus(next);
        },
        overview: false,
        views,
        stacks,
      };
    },
    roomToward(direction) {
      const { entered, rooms } = latest.current;
      if (entered === null) return null;
      return neighbour(new Map(rooms.map((r) => [r.id, roomRect(r, size)])), entered, direction);
    },
    resize(window, box) {
      const r = roomOf(window);
      const now = target.get(window);
      if (!r || !now) return false;
      const width = Math.round(box.width);
      const height = Math.round(box.height);
      if (r.world.kind === "niri") {
        // niri's: the column's width, and the tile's share of the column's height.
        const floating = r.world.state.monitors[roomOutput]?.workspaces.some((w) => w.floating.some((f) => f.window === window));
        if (floating) {
          act(r.id, { kind: "niri", action: { type: "placeFloating", window, x: box.x - r.x, y: box.y - r.y, width, height } });
          return true;
        }
        if (width !== now.width) act(r.id, { kind: "niri", action: { type: "resizeColumn", window, width } });
        if (height !== now.height) act(r.id, { kind: "niri", action: { type: "resizeTile", window, height } });
        return true;
      }
      if (r.world.kind !== "hypr") return true;
      // A floating window takes the box; a tile moves the split it borders.
      if (r.world.state.floating[window]) {
        act(r.id, { kind: "hypr", action: { type: "float", window, box: { x: box.x - r.x, y: box.y - r.y, width, height } } });
        return true;
      }
      const members = new Set(r.members.filter((id) => present.has(id)));
      const splits = resizedSplits(r.world.state, area, members, r.splits ?? noSplits, window, { width, height });
      if (splits !== (r.splits ?? noSplits)) {
        update((s) => ({ ...s, rooms: s.rooms.map((c) => (c.id === r.id ? { ...c, splits } : c)) }));
      }
      return true;
    },
    grabWindow(window, x, y) {
      const r = roomOf(window);
      const origin = target.get(window);
      if (!r || !origin) return false;
      const started: RoomDrag = { kind: "window", room: r.id, window, from: { x, y }, at: { x, y }, origin };
      dragRef.current = started;
      setDrag(started);
      // In hand, it is above the rest.
      focus(window);
      return true;
    },
    grabRoom(room, x, y) {
      const r = latest.current.rooms.find((candidate) => candidate.id === room);
      if (!r) return;
      const started: RoomDrag = { kind: "room", room, from: { x, y }, origin: { x: r.x, y: r.y } };
      dragRef.current = started;
      setDrag(started);
    },
    carry(x, y) {
      const now = dragRef.current;
      if (!now) return false;
      if (now.kind === "window") {
        dragRef.current = { ...now, at: { x, y } };
        setDrag(dragRef.current);
        return true;
      }
      const nx = Math.round(now.origin.x + x - now.from.x);
      const ny = Math.round(now.origin.y + y - now.from.y);
      update((s) => ({ ...s, rooms: s.rooms.map((r) => (r.id === now.room ? { ...r, x: nx, y: ny } : r)) }));
      return true;
    },
    letGo(x, y) {
      const now = dragRef.current;
      if (!now) return false;
      dragRef.current = null;
      if (now.kind === "window" && Math.hypot(x - now.from.x, y - now.from.y) >= clickDistance) dropWindow(now, x, y);
      setDrag(null);
      return true;
    },
  };
}

/** The bounds of WINDOWS where they are now, or null. */
export function boundsOf(windows: Iterable<number>, places: ReadonlyMap<number, Rectangle>): Rectangle | null {
  return union([...windows].flatMap((id) => places.get(id) ?? []));
}
