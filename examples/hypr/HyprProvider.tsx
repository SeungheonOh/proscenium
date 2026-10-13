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
  useCompositorInstance,
  useFocusedWindow,
  useOutputs,
  usePersistentReducer,
  useWindowIds,
  type OutputInfo,
} from "proscenium";
import type { Direction } from "../lib/geometry.js";
import { hyprReducer, initialHyprState, type HyprAction, type HyprState } from "./state.js";
import { placeWindows, shownWorkspace, type PlacedBox } from "./tiling.js";

export interface HyprContextValue {
  state: HyprState;
  dispatch: (action: HyprAction) => void;
  outputs: readonly OutputInfo[];
  focused: number | null;
  /** Mapped windows. */
  present: ReadonlySet<number>;
  /** Where every window on a shown workspace goes. */
  boxes: ReadonlyMap<number, PlacedBox>;
  /** The output keyboard actions apply to: the focused window's, else the one last worked on. */
  focusOutput: OutputInfo | undefined;
  /** The workspace `focusOutput` shows. */
  currentWorkspace: number;
  workspaceOf: (output: OutputInfo) => number;
  /** Shows a workspace on the focused output and focuses its first window. */
  switchTo: (workspace: number) => void;
  /** Shows a window wherever it is and focuses it, e.g. when its client asks to be activated. */
  reveal: (window: number) => void;
  /** The window last pushed against an edge, and how many pushes there have been. */
  bumped: { window: number; direction: Direction; count: number } | null;
  /** Shows that WINDOW cannot go in DIRECTION. */
  bump: (window: number, direction: Direction) => void;
}

const HyprContext = createContext<HyprContextValue | null>(null);

export function useHypr(): HyprContextValue {
  const value = useContext(HyprContext);
  if (!value) throw new Error("useHypr must be used inside <HyprProvider>.");
  return value;
}

/** Owns the Hypr world's state and shares it, with its actions, through `useHypr`. */
export function HyprProvider({ children }: { children: ReactNode }) {
  const windows = useWindowIds();
  const outputs = useOutputs();
  const focused = useFocusedWindow();
  const instance = useCompositorInstance();
  const [state, dispatch] = usePersistentReducer("hypr", hyprReducer, initialHyprState);

  const present = useMemo(() => new Set(windows), [windows]);
  const boxes = useMemo(() => placeWindows(state, outputs, present), [state, outputs, present]);
  const workspaceOf = useCallback(
    (output: OutputInfo) => shownWorkspace(state, outputs, output),
    [state, outputs],
  );

  // A window that just mapped has focus before it has a workspace; the active output decides for it.
  const windowOutput =
    focused === null
      ? undefined
      : outputs.find((output) => state.workspaces[focused] === workspaceOf(output));
  const focusOutput =
    windowOutput ?? outputs.find((output) => output.name === state.active) ?? outputs[0];
  const currentWorkspace = focusOutput ? workspaceOf(focusOutput) : 1;

  useEffect(() => {
    if (windowOutput && windowOutput.name !== state.active) {
      dispatch({ type: "activate", output: windowOutput.name });
    }
  }, [windowOutput]);

  // Until the compositor says hello there is nothing to prune against.
  useEffect(() => {
    if (instance !== null)
      dispatch({ type: "sync", windows, workspace: currentWorkspace, instance });
  }, [windows, instance]);

  const switchTo = useCallback(
    (workspace: number) => {
      if (!focusOutput || workspace < 1 || workspace > 9) return;
      // An output already showing that workspace takes this one's in exchange.
      const other = outputs.find(
        (output) => output !== focusOutput && workspaceOf(output) === workspace,
      );
      if (other) dispatch({ type: "show", output: other.name, workspace: currentWorkspace });
      dispatch({ type: "show", output: focusOutput.name, workspace });
      const first = state.order.find((id) => state.workspaces[id] === workspace && present.has(id));
      focus(first ?? null);
    },
    [focusOutput, outputs, workspaceOf, currentWorkspace, state, present],
  );

  const reveal = useCallback(
    (window: number) => {
      const workspace = state.workspaces[window];
      const isShown = outputs.some((output) => workspaceOf(output) === workspace);
      if (workspace !== undefined && !isShown && focusOutput) {
        dispatch({ type: "show", output: focusOutput.name, workspace });
      }
      if (state.scratchpad.includes(window)) dispatch({ type: "toggleScratchpad", window });
      focus(window);
    },
    [state, outputs, workspaceOf, focusOutput],
  );

  const [bumped, setBumped] = useState<HyprContextValue["bumped"]>(null);
  const bump = useCallback((window: number, direction: Direction) => {
    setBumped((last) => ({ window, direction, count: (last?.count ?? 0) + 1 }));
  }, []);

  const value = useMemo<HyprContextValue>(
    () => ({
      state,
      dispatch,
      outputs,
      focused,
      present,
      boxes,
      focusOutput,
      currentWorkspace,
      workspaceOf,
      switchTo,
      reveal,
      bumped,
      bump,
    }),
    [
      state,
      dispatch,
      outputs,
      focused,
      present,
      boxes,
      focusOutput,
      currentWorkspace,
      workspaceOf,
      switchTo,
      reveal,
      bumped,
      bump,
    ],
  );

  return <HyprContext.Provider value={value}>{children}</HyprContext.Provider>;
}
