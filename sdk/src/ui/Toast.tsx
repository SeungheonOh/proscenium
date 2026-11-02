import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Box, Rect, Screen } from "../components.js";
import { useOutputs } from "../hooks.js";
import { scale } from "../transform.js";
import type { Color } from "../color.js";
import type { BoxProps, Style, TextProps } from "../props.js";
import { StyleSheet } from "./styles.js";
import { makeStyles, useTheme, type ThemeColors } from "./theme.js";
import { Label, Surface } from "./views.js";

/** What just changed, said briefly. */
export interface ToastMessage {
  /** What it is: "Magnet", "Guides". */
  label: string;
  /** What it is now: "On · Firm", "3 columns". */
  detail?: string;
  /** The dot before it: on (the accent), off (grey), or a color of its own. */
  dot?: "on" | "off" | Color;
}

/**
 * VALUE, or while it is null the last value it had: a closing surface keeps
 * its content while it animates out.
 */
export function useRetained<T>(value: T | null): T | null {
  const kept = useRef(value);
  useEffect(() => {
    if (value !== null) kept.current = value;
  });
  return value ?? kept.current;
}

/**
 * A message to show and a function that shows one for SHOWFOR milliseconds,
 * replacing whatever was showing: `const [toast, say] = useToast()`.
 */
export function useToast(showFor = 1400): [ToastMessage | null, (message: ToastMessage) => void] {
  const [message, setMessage] = useState<ToastMessage | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = useCallback((next: ToastMessage) => {
    setMessage(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(null), showFor);
  }, [showFor]);
  return [message, show];
}

const height = 48;

const useStyles = makeStyles(({ motion }) => ({
  ...StyleSheet.create({
    row: { justifyContent: "center", transition: motion.pop },
    pill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
      height,
      paddingX: 20,
      radius: height / 2,
      transition: motion.pop,
      // Content that grows faster than the pill stays inside it.
      clip: true,
    },
    dot: { width: 10, height: 10, radius: 5, transition: motion.pop },
  }),
  motion,
}));

const shownScale = scale(1);
const hiddenScale = scale(0.92);

/** The color of a message's DOT, or undefined for none. */
function dotColor(dot: ToastMessage["dot"], colors: ThemeColors): Color | undefined {
  if (dot === "on") return colors.accent;
  if (dot === "off") return colors.faint;
  return dot;
}

interface ToastStyles {
  /** The pill. */
  style?: Style<BoxProps>;
  /** A message's label and detail. */
  labelStyle?: Style<TextProps>;
  detailStyle?: Style<TextProps>;
}

export type ToastProps = ToastStyles & (
  /** A message, or null to hide it; it keeps its words while it sinks away. */
  | { message: ToastMessage | null; shown?: never; children?: never }
  /** Content of its own, laid out in a row, shown while SHOWN. */
  | { message?: never; shown: boolean; children: ReactNode });

/**
 * A frosted pill that rises at the bottom of every output while it shows:
 * `<Toast message={toast} />`, or `<Toast shown={…}>…</Toast>` for content of
 * its own, such as a level.
 */
export function Toast(props: ToastProps) {
  const outputs = useOutputs();
  const styles = useStyles();
  const shown = props.message !== undefined ? props.message !== null : props.shown;
  const content = props.message !== undefined
    ? <MessageContent message={props.message} labelStyle={props.labelStyle} detailStyle={props.detailStyle} />
    : props.children;
  return outputs.map((output) => (
    <Screen key={output.name} output={output.name}>
      <Box style={styles.row} y={output.height - (shown ? 100 : 76)} width={output.width} opacity={shown ? 1 : 0}>
        <Surface variant="glass" style={[styles.pill, props.style]} transform={shown ? shownScale : hiddenScale}>
          {content}
        </Surface>
      </Box>
    </Screen>
  ));
}

function MessageContent({ message, labelStyle, detailStyle }: { message: ToastMessage | null } & ToastStyles) {
  const styles = useStyles();
  const { colors } = useTheme();
  // The last message stays in the pill while it sinks away.
  const shown = useRetained(message);
  if (!shown) return null;
  const dot = dotColor(shown.dot, colors);
  return (
    <>
      {dot && <Rect style={styles.dot} fill={dot} />}
      {/* New words fade in while the pill grows to hold them, and never show outside it. */}
      <Label key={`label-${shown.label}`} variant="strong" style={labelStyle} initial={{ opacity: 0 }} transition={styles.motion.pop}>
        {shown.label}
      </Label>
      {shown.detail && (
        <Label key={`detail-${shown.detail}`} tone="muted" style={detailStyle} initial={{ opacity: 0 }} transition={styles.motion.pop}>
          {shown.detail}
        </Label>
      )}
    </>
  );
}
