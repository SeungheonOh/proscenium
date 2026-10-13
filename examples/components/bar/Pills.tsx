import { Box, Rect, spring } from "proscenium";
import { colors } from "../../lib/theme.js";

const pillMotion = spring({ duration: 0.3, bounce: 0.1 });

interface PillsProps<Item> {
  items: readonly Item[];
  /** The item shown, a wide accent pill. */
  shown: Item | null;
  /** Items with windows, darker than the empty ones. */
  occupied: ReadonlySet<Item>;
  onPick: (item: Item) => void;
}

/** The bar's places as pills: workspaces, rooms or faces. */
export function Pills<Item extends string | number>({ items, shown, occupied, onPick }: PillsProps<Item>) {
  return (
    <Box flexDirection="row" alignItems="center">
      {items.map((item) => (
        // Each pill's Box is a larger target than the pill itself.
        <Box key={item} paddingX={3} paddingY={12} cursor="pointer" onPointerDown={() => onPick(item)}>
          <Rect
            width={item === shown ? 22 : 8}
            height={8}
            radius={4}
            fill={item === shown ? colors.accent : colors.ink}
            opacity={item === shown ? 1 : occupied.has(item) ? 0.55 : 0.18}
            transition={pillMotion}
          />
        </Box>
      ))}
    </Box>
  );
}
