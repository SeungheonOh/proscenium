import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  focus,
  getCamera,
  useCompositorInstance,
  useFocusedWindow,
  useOutputs,
  usePersistentReducer,
  useWindows,
  type OutputInfo,
  type Rectangle,
  type WindowInfo,
} from "proscenium";
import { cardOf } from "../deck/DeckProvider.js";
import { deckTable } from "../deck/layout.js";
import type { Direction } from "../lib/geometry.js";
import type { WindowEnv } from "../niri/model.js";
import { roomRect, roomSize, type Size } from "./geometry.js";
import {
  initialMetaState,
  metaReducer,
  normalizeMeta,
  windowsIn,
  worldOf,
  type EnvMetaAction,
  type MetaAction,
  type MetaState,
} from "./state.js";
import {
  roomInfo,
  worldBoxes,
  worldFocus,
  type Kind,
  type RoomEnv,
  type World,
  type WorldAction,
} from "./worlds.js";

export interface MetaContextValue {
  state: MetaState;
  dispatch: (action: MetaAction) => void;
  /** Every room's size: the main output's. */
  size: Size;
  /** Where windows go in a room: all of it but what the main output reserves, e.g. for the bar. */
  area: Rectangle;
  /** A deck room's table. */
  table: Rectangle;
  /** A room as its world sees it, with the windows' size limits. */
  env: RoomEnv;
  outputs: readonly OutputInfo[];
  focused: number | null;
  /** Mapped windows. */
  present: ReadonlySet<number>;
  windows: ReadonlyMap<number, WindowInfo>;
  /** Where every window shows, in its room's coordinates. */
  boxes: ReadonlyMap<number, Rectangle>;
  /** A room's box on the canvas. */
  rectOf: (room: number) => Rectangle;
  /** A room's world. */
  worldOf: (room: number) => World;
  /** The mapped windows in a room, oldest first. */
  windowsOf: (room: number) => number[];
  /** Sends an action to a room's world. */
  act: (room: number, action: WorldAction) => void;
  /** The room an output shows, or null while it shows the canvas. */
  enteredRoom: (output: OutputInfo) => number | null;
  /** The output keyboard actions apply to: the focused window's, else the one last worked on. */
  focusOutput: OutputInfo | undefined;
  /** The room `focusOutput` shows, or null on the canvas. */
  activeRoom: number | null;
  /** The room whose world has the keyboard: the active one, or on the canvas the focused window's. */
  keyRoom: number | null;
  /** Shows `room` on `output` (the focused one by default), or the canvas with null. */
  enter: (room: number | null, output?: OutputInfo) => void;
  /** Makes a room near a canvas point, clear of the others, and returns its id. */
  addRoom: (x: number, y: number, kind?: Kind) => number;
  /** Shows a window's room and focuses it, e.g. when its client asks to be activated. */
  reveal: (window: number) => void;
  /** The window last pushed against an edge, and how many pushes there have been. */
  bumped: { window: number; direction: Direction; count: number } | null;
  /** Shows that WINDOW cannot go in DIRECTION. */
  bump: (window: number, direction: Direction) => void;
  /** Reports where a room being dragged is now, or null once it is dropped. */
  setRoomDrag: (drag: RoomDrag | null) => void;
}

/** A room on its way somewhere, at (x, y) on the canvas. */
export interface RoomDrag {
  room: number;
  x: number;
  y: number;
}

const MetaContext = createContext<MetaContextValue | null>(null);
// Kept apart, so a drag's progress redraws only what shows it, not every room.
const RoomDragContext = createContext<RoomDrag | null>(null);

export function useMeta(): MetaContextValue {
  const value = useContext(MetaContext);
  if (!value) throw new Error("useMeta must be used inside <MetaProvider>.");
  return value;
}

/** The room being dragged, and where it is now, updated as it moves. */
export function useRoomDrag(): RoomDrag | null {
  return useContext(RoomDragContext);
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

/** Owns the meta world's state and shares it, with its actions, through `useMeta`. */
export function MetaProvider({ children }: { children: ReactNode }) {
  const list = useWindows();
  const outputs = useOutputs();
  const focused = useFocusedWindow();
  const instance = useCompositorInstance();
  const [saved, send] = usePersistentReducer("metaworld", metaReducer, initialMetaState);
  const state = useMemo(() => normalizeMeta(saved), [saved]);

  const main = outputs[0];
  const size = useMemo(() => roomSize(main), [main?.width, main?.height]);
  const area = useMemo(() => main?.workArea ?? { x: 0, y: 0, ...size }, [size, main?.workArea]);
  const table = useMemo(() => deckTable(area), [area]);
  const ids = list.map((window) => window.id);
  const idsKey = ids.join();
  const present = useMemo(() => new Set(ids), [idsKey]);
  const windows = useMemo(() => new Map(list.map((window) => [window.id, window])), [list]);

  // Rooms are laid out only by size limits; anything else changing must not lay them out again.
  const limitsKey = list
    .map((window) =>
      [window.id, window.minWidth, window.minHeight, window.maxWidth, window.maxHeight, window.parent].join(":"),
    )
    .join();
  const room = roomInfo(size, area);
  const current: RoomEnv = {
    room,
    outputs: [room],
    windows: Object.fromEntries(list.map((window) => [window.id, windowEnv(window)])),
  };
  // Actions take the environment current when they are sent; rendering, the one laid out by.
  const envRef = useRef(current);
  envRef.current = current;
  const env = useMemo(() => current, [limitsKey, size, area]);

  const dispatch = useCallback(
    (action: MetaAction) => send({ ...action, env: envRef.current } as EnvMetaAction),
    [send],
  );
  const act = useCallback(
    (room: number, action: WorldAction) => dispatch({ type: "world", room, action }),
    [dispatch],
  );

  const rooms = useMemo(() => new Map(state.rooms.map((room) => [room.id, room])), [state.rooms]);
  const rectOf = useCallback(
    (room: number) => roomRect(rooms.get(room) ?? { id: room, x: 0, y: 0 }, size),
    [rooms, size],
  );
  const enteredRoom = useCallback(
    (output: OutputInfo) => {
      const room = state.entered[output.name] ?? null;
      return room !== null && rooms.has(room) ? room : null;
    },
    [state.entered, rooms],
  );
  const worldOfRoom = useCallback((room: number) => worldOf(state, room), [state]);
  const windowsOf = useCallback(
    (room: number) => windowsIn(state, room).filter((id) => present.has(id)),
    [state, present],
  );

  const boxes = useMemo(() => {
    const all = new Map<number, Rectangle>();
    for (const { id } of state.rooms) {
      for (const [window, box] of worldBoxes(worldOf(state, id), env, present, table)) {
        if (state.roomOf[window] === id) all.set(window, box);
      }
    }
    return all;
  }, [state, env, present, table]);

  // A window that just mapped has focus before it has a room; the active output decides for it.
  const windowOutput =
    focused === null
      ? undefined
      : outputs.find((output) => enteredRoom(output) === state.roomOf[focused]);
  const focusOutput =
    windowOutput ?? outputs.find((output) => output.name === state.active) ?? outputs[0];
  const activeRoom = focusOutput ? enteredRoom(focusOutput) : null;
  const keyRoom = activeRoom ?? (focused !== null ? (state.roomOf[focused] ?? null) : null);

  useEffect(() => {
    if (windowOutput && windowOutput.name !== state.active) {
      dispatch({ type: "activate", output: windowOutput.name });
    }
  }, [windowOutput]);

  // Until the compositor says hello there is nothing to prune against.
  useEffect(() => {
    if (instance !== null)
      dispatch({ type: "sync", windows: ids, room: activeRoom ?? state.current, instance });
  }, [idsKey, instance]);

  const enter = useCallback(
    (room: number | null, output = focusOutput) => {
      if (!output) return;
      // Leaving the canvas remembers where it was looking, to return there.
      const camera = room !== null && enteredRoom(output) === null ? getCamera(output.name) : null;
      const from = camera ? { x: camera.x, y: camera.y, zoom: camera.zoom } : undefined;
      dispatch({ type: "enter", output: output.name, room, from });
      if (room === null || (focused !== null && state.roomOf[focused] === room)) return;
      focus(worldFocus(worldOf(state, room), windowsOf(room), env));
    },
    [focusOutput, enteredRoom, focused, state, windowsOf, env],
  );

  const addRoom = useCallback(
    (x: number, y: number, kind?: Kind) => {
      dispatch({ type: "addRoom", x, y, size, kind });
      return state.nextRoom;
    },
    [size, state.nextRoom],
  );

  const reveal = useCallback(
    (window: number) => {
      const room = state.roomOf[window];
      if (room === undefined) return;
      if (!outputs.some((output) => enteredRoom(output) === room)) enter(room);
      // Its world brings it forward: niri's view goes to it, the deck plays its card.
      const world = worldOf(state, room);
      if (world.kind === "niri") act(room, { kind: "niri", action: { type: "activate", window } });
      if (world.kind === "deck") {
        act(room, { kind: "deck", action: { type: "play", window: cardOf(windows, window) } });
      }
      focus(window);
    },
    [state, outputs, enteredRoom, enter, act, windows],
  );

  const [roomDrag, setRoomDrag] = useState<RoomDrag | null>(null);
  const [bumped, setBumped] = useState<MetaContextValue["bumped"]>(null);
  const bump = useCallback((window: number, direction: Direction) => {
    setBumped((last) => ({ window, direction, count: (last?.count ?? 0) + 1 }));
  }, []);

  const value = useMemo<MetaContextValue>(
    () => ({
      state,
      dispatch,
      size,
      area,
      table,
      env,
      outputs,
      focused,
      present,
      windows,
      boxes,
      rectOf,
      worldOf: worldOfRoom,
      windowsOf,
      act,
      enteredRoom,
      focusOutput,
      activeRoom,
      keyRoom,
      enter,
      addRoom,
      reveal,
      bumped,
      bump,
      setRoomDrag,
    }),
    [
      state,
      dispatch,
      size,
      area,
      table,
      env,
      outputs,
      focused,
      present,
      windows,
      boxes,
      rectOf,
      worldOfRoom,
      windowsOf,
      act,
      enteredRoom,
      focusOutput,
      activeRoom,
      keyRoom,
      enter,
      addRoom,
      reveal,
      bumped,
      bump,
      setRoomDrag,
    ],
  );

  return (
    <MetaContext.Provider value={value}>
      <RoomDragContext.Provider value={roomDrag}>{children}</RoomDragContext.Provider>
    </MetaContext.Provider>
  );
}
