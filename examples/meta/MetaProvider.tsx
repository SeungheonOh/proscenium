import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
  useWindowIds,
  type OutputInfo,
  type Rectangle,
} from "proscenium";
import type { Direction } from "../lib/geometry.js";
import { roomRect, roomSize, type Size } from "./geometry.js";
import { initialMetaState, metaReducer, type MetaAction, type MetaState } from "./state.js";
import { placeWindows, roomWindows, tilingArea } from "./tiling.js";

export interface MetaContextValue {
  state: MetaState;
  dispatch: (action: MetaAction) => void;
  /** Every room's size: the main output's. */
  size: Size;
  outputs: readonly OutputInfo[];
  focused: number | null;
  /** Mapped windows. */
  present: ReadonlySet<number>;
  /** Where every window goes, in its room's coordinates. */
  boxes: ReadonlyMap<number, Rectangle>;
  /** A room's box on the canvas. */
  rectOf: (room: number) => Rectangle;
  /** The room an output shows, or null while it shows the canvas. */
  enteredRoom: (output: OutputInfo) => number | null;
  /** The output keyboard actions apply to: the focused window's, else the one last worked on. */
  focusOutput: OutputInfo | undefined;
  /** The room `focusOutput` shows, or null on the canvas. */
  activeRoom: number | null;
  /** Shows `room` on `output` (the focused one by default), or the canvas with null. */
  enter: (room: number | null, output?: OutputInfo) => void;
  /** Makes a room near a canvas point, clear of the others, and returns its id. */
  addRoom: (x: number, y: number) => number;
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

/** Owns the meta world's state and shares it, with its actions, through `useMeta`. */
export function MetaProvider({ children }: { children: ReactNode }) {
  const windows = useWindowIds();
  const outputs = useOutputs();
  const focused = useFocusedWindow();
  const instance = useCompositorInstance();
  const [state, dispatch] = usePersistentReducer("metaworld", metaReducer, initialMetaState);

  const main = outputs[0];
  const size = useMemo(() => roomSize(main), [main?.width, main?.height]);
  const area = useMemo(() => tilingArea(size, main), [size, main?.workArea]);
  const present = useMemo(() => new Set(windows), [windows]);
  const boxes = useMemo(() => placeWindows(state, present, area), [state, present, area]);

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

  // A window that just mapped has focus before it has a room; the active output decides for it.
  const windowOutput =
    focused === null
      ? undefined
      : outputs.find((output) => enteredRoom(output) === state.roomOf[focused]);
  const focusOutput =
    windowOutput ?? outputs.find((output) => output.name === state.active) ?? outputs[0];
  const activeRoom = focusOutput ? enteredRoom(focusOutput) : null;

  useEffect(() => {
    if (windowOutput && windowOutput.name !== state.active) {
      dispatch({ type: "activate", output: windowOutput.name });
    }
  }, [windowOutput]);

  // Until the compositor says hello there is nothing to prune against.
  useEffect(() => {
    if (instance !== null)
      dispatch({ type: "sync", windows, room: activeRoom ?? state.current, instance });
  }, [windows, instance]);

  const enter = useCallback(
    (room: number | null, output = focusOutput) => {
      if (!output) return;
      // Leaving the canvas remembers where it was looking, to return there.
      const camera = room !== null && enteredRoom(output) === null ? getCamera(output.name) : null;
      const from = camera ? { x: camera.x, y: camera.y, zoom: camera.zoom } : undefined;
      dispatch({ type: "enter", output: output.name, room, from });
      if (room === null || (focused !== null && state.roomOf[focused] === room)) return;
      focus(roomWindows(state, room, present)[0] ?? null);
    },
    [focusOutput, enteredRoom, focused, state, present],
  );

  const addRoom = useCallback(
    (x: number, y: number) => {
      dispatch({ type: "addRoom", x, y, size });
      return state.nextRoom;
    },
    [size, state.nextRoom],
  );

  const reveal = useCallback(
    (window: number) => {
      const room = state.roomOf[window];
      const isShown = outputs.some((output) => enteredRoom(output) === room);
      if (room !== undefined && !isShown) enter(room);
      focus(window);
    },
    [state, outputs, enteredRoom, enter],
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
      outputs,
      focused,
      present,
      boxes,
      rectOf,
      enteredRoom,
      focusOutput,
      activeRoom,
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
      outputs,
      focused,
      present,
      boxes,
      rectOf,
      enteredRoom,
      focusOutput,
      activeRoom,
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
