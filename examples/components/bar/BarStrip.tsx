import { useState, type ComponentType } from "react";
import {
  Box,
  Rect,
  Screen,
  Spacer,
  useClipboard,
  useFocusedWindow,
  useWindow,
  type LayoutBox,
  type OutputInfo,
} from "proscenium";
import { useContextMenu } from "proscenium/ui";
import { liquidGlass } from "../../lib/effects.js";
import { colors, glassBorder, motion } from "../../lib/theme.js";
import { RollingText } from "./BarText.js";
import { Clock } from "./Clock.js";
import { Highlight } from "./Highlight.js";
import { barLayout } from "./layout.js";
import type { StatusItem } from "./useStatusItems.js";

/** Centers the title on the bar while that clears the items, else centers it left of them. */
function titleSpan(barWidth: number, itemsLeft: number) {
  const left = 180;
  const right = itemsLeft - 12;
  const half = Math.min(260, barWidth / 2 - left, right - barWidth / 2);
  return half >= 120
    ? { x: barWidth / 2 - half, width: 2 * half }
    : { x: left, width: Math.max(0, right - left) };
}

export interface BarStripProps {
  output: OutputInfo;
  items: readonly StatusItem[];
  start?: ComponentType<{ output: OutputInfo }>;
  /** Whether the middle names the focused window. */
  windowTitle: boolean;
  /** Key of the item whose menu is open on this output. */
  openItem: string | null;
  /** RIGHT is the item's right edge on the output, for its menu to hang from. */
  onPress: (item: StatusItem, right: number) => void;
  onDismiss: () => void;
}

/** The bar on one output. */
export function BarStrip({
  output,
  items,
  start: Start,
  windowTitle,
  openItem,
  onPress,
  onDismiss,
}: BarStripProps) {
  const focused = useFocusedWindow();
  const window = useWindow(focused ?? -1);
  const [hoveredItem, setHoveredItem] = useState<string | null>(null);
  // Where layout put the status area and each item in it, for the title, highlight and menus.
  const [status, setStatus] = useState<LayoutBox | null>(null);
  const [itemBoxes, setItemBoxes] = useState<Record<string, LayoutBox>>({});

  const { height, margin, inset } = barLayout;
  const width = output.width - 2 * margin;
  const title = titleSpan(width, status?.x ?? width);
  const highlightKey = openItem ?? hoveredItem;
  const highlighted = items.some((item) => item.key === highlightKey)
    ? (itemBoxes[highlightKey!] ?? null)
    : null;

  function handlePress(item: StatusItem) {
    const box = itemBoxes[item.key];
    onPress(item, margin + (status?.x ?? 0) + (box ? box.x + box.width : 0));
  }

  return (
    <Screen output={output.name}>
      <Box
        layoutId={`bar:${output.name}`}
        x={margin}
        y={margin}
        width={width}
        height={height}
        flexDirection="row"
        alignItems="center"
        paddingX={inset}
        radius={12}
        fill="#ffffff70"
        border={glassBorder}
        shaders={[{ id: "glass", shader: liquidGlass, uniforms: { frost: 12 } }]}
        shadow={{ color: "#00000024", blur: 26, y: 6 }}
        clip
        initial={{ opacity: 0, y: margin - 18 }}
        transition={motion.arrive}
      >
        {Start && <Start output={output} />}

        {windowTitle && (
          <Box position="absolute" x={title.x} height={height} alignItems="center">
            <RollingText
              identity={focused ?? "desktop"}
              width={title.width}
              align="center"
              weight={600}
              color={window ? colors.ink : "#17171a80"}
            >
              {window?.title || "Desktop"}
            </RollingText>
          </Box>
        )}

        <Spacer />
        <Box flexDirection="row" alignItems="center" height={height} onLayout={setStatus}>
          <Highlight target={highlighted} active={openItem !== null} />
          {items.map((item) => (
            <BarItem
              key={item.key}
              item={item}
              onLayout={(box) => setItemBoxes((boxes) => ({ ...boxes, [item.key]: box }))}
              onPointerEnter={() => setHoveredItem(item.key)}
              onPointerLeave={() => setHoveredItem((key) => (key === item.key ? null : key))}
              onPress={() => handlePress(item)}
            />
          ))}
          <ClockItem />
        </Box>
      </Box>

      {openItem !== null && (
        // A click anywhere outside the open menu closes it.
        <Rect width={output.width} height={output.height} onPointerDown={onDismiss} />
      )}
    </Screen>
  );
}

interface BarItemProps {
  item: StatusItem;
  onLayout: (box: LayoutBox) => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onPress: () => void;
}

/** One status item: the primary button opens its menu, the secondary its context menu. */
function BarItem({ item, onLayout, onPointerEnter, onPointerLeave, onPress }: BarItemProps) {
  const context = useContextMenu(item.contextMenu ?? [], { disabled: !item.contextMenu });
  return (
    <Box
      flexDirection="row"
      alignItems="center"
      gap={6}
      height={barLayout.height}
      paddingX={10}
      cursor="pointer"
      onLayout={onLayout}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerDown={(event) => {
        if ((event.button ?? 272) === 272) onPress();
      }}
      onContextMenu={context.onContextMenu}
    >
      {item.content}
      {context.element}
    </Box>
  );
}

const copyTime = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const copyDate = new Intl.DateTimeFormat(undefined, { dateStyle: "full" });

/** The clock, whose context menu copies the date or the time. */
function ClockItem() {
  const clipboard = useClipboard();
  const context = useContextMenu([
    { label: "Copy time", onSelect: () => clipboard.copy(copyTime.format(new Date())) },
    { label: "Copy date", onSelect: () => clipboard.copy(copyDate.format(new Date())) },
  ]);
  return (
    <Box flexDirection="row" alignItems="center" height={barLayout.height} onContextMenu={context.onContextMenu}>
      <Clock />
      {context.element}
    </Box>
  );
}
