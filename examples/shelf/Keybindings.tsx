import { SwitcherKeys } from "../components/SwitcherKeys.js";
import { useShelf } from "./ShelfProvider.js";

/** The switcher on Super+Tab, and the keys for the open book. */
export function Keybindings() {
  const { state, dispatch, browsing } = useShelf();
  return <SwitcherKeys open={browsing} played={state.played} dispatch={dispatch} />;
}
