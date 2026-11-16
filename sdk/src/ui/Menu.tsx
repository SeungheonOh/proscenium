import { Children, Fragment, isValidElement, memo, useEffect, useRef, useState, type ReactElement,
  type ReactNode } from "react";
import { Box, Rect } from "../components.js";
import { useOutputs } from "../hooks.js";
import type { StageClickEvent, StageContextMenuEvent, StageElement, StageKeyboardEvent } from "../events.js";
import type { LayoutBox } from "../layout.js";
import type { BoxProps, States, Style } from "../props.js";
import { currentSession } from "../session.js";
import { Glyph } from "./glyphs.js";
import { moveIndex, typeahead, TypeaheadBuffer } from "./navigation.js";
import { Dismisser, Floating, focusLater, resolveAnchor, useReturnFocus, type Anchor } from "./overlay.js";
import { controlTransition } from "./parts.js";
import { rememberAnchor, type Align, type OutputRect, type Side } from "./placement.js";
import { StyleSheet } from "./styles.js";
import { makeStyles } from "./theme.js";
import { Icon, Label } from "./views.js";

// Menus: a list of commands floating over everything, opened from a button, a select or
// a right click. Items highlight under the pointer in the compositor's own frame, and
// the highlight is keyboard focus, so the pointer and the arrow keys move one and the
// same highlight. A submenu opens as the pointer rests on its item, and stays open
// while the pointer crosses other items on its way there.

export interface MenuItemProps {
  label: string;
  /** An image path or an imported image before the label, tinted as text is. */
  icon?: string;
  /** A key combination to show at the end, as a hint: "Ctrl+C". */
  shortcut?: string;
  /** A tick before the label; false leaves room for one, so checkable items line up. */
  checked?: boolean;
  disabled?: boolean;
  /** Destructive: drawn in the danger color. */
  danger?: boolean;
  /** Picked, by a click or Enter; the menu then closes. */
  onSelect?: () => void;
  /** Stay open after it is picked, e.g. to toggle several checks in a row. */
  keepOpen?: boolean;
}

export interface SubmenuProps {
  label: string;
  icon?: string;
  disabled?: boolean;
  /** Its entries, as a Menu's `items`; or give them as children. */
  items?: readonly MenuEntry[];
  children?: ReactNode;
}

/** An entry of a menu: an item, a submenu, a separator, a heading; false or null are left out. */
export type MenuEntry =
  | ({ type?: "item" } & MenuItemProps)
  | ({ type: "submenu" } & Omit<SubmenuProps, "children">)
  | { type: "separator" }
  | { type: "label"; label: string }
  | "-"
  | false | null | undefined;

type Entry =
  | ({ type: "item" } & MenuItemProps)
  | { type: "submenu"; label: string; icon?: string; disabled?: boolean; items: Entry[] }
  | { type: "separator" }
  | { type: "label"; label: string };

/** An item of a Menu given as JSX: `<MenuItem label="Copy" shortcut="Ctrl+C" onSelect={copy} />`. */
export function MenuItem(_props: MenuItemProps): ReactNode {
  return null;
}

/** A line between groups of items. */
export function MenuSeparator(): ReactNode {
  return null;
}

/** A small heading over a group of items. */
export function MenuLabel(_props: { label: string }): ReactNode {
  return null;
}

/** An item opening a menu of its own: `<Submenu label="Share"><MenuItem … /></Submenu>`. */
export function Submenu(_props: SubmenuProps): ReactNode {
  return null;
}

/** ITEMS, as a list or as JSX of MenuItem, Submenu, MenuSeparator and MenuLabel, as plain entries. */
export function menuEntries(items: readonly MenuEntry[] | ReactNode): Entry[] {
  const entries: Entry[] = [];
  const fromList = (list: readonly MenuEntry[]) => {
    for (const entry of list) {
      if (!entry) continue;
      if (entry === "-" || entry.type === "separator") entries.push({ type: "separator" });
      else if (entry.type === "label") entries.push(entry);
      else if (entry.type === "submenu") entries.push({ ...entry, items: menuEntries(entry.items ?? []) });
      else entries.push({ ...entry, type: "item" });
    }
  };
  const fromNodes = (nodes: ReactNode) => {
    Children.forEach(nodes, (node) => {
      if (!isValidElement(node)) return;
      const element = node as ReactElement<Record<string, unknown>>;
      if (element.type === Fragment) return fromNodes(element.props.children as ReactNode);
      if (element.type === MenuSeparator) entries.push({ type: "separator" });
      else if (element.type === MenuLabel) entries.push({ type: "label", label: String(element.props.label) });
      else if (element.type === MenuItem) entries.push({ type: "item", ...(element.props as unknown as MenuItemProps) });
      else if (element.type === Submenu) {
        const { items, children, ...rest } = element.props as unknown as SubmenuProps;
        entries.push({ type: "submenu", ...rest, items: items ? menuEntries(items) : menuEntries(children) });
      }
    });
  };
  if (Array.isArray(items)) fromList(items as readonly MenuEntry[]);
  else fromNodes(items as ReactNode);
  return entries;
}

const itemHeight = 28, padding = 4;

const useMenuStyles = makeStyles((theme) => {
  const { colors, radii, shadows, type, motion } = theme;
  const transition = controlTransition(theme);
  return {
    ...StyleSheet.create({
      surface: { flexDirection: "column", padding, radius: radii.md, fill: colors.popover, minWidth: 200, maxWidth: 360,
                 border: { width: 1, color: colors.popoverLine }, shadow: shadows.float },
      item: { flexDirection: "row", alignItems: "center", height: itemHeight, paddingX: 8, gap: 8, radius: radii.xs,
              fill: colors.clear, transition },
      expanded: { fill: colors.hover },
      disabled: { opacity: 0.45 },
      lead: { width: 16, height: 16, alignItems: "center", justifyContent: "center" },
      text: { ...type.body, color: colors.ink, flexGrow: 1, flexShrink: 1, maxLines: 1 },
      danger: { color: colors.danger },
      shortcut: { ...type.small, color: colors.muted, marginLeft: 16, flexShrink: 0 },
      separator: { height: 1, marginY: padding, marginX: -padding, fill: colors.popoverLine, alignSelf: "stretch" },
      heading: { height: 26, paddingX: 8, paddingTop: 4, alignItems: "center", flexDirection: "row" },
      headingIndented: { paddingLeft: 8 + 16 + 8 },
      headingText: { ...type.caption, color: colors.muted, maxLines: 1 },
    }),
    // The highlight under the pointer and on the focused item is the same, so the
    // pointer and the keys move one highlight.
    itemStates: { hover: { fill: colors.hover }, focus: { fill: colors.hover } } satisfies States,
    dangerStates: { hover: { fill: colors.dangerSoft }, focus: { fill: colors.dangerSoft } } satisfies States,
    colors,
    motion,
  };
});

/** How long the pointer rests on a submenu's item before it opens, and on another item before it closes. */
const openDelay = 160, closeDelay = 320;

interface PanelProps {
  entries: Entry[];
  anchor: Anchor;
  side?: Side;
  align?: Align;
  gap?: number;
  flipAlign?: boolean;
  matchWidth?: boolean;
  /** Closes every menu of the tree, as picking an item or a press outside does. */
  onCloseAll: () => void;
  /** Closes this submenu alone, as Left or Escape does; the root has none. */
  onBack?: () => void;
  /** Focus the first item, shown, when it opens: it was opened from the keyboard. */
  focusFirst?: boolean;
  /** Focus this entry when it opens, if it takes focus: a select's chosen option. */
  focusIndex?: number;
  /** Show the focus given as it opens as keyboard focus; true by default. */
  focusVisible?: boolean;
  /** The pointer came over it: a submenu tells its parent to keep it open. */
  onPointerEnter?: () => void;
  style?: Style<BoxProps>;
}

/** One level of a menu: its surface, items, and the submenu open from it. */
function MenuPanel({ entries, anchor, side, align, gap, flipAlign, matchWidth, onCloseAll, onBack, focusFirst,
                     focusIndex, focusVisible = true, onPointerEnter, style }: PanelProps) {
  const styles = useMenuStyles();
  const surface = useRef<StageElement | null>(null);
  const items = useRef<(StageElement | null)[]>([]);
  const boxes = useRef<(LayoutBox | null)[]>([]);
  const placed = useRef<OutputRect | null>(null);
  const focused = useRef(-1);
  const [sub, setSub] = useState<{ index: number; focus: boolean } | null>(null);
  const timers = useRef<{ open?: ReturnType<typeof setTimeout>; close?: ReturnType<typeof setTimeout> }>({});
  const buffer = useRef(new TypeaheadBuffer());
  const enabled = entries.map((entry) => (entry.type === "item" || entry.type === "submenu") && !entry.disabled);
  const labels = entries.map((entry) => ("label" in entry ? entry.label : ""));

  const focusItem = (index: number, visible: boolean) => {
    focused.current = index;
    const node = items.current[index];
    if (node) currentSession().focusNode(node, { visible });
  };
  const clearTimer = (which: "open" | "close") => {
    clearTimeout(timers.current[which]);
    timers.current[which] = undefined;
  };

  useEffect(() => {
    if (focusIndex !== undefined && enabled[focusIndex]) return focusItem(focusIndex, focusVisible);
    if (focusFirst) {
      const first = moveIndex("Home", -1, enabled);
      if (first !== undefined && first >= 0 && enabled[first]) return focusItem(first, true);
    }
    focusLater(surface.current, false);
  }, []);
  useEffect(() => () => {
    clearTimer("open");
    clearTimer("close");
  }, []);

  const openSub = (index: number, focus: boolean) => {
    clearTimer("open");
    clearTimer("close");
    setSub({ index, focus });
  };
  const select = (index: number, event: StageClickEvent) => {
    const entry = entries[index]!;
    if (entry.type === "submenu") return openSub(index, event.count === 0);
    if (entry.type !== "item") return;
    entry.onSelect?.();
    if (!entry.keepOpen) onCloseAll();
  };

  const onKeyDown = (event: StageKeyboardEvent) => {
    const { key } = event;
    const moved = moveIndex(key, focused.current, enabled);
    if (moved !== undefined) {
      if (moved >= 0 && enabled[moved]) focusItem(moved, true);
      return;
    }
    const current = entries[focused.current];
    if ((key === "Right" || key === "KP_Right") && current?.type === "submenu" && !current.disabled) {
      openSub(focused.current, true);
    } else if (key === "Left" || key === "KP_Left") {
      onBack?.();
    } else if (key === "Escape") {
      if (onBack) onBack();
      else onCloseAll();
    } else if (event.text && event.text.trim() && !event.modifiers.some((modifier) => modifier === "control"
                                                                       || modifier === "alt" || modifier === "logo")) {
      const found = typeahead(buffer.current.add(event.text), labels, enabled, focused.current);
      if (found >= 0) focusItem(found, true);
    }
  };

  // One leading column for every item when any has an icon or can be checked, so labels line up.
  const leadingColumn = entries.some((other) => (other.type === "item" && other.checked !== undefined)
                                            || ("icon" in other && !!other.icon));
  const subEntry = sub ? entries[sub.index] : undefined;
  const subAnchor = (): OutputRect | null => {
    const panel = placed.current, box = sub ? boxes.current[sub.index] : null;
    if (!panel || !box) return null;
    // Beside the whole panel, its first item level with the item that opened it.
    return { output: panel.output, x: panel.x, y: panel.y + box.y - padding, width: panel.width, height: box.height };
  };
  const subRect = sub ? subAnchor() : null;

  return (
    <>
      <Floating anchor={anchor} side={side} align={align} gap={gap} flipAlign={flipAlign} matchWidth={matchWidth}
                style={[styles.surface, style]}
                onPlace={(placement) => { placed.current = placement; }}
                surface={{
                  ref: (node: StageElement | null) => { surface.current = node; },
                  tabIndex: -1,
                  focusScope: true,
                  onKeyDown,
                  onPointerEnter: () => {
                    clearTimer("close");
                    onPointerEnter?.();
                  },
                }}>
        {entries.map((entry, index) => {
          if (entry.type === "separator") return <Rect key={index} style={styles.separator} />;
          if (entry.type === "label") {
            // Level with the items' text, past their leading column when they have one.
            return (
              <Box key={index} style={[styles.heading, leadingColumn && styles.headingIndented]}>
                <Label style={styles.headingText}>{entry.label}</Label>
              </Box>
            );
          }
          const disabled = !!entry.disabled;
          const danger = entry.type === "item" && !!entry.danger;
          const checkable = leadingColumn;
          return (
            <Box key={index}
                 ref={(node: StageElement | null) => { items.current[index] = node; }}
                 style={[styles.item, sub?.index === index && styles.expanded, disabled && styles.disabled]}
                 states={disabled ? undefined : danger ? styles.dangerStates : styles.itemStates}
                 tabIndex={disabled ? undefined : -1}
                 onLayout={(box) => { boxes.current[index] = box; }}
                 onClick={disabled ? undefined : (event) => select(index, event)}
                 onPointerEnter={disabled ? undefined : () => {
                   focusItem(index, false);
                   clearTimer("open");
                   if (sub && sub.index !== index) {
                     clearTimer("close");
                     timers.current.close = setTimeout(() => setSub(null), closeDelay);
                   }
                   if (entry.type === "submenu" && sub?.index !== index) {
                     timers.current.open = setTimeout(() => openSub(index, false), openDelay);
                   }
                 }}
                 onPointerLeave={disabled ? undefined : () => {
                   clearTimer("open");
                   if (focused.current === index) {
                     focused.current = -1;
                     focusLater(surface.current, false);
                   }
                 }}>
              {checkable && (
                <Box style={styles.lead}>
                  {entry.type === "item" && entry.checked
                    ? <Glyph shape="check" size={14} color={danger ? styles.colors.danger : styles.colors.ink} />
                    : entry.icon ? <Icon src={entry.icon} size={16} tone={danger ? "danger" : "ink"} /> : null}
                </Box>
              )}
              <Label style={[styles.text, danger && styles.danger]}>{entry.label}</Label>
              {entry.type === "item" && entry.shortcut && <Label style={styles.shortcut}>{entry.shortcut}</Label>}
              {entry.type === "submenu" && <Glyph shape="chevron-right" size={14} color={styles.colors.muted} />}
            </Box>
          );
        })}
      </Floating>
      {subEntry?.type === "submenu" && subRect && (
        <MenuPanel key={sub!.index} entries={subEntry.items} anchor={subRect} side="right" align="start" gap={-1}
                   flipAlign onCloseAll={onCloseAll} focusFirst={sub!.focus}
                   onPointerEnter={() => clearTimer("close")}
                   onBack={() => {
                     const index = sub!.index;
                     setSub(null);
                     focusItem(index, true);
                   }} />
      )}
    </>
  );
}

export interface MenuProps {
  /** Shown while true. */
  open: boolean;
  /** A press outside, Escape, or picking an item asks it to close. */
  onClose: () => void;
  /** What it opens beside: a node (from a ref), or a point or box on an output; see Anchor. */
  anchor: Anchor;
  /** Its entries, as a list (`{ label, onSelect, shortcut, checked, icon, danger, disabled }`, `"-"`,
   * `{ type: "submenu", label, items }`, `{ type: "label", label }`), or as JSX of MenuItem,
   * Submenu, MenuSeparator and MenuLabel. */
  items: readonly MenuEntry[] | ReactNode;
  /** The side of the anchor it opens on; below by default, flipping above when there is no room. */
  side?: Side;
  align?: Align;
  gap?: number;
  /** At least as wide as the anchor. */
  matchWidth?: boolean;
  /** Line up its other edge with the anchor when there is no room, rather than shifting; for menus at a point. */
  flipAlign?: boolean;
  /** Focus its first item, shown, as it opens: it was opened from the keyboard. */
  focusFirst?: boolean;
  /** Focus this entry (an index into its entries) as it opens: a select's chosen option. */
  focusIndex?: number;
  /** Show the focus given as it opens as keyboard focus; true by default. */
  focusVisible?: boolean;
  /** The surface. */
  style?: Style<BoxProps>;
}

/**
 * A menu of commands beside an anchor: `<Menu open={open} onClose={() => setOpen(false)}
 * anchor={buttonRef} items={[{ label: "Rename", onSelect: rename }, "-", { label: "Delete", danger: true }]} />`.
 * Arrow keys, Home and End move through it, typing jumps to an item, Enter picks, Right
 * and Left open and close submenus, Escape closes; focus returns to the anchor after.
 */
export const Menu = memo(function Menu({ open, onClose, anchor, items, side, align, gap, matchWidth, flipAlign,
                                         focusFirst, focusIndex, focusVisible, style }: MenuProps) {
  useReturnFocus(open, anchor);
  if (!open) return null;
  return (
    <>
      <Dismisser onDismiss={onClose} />
      <MenuPanel entries={menuEntries(items)} anchor={anchor} side={side} align={align} gap={gap}
                 matchWidth={matchWidth} flipAlign={flipAlign} focusFirst={focusFirst} focusIndex={focusIndex}
                 focusVisible={focusVisible} onCloseAll={onClose}
                 style={style} />
    </>
  );
});

/** Where a context menu opens for EVENT: at the pointer, or below the node from the keyboard. */
function menuPoint(event: StageContextMenuEvent, outputs: ReturnType<typeof useOutputs>): Anchor | null {
  if (!event.keyboard && event.output && event.screenX !== undefined && event.screenY !== undefined) {
    return { output: event.output, x: event.screenX, y: event.screenY };
  }
  const rect = resolveAnchor(event.currentTarget, outputs);
  return rect ? { output: rect.output, x: rect.x, y: rect.y + rect.height } : null;
}

/**
 * A context menu for any node: `const menu = useContextMenu(items)`, then
 * `<Box onContextMenu={menu.onContextMenu}>…{menu.element}</Box>`. The menu opens at
 * the pointer on a right press, or below the node on Menu or Shift+F10.
 */
export function useContextMenu(items: readonly MenuEntry[] | ReactNode, options: { disabled?: boolean;
  onOpenChange?: (open: boolean) => void } = {}) {
  const outputs = useOutputs();
  const [at, setAt] = useState<{ anchor: Anchor; keyboard: boolean } | null>(null);
  const onContextMenu = options.disabled ? undefined : (event: StageContextMenuEvent) => {
    event.stopPropagation();
    if (!event.keyboard) rememberAnchor(event.currentTarget, event, outputs);
    const anchor = menuPoint(event, outputs);
    if (!anchor) return;
    setAt({ anchor, keyboard: !!event.keyboard });
    options.onOpenChange?.(true);
  };
  const close = () => {
    setAt(null);
    options.onOpenChange?.(false);
  };
  const element = at
    ? <Menu open onClose={close} anchor={at.anchor} items={items} gap={0} flipAlign focusFirst={at.keyboard} />
    : null;
  return { onContextMenu, element, open: at !== null, close };
}

export interface ContextMenuProps extends Omit<BoxProps, "onContextMenu"> {
  /** The menu's entries, as a Menu's `items`. */
  items: readonly MenuEntry[] | ReactNode;
  /** No menu opens. */
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** What a right click on opens the menu: laid out in this Box. */
  children?: ReactNode;
}

/**
 * A Box whose children open a menu on a right click, at the pointer, or on Menu or
 * Shift+F10 when focus is in them:
 * `<ContextMenu items={[{ label: "Copy", onSelect: copy }]}><Card /></ContextMenu>`.
 */
export function ContextMenu({ items, disabled, onOpenChange, children, ...box }: ContextMenuProps) {
  const menu = useContextMenu(items, { disabled, onOpenChange });
  return (
    <Box {...box} onContextMenu={menu.onContextMenu}>
      {children}
      {menu.element}
    </Box>
  );
}
