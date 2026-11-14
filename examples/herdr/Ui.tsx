// The herdr world's shared interaction pieces, so the same thing looks and
// behaves the same everywhere. The rules they carry:
//
//   - A row's click does the obvious thing (select, open, go); right-click or
//     its ⋯ opens a menu of everything else it can do.
//   - × only ever takes something out of view (dismiss, detach); it never
//     destroys. Destroying is in menus, as an item marked `confirm`: the first
//     choice turns it into a red confirmation in place, the second does it.
//   - One transient thing at a time (a menu, the finder, the notification
//     center, the prompt, help); Escape closes it.
//   - Hover is a faint tint; selection the accent tint with an accent bar on
//     its left, in the sidebar, the file tree, the finder and menus alike.
//   - What an action has to say (done, failed, how to) is a toast at the bottom.

import { useState, type ReactNode } from "react";
import { Box, Rect, Spacer, Text, type Rectangle, type StagePointerEvent } from "proscenium";
import { useUiScale } from "./UiScale.js";

export const look = {
  ink: "#1f2328",
  muted: "#656d76",
  faint: "#8c959f",
  line: "#d0d7de",
  panel: "#f6f8fa",
  hover: "#0000000a",
  selected: "#0969da1a",
  accent: "#0969da",
  danger: "#cf222e",
  menuEdge: "#8c959f",
};

/** A row's fill for its state, the same everywhere. */
export function rowFill(selected: boolean, hovered: boolean): string {
  return selected ? look.selected : hovered ? look.hover : "transparent";
}

/** The accent bar on a selected row's left edge. */
export function SelectedBar({ height }: { height: number }) {
  return <Rect x={0} y={0} width={2} height={height} fill={look.accent} position="absolute" />;
}

/** Where a press was, in UI units on the output: where a menu it opens goes. */
export function usePointAt(): (event: StagePointerEvent) => { x: number; y: number } {
  const scale = useUiScale();
  return (event) => ({ x: event.screenX / scale, y: event.screenY / scale });
}

/** Whether a press is the secondary button, which opens a menu wherever menus are. */
export const isMenuPress = (event: StagePointerEvent) => event.button === 273;

/** The ⋯ a row shows on hover; it opens the row's menu, as right-clicking the row does. */
export function MoreButton({ onPress }: { onPress: (at: { x: number; y: number }) => void }) {
  const [hovered, setHovered] = useState(false);
  const pointAt = usePointAt();
  return (
    <Box width={16} height={16} justifyContent="center" alignItems="center" cursor="pointer"
         fill={hovered ? "#0000001f" : "#0000000f"}
         onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
         onPointerDown={(event) => { event.stopPropagation(); onPress(pointAt(event)); }}>
      <Text size={12} weight="bold" color={look.ink}>⋯</Text>
    </Box>
  );
}

/** A plain × that takes something out of view; never one that destroys. */
export function DismissButton({ onPress, visible = true }: { onPress: () => void; visible?: boolean }) {
  const [hovered, setHovered] = useState(false);
  return (
    <Box width={16} height={16} justifyContent="center" alignItems="center" cursor="pointer" opacity={visible ? 1 : 0}
         fill={hovered ? "#0000001f" : "transparent"}
         onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
         onPointerDown={(event) => { event.stopPropagation(); onPress(); }}>
      <Text size={12} color={look.muted}>×</Text>
    </Box>
  );
}

export interface MenuItem {
  label: string;
  /** A Super+ shortcut doing the same, shown on the right. */
  keys?: string;
  onSelect: () => void;
  /** Destroys something: the first choice asks, with this text, and the second does it. */
  confirm?: string;
  disabled?: boolean;
}

export interface MenuSpec {
  title: string;
  items: (MenuItem | "separator")[];
  /** Where it opens, in UI units on the output. */
  x: number;
  y: number;
}

const itemHeight = 24;
const separatorHeight = 9;
const menuWidth = 230;

/** The one menu: a title, its items, and the in-place confirmation for an item that destroys. */
export function Menu({ menu, bounds, onDone }: { menu: MenuSpec; bounds: Rectangle; onDone: () => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const [asking, setAsking] = useState<number | null>(null);
  const separators = menu.items.filter((item) => item === "separator").length;
  const height = 22 + (menu.items.length - separators) * itemHeight + separators * separatorHeight + 2;
  const x = Math.max(bounds.x, Math.min(menu.x, bounds.x + bounds.width - menuWidth - 2));
  const y = Math.max(bounds.y, Math.min(menu.y, bounds.y + bounds.height - height - 2));
  return (
    <>
      {/* A press anywhere else closes it. */}
      <Rect x={bounds.x} y={bounds.y} width={bounds.width} height={bounds.height} fill="#00000001"
            onPointerDown={onDone} />
      <Box x={x} y={y} width={menuWidth} flexDirection="column" padding={1} fill="#ffffff"
           border={{ width: 1, color: look.menuEdge }}>
        <Box height={22} paddingX={8} alignItems="center" fill={look.panel}>
          <Text size={10.5} weight="bold" color={look.muted} maxLines={1} width={menuWidth - 18}>{menu.title}</Text>
        </Box>
        {menu.items.map((item, index) => {
          if (item === "separator") {
            return <Box key={`s${index}`} height={separatorHeight} justifyContent="center">
              <Rect width={menuWidth - 2} height={1} fill={look.line} />
            </Box>;
          }
          const confirming = asking === index;
          const destroys = item.confirm !== undefined;
          return (
            <Box key={index} height={itemHeight} paddingX={8} gap={8} alignItems="center"
                 cursor={item.disabled ? "default" : "pointer"}
                 fill={confirming ? look.danger : hover === index && !item.disabled ? look.selected : "transparent"}
                 onPointerEnter={() => setHover(index)} onPointerLeave={() => setHover(null)}
                 onPointerDown={(event) => {
                   event.stopPropagation();
                   if (item.disabled) return;
                   if (destroys && !confirming) return setAsking(index);
                   onDone();
                   item.onSelect();
                 }}>
              <Text size={12} weight={confirming ? "bold" : "normal"} maxLines={1} flexShrink={1}
                    color={confirming ? "#ffffff" : item.disabled ? look.faint : destroys ? look.danger : look.ink}>
                {confirming ? item.confirm! : destroys ? `${item.label}…` : item.label}
              </Text>
              <Spacer />
              {item.keys && !confirming && <Text size={10.5} color={look.faint}>{item.keys}</Text>}
            </Box>
          );
        })}
      </Box>
    </>
  );
}

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "error";
}

/** The toast at the bottom center: what the last action had to say. */
export function ToastView({ toast, bounds }: { toast: Toast; bounds: Rectangle }) {
  const width = Math.min(520, bounds.width - 40);
  return (
    <Box key={toast.id} x={bounds.x + (bounds.width - width) / 2} y={bounds.y + bounds.height - 44}
         width={width} height={30} paddingX={10} gap={8} alignItems="center" justifyContent="center"
         fill={toast.tone === "error" ? look.danger : look.ink} interactive={false}
         initial={{ opacity: 0 }} exit={{ opacity: 0 }}>
      <Text size={12} weight="bold" color="#ffffff" maxLines={1} width={width - 20} align="center">{toast.text}</Text>
    </Box>
  );
}

export interface KeyHelp {
  group: string;
  keys: string;
  label: string;
}

/** The help sheet: every shortcut, from the same table that binds them. */
export function HelpSheet({ entries, bounds, onClose }: { entries: readonly KeyHelp[]; bounds: Rectangle; onClose: () => void }) {
  const groups = [...new Set(entries.map((entry) => entry.group))];
  const columnWidth = 380;
  const columns = Math.max(1, Math.min(3, Math.floor((bounds.width - 40) / columnWidth)));
  const perColumn: ReactNode[][] = Array.from({ length: columns }, () => []);
  const heights = new Array(columns).fill(0);
  for (const group of groups) {
    const rows = entries.filter((entry) => entry.group === group);
    const column = heights.indexOf(Math.min(...heights));
    perColumn[column].push(
      <Box key={group} flexDirection="column" gap={2} paddingBottom={10}>
        <Text size={10.5} weight="bold" color={look.muted}>{group.toUpperCase()}</Text>
        {rows.map((entry) => (
          <Box key={entry.keys} height={18} gap={10} alignItems="center">
            <Box width={124}><Text size={11.5} weight="bold" color={look.ink} maxLines={1}>{entry.keys}</Text></Box>
            <Text size={11.5} color={look.ink} maxLines={1} width={columnWidth - 152}>{entry.label}</Text>
          </Box>
        ))}
      </Box>,
    );
    heights[column] += 24 + rows.length * 20;
  }
  const width = columns * columnWidth + 32;
  const height = Math.min(bounds.height - 40, Math.max(...heights) + 60);
  return (
    <>
      <Rect x={bounds.x} y={bounds.y} width={bounds.width} height={bounds.height} fill="#1f232833" onPointerDown={onClose} />
      <Box x={bounds.x + (bounds.width - width) / 2} y={bounds.y + (bounds.height - height) / 2}
           width={width} height={height} flexDirection="column" fill="#ffffff" border={{ width: 1, color: look.menuEdge }}>
        <Box height={26} paddingX={12} alignItems="center" fill={look.panel}>
          <Text size={12} weight="bold" color={look.ink}>Shortcuts</Text>
          <Spacer />
          <Text size={10.5} color={look.muted}>Right-click or ⋯ on anything for its menu · Escape closes</Text>
        </Box>
        <Box padding={14} gap={18}>
          {perColumn.map((column, index) => (
            <Box key={index} width={columnWidth - 18} flexDirection="column">{column}</Box>
          ))}
        </Box>
      </Box>
    </>
  );
}
