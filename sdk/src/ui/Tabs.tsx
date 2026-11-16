import { memo, useRef, useState } from "react";
import { Box, Rect } from "../components.js";
import type { StageElement, StageKeyboardEvent } from "../events.js";
import type { LayoutBox } from "../layout.js";
import type { BoxProps, States, Style } from "../props.js";
import { currentSession } from "../session.js";
import { SegmentedControl } from "./controls.js";
import { groupStates, ringed } from "./parts.js";
import { Pressable } from "./Pressable.js";
import { StyleSheet } from "./styles.js";
import { makeStyles } from "./theme.js";
import { Icon, Label } from "./views.js";

export interface TabOption<T extends string | number> {
  value: T;
  label: string;
  icon?: string;
  disabled?: boolean;
}

export interface TabsProps<T extends string | number> {
  options: readonly TabOption<T>[];
  value: T;
  onChange?: (value: T) => void;
  /** A line under the chosen tab, over a hairline across them all (the default); or segmented, as a SegmentedControl. */
  variant?: "underline" | "segmented";
  /** The row of tabs. */
  style?: Style<BoxProps>;
}

const useStyles = makeStyles((theme) => {
  const { colors, motion, controls } = theme;
  const ring = ringed(theme);
  return {
    ...StyleSheet.create({
      // The hairline across is the row's own bottom border.
      row: { flexDirection: "row", gap: 4, border: { width: [0, 0, 1, 0], color: colors.line } },
      tab: { height: controls.large + 4, paddingX: 10, flexDirection: "row", alignItems: "center", gap: 6, radius: 6,
             fill: colors.clear, shadow: ring.rest, transition: { default: motion.fade } },
      disabled: { opacity: 0.45 },
      indicator: { position: "absolute", height: 2, radius: 1, fill: colors.accent, transition: motion.glide },
    }),
    tabStates: { hover: { fill: colors.hover }, focusVisible: { shadow: ring.focus } } satisfies States,
    labelStates: groupStates({ hover: { color: colors.ink } }),
    motion,
  };
});

/**
 * Tabs: one of a few views, chosen from a row of labels; a line glides under the chosen
 * one. Tab reaches the chosen tab, and the arrow keys, Home and End choose another.
 * `<Tabs options={[{ value: "general", label: "General" }, …]} value={tab} onChange={setTab} />`.
 */
function TabsOf<T extends string | number>({ options, value, onChange, variant = "underline", style }: TabsProps<T>) {
  const styles = useStyles();
  const [boxes, setBoxes] = useState<Record<string, LayoutBox>>({});
  const nodes = useRef(new Map<string, StageElement>());
  if (variant === "segmented") return <SegmentedControl options={options} value={value} onChange={onChange} style={style} />;
  const index = options.findIndex((option) => option.value === value);
  const chosen = boxes[String(value)];
  const onKeyDown = (event: StageKeyboardEvent) => {
    const enabled = options.map((option) => !option.disabled);
    const step = (from: number, by: number) => {
      for (let i = 1; i <= options.length; i++) {
        const at = (from + by * i + options.length * 2) % options.length;
        if (enabled[at]) return at;
      }
      return from;
    };
    const next = { Left: step(index, -1), Right: step(index, 1), Home: step(-1, 1), End: step(options.length, -1) }[event.key];
    if (next === undefined || next < 0) return;
    const option = options[next]!;
    if (option.value !== value) onChange?.(option.value);
    const node = nodes.current.get(String(option.value));
    if (node) currentSession().focusNode(node, { visible: true });
  };
  return (
    <Box style={[styles.row, style]} onKeyDown={onKeyDown}>
      {options.map((option, at) => {
        const selected = option.value === value;
        return (
          <Pressable key={option.value}
                     ref={(node: StageElement | null) => {
                       if (node) nodes.current.set(String(option.value), node);
                       else nodes.current.delete(String(option.value));
                     }}
                     style={[styles.tab, option.disabled && styles.disabled]} states={styles.tabStates}
                     disabled={option.disabled} tabIndex={selected || (index < 0 && at === 0) ? 0 : -1}
                     onPress={() => onChange?.(option.value)}
                     onLayout={(box) => setBoxes((all) => {
                       const known = all[String(option.value)];
                       return known && known.x === box.x && known.width === box.width && known.height === box.height
                         ? all : { ...all, [option.value]: box };
                     })}>
            {option.icon && <Icon src={option.icon} size={16} tone={selected ? "ink" : "muted"} />}
            <Label variant="label" tone={selected ? "ink" : "muted"} transition={styles.motion.fade}
                   states={selected ? undefined : styles.labelStates}>{option.label}</Label>
          </Pressable>
        );
      })}
      {/* Over the hairline, under the chosen tab's label, inset from its padding. */}
      {chosen && <Rect style={styles.indicator} x={chosen.x + 6} y={chosen.y + chosen.height - 1}
                       width={Math.max(0, chosen.width - 12)} />}
    </Box>
  );
}

export const Tabs = memo(TabsOf) as typeof TabsOf;
