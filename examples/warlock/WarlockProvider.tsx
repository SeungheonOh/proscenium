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
  close,
  focus,
  instant,
  useCompositorInstance,
  useFocusedWindow,
  useInput,
  useOutputs,
  usePersistentReducer,
  useWindows,
  type OutputInfo,
  type Rectangle,
  type StagePointerEvent,
  type WindowInfo,
} from "proscenium";
import { strengths } from "../canvas/magnetism.js";
import { useArrangeSettings } from "../canvas/useArrange.js";
import { atActualSize, homeView, middle, moveView, pageInView, viewOf } from "./canvas/view.js";
import {
  outputShowing,
  pageAt,
  pageOf,
  placeWindows,
  shownWorkspace,
  stackingOrder,
  type Placed,
} from "./geometry.js";
import {
  homePage,
  initialWarlockState,
  snapRegions,
  warlockReducer,
  type Page,
  type SnapRegion,
  type View,
  type WarlockAction,
  type WarlockState,
  type WindowRecord,
} from "./state.js";
import { appearanceFile, motionFile, useStored } from "./storage.js";
import { makeTheme, WarlockThemeProvider } from "./theme.js";

/** The one popup Warlock shows at a time, and what it is about. */
export type PopupMode =
  | { mode: "applications" }
  | { mode: "overview" }
  /** `chord`: opened by Alt+Tab, so letting go of Alt chooses. `list` is frozen as it opens. */
  | { mode: "switcher"; chord: boolean; list: readonly number[]; index: number }
  | { mode: "snap"; window: number }
  | { mode: "menu"; window: number }
  /** The windows of one taskbar group. */
  | { mode: "picker"; group: string }
  /** An application's own actions and recent files, by desktop-entry id. */
  | { mode: "jump"; entry: string }
  | { mode: "notifications" }
  | { mode: "system" }
  | { mode: "settings" }
  | { mode: "files" };

export type Popup = PopupMode & {
  /** The output it shows on. */
  output: string;
  /** Where a context menu opens, in that output's pixels; under the bar without one. */
  anchor: { x: number; y: number } | null;
  /** Counts popups opened, so a popup opened again starts afresh. */
  serial: number;
};

export interface PopupOptions {
  output?: string;
  anchor?: { x: number; y: number } | null;
}

/** A window the view should come to, unless all of it is in view already. */
export interface FlyRequest {
  window: number;
  /** Its workspace was only now shown: the view starts there, rather than travelling. */
  instant: boolean;
  /** Counts requests, so asking again for the same window is a new one. */
  serial: number;
}

export type Arrow = "Left" | "Right" | "Up" | "Down";

/** What the canvas of one output does when asked: its keys, and pointer presses bound with a modifier. */
export interface CanvasHandle {
  /** Fit every window of the workspace in view; again, go back to where the view was. */
  toggleOverview: () => void;
  /** The focused window to the middle of the view, at 100%. */
  centerFocused: () => void;
  flyHome: () => void;
  /** Focus the nearest window that way and bring it into view. */
  focusToward: (arrow: Arrow) => void;
  /** Move the view by whole pages. */
  turnPage: (columns: number, rows: number) => void;
  /** Pile the selection into a stack, or spread the focused window's stack out again. */
  stackOrSpread: () => void;
  /** Fan the focused window's stack out to pick from, or step the pick. */
  fanStack: (step: 1 | -1) => void;
  /** A press with Alt or Super held: move the window under it or, with `select`, draw a selection box on empty desktop; or resize. */
  press: (event: StagePointerEvent, what: "move" | "select" | "resize") => void;
  drag: (event: StagePointerEvent) => void;
  release: (event: StagePointerEvent) => void;
}

/** What the canvas keys do on one output. */
export type CanvasActions = Omit<CanvasHandle, "press" | "drag" | "release">;

/** The canvas keys: those of the output keyboard actions apply to, and what every canvas shares. */
export interface CanvasCommands extends CanvasActions {
  /** Alignment guides while dragging, on or off. */
  toggleGuides: () => void;
  /** Magnet mode, in which a moved window pushes the others out of its way, on or off. */
  toggleMagnet: () => void;
  cycleMagnetStrength: () => void;
}

/** The notice the taskbar shows while nothing else has anything to say. */
export const idleNotice = "Connected";

export interface WarlockContextValue {
  state: WarlockState;
  dispatch: (action: WarlockAction) => void;
  outputs: readonly OutputInfo[];
  /** Every mapped window by id. */
  windows: ReadonlyMap<number, WindowInfo>;
  /** Windows that are nobody's dialog, oldest first: what the taskbar, switcher and Task View list. */
  roots: readonly number[];
  /** A window and the dialogs that belong to it, however deep. */
  family: (root: number) => number[];
  /** The window a dialog belongs to in the end; a root is its own. */
  rootOf: (window: number) => number;
  record: (window: number) => WindowRecord | undefined;
  /** What a window is called: its title, else its application's id. */
  label: (window: number) => string;
  /** The window with the keyboard, and the root of its family. */
  focused: number | null;
  focusedRoot: number | null;
  /** Where every root window an output shows goes, on the canvas of the workspace it shows. */
  placed: ReadonlyMap<number, Placed>;
  /** Roots from the bottom of the stack up. */
  stack: readonly number[];
  /** The output keyboard actions apply to, and the workspace it shows. */
  focusOutput: OutputInfo | undefined;
  activeWorkspace: number;
  workspaceOf: (output: OutputInfo) => number;
  /** Workspaces to list: the first three, any in use and the active one, ascending. */
  workspaces: readonly number[];
  motion: "full" | "reduced";

  /** Show a window's workspace, bring it back if minimized, focus and raise it, and bring it into view. */
  activate: (window: number) => void;
  minimize: (window: number) => void;
  /** Maximize on PAGE; without one, on the page in view at 100%, else on the page the window is on. */
  maximize: (window: number, page?: Page) => void;
  /** Back to the size a snapped or maximized window had. */
  restoreSize: (window: number) => void;
  toggleMaximize: (window: number) => void;
  /** Snap to a region of PAGE, chosen as `maximize` chooses it. */
  snap: (window: number, region: SnapRegion, page?: Page) => void;
  float: (window: number, rect: Rectangle) => void;
  setOnTop: (window: number, value: boolean) => void;
  setFullscreen: (window: number, value: boolean) => void;
  /** Move a window's family to a workspace; the view stays where it is. */
  transfer: (window: number, workspace: number) => void;
  showWorkspace: (workspace: number, output?: OutputInfo) => void;
  closeWindow: (window: number) => void;
  /** Whether a window can be snapped, kept on top or maximized as it is now. */
  canSnap: (window: number) => boolean;
  canPin: (window: number) => boolean;
  canMaximize: (window: number) => boolean;

  popup: Popup | null;
  openPopup: (mode: PopupMode, options?: PopupOptions) => void;
  closePopup: () => void;
  /**
   * Say that the press being handled landed on the popup or on a taskbar
   * control: any other press dismisses the popup, and still goes where it was aimed.
   */
  keepPopup: () => void;
  /** Open the switcher a step forward or back, or step it if it is open. */
  stepSwitcher: (by: 1 | -1, chord: boolean) => void;
  /** Choose the switcher's candidate, or the window at INDEX of its list. */
  commitSwitcher: (index?: number) => void;

  /** What the taskbar's status chip says. */
  status: string;
  /** Say NOTICE in the status chip, for SECONDS or until the next notice. */
  notify: (notice: string, seconds?: number) => void;
  /** The open popup's status line, which the chip mirrors; null when it has none to show. */
  setPopupStatus: (status: string | null) => void;

  /** The window the view was last asked to come to; its output's canvas flies there. */
  flyRequest: FlyRequest | null;
  canvas: CanvasCommands;
  /** The canvas of an output makes itself known by the output's name; with null it takes its leave. */
  registerCanvas: (output: string, handle: CanvasHandle | null) => void;
  /** The canvas of an output, for input that is bound to no node. */
  canvasOn: (output: string) => CanvasHandle | undefined;
}

const WarlockContext = createContext<WarlockContextValue | null>(null);

export function useWarlock(): WarlockContextValue {
  const value = useContext(WarlockContext);
  if (!value) throw new Error("useWarlock must be used inside <WarlockProvider>.");
  return value;
}

/** The name of a snap region, as its button says it. */
export function regionLabel(region: SnapRegion): string {
  return snapRegions.find((entry) => entry.region === region)?.label ?? region;
}

/** Owns the Warlock world's windows, workspaces and popup, and shares them through `useWarlock`. */
export function WarlockProvider({ children }: { children: ReactNode }) {
  const mapped = useWindows();
  const outputs = useOutputs();
  const focused = useFocusedWindow();
  const instance = useCompositorInstance();
  const [state, dispatch] = usePersistentReducer("warlock", warlockReducer, initialWarlockState);
  const appearance = useStored(appearanceFile);
  const motionOverride = useStored(motionFile);
  const theme = useMemo(() => makeTheme(appearance), [appearance]);

  const windows = useMemo(() => new Map(mapped.map((window) => [window.id, window])), [mapped]);
  const ids = useMemo(
    () => mapped.map((window) => window.id),
    [mapped.map((window) => window.id).join()],
  );

  const rootOf = useCallback(
    (window: number): number => {
      let current = window;
      for (let depth = 0; depth < 16; depth++) {
        const parent = windows.get(current)?.parent;
        if (parent === null || parent === undefined || !windows.has(parent)) break;
        current = parent;
      }
      return current;
    },
    [windows],
  );
  const roots = useMemo(() => ids.filter((id) => rootOf(id) === id), [ids, rootOf]);
  const family = useCallback(
    (root: number): number[] => [root, ...ids.filter((id) => id !== root && rootOf(id) === root)],
    [ids, rootOf],
  );
  const record = useCallback((window: number) => state.windows[window], [state.windows]);
  const label = useCallback(
    (window: number): string => {
      const info = windows.get(window);
      return info?.title || info?.appId || "Window";
    },
    [windows],
  );

  const placed = useMemo(() => placeWindows(state, outputs, roots), [state, outputs, roots]);
  const focusedRoot = focused === null || !windows.has(focused) ? null : rootOf(focused);
  const stack = useMemo(
    () => stackingOrder(state, roots, focusedRoot),
    [state, roots, focusedRoot],
  );
  const workspaceOf = useCallback(
    (output: OutputInfo) => shownWorkspace(state, outputs, output),
    [state, outputs],
  );

  const windowOutput = focusedRoot === null ? undefined : placed.get(focusedRoot)?.output;
  const focusOutput =
    windowOutput ?? outputs.find((output) => output.name === state.active) ?? outputs[0];
  const activeWorkspace = focusOutput ? workspaceOf(focusOutput) : 1;

  const workspaces = useMemo(() => {
    const used = new Set([1, 2, 3, activeWorkspace]);
    for (const id of roots) {
      const workspace = state.windows[id]?.workspace;
      if (workspace !== undefined) used.add(workspace);
    }
    return [...used].sort((a, b) => a - b);
  }, [roots, state.windows, activeWorkspace]);

  useEffect(() => {
    if (windowOutput && windowOutput.name !== state.active)
      dispatch({ type: "activateOutput", output: windowOutput.name });
  }, [windowOutput]);

  const [flyRequest, setFlyRequest] = useState<FlyRequest | null>(null);
  const flights = useRef(0);
  /** Ask for WINDOW to be brought into view. */
  const flyTo = useCallback((window: number, immediately = false) => {
    setFlyRequest({ window, instant: immediately, serial: ++flights.current });
  }, []);

  // Until the compositor says hello there is nothing to prune against.
  useEffect(() => {
    if (instance === null) return;
    // A new window opens on the page in view.
    const page = focusOutput
      ? pageInView(focusOutput, viewOf(focusOutput, outputs.indexOf(focusOutput)))
      : homePage;
    dispatch({ type: "sync", windows: ids, workspace: activeWorkspace, page, instance });
    const opened = roots.filter((id) => state.windows[id] === undefined);
    if (state.instance === instance && opened.length > 0) flyTo(opened.at(-1)!);
  }, [ids, instance]);

  // A window focused by a click, or as it opens, is the one most lately used.
  useEffect(() => {
    if (focusedRoot !== null) dispatch({ type: "focused", window: focusedRoot });
  }, [focusedRoot]);

  /** The window to focus once WINDOW leaves the screen: the one most lately used that still shows. */
  const nextAfter = useCallback(
    (window: number): number | null => {
      const output = placed.get(window)?.output ?? focusOutput;
      const candidates = [...placed.values()].filter(
        (entry) => entry.id !== window && entry.output === output,
      );
      const rank = (id: number) => {
        const used = state.history.indexOf(id);
        return used < 0 ? Number.MAX_SAFE_INTEGER : used;
      };
      candidates.sort((a, b) => rank(a.id) - rank(b.id) || a.id - b.id);
      return candidates[0]?.id ?? null;
    },
    [placed, focusOutput, state.history],
  );

  /**
   * Show workspaces on outputs, the last of which becomes the active one. Each
   * workspace remembers its camera: the view of an output goes at once to
   * where its new workspace was left.
   */
  const switchWorkspaces = useCallback(
    (changes: readonly (readonly [OutputInfo, number])[]) => {
      const views: Record<number, View> = { ...state.views };
      for (const [output] of changes)
        views[workspaceOf(output)] = viewOf(output, outputs.indexOf(output));
      for (const [output, workspace] of changes) {
        const leaving = workspaceOf(output);
        dispatch({
          type: "show",
          output: output.name,
          workspace,
          leaving: { workspace: leaving, view: views[leaving] ?? homeView },
        });
        if (leaving !== workspace)
          moveView(output, outputs.indexOf(output), views[workspace] ?? homeView, instant);
      }
    },
    [state.views, workspaceOf, outputs],
  );

  const showWorkspace = useCallback(
    (workspace: number, output: OutputInfo | undefined = focusOutput) => {
      if (!output || workspace < 1) return;
      // An output already showing that workspace takes this one's in exchange.
      const other = outputs.find(
        (candidate) => candidate !== output && workspaceOf(candidate) === workspace,
      );
      switchWorkspaces(
        other
          ? [
              [other, workspaceOf(output)],
              [output, workspace],
            ]
          : [[output, workspace]],
      );
      const here = roots.filter((id) => {
        const entry = state.windows[id];
        return entry && entry.workspace === workspace && !entry.minimized;
      });
      const latest = state.history.find((id) => here.includes(id)) ?? here[0];
      focus(latest ?? null);
    },
    [focusOutput, outputs, workspaceOf, switchWorkspaces, roots, state.windows, state.history],
  );

  const activate = useCallback(
    (window: number) => {
      const root = rootOf(window);
      const entry = state.windows[root];
      if (!entry) return;
      const hidden =
        !entry.onTop &&
        !outputShowing(state, outputs, entry.workspace) &&
        focusOutput !== undefined;
      if (hidden) switchWorkspaces([[focusOutput, entry.workspace]]);
      dispatch({ type: "activate", windows: family(root) });
      focus(window);
      flyTo(root, hidden);
    },
    [rootOf, state, outputs, focusOutput, switchWorkspaces, family, flyTo],
  );

  const minimize = useCallback(
    (window: number) => {
      const root = rootOf(window);
      dispatch({ type: "minimize", windows: family(root) });
      if (focusedRoot === root) focus(nextAfter(root));
    },
    [rootOf, family, focusedRoot, nextAfter],
  );

  const canMaximize = useCallback(
    (window: number) => {
      const entry = state.windows[window];
      const info = windows.get(window);
      if (!entry || !info || entry.minimized || entry.fullscreen || entry.placement === "maximized")
        return false;
      // A window that cannot grow has a largest size.
      return info.maxWidth === 0 && info.maxHeight === 0;
    },
    [state.windows, windows],
  );
  const canSnap = useCallback(
    (window: number) => {
      const entry = state.windows[window];
      const info = windows.get(window);
      if (!entry || !info || info.parent !== null) return false;
      const fixed = info.maxWidth !== 0 || info.maxHeight !== 0;
      return (
        (entry.placement === "floating" || entry.placement === "snapped") &&
        !entry.minimized &&
        !entry.fullscreen &&
        !fixed
      );
    },
    [state.windows, windows],
  );
  const canPin = useCallback(
    (window: number) => {
      const entry = state.windows[window];
      const info = windows.get(window);
      if (!entry || !info || info.parent !== null) return false;
      return (
        entry.placement !== "tiled" &&
        entry.placement !== "maximized" &&
        !entry.minimized &&
        !entry.fullscreen
      );
    },
    [state.windows, windows],
  );

  /** The page a window snaps or maximizes on: the one in view at 100%, else the one it is on. */
  const pageFor = useCallback(
    (window: number): Page => {
      const entry = placed.get(window);
      const output = entry?.output ?? focusOutput;
      if (!output) return pageOf(state.windows[window]);
      const view = viewOf(output, outputs.indexOf(output));
      if (atActualSize(view)) return pageInView(output, view);
      if (entry?.record.placement !== "floating") return pageOf(state.windows[window]);
      const { x, y } = middle(entry.rect);
      return pageAt(output, x, y);
    },
    [placed, focusOutput, state.windows, outputs],
  );

  const maximize = useCallback(
    (window: number, page?: Page) => {
      dispatch({
        type: "maximize",
        window,
        from: placed.get(window)?.rect ?? null,
        page: page ?? pageFor(window),
      });
      flyTo(window);
    },
    [placed, pageFor, flyTo],
  );
  const restoreSize = useCallback(
    (window: number) => dispatch({ type: "restoreSize", window }),
    [],
  );
  const toggleMaximize = useCallback(
    (window: number) => {
      if (state.windows[window]?.placement === "maximized") restoreSize(window);
      else maximize(window);
    },
    [state.windows, maximize, restoreSize],
  );
  const snap = useCallback(
    (window: number, region: SnapRegion, page?: Page) => {
      dispatch({
        type: "snap",
        window,
        region,
        from: placed.get(window)?.rect ?? null,
        page: page ?? pageFor(window),
      });
      flyTo(window);
    },
    [placed, pageFor, flyTo],
  );
  const float = useCallback(
    (window: number, rect: Rectangle) => dispatch({ type: "float", window, rect }),
    [],
  );
  const setOnTop = useCallback(
    (window: number, value: boolean) => dispatch({ type: "onTop", window, value }),
    [],
  );
  const setFullscreen = useCallback(
    (window: number, value: boolean) => dispatch({ type: "fullscreen", window, value }),
    [],
  );
  const transfer = useCallback(
    (window: number, workspace: number) => {
      const root = rootOf(window);
      dispatch({ type: "transfer", windows: family(root), workspace });
      // It leaves the screen unless its new workspace shows; focus falls to what stays.
      if (focusedRoot === root && !outputShowing(state, outputs, workspace)) focus(nextAfter(root));
    },
    [rootOf, family, focusedRoot, state, outputs, nextAfter],
  );
  const closeWindow = useCallback((window: number) => close(window), []);

  const [popup, setPopup] = useState<Popup | null>(null);
  const serial = useRef(0);
  const openPopup = useCallback(
    (mode: PopupMode, options: PopupOptions = {}) => {
      const output = options.output ?? focusOutput?.name ?? outputs[0]?.name;
      if (output === undefined) return;
      setPopup({ ...mode, output, anchor: options.anchor ?? null, serial: ++serial.current });
    },
    [focusOutput, outputs],
  );
  const closePopup = useCallback(() => setPopup(null), []);

  // A press is heard just before the node it lands on hears it, so wait a moment to learn where it went.
  const insidePress = useRef(0);
  const keepPopup = useCallback(() => {
    insidePress.current = performance.now();
  }, []);
  const openSerial = popup?.serial;
  useInput(
    popup
      ? (event) => {
          if (event.kind !== "button") return;
          const heard = performance.now();
          setTimeout(() => {
            if (insidePress.current < heard - 5)
              setPopup((current) => (current?.serial === openSerial ? null : current));
          }, 60);
        }
      : null,
  );

  const stepSwitcher = useCallback(
    (by: 1 | -1, chord: boolean) => {
      setPopup((current) => {
        if (current?.mode === "switcher") {
          const count = current.list.length;
          return count === 0
            ? current
            : { ...current, index: (current.index + by + count) % count };
        }
        // Every window, minimized ones and other workspaces' too, the most lately used first.
        const used = state.history.filter((id) => roots.includes(id));
        const list = [...used, ...roots.filter((id) => !used.includes(id))];
        const output = focusOutput?.name ?? outputs[0]?.name;
        if (list.length === 0 || output === undefined) return current;
        const from = focusedRoot === null ? -1 : list.indexOf(focusedRoot);
        const index =
          from < 0 ? (by > 0 ? 0 : list.length - 1) : (from + by + list.length) % list.length;
        return {
          mode: "switcher",
          chord,
          list,
          index,
          output,
          anchor: null,
          serial: ++serial.current,
        };
      });
    },
    [state.history, roots, focusOutput, outputs, focusedRoot],
  );
  const commitSwitcher = useCallback(
    (index?: number) => {
      if (popup?.mode !== "switcher") return;
      const list = popup.list.filter((id) => windows.has(id));
      const candidate = index === undefined ? popup.list[popup.index] : popup.list[index];
      setPopup(null);
      if (candidate !== undefined && list.includes(candidate)) activate(candidate);
    },
    [popup, windows, activate],
  );

  // A popup about a window that closed has nothing left to show.
  useEffect(() => {
    if (!popup) return;
    if ((popup.mode === "menu" || popup.mode === "snap") && !windows.has(popup.window))
      setPopup(null);
    if (popup.mode === "switcher" && popup.list.every((id) => !windows.has(id))) setPopup(null);
  }, [popup, windows]);

  const [notice, setNotice] = useState<string | null>(null);
  const [popupStatus, setPopupStatus] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const notify = useCallback((text: string, seconds?: number) => {
    clearTimeout(noticeTimer.current);
    setNotice(text);
    if (seconds !== undefined)
      noticeTimer.current = setTimeout(() => setNotice(null), seconds * 1000);
  }, []);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);
  useEffect(() => {
    if (!popup) setPopupStatus(null);
  }, [popup]);
  const status = (popup ? popupStatus : null) ?? notice ?? idleNotice;

  const motion = motionOverride === "reduced" ? "reduced" : "full";

  const canvases = useRef(new Map<string, CanvasHandle>());
  const registerCanvas = useCallback((output: string, handle: CanvasHandle | null) => {
    if (handle) canvases.current.set(output, handle);
    else canvases.current.delete(output);
  }, []);
  const canvasOn = useCallback((output: string) => canvases.current.get(output), []);
  const [arrangement, setArrangement] = useArrangeSettings();
  const keyed = useRef({ output: focusOutput?.name, arrangement });
  keyed.current = { output: focusOutput?.name, arrangement };
  const canvas = useMemo<CanvasCommands>(() => {
    const here = () =>
      keyed.current.output === undefined ? undefined : canvases.current.get(keyed.current.output);
    const strengthName = (value: number) =>
      strengths.find((strength) => strength.value === value)?.name ?? "";
    return {
      toggleOverview: () => here()?.toggleOverview(),
      centerFocused: () => here()?.centerFocused(),
      flyHome: () => here()?.flyHome(),
      focusToward: (arrow) => here()?.focusToward(arrow),
      turnPage: (columns, rows) => here()?.turnPage(columns, rows),
      stackOrSpread: () => here()?.stackOrSpread(),
      fanStack: (step) => here()?.fanStack(step),
      toggleGuides: () => {
        const next = {
          ...keyed.current.arrangement,
          snapping: !keyed.current.arrangement.snapping,
        };
        setArrangement(next);
        notify(
          next.snapping
            ? "Alignment guides on: edges stick to neighbours."
            : "Alignment guides off.",
          4,
        );
      },
      toggleMagnet: () => {
        const next = { ...keyed.current.arrangement, magnet: !keyed.current.arrangement.magnet };
        setArrangement(next);
        notify(
          next.magnet ? `Magnet mode on: ${strengthName(next.strength)}.` : "Magnet mode off.",
          4,
        );
      },
      cycleMagnetStrength: () => {
        const values = strengths.map((strength) => strength.value as number);
        const strength =
          values[(values.indexOf(keyed.current.arrangement.strength) + 1) % values.length]!;
        setArrangement({ ...keyed.current.arrangement, magnet: true, strength });
        notify(`Magnet mode: ${strengthName(strength)}.`, 4);
      },
    };
  }, [setArrangement, notify]);

  const value: WarlockContextValue = {
    state,
    dispatch,
    outputs,
    windows,
    roots,
    family,
    rootOf,
    record,
    label,
    focused,
    focusedRoot,
    placed,
    stack,
    focusOutput,
    activeWorkspace,
    workspaceOf,
    workspaces,
    motion,
    activate,
    minimize,
    maximize,
    restoreSize,
    toggleMaximize,
    snap,
    float,
    setOnTop,
    setFullscreen,
    transfer,
    showWorkspace,
    closeWindow,
    canSnap,
    canPin,
    canMaximize,
    popup,
    openPopup,
    closePopup,
    keepPopup,
    stepSwitcher,
    commitSwitcher,
    status,
    notify,
    setPopupStatus,
    flyRequest,
    canvas,
    registerCanvas,
    canvasOn,
  };

  return (
    <WarlockThemeProvider value={theme}>
      <WarlockContext.Provider value={value}>{children}</WarlockContext.Provider>
    </WarlockThemeProvider>
  );
}
