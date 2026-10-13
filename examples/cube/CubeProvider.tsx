import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  dwindle,
  focus,
  useCompositorInstance,
  useFocusedWindow,
  useOutputs,
  usePersistentReducer,
  useWindowIds,
  type OutputInfo,
  type Rectangle,
} from "proscenium";
import {
  cubeReducer,
  faces,
  frontFace,
  initialCubeState,
  type CubeAction,
  type CubeState,
} from "./state.js";
import { fallbackArea } from "../lib/geometry.js";

const gaps = { gap: 10, outer: 18 };

export interface CubeContextValue {
  state: CubeState;
  dispatch: (action: CubeAction) => void;
  /** The output the cube turns on and its work area, which every face covers. */
  output: OutputInfo | undefined;
  area: Rectangle;
  front: number;
  focused: number | null;
  /** Each window's box on its face, in the face's coordinates. */
  boxes: Map<number, Rectangle>;
}

const CubeContext = createContext<CubeContextValue | null>(null);

export function useCube(): CubeContextValue {
  const value = useContext(CubeContext);
  if (!value) throw new Error("useCube must be used inside <CubeProvider>.");
  return value;
}

/** Owns the cube's state: which face each window is on, and which face is in front. */
export function CubeProvider({ children }: { children: ReactNode }) {
  const windows = useWindowIds();
  const outputs = useOutputs();
  const focused = useFocusedWindow();
  const instance = useCompositorInstance();
  const [state, dispatch] = usePersistentReducer("cube", cubeReducer, initialCubeState);
  const output = outputs[0];
  const area = output?.workArea ?? fallbackArea;
  const front = frontFace(state);
  // The window each face last had focused, to give it back when the face returns.
  const lastFocused = useRef(new Map<number, number>());

  useEffect(() => {
    if (instance !== null) dispatch({ type: "sync", windows, instance });
  }, [windows, instance]);

  const boxes = useMemo(() => {
    const placed = new Map<number, Rectangle>();
    const face = { x: 0, y: 0, width: area.width, height: area.height };
    for (let index = 0; index < faces; index++) {
      const tiled = state.order.filter((id) => state.faceOf[id] === index);
      for (const { key, ...box } of dwindle(tiled, face, gaps)) placed.set(key, box);
    }
    return placed;
  }, [state.order, state.faceOf, area.width, area.height]);

  // A window that takes focus elsewhere, e.g. one asking to be shown, brings its face round.
  useEffect(() => {
    if (focused === null) return;
    const face = state.faceOf[focused];
    if (face === undefined) return;
    lastFocused.current.set(face, focused);
    if (face !== front) dispatch({ type: "show", face });
  }, [focused]);

  // The face coming round gives focus back to the window it last had.
  const frontWindows = state.order.filter((id) => state.faceOf[id] === front);
  useEffect(() => {
    if (focused !== null && state.faceOf[focused] === front) return;
    const remembered = lastFocused.current.get(front);
    const target =
      remembered !== undefined && frontWindows.includes(remembered) ? remembered : frontWindows[0];
    if ((target ?? null) !== focused) focus(target ?? null);
  }, [front, frontWindows.join(" ")]);

  const value = useMemo(
    () => ({ state, dispatch, output, area, front, focused, boxes }),
    [state, output, area, front, focused, boxes],
  );
  return <CubeContext.Provider value={value}>{children}</CubeContext.Provider>;
}
