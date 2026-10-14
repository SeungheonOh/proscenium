import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  focus,
  useCompositorInstance,
  useFocusedWindow,
  useOutputs,
  usePersistentReducer,
  useWindows,
  type OutputInfo,
  type Rectangle,
  type WindowInfo,
} from "proscenium";
import { deckTable, type Hover } from "./layout.js";
import {
  handOf,
  handReducer,
  initialHandState,
  type HandAction,
  type HandState,
} from "../lib/hand.js";
import { fallbackArea } from "../lib/geometry.js";

/** How long a deal staggers the cards, in seconds. */
const dealTime = 0.6;

export interface DeckContextValue {
  state: HandState;
  dispatch: (action: HandAction) => void;
  /** The output the deck is dealt on, its work area and the table on it. */
  output: OutputInfo | undefined;
  area: Rectangle;
  table: Rectangle;
  /** Every mapped window, by id. */
  windows: ReadonlyMap<number, WindowInfo>;
  /** The dialogs that ride on each card, oldest first: windows that belong to it. */
  dialogs: ReadonlyMap<number, readonly number[]>;
  /** The window in play while it fills the whole output, or null. */
  fullscreen: number | null;
  setFullscreen: (window: number, value: boolean) => void;
  /** Bring the card a window or one of its dialogs is on into play. */
  show: (window: number) => void;
  /** Whether the switcher is open. */
  spread: boolean;
  /** The card under the pointer, and where on it. */
  hover: Hover | null;
  setHover: (hover: Hover | null) => void;
  /** Counts each new hover and choice, so the card they land on pops once. */
  pops: number;
  /** True for a moment after the switcher opens or closes, while cards are dealt in turn. */
  dealing: boolean;
}

const DeckContext = createContext<DeckContextValue | null>(null);

export function useDeck(): DeckContextValue {
  const value = useContext(DeckContext);
  if (!value) throw new Error("useDeck must be used inside <DeckProvider>.");
  return value;
}

/** The window WINDOW belongs to through its chain of parents: its card. */
export function cardOf(windows: ReadonlyMap<number, Pick<WindowInfo, "parent">>, window: number): number {
  let id = window;
  for (let step = 0; step < 16; step++) {
    const parent = windows.get(id)?.parent;
    if (parent === null || parent === undefined || !windows.has(parent)) return id;
    id = parent;
  }
  return id;
}

/**
 * The windows of LIST dealt as cards. Windows with a parent are dialogs: they
 * ride on their window's card, oldest first, instead of being dealt one of their own.
 */
export function dealCards(list: readonly WindowInfo[], windows: ReadonlyMap<number, WindowInfo>) {
  const cards: number[] = [];
  const dialogs = new Map<number, number[]>();
  for (const window of list) {
    const card = cardOf(windows, window.id);
    if (card === window.id) cards.push(window.id);
    else dialogs.set(card, [...(dialogs.get(card) ?? []), window.id]);
  }
  return { cards, dialogs };
}

/**
 * How the cards of hand STATE move: the card under the pointer, a count that
 * changes with each new hover and choice so the card they land on pops once,
 * and whether the cards are being dealt in turn, for a moment after the
 * switcher opens or closes.
 */
export function useDealing(state: HandState) {
  const [hover, setHover] = useState<Hover | null>(null);
  const [pops, setPops] = useState(0);
  const [dealing, setDealing] = useState(false);
  const spread = state.selected !== null;

  // A card coming into play leaves the hand, and the pointer with it.
  useEffect(() => setHover(null), [state.played]);

  // Cards deal one after another as the switcher opens or closes, then follow at once.
  useEffect(() => {
    setDealing(true);
    const timer = setTimeout(() => setDealing(false), dealTime * 1000);
    return () => clearTimeout(timer);
  }, [spread]);

  const hovered = hover?.window ?? null;
  useEffect(() => setPops((count) => count + 1), [hovered, state.selected]);

  return { hover, setHover, pops, dealing };
}

/** Owns the deck's state and shares it, with the switcher's behaviour, through `useDeck`. */
export function DeckProvider({ children }: { children: ReactNode }) {
  const list = useWindows();
  const outputs = useOutputs();
  const focused = useFocusedWindow();
  const instance = useCompositorInstance();
  const [saved, dispatch] = usePersistentReducer("deck", handReducer, initialHandState);
  // Until synced, a hand saved by an earlier compositor names windows long gone.
  const state = handOf(saved, instance);
  const { hover, setHover, pops, dealing } = useDealing(state);
  const [fullscreen, setFullscreenWindow] = useState<number | null>(null);

  const output = outputs[0];
  const area = output?.workArea ?? fallbackArea;
  const table = useMemo(() => deckTable(area), [area]);
  const spread = state.selected !== null;

  const windows = useMemo(() => new Map(list.map((window) => [window.id, window])), [list]);
  const { cards, dialogs } = useMemo(() => dealCards(list, windows), [list, windows]);

  const cardKey = cards.join(" ");
  useEffect(() => {
    if (instance !== null) dispatch({ type: "sync", windows: cards, instance });
  }, [cardKey, instance]);

  const show = (window: number) => dispatch({ type: "play", window: cardOf(windows, window) });

  // The window in play has the keyboard, or its newest dialog while one is open.
  const playedDialogs = state.played !== null ? (dialogs.get(state.played) ?? []) : [];
  const keyboard = playedDialogs[playedDialogs.length - 1] ?? state.played;
  useEffect(() => {
    if (keyboard !== null && keyboard !== focused) focus(keyboard);
  }, [keyboard]);
  // A window or dialog that takes focus itself brings its card into play.
  useEffect(() => {
    if (focused !== null && cardOf(windows, focused) !== state.played) show(focused);
  }, [focused]);

  // Only the window in play goes fullscreen, and leaves it when it leaves play.
  useEffect(() => {
    if (fullscreen !== null && fullscreen !== state.played) setFullscreenWindow(null);
  }, [state.played, fullscreen]);
  const setFullscreen = (window: number, value: boolean) => {
    if (value && window === state.played) setFullscreenWindow(window);
    else if (!value && window === fullscreen) setFullscreenWindow(null);
  };

  const value = useMemo(
    () => ({
      state,
      dispatch,
      output,
      area,
      table,
      windows,
      dialogs,
      // The switcher deals every card, the one filling the screen too.
      fullscreen: spread ? null : fullscreen,
      setFullscreen,
      show,
      spread,
      hover,
      setHover,
      pops,
      dealing,
    }),
    [
      state,
      output,
      area,
      table,
      windows,
      dialogs,
      fullscreen,
      spread,
      hover,
      setHover,
      pops,
      dealing,
    ],
  );
  return <DeckContext.Provider value={value}>{children}</DeckContext.Provider>;
}
