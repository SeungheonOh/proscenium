import { createContext, memo, useContext, useRef, type ReactNode } from "react";
import { Box } from "../components.js";
import type { StageClickEvent, StageElement, StageKeyboardEvent } from "../events.js";
import type { Color } from "../color.js";
import type { BoxProps, Shadow, States, Style, TextProps } from "../props.js";
import { currentSession } from "../session.js";
import { useContextMenu, type MenuEntry } from "./Menu.js";
import { moveIndex } from "./navigation.js";
import { controlTransition } from "./parts.js";
import { Pressable } from "./Pressable.js";
import { StyleSheet } from "./styles.js";
import { makeStyles } from "./theme.js";
import { Icon, Label, type Tone } from "./views.js";

// Rows to pick from, as a launcher's results or a sidebar's places: each lights under
// the pointer and when held, the selected one is tinted, and Up and Down move keyboard
// focus through the list. A row's focus ring is drawn inside it, so a list clipped by
// its scroll container still shows it.

/** The rows of a List, so its keys can move between them. */
const ListContext = createContext<Map<StageElement, { disabled: boolean }> | null>(null);

export interface ListProps extends BoxProps {
  children?: ReactNode;
}

/** A column of ListItems that Up, Down, Home and End move focus through: `<List>{rows}</List>`. */
export function List({ children, style, onKeyDown, ...box }: ListProps) {
  const styles = useStyles();
  const rows = useRef(new Map<StageElement, { disabled: boolean }>()).current;
  const keys = (event: StageKeyboardEvent) => {
    onKeyDown?.(event);
    // Rows in the order they are laid out, top to bottom.
    const order = [...rows.entries()].sort(([a], [b]) => (a.layout?.y ?? 0) - (b.layout?.y ?? 0));
    const current = order.findIndex(([node]) => node.id === event.target.id || isWithin(event.target, node));
    const next = moveIndex(event.key, current, order.map(([, row]) => !row.disabled), false);
    if (next === undefined || next < 0 || next === current) return;
    event.stopPropagation();
    currentSession().focusNode(order[next]![0], { visible: true });
  };
  return (
    <ListContext.Provider value={rows}>
      <Box style={[styles.list, style]} {...box} onKeyDown={keys}>{children}</Box>
    </ListContext.Provider>
  );
}

function isWithin(node: StageElement, ancestor: StageElement): boolean {
  for (let at = node as StageElement & { parent?: StageElement | null } | null | undefined; at;
       at = (at as { parent?: StageElement | null }).parent) {
    if (at === ancestor) return true;
  }
  return false;
}

const useStyles = makeStyles((theme) => {
  const { colors, radii, type } = theme;
  const ringRest: Shadow = { inset: true, blur: 0, spread: 0, color: colors.accentClear };
  const ring: Shadow = { inset: true, blur: 0, spread: 2, color: colors.ring };
  return {
    ...StyleSheet.create({
      list: { flexDirection: "column", gap: 1 },
      row: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 32, paddingX: 8, paddingY: 4,
             radius: radii.sm, fill: colors.clear, shadow: [ringRest], transition: controlTransition(theme) },
      selected: { fill: colors.accentSoft },
      disabled: { opacity: 0.45 },
      texts: { flexDirection: "column", flexGrow: 1, flexShrink: 1 },
      label: { ...type.body, color: colors.ink, maxLines: 1 },
      description: { ...type.small, color: colors.muted, maxLines: 1 },
      detail: { ...type.small, color: colors.muted, maxLines: 1, flexShrink: 0 },
    }),
    states: { hover: { fill: colors.hover }, pressed: { fill: colors.press }, focusVisible: { shadow: [ring] } } satisfies States,
    selectedStates: { hover: { fill: colors.accentSoftHover }, pressed: { fill: colors.accentSoftPress },
                      focusVisible: { shadow: [ring] } } satisfies States,
  };
});

export interface ListItemProps extends Omit<BoxProps, "children" | "onContextMenu"> {
  label: string;
  /** A second line, smaller and muted. */
  description?: string;
  /** Muted words at the end: a count, a shortcut, a time. */
  detail?: string;
  /** An image before the label. */
  icon?: string;
  /** Its side; 16 by default. */
  iconSize?: number;
  iconTone?: Tone;
  /** Its color over `iconTone`; null keeps the image's own colors, as an application's icon. */
  iconTint?: Color | null;
  /** The label's text style, over the theme's. */
  labelStyle?: Style<TextProps>;
  /** Drawn before the label in place of an icon: an avatar, a placeholder. */
  leading?: ReactNode;
  /** Anything else at the end, after the detail. */
  trailing?: ReactNode;
  /** The chosen row: tinted. */
  selected?: boolean;
  disabled?: boolean;
  /** Takes keyboard focus when pressed or tabbed to; true by default. False leaves focus where it is, as in a field above the list. */
  focusable?: boolean;
  onPress?: (event: StageClickEvent) => void;
  /** A context menu for the row, opening on a right click or the Menu key. */
  menu?: readonly MenuEntry[] | ReactNode;
  /** Its context menu opened or closed: e.g. to give focus back to a field above the list. */
  onMenuOpenChange?: (open: boolean) => void;
}

/**
 * A row to pick: `<ListItem icon={folder} label="Documents" detail="12" selected={here} onPress={open} />`,
 * in a List for the arrow keys to move through.
 */
export const ListItem = memo(function ListItem({ label, description, detail, icon, iconSize = 16, iconTone, iconTint,
                                                 leading, trailing, labelStyle, onMenuOpenChange, selected = false,
                                                 disabled = false, onPress, menu, style, ...box }: ListItemProps) {
  const styles = useStyles();
  const rows = useContext(ListContext);
  const own = useRef<StageElement | null>(null);
  const context = useContextMenu(menu ?? [], { disabled: disabled || menu === undefined, onOpenChange: onMenuOpenChange });
  return (
    <Pressable {...box}
               ref={(node: StageElement | null) => {
                 if (own.current) rows?.delete(own.current);
                 own.current = node;
                 if (node) rows?.set(node, { disabled });
               }}
               style={[styles.row, selected && styles.selected, disabled && styles.disabled, style as Style<BoxProps>]}
               states={selected ? styles.selectedStates : styles.states} disabled={disabled}
               onPress={onPress} onContextMenu={context.onContextMenu}>
      {!icon && leading}
      {icon && <Icon src={icon} size={iconSize} tone={iconTone ?? (selected ? "accent" : "soft")} tint={iconTint} />}
      <Box style={styles.texts}>
        <Label style={[styles.label, labelStyle]}>{label}</Label>
        {description !== undefined && <Label style={styles.description}>{description}</Label>}
      </Box>
      {detail !== undefined && <Label style={styles.detail}>{detail}</Label>}
      {trailing}
      {context.element}
    </Pressable>
  );
});
