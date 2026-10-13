import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
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
  handOf,
  handReducer,
  initialHandState,
  type HandAction,
  type HandState,
} from "../lib/hand.js";
import { shelfLayout, type Shelf } from "./layout.js";
import { fallbackArea } from "../lib/geometry.js";

export interface ShelfContextValue {
  /** `played` is the open book, `hand` the shelf left to right. */
  state: HandState;
  dispatch: (action: HandAction) => void;
  output: OutputInfo | undefined;
  area: Rectangle;
  shelf: Shelf;
  /** Whether the switcher is open. */
  browsing: boolean;
  /** The book under the pointer. */
  hovered: number | null;
  setHovered: (window: number | null) => void;
}

const ShelfContext = createContext<ShelfContextValue | null>(null);

export function useShelf(): ShelfContextValue {
  const value = useContext(ShelfContext);
  if (!value) throw new Error("useShelf must be used inside <ShelfProvider>.");
  return value;
}

/** Owns the shelf's state and shares it, with the switcher's behaviour, through `useShelf`. */
export function ShelfProvider({ children }: { children: ReactNode }) {
  const windows = useWindowIds();
  const outputs = useOutputs();
  const focused = useFocusedWindow();
  const instance = useCompositorInstance();
  const [saved, dispatch] = usePersistentReducer("shelf", handReducer, initialHandState);
  // Until synced, a hand saved by an earlier compositor names windows long gone.
  const state = handOf(saved, instance);
  const [hovered, setHovered] = useState<number | null>(null);

  const output = outputs[0];
  const area = output?.workArea ?? fallbackArea;
  const shelf = useMemo(() => shelfLayout(area), [area]);
  const browsing = state.selected !== null;

  useEffect(() => {
    if (instance !== null) dispatch({ type: "sync", windows, instance });
  }, [windows, instance]);

  // The open book has the keyboard; one that takes focus itself comes off the shelf.
  useEffect(() => {
    if (state.played !== null && state.played !== focused) focus(state.played);
  }, [state.played]);
  useEffect(() => {
    if (focused !== null && focused !== state.played) dispatch({ type: "play", window: focused });
  }, [focused]);

  const value = useMemo(
    () => ({ state, dispatch, output, area, shelf, browsing, hovered, setHovered }),
    [state, output, area, shelf, browsing, hovered],
  );
  return <ShelfContext.Provider value={value}>{children}</ShelfContext.Provider>;
}
