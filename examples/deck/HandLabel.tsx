import { Text } from "proscenium";
import { BarText } from "../components/bar/BarText.js";
import { colors } from "../lib/theme.js";
import { useDeck } from "./DeckProvider.js";

/** The bar's left side: how many cards are in hand. */
export function HandLabel() {
  const { state } = useDeck();
  return (
    <BarText color={colors.muted}>
      Deck ·{" "}
      <Text weight={600} color={colors.ink}>
        {state.hand.length}
      </Text>{" "}
      in hand
    </BarText>
  );
}
