/**
 * One window in play and the rest in a hand, as the deck and the shelf keep
 * them, as a pure reducer: the window in play, the others in the order they lie,
 * and the order windows were last played, which the switcher follows as Alt+Tab
 * does.
 */

export interface HandState {
  /** The window in play, which is shown whole and takes input. */
  played: number | null;
  /** Every other window, left to right. */
  hand: number[];
  /** Every window, most recently played first. */
  recent: number[];
  /** While the switcher is open, the card it would play. */
  selected: number | null;
  /** The compositor instance the window ids belong to. */
  instance: string | null;
}

export const initialHandState: HandState = {
  played: null,
  hand: [],
  recent: [],
  selected: null,
  instance: null,
};

/** STATE while its window ids belong to compositor INSTANCE; an empty hand otherwise. */
export function handOf(state: HandState, instance: string | null): HandState {
  return state.instance === instance ? state : initialHandState;
}

export type HandAction =
  /** The mapped windows changed: a new one comes into play, closed ones leave. */
  | { type: "sync"; windows: readonly number[]; instance: string }
  /** Put a window into play; the one in play takes its place in the hand. */
  | { type: "play"; window: number }
  /** Open the switcher on the window played before the current one. */
  | { type: "spread" }
  /** Move the switcher's choice by STEP cards, or to a window. */
  | { type: "cycle"; step: number }
  | { type: "choose"; window: number }
  /** Close the switcher, playing its choice unless cancelled. */
  | { type: "fold"; play: boolean };

function play(state: HandState, window: number): HandState {
  const recent = [window, ...state.recent.filter((id) => id !== window)];
  if (window === state.played) return { ...state, recent, selected: null };
  const hand =
    state.played === null
      ? state.hand.filter((id) => id !== window)
      : state.hand.map((id) => (id === window ? state.played! : id));
  return { ...state, played: window, hand, recent, selected: null };
}

function sync(state: HandState, windows: readonly number[], instance: string): HandState {
  // Window ids start over with the compositor: the old ones name nothing now.
  if (state.instance !== instance) state = { ...initialHandState, instance };
  const live = new Set(windows);
  const known = new Set(state.recent);
  const fresh = windows.filter((id) => !known.has(id));
  let next: HandState = {
    ...state,
    played: state.played !== null && live.has(state.played) ? state.played : null,
    hand: state.hand.filter((id) => live.has(id)),
    recent: state.recent.filter((id) => live.has(id)),
    selected: state.selected !== null && live.has(state.selected) ? state.selected : null,
  };
  // A new window is dealt straight into play; the one it replaces joins the hand.
  for (const window of fresh) {
    next = {
      ...next,
      hand: next.played === null ? next.hand : [...next.hand, next.played],
      played: null,
    };
    next = play(next, window);
  }
  // With the played window gone, the one played before it returns.
  const previous = next.recent[0];
  if (next.played === null && previous !== undefined) next = play(next, previous);
  return next;
}

export function handReducer(state: HandState, action: HandAction): HandState {
  switch (action.type) {
    case "sync":
      return sync(state, action.windows, action.instance);

    case "play":
      return state.recent.includes(action.window) ? play(state, action.window) : state;

    case "spread":
      return { ...state, selected: state.recent[1] ?? state.recent[0] ?? null };

    case "cycle": {
      const count = state.recent.length;
      if (count === 0 || state.selected === null) return state;
      const index = state.recent.indexOf(state.selected);
      return { ...state, selected: state.recent[(((index + action.step) % count) + count) % count]! };
    }

    case "choose":
      return state.selected === null || !state.recent.includes(action.window)
        ? state
        : { ...state, selected: action.window };

    case "fold":
      if (state.selected === null) return state;
      return action.play ? play(state, state.selected) : { ...state, selected: null };
  }
}
