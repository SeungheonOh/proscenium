import { useCallback, useMemo, useSyncExternalStore } from "react";
import { currentSession } from "./session.js";
import type { Modifier } from "./events.js";
import type { CameraInfo, OutputInfo, ShareInfo, WindowInfo } from "./store.js";

/** Mapped windows in creation order. */
export function useWindows(): readonly WindowInfo[] {
  const store = currentSession().store;
  const all = useSyncExternalStore(store.subscribe, store.windows);
  return useMemo(() => all.filter((window) => window.mapped), [all]);
}

/** Ids of mapped windows in creation order; a new array only when a window maps or unmaps. */
export function useWindowIds(): readonly number[] {
  const windows = useWindows();
  const key = windows.map((window) => window.id).join();
  return useMemo(() => windows.map((window) => window.id), [key]);
}

export function useWindow(id: number): WindowInfo | undefined {
  const store = currentSession().store;
  return useSyncExternalStore(store.subscribe, () => store.window(id));
}

/** Outputs left to right, in logical pixels. */
export function useOutputs(): readonly OutputInfo[] {
  const store = currentSession().store;
  return useSyncExternalStore(store.subscribe, store.outputs);
}

/**
 * Where OUTPUT's camera (or the first output's) is headed, updated as pans and
 * zooms happen. Read-only: move the camera with moveCamera(), not by feeding
 * this back into <Camera> props.
 */
export function useCamera(output?: string): CameraInfo | undefined {
  const store = currentSession().store;
  return useSyncExternalStore(store.subscribe, () => store.camera(output));
}

/** Text copied this session, newest first, and actions on it. */
export function useClipboard(): { history: readonly string[]; copy: (text: string) => void;
                                  clear: () => void } {
  const session = currentSession();
  const history = useSyncExternalStore(session.store.subscribe, session.store.clipboard);
  return useMemo(() => ({ history, copy: (text: string) => session.copy(text),
                          clear: () => session.store.clearClipboard() }), [history, session]);
}

/** Screen-sharing requests awaiting a choice (source null) and running shares. */
export function useShares(): readonly ShareInfo[] {
  const store = currentSession().store;
  return useSyncExternalStore(store.subscribe, store.shares);
}

/** Window with keyboard focus on SEAT, or on the first seat. */
export function useFocusedWindow(seat?: string): number | null {
  const store = currentSession().store;
  return useSyncExternalStore(store.subscribe, () => store.focus(seat));
}

/**
 * The compositor process the director is connected to, or null before it says
 * hello. Window ids start over when it restarts, so state kept by window id
 * belongs to one instance: forget it when this changes.
 */
export function useCompositorInstance(): string | null {
  const store = currentSession().store;
  return useSyncExternalStore(store.subscribe, () => store.instance);
}

/** Modifiers held on SEAT, or on the first seat: e.g. to end a switcher when they are let go. */
export function useModifiers(seat?: string): readonly Modifier[] {
  const store = currentSession().store;
  return useSyncExternalStore(store.subscribe, () => store.modifiers(seat));
}

type SetState<T> = (next: T | ((previous: T) => T)) => void;

/**
 * Like useState, but kept across hot reloads, remounts and restarts: values
 * are saved as JSON next to the runtime's state, so they must be serializable.
 * Use it for layout and camera state an edited or restarted world should keep.
 */
export function usePersistentState<T>(key: string, initial: T | (() => T)): [T, SetState<T>] {
  const store = currentSession().store;
  const init = typeof initial === "function" ? initial as () => T : () => initial;
  const subscribe = useCallback((listener: () => void) => store.subscribePersistent(key, listener),
                                [store, key]);
  const value = useSyncExternalStore(subscribe, () => store.getPersistent(key, init));
  const set = useCallback<SetState<T>>((next) => {
    const previous = store.getPersistent(key, init);
    store.setPersistent(key, typeof next === "function" ? (next as (value: T) => T)(previous) : next);
  }, [store, key]);
  return [value, set];
}

/** Like useReducer, kept across hot reloads, remounts and restarts as usePersistentState is. */
export function usePersistentReducer<S, A>(key: string, reducer: (state: S, action: A) => S,
                                           initial: S | (() => S)): [S, (action: A) => void] {
  const [state, setState] = usePersistentState(key, initial);
  const dispatch = useCallback((action: A) => setState((previous) => reducer(previous, action)),
                               [setState, reducer]);
  return [state, dispatch];
}
