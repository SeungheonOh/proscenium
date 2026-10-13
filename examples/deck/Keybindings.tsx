import { SwitcherKeys } from "../components/SwitcherKeys.js";
import { useDeck } from "./DeckProvider.js";

/** The switcher on Super+Tab, and the keys for the window in play. */
export function Keybindings() {
  const { state, dispatch, spread } = useDeck();
  return <SwitcherKeys open={spread} played={state.played} dispatch={dispatch} />;
}
