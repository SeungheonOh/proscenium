import { Text } from "proscenium";
import { BarText } from "../components/bar/BarText.js";
import { colors } from "../lib/theme.js";
import { useShelf } from "./ShelfProvider.js";

/** The bar's left side: how many books are on the shelf. */
export function ShelfLabel() {
  const { state } = useShelf();
  const count = state.hand.length;
  return (
    <BarText color={colors.muted}>
      Shelf ·{" "}
      <Text weight={600} color={colors.ink}>
        {count}
      </Text>{" "}
      {count === 1 ? "book" : "books"}
    </BarText>
  );
}
