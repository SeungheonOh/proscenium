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
  useCompositorInstance,
  useFocusedWindow,
  useOutputs,
  usePersistentReducer,
  usePersistentState,
  useWindows,
  type OutputInfo,
} from "proscenium";
import { Pointer, type Niri } from "./interaction.js";
import { LiveMap, type Driven } from "./live.js";
import type { Env, OutputEnv, WindowEnv } from "./model.js";
import {
  allWindows,
  focusedWindow,
  initialNiriState,
  niriReducer,
  normalizeState,
  type EnvAction,
  type NiriAction,
  type NiriState,
} from "./state.js";

/** A window being dragged by Mod+left button, or in the overview. */
export interface Drag {
  window: number;
  /** Pointer position on OUTPUT, in its logical pixels. */
  output: string;
  x: number;
  y: number;
  /** Where the pointer holds the window, as a fraction of its size. */
  ratioX: number;
  ratioY: number;
  width: number;
  height: number;
  /** Out of the layout, following the pointer; before that it resists in place by DX/DY. */
  lifted: boolean;
  dx: number;
  dy: number;
  floating: boolean;
}

export interface Overlays {
  hotkeys: boolean;
  exit: boolean;
  screenshot: boolean;
}

export interface NiriContextValue {
  state: NiriState;
  act: (action: NiriAction) => void;
  /** Outputs and window limits, as layout sees them. */
  env: Env;
  /** The same, current at any moment, for input handlers. */
  envRef: { readonly current: Env };
  outputs: readonly OutputInfo[];
  /** The window niri's layout focuses, whether or not the keyboard is with it. */
  focused: number | null;
  overview: boolean;
  setOverview: (open: boolean | ((open: boolean) => boolean)) => void;
  overlays: Overlays;
  setOverlay: (name: keyof Overlays, shown: boolean) => void;
  /** View positions of workspaces by id, while a gesture drives them. */
  views: LiveMap<Driven>;
  /** Fractional workspace index of outputs by name, while a gesture drives it. */
  stacks: LiveMap<Driven>;
  /** Overview progress, 0 closed to 1 open, while a gesture drives it. */
  zoom: LiveMap<Driven>;
  /** The dragged window by its id, and as "current" for whatever follows any drag. */
  drags: LiveMap<Drag>;
  /** Workspaces, by id, with a window being resized by hand: their layout follows unanimated. */
  resizing: LiveMap<boolean>;
  /** The pointer grab in progress. */
  pointer: Pointer;
  /** The latest context value, for input handlers that outlive a render. */
  handle: Niri;
}

const NiriContext = createContext<NiriContextValue | null>(null);

export function useNiri(): NiriContextValue {
  const value = useContext(NiriContext);
  if (!value) throw new Error("useNiri must be used inside <NiriProvider>.");
  return value;
}

/** How long a workspace switch takes to play out, after which emptied workspaces go. */
const switchSettle = 350;

function outputEnv(output: OutputInfo): OutputEnv {
  return { name: output.name, x: output.x, width: output.width, height: output.height,
           workArea: output.workArea };
}

/** Removes the workspaces a switch left empty, once the switch away from them has played. */
export function useWorkspaceCleanup(state: NiriState, act: (action: NiriAction) => void): void {
  const shownKey = Object.entries(state.monitors)
    .map(([name, monitor]) => `${name}:${monitor.workspaces[monitor.active]?.id}:${monitor.workspaces.length}`)
    .join();
  useEffect(() => {
    const timer = setTimeout(() => {
      for (const name of Object.keys(state.monitors)) act({ type: "cleanWorkspaces", output: name });
    }, switchSettle);
    return () => clearTimeout(timer);
  }, [shownKey]);
}

/** Owns the niri world's state and shares it, with its actions, through `useNiri`. */
export function NiriProvider({ children }: { children: ReactNode }) {
  const windows = useWindows();
  const outputs = useOutputs();
  const compositorFocus = useFocusedWindow();
  const instance = useCompositorInstance();
  const [saved, dispatch] = usePersistentReducer<NiriState, EnvAction>("niri", niriReducer, initialNiriState);
  const state = useMemo(() => normalizeState(saved), [saved]);
  const [overview, setOverview] = useState(false);
  const [overlays, setOverlays] = useState<Overlays>({ hotkeys: false, exit: false, screenshot: false });
  const [hotkeysShownFor, setHotkeysShownFor] = usePersistentState<string | null>("niri-hotkeys", null);

  // Layout reads sizes only through limits; everything else changing must not re-render it.
  const limitsKey = windows.map((window) =>
    [window.id, window.minWidth, window.minHeight, window.maxWidth, window.maxHeight, window.parent].join(":"),
  ).join();
  const outputsKey = JSON.stringify(outputs);
  const fresh: Env = {
    outputs: outputs.map(outputEnv),
    windows: Object.fromEntries(windows.map((window): [number, WindowEnv] => [window.id, {
      width: window.width, height: window.height, minWidth: window.minWidth, minHeight: window.minHeight,
      maxWidth: window.maxWidth, maxHeight: window.maxHeight, parent: window.parent,
      appId: window.appId, title: window.title,
    }])),
  };
  const envRef = useRef(fresh);
  envRef.current = fresh;
  const env = useMemo(() => fresh, [limitsKey, outputsKey]);

  const act = useCallback((action: NiriAction) => dispatch({ ...action, env: envRef.current } as EnvAction),
                          [dispatch]);

  const ids = windows.map((window) => window.id);
  const idsKey = ids.join();
  useEffect(() => {
    if (instance !== null) act({ type: "sync", windows: ids, instance });
  }, [idsKey, outputsKey, instance]);

  // The overview and the dialogs hold the keyboard with grabs; the layout's focus stays as it is.
  const focused = focusedWindow(state);
  const desired = focused;
  const placed = useMemo(() => new Set(allWindows(state)), [state]);
  const present = useMemo(() => new Set(ids), [idsKey]);
  const requested = useRef<number | null | undefined>(undefined);
  const previousFocus = useRef<number | null>(compositorFocus);
  const previousDesired = useRef<number | null | undefined>(undefined);

  useEffect(() => {
    const before = previousFocus.current;
    const desiredBefore = previousDesired.current;
    previousFocus.current = compositorFocus;
    previousDesired.current = desired;
    if (compositorFocus === desired) return;
    // A window closing leaves the layout to choose, once it hears of it.
    if (desired !== null && !present.has(desired)) return;
    const push = () => {
      requested.current = desired;
      focus(desired);
    };
    if (desired !== desiredBefore) return push();
    if (compositorFocus === null || !placed.has(compositorFocus)) return;
    if (compositorFocus === requested.current) return;
    // A press focused another window: the layout follows, as niri activates what is clicked.
    const clicked = compositorFocus !== before && (before === null || present.has(before));
    if (clicked) act({ type: "activate", window: compositorFocus });
    else push();
  }, [compositorFocus, desired, placed, present]);

  useWorkspaceCleanup(state, act);

  // niri shows its important hotkeys once each time it starts.
  useEffect(() => {
    if (instance === null || hotkeysShownFor === instance) return;
    setHotkeysShownFor(instance);
    setOverlays((current) => ({ ...current, hotkeys: true }));
  }, [instance]);

  const setOverlay = useCallback((name: keyof Overlays, shown: boolean) =>
    setOverlays((current) => (current[name] === shown ? current : { ...current, [name]: shown })), []);

  const latest = useRef<NiriContextValue | null>(null);
  const [live] = useState(() => {
    const handle: Niri = () => latest.current!;
    return {
      views: new LiveMap<Driven>(), stacks: new LiveMap<Driven>(), zoom: new LiveMap<Driven>(),
      drags: new LiveMap<Drag>(), resizing: new LiveMap<boolean>(), pointer: new Pointer(handle), handle,
    };
  });

  const value = useMemo<NiriContextValue>(() => ({
    state, act, env, envRef, outputs, focused, overview, setOverview, overlays, setOverlay, ...live,
  }), [state, act, env, outputs, focused, overview, overlays, setOverlay, live]);
  latest.current = value;

  return <NiriContext.Provider value={value}>{children}</NiriContext.Provider>;
}
