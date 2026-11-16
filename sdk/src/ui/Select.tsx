import { memo, useRef, useState, type ReactNode } from "react";
import { useOutputs } from "../hooks.js";
import type { StageClickEvent, StageElement, StageKeyboardEvent } from "../events.js";
import type { BoxProps, Style, TextProps } from "../props.js";
import { Button, type ButtonProps } from "./controls.js";
import { Glyph } from "./glyphs.js";
import { Menu, type MenuEntry } from "./Menu.js";
import { controlTransition, ringed } from "./parts.js";
import { rememberAnchor } from "./placement.js";
import { Pressable } from "./Pressable.js";
import { StyleSheet } from "./styles.js";
import { makeStyles } from "./theme.js";
import { Icon, Label } from "./views.js";

export interface SelectOption<T extends string | number> {
  value: T;
  label: string;
  /** An image before the label, in the list and on the button. */
  icon?: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string | number> {
  options: readonly SelectOption<T>[];
  /** The chosen option's value, or null for none. */
  value: T | null;
  onChange?: (value: T) => void;
  /** Shown while nothing is chosen. */
  placeholder?: string;
  disabled?: boolean;
  /** Takes keyboard focus, shown, as it appears. */
  autoFocus?: boolean;
  /** Pixels; it sizes to the chosen label without one. */
  width?: number;
  size?: "small" | "medium" | "large";
  /** The button. */
  style?: Style<BoxProps>;
  labelStyle?: Style<TextProps>;
}

const useSelect = makeStyles((theme) => {
  const { colors, radii, shadows, controls } = theme;
  const ring = ringed(theme, shadows.control);
  return {
    ...StyleSheet.create({
      button: { flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 10, paddingRight: 6, radius: radii.sm,
                fill: colors.field, border: { width: 1, color: colors.border }, shadow: ring.rest,
                transition: controlTransition(theme) },
      small: { height: controls.small, paddingLeft: 8, paddingRight: 4 },
      medium: { height: controls.medium },
      large: { height: controls.large },
      open: { border: { width: 1, color: colors.accent }, shadow: ring.focus },
      disabled: { opacity: 0.45 },
      label: { flexGrow: 1, flexShrink: 1 },
    }),
    states: { hover: { fill: colors.fieldHover, border: { color: colors.borderHover } },
              pressed: { fill: colors.fieldPress }, focusVisible: { shadow: ring.focus } },
    colors,
  };
});

/**
 * One of several options, from a list that drops down from a button:
 * `<Select options={[{ value: "a", label: "Alpha" }, …]} value={value} onChange={setValue} />`.
 * Click it, or press Enter, Space, Up or Down on it, and the list opens with the chosen
 * option focused; arrows, typing and Enter pick, Escape closes.
 */
function SelectOf<T extends string | number>({ options, value, onChange, placeholder = "Choose…", disabled = false, autoFocus,
                                               width, size = "medium", style, labelStyle }: SelectProps<T>) {
  const styles = useSelect();
  const outputs = useOutputs();
  const button = useRef<StageElement | null>(null);
  const [open, setOpen] = useState<{ keyboard: boolean } | null>(null);
  const chosen = options.findIndex((option) => option.value === value);
  const current = chosen >= 0 ? options[chosen] : undefined;
  const items: MenuEntry[] = options.map((option) => ({
    label: option.label, icon: option.icon, disabled: option.disabled, checked: option.value === value,
    onSelect: () => onChange?.(option.value),
  }));
  const openFrom = (keyboard: boolean) => setOpen({ keyboard });
  return (
    <>
      <Pressable ref={(node: StageElement | null) => { button.current = node; }}
                 style={[styles.button, styles[size], open && styles.open, disabled && styles.disabled, style]}
                 states={styles.states} width={width} disabled={disabled} autoFocus={autoFocus}
                 onPress={(event: StageClickEvent) => {
                   if (event.count > 0 && button.current) rememberAnchor(button.current, event, outputs);
                   openFrom(event.count === 0);
                 }}
                 onKeyDown={disabled ? undefined : (event: StageKeyboardEvent) => {
                   if (["Return", "KP_Enter", "space", "Up", "Down", "KP_Up", "KP_Down"].includes(event.key)) {
                     openFrom(true);
                   }
                 }}>
        {current?.icon && <Icon src={current.icon} size={16} />}
        <Label tone={current ? "ink" : "faint"} style={[styles.label, labelStyle]}>
          {current?.label ?? placeholder}
        </Label>
        <Glyph shape="chevron-down" size={14} color={styles.colors.muted} />
      </Pressable>
      <Menu open={open !== null} onClose={() => setOpen(null)} anchor={button} items={items} matchWidth
            focusIndex={open?.keyboard ? Math.max(chosen, 0) : chosen >= 0 ? chosen : undefined}
            focusVisible={open?.keyboard ?? false} />
    </>
  );
}

export const Select = memo(SelectOf) as typeof SelectOf;

export interface MenuButtonProps extends Omit<ButtonProps, "onPress" | "selected"> {
  /** The menu's entries, as a Menu's `items`. */
  items: readonly MenuEntry[] | ReactNode;
  /** A chevron after the label; true by default when there is a label. */
  chevron?: boolean;
}

/**
 * A button opening a menu below it: `<MenuButton label="File" items={[…]} />`. From the
 * keyboard (Enter or Space) the menu opens with its first item focused.
 */
export const MenuButton = memo(function MenuButton({ items, chevron, label, ...button }: MenuButtonProps) {
  const outputs = useOutputs();
  const node = useRef<StageElement | null>(null);
  const [open, setOpen] = useState<{ keyboard: boolean } | null>(null);
  const styles = useSelect();
  const withChevron = chevron ?? label !== undefined;
  return (
    <>
      <Button {...button} label={label} selected={open !== null}
              ref={(element: StageElement | null) => { node.current = element; }}
              trailing={withChevron ? <Glyph shape="chevron-down" size={12} color={styles.colors.muted} /> : undefined}
              onPress={(event) => {
                if (event.count > 0 && node.current) rememberAnchor(node.current, event, outputs);
                setOpen({ keyboard: event.count === 0 });
              }} />
      <Menu open={open !== null} onClose={() => setOpen(null)} anchor={node} items={items}
            focusFirst={open?.keyboard} />
    </>
  );
});
