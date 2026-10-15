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
  useCompositorInstance,
  useFocusedWindow,
  useOutputs,
  usePersistentReducer,
  useWindows,
  type OutputInfo,
  type WindowInfo,
} from "proscenium";
import { useApplications } from "../lib/system/applications.js";
import { appLook, type AppLook } from "./apps.js";
import { contains, type Drop } from "./model.js";
import { dropAt, sameDrop, sceneOf, type Scene, type WindowView } from "./scene.js";
import {
  initialTrellis,
  trellisReducer,
  windowsOf,
  withoutWindow,
  type TrellisAction,
  type TrellisState,
} from "./state.js";

/** How long a drop target holds before the layout opens a slot for it. */
const settleDrop = 150;
/** The window shown in the slot a drop opens. */
export const slotWindow = -1;

/** A window being dragged: where the pointer holds it, and what dropping would do. */
export interface Drag {
  window: number;
  /** Carried by its tab, while the window itself waits in place. */
  byTab: boolean;
  /** The drop under the pointer now, and the one the layout shows. */
  candidate: Drop | null;
  shown: Drop | null;
  /** How it was shown when it was picked up, and where in its box the pointer took it. */
  view: WindowView;
  grabX: number;
  grabY: number;
  /** The pointer, on screen. */
  pointerX: number;
  pointerY: number;
}

interface TrellisContextValue {
  state: TrellisState;
  act: (action: TrellisAction) => void;
  output: OutputInfo | undefined;
  /** The layout as shown: during a drag, without the dragged window and with its slot. */
  scene: Scene | null;
  drag: Drag | null;
  /** Pick WINDOW up with the pointer at (X, Y) on screen, by its tab or by itself. */
  startDrag: (window: number, byTab: boolean, view: WindowView, x: number, y: number) => void;
  moveDrag: (x: number, y: number) => void;
  endDrag: () => void;
  windows: ReadonlyMap<number, WindowInfo>;
  look: (window: number) => AppLook;
}

const TrellisContext = createContext<TrellisContextValue | null>(null);

export function useTrellis(): TrellisContextValue {
  const value = useContext(TrellisContext);
  if (!value) throw new Error("useTrellis needs a <TrellisProvider>.");
  return value;
}

/** Windows Trellis arranges: everything mapped but dialogs, which stay with their windows. */
const arranged = (window: WindowInfo) => window.mapped && window.parent === null;

export function TrellisProvider({ children }: { children: ReactNode }) {
  const output = useOutputs()[0];
  const instance = useCompositorInstance();
  const windowList = useWindows();
  const applications = useApplications();
  const focused = useFocusedWindow();
  const [state, act] = usePersistentReducer<TrellisState, TrellisAction>("trellis", trellisReducer, initialTrellis);
  const [drag, setDrag] = useState<Drag | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const windows = useMemo(() => new Map(windowList.map((window) => [window.id, window])), [windowList]);
  const area = output?.workArea;

  // New windows float on the Desktop, cascading; closed ones leave the arrangement.
  const ids = windowList.filter(arranged).map((window) => window.id);
  const idsKey = ids.join();
  useEffect(() => {
    if (!area || instance === null) return;
    const sameInstance = state.instance === instance;
    const known = new Set(sameInstance ? windowsOf(state) : []);
    const scene = sceneOf(state.root, state.floating, state.framed, area);
    const deskBox = scene.boxes.get("desktop") ?? scene.screen;
    let cascade = sameInstance ? state.floating.length : 0;
    const opened = ids.filter((id) => !known.has(id)).map((window) => {
      const info = windows.get(window);
      const width = Math.min(deskBox.width * 0.86, Math.max(480, info?.width || deskBox.width * 0.6));
      const height = Math.min(deskBox.height * 0.86, Math.max(320, info?.height || deskBox.height * 0.6));
      const step = 28 * (cascade++ % 6);
      return {
        window,
        rect: { x: (deskBox.width - width) / 2 + step, y: (deskBox.height - height) / 2 + step, width, height },
      };
    });
    if (!sameInstance || opened.length || known.size !== ids.length) {
      act({ type: "sync", instance, windows: ids, opened });
      // A window opens on the Desktop; out of view, the view goes there.
      const desk = scene.desktop;
      if (opened.length && (desk.width < scene.screen.width / 3 || desk.height < scene.screen.height / 3)) {
        act({ type: "frame", target: { node: "desktop" } });
      }
    }
  }, [idsKey, instance, area?.width, area?.height]);

  // Focus raises a floating window and brings its tab to the front.
  useEffect(() => {
    if (focused !== null && windows.has(focused)) act({ type: "activate", window: focused });
  }, [focused]);

  const shownState = useMemo(() => {
    if (!drag) return state;
    // A window lifted out leaves a gap that closes; one carried by its tab stays until dropped.
    const without = drag.byTab ? state : withoutWindow(state, drag.window);
    const shown = drag.shown;
    if (!shown || shown.kind === "float" || shown.kind === "tab") return without;
    return trellisReducer(without, { type: "drop", window: slotWindow, drop: shown });
  }, [state, drag?.window, drag?.shown]);
  // Windows lay out at no less than the size their clients accept.
  const minimumsKey = windowList.map((window) => `${window.id}:${window.minWidth}x${window.minHeight}`).join();
  const scene = useMemo(() => {
    if (!area) return null;
    const minimum = (id: number) => {
      const window = windows.get(id);
      return window && { width: window.minWidth, height: window.minHeight };
    };
    return sceneOf(shownState.root, shownState.floating, shownState.framed, area, minimum);
  }, [shownState, area?.x, area?.y, area?.width, area?.height, minimumsKey]);
  const latest = useRef({ scene, drag, state, shownState });
  latest.current = { scene, drag, state, shownState };

  const startDrag = useCallback((window: number, byTab: boolean, view: WindowView, x: number, y: number) => {
    const grabX = x - view.rect.x, grabY = y - view.rect.y;
    setDrag({ window, byTab, candidate: null, shown: null, view, grabX, grabY, pointerX: x, pointerY: y });
  }, []);

  const moveDrag = useCallback((pointerX: number, pointerY: number) => {
    const { scene, drag, shownState } = latest.current;
    if (!scene || !drag) return;
    // Over the slot it opened, the drop holds.
    const slot = scene.panels.find((panel) => panel.windows.includes(slotWindow));
    const candidate = slot && contains(slot.rect, pointerX, pointerY)
      ? drag.shown
      : dropAt(scene, shownState.root, pointerX, pointerY, drag.window);
    const moved = { ...drag, pointerX, pointerY };
    latest.current.drag = moved;
    if (sameDrop(candidate, drag.candidate)) {
      setDrag(moved);
      return;
    }
    if (settleTimer.current) clearTimeout(settleTimer.current);
    setDrag({ ...moved, candidate });
    if (sameDrop(candidate, drag.shown)) return;
    settleTimer.current = setTimeout(() => {
      setDrag((current) => (current && sameDrop(current.candidate, candidate) ? { ...current, shown: candidate } : current));
    }, settleDrop);
  }, []);

  const endDrag = useCallback(() => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
    const { scene, drag, state } = latest.current;
    setDrag(null);
    if (!scene || !drag) return;
    // Release commits what is under the pointer, settled or not.
    const drop = drag.candidate;
    if (!drop) return;
    if (drop.kind !== "float") {
      act({ type: "drop", window: drag.window, drop });
      return;
    }
    // On the Desktop it floats where it was let go, at the size it had, held where it was taken.
    const deskBox = scene.boxes.get("desktop") ?? scene.screen;
    const corner = scene.map.point(drag.pointerX - drag.grabX, drag.pointerY - drag.grabY);
    const rect = {
      x: corner.x - deskBox.x,
      y: corner.y - deskBox.y,
      width: drag.view.rect.width / scene.map.sx,
      height: drag.view.rect.height / scene.map.sy,
    };
    if (state.floating.some((float) => float.panel.windows.length === 1 && float.panel.windows[0] === drag.window)) {
      act({ type: "moveFloat", window: drag.window, rect });
    } else {
      act({ type: "drop", window: drag.window, drop, rect });
    }
  }, [act]);

  const looks = useMemo(() => new Map<string, AppLook>(), [applications]);
  const look = useCallback((window: number) => {
    const appId = windows.get(window)?.appId ?? "";
    let found = looks.get(appId);
    if (!found) looks.set(appId, (found = appLook(appId, applications)));
    return found;
  }, [windows, looks, applications]);

  const value = useMemo<TrellisContextValue>(() => ({
    state, act, output, scene, drag, startDrag, moveDrag, endDrag, windows, look,
  }), [state, act, output, scene, drag, startDrag, moveDrag, endDrag, windows, look]);
  return <TrellisContext.Provider value={value}>{children}</TrellisContext.Provider>;
}
