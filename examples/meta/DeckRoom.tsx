import { useEffect, useMemo, useState } from "react";
import { focus, Group, spring, Window, type StageDragEvent } from "proscenium";
import { Hand } from "../deck/Cards.js";
import { cardOf, dealCards, useDealing } from "../deck/DeckProvider.js";
import { Dialog } from "../deck/Dialog.js";
import type { Size } from "../deck/layout.js";
import { paintSwirl } from "../deck/shaders.js";
import type { HandAction, HandState } from "../lib/hand.js";
import { useMeta } from "./MetaProvider.js";
import type { RoomViewProps } from "./Rooms.js";

const fullscreenMotion = spring({ duration: 0.4, bounce: 0.1 });

/**
 * A deck room: its windows dealt as the deck deals them, the one in play on the
 * table and the rest in a hand, on the deck's swirl of paint. Its dialogs ride
 * on their windows' cards. The window in play has the keyboard while the room
 * does, and a card picked on the canvas brings the keyboard along.
 */
export function DeckRoom({ room, state, size, carry }: RoomViewProps<HandState>) {
  const { act, area, table, windows: all, windowsOf, focused, keyRoom, reveal } = useMeta();
  const ids = windowsOf(room);
  const idsKey = ids.join();
  const windows = useMemo(
    () => new Map(ids.flatMap((id) => (all.has(id) ? [[id, all.get(id)!] as const] : []))),
    [idsKey, all],
  );
  const { dialogs } = useMemo(() => dealCards([...windows.values()], windows), [windows]);
  const { hover, setHover, pops, dealing } = useDealing(state);
  const [fullscreen, setFullscreenWindow] = useState<number | null>(null);
  const spread = state.selected !== null;
  const dispatch = (action: HandAction) => act(room, { kind: "deck", action });

  // The window in play has the keyboard, or its newest dialog while one is open.
  const keyboardOf = (card: number) => dialogs.get(card)?.at(-1) ?? card;
  const keyboard = state.played === null ? null : keyboardOf(state.played);
  useEffect(() => {
    if (keyRoom === room && keyboard !== null && keyboard !== focused) focus(keyboard);
  }, [keyboard]);
  // A window or dialog that takes focus itself brings its card into play.
  useEffect(() => {
    if (focused === null || !windows.has(focused)) return;
    const card = cardOf(windows, focused);
    if (card !== state.played) dispatch({ type: "play", window: card });
  }, [focused]);

  // Only the window in play goes fullscreen, and leaves it when it leaves play.
  useEffect(() => {
    if (fullscreen !== null && fullscreen !== state.played) setFullscreenWindow(null);
  }, [state.played, fullscreen]);
  const setFullscreen = (window: number, value: boolean) => {
    if (value && window === state.played) setFullscreenWindow(window);
    else if (!value && window === fullscreen) setFullscreenWindow(null);
  };
  const shown = spread ? null : fullscreen;

  /** Playing a card takes the keyboard to it, wherever the keyboard was. */
  function play(action: HandAction) {
    dispatch(action);
    if (action.type === "play") focus(keyboardOf(action.window));
  }

  /** A card carried off the table goes to the room it was let go over. */
  function carryCard(window: number, { x, y }: StageDragEvent, card: Size) {
    carry(window, { x, y, ...card });
  }

  return (
    <>
      {/* The table turns only while the switcher is open; still, it is drawn once. */}
      <Group width={size.width} height={size.height} shaders={[{ id: "swirl", shader: paintSwirl, time: spread }]} />
      <Hand
        state={state}
        dispatch={play}
        area={area}
        table={table}
        windows={windows}
        dialogs={dialogs}
        fullscreen={shown}
        setFullscreen={setFullscreen}
        show={reveal}
        spread={spread}
        hover={hover}
        setHover={setHover}
        pops={pops}
        dealing={dealing}
        onCarry={carryCard}
      />
      {shown !== null && windows.has(shown) && (
        <Window
          window={shown}
          width={size.width}
          height={size.height}
          fullscreen
          transition={fullscreenMotion}
          onFullscreenRequest={({ value }) => setFullscreen(shown, Boolean(value))}
        >
          {(dialogs.get(shown) ?? []).map((dialog) => (
            <Dialog key={dialog} window={windows.get(dialog)!} card={size} active onActivate={() => reveal(dialog)} />
          ))}
        </Window>
      )}
    </>
  );
}
