import { memo, useRef, useState, type ReactNode } from "react";
import { Box, Group, Rect } from "../components.js";
import type { Color } from "../color.js";
import type { StagePointerEvent } from "../events.js";
import type { LayoutBox } from "../layout.js";
import type { BoxProps, ImageProps, PointerHandlers, RectProps, Style, TextProps } from "../props.js";
import { Pressable, type PressState } from "./Pressable.js";
import { resolveStyle, StyleSheet, variants, type StateStyle } from "./styles.js";
import { makeStyles } from "./theme.js";
import { Icon, Label, type Tone } from "./views.js";

// Every control takes `style` for its root and a style for each of its parts. Any of
// them may be a function of the control's state, as Pressable's is. Looks by state
// are styles made once per theme, so a hover only swaps one made style for another
// and the compositor fades between them.

/** A pressable control's state, as its style functions see it. */
export interface ControlState extends PressState {
  selected: boolean;
  disabled: boolean;
}

type Look = "rest" | "hover" | "press";

function look({ hovered, pressed }: PressState): Look {
  return pressed ? "press" : hovered ? "hover" : "rest";
}

/** Image props a style may set. */
type ImageStyle = Omit<ImageProps, "src" | "ref" | "style" | `on${string}`>;

export type ButtonVariant = "plain" | "tinted" | "filled";

const buttonTones: Record<ButtonVariant, Tone> = { plain: "ink", tinted: "accent", filled: "onAccent" };

const useButton = makeStyles(({ colors, radii, motion }) => variants({
  base: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    border: { width: 1, color: colors.accentClear },
    transition: motion.pop,
  },
  variants: {
    variant: { plain: {}, tinted: {}, filled: {} } satisfies Record<ButtonVariant, BoxProps>,
    size: {
      small: { height: 26, paddingX: 8, gap: 4, radius: radii.sm },
      medium: { height: 32, paddingX: 12, gap: 6, radius: radii.md },
    },
    look: { rest: {}, hover: {}, press: {} } satisfies Record<Look, BoxProps>,
    selected: { true: {}, false: {} },
    disabled: { true: { opacity: 0.4 }, false: {} },
  },
  defaults: { variant: "plain", size: "medium", look: "rest", selected: false, disabled: false },
  compound: [
    { when: { variant: "plain", look: "rest" }, style: { fill: colors.clear } },
    { when: { variant: "plain", look: "hover" }, style: { fill: colors.hover } },
    { when: { variant: "plain", look: "press" }, style: { fill: colors.press } },
    { when: { variant: "tinted", look: "rest" }, style: { fill: colors.accentSoft } },
    { when: { variant: "tinted", look: "hover" }, style: { fill: colors.accentSoftHover } },
    { when: { variant: "tinted", look: "press" }, style: { fill: colors.accentSoftPress } },
    { when: { variant: "filled", look: "rest" }, style: { fill: colors.accent } },
    { when: { variant: "filled", look: "hover" }, style: { fill: colors.accentHover } },
    { when: { variant: "filled", look: "press" }, style: { fill: colors.accentPress } },
    // A picked tool keeps its tint whatever the pointer does.
    { when: { variant: "plain", selected: true }, style: { fill: colors.accentTint } },
    { when: { selected: true }, style: { border: { width: 1, color: colors.accentLine } } },
  ],
}));

export interface ButtonProps extends Omit<BoxProps, "children" | "style" | keyof PointerHandlers> {
  /** Its words; leave out for an icon alone. */
  label?: string;
  /** An image path or an imported image, before the label, tinted as the label is. */
  icon?: string;
  /** Plain (the default) shows only on hover; tinted is a soft accent; filled is the solid accent. */
  variant?: ButtonVariant;
  size?: "small" | "medium";
  /** On, as a tool picked in a toolbar: tinted and ringed with the accent. */
  selected?: boolean;
  disabled?: boolean;
  onPress?: () => void;
  style?: StateStyle<BoxProps, ControlState>;
  labelStyle?: StateStyle<TextProps, ControlState>;
  iconStyle?: StateStyle<ImageStyle, ControlState>;
}

/**
 * A button with a label, an icon or both: `<Button label="Save" variant="filled" onPress={save} />`.
 * Restyle it in any state: `style={({ hovered }) => hovered && styles.glow}`.
 */
export const Button = memo(function Button({ label, icon, variant = "plain", size, selected = false, disabled = false,
                                             onPress, style, labelStyle, iconStyle, ...props }: ButtonProps) {
  const button = useButton();
  const iconSize = size === "small" ? 14 : 16;
  return (
    <Pressable {...props} disabled={disabled} onPress={onPress}
               style={(press) => [button({ variant, size, look: look(press), selected, disabled }),
                                  resolveStyle(style, { ...press, selected, disabled })]}>
      {(press) => {
        const state = { ...press, selected, disabled };
        return (
          <>
            {icon && <Icon src={icon} size={iconSize} tone={buttonTones[variant]} style={resolveStyle(iconStyle, state)} />}
            {label !== undefined && (
              <Label variant="strong" tone={buttonTones[variant]} style={resolveStyle(labelStyle, state)}>{label}</Label>
            )}
          </>
        );
      }}
    </Pressable>
  );
});

const useIconButton = makeStyles(({ colors, radii, motion }) => variants({
  base: {
    alignItems: "center",
    justifyContent: "center",
    radius: radii.md,
    border: { width: 1, color: colors.accentClear },
    transition: motion.pop,
  },
  variants: {
    look: {
      rest: { fill: colors.clear },
      hover: { fill: colors.hover },
      press: { fill: colors.press },
    } satisfies Record<Look, BoxProps>,
    selected: { true: { fill: colors.accentTint, border: { width: 1, color: colors.accentLine } }, false: {} },
    disabled: { true: { opacity: 0.4 }, false: {} },
  },
  defaults: { look: "rest", selected: false, disabled: false },
}));

export interface IconButtonProps extends Omit<BoxProps, "children" | "style" | keyof PointerHandlers> {
  /** An image path or an imported image; or give children to draw something else. */
  icon?: string;
  children?: ReactNode;
  /** Its side, in pixels; defaults to 36. */
  size?: number;
  /** The icon's side; defaults to 20. */
  iconSize?: number;
  /** The icon's color, the theme's ink by default; null keeps the image's own colors. */
  iconTint?: Color | null;
  /** On, as a tool picked in a toolbar. */
  selected?: boolean;
  disabled?: boolean;
  onPress?: () => void;
  style?: StateStyle<BoxProps, ControlState>;
  iconStyle?: StateStyle<ImageStyle, ControlState>;
}

/** A square button holding an icon, as in a toolbar: `<IconButton icon={pen} selected={tool === "pen"} onPress={…} />`. */
export const IconButton = memo(function IconButton({ icon, children, size = 36, iconSize = 20, iconTint, selected = false,
                                                     disabled = false, onPress, style, iconStyle,
                                                     ...props }: IconButtonProps) {
  const iconButton = useIconButton();
  return (
    <Pressable {...props} width={size} height={size} disabled={disabled} onPress={onPress}
               style={(press) => [iconButton({ look: look(press), selected, disabled }),
                                  resolveStyle(style, { ...press, selected, disabled })]}>
      {(press) => (icon
        ? <Icon src={icon} size={iconSize} tint={iconTint} style={resolveStyle(iconStyle, { ...press, selected, disabled })} />
        : children)}
    </Pressable>
  );
});

/** A switch's state, as its style functions see it. */
export interface SwitchState extends PressState {
  value: boolean;
  disabled: boolean;
}

const useSwitch = makeStyles(({ colors, shadows, motion }) => ({
  track: variants({
    base: { width: 36, height: 20, radius: 10, paddingX: 2, alignItems: "center", transition: motion.pop },
    variants: {
      value: { true: { justifyContent: "flex-end", fill: colors.accent }, false: { justifyContent: "flex-start", fill: colors.control } },
      hovered: { true: {}, false: {} },
      disabled: { true: { opacity: 0.4 }, false: {} },
    },
    defaults: { value: false, hovered: false, disabled: false },
    compound: [{ when: { value: false, hovered: true }, style: { fill: colors.controlHover } }],
  }),
  knob: StyleSheet.create({
    knob: { width: 16, height: 16, radius: 8, fill: colors.knob, shadow: shadows.knob, transition: motion.pop },
  }).knob,
}));

export interface SwitchProps {
  value: boolean;
  onValueChange?: (value: boolean) => void;
  disabled?: boolean;
  /** The track. */
  style?: StateStyle<BoxProps, SwitchState>;
  knobStyle?: StateStyle<RectProps, SwitchState>;
}

/** An on/off switch; the knob slides across as the compositor animates its new place. */
export const Switch = memo(function Switch({ value, onValueChange, disabled = false, style, knobStyle }: SwitchProps) {
  const styles = useSwitch();
  return (
    <Pressable disabled={disabled} onPress={() => onValueChange?.(!value)}
               style={(press) => [styles.track({ value, hovered: press.hovered, disabled }),
                                  resolveStyle(style, { ...press, value, disabled })]}>
      {(press) => <Rect style={[styles.knob, resolveStyle(knobStyle, { ...press, value, disabled })]} />}
    </Pressable>
  );
});

const useSegments = makeStyles(({ colors, radii, motion }) => ({
  ...StyleSheet.create({
    segments: { flexDirection: "row", padding: 2, radius: radii.md, fill: colors.hover },
    disabled: { opacity: 0.4 },
    segment: { height: 26, paddingX: 12, radius: 7, alignItems: "center", justifyContent: "center" },
    indicator: { position: "absolute", radius: 7, fill: colors.raised, shadow: { color: "#0000001f", blur: 4, y: 1 },
                 transition: motion.glide },
  }),
  motion,
}));

export interface SegmentedControlProps<T extends string | number> {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange?: (value: T) => void;
  disabled?: boolean;
  /** The row holding the segments. */
  style?: Style<BoxProps>;
  segmentStyle?: StateStyle<BoxProps, ControlState>;
  labelStyle?: StateStyle<TextProps, ControlState>;
  /** The card under the chosen segment. */
  indicatorStyle?: Style<RectProps>;
}

/** One of a few choices, side by side; a light card glides under the chosen one. */
function SegmentedControlOf<T extends string | number>({ options, value, onChange, disabled = false, style, segmentStyle,
                                                         labelStyle, indicatorStyle }: SegmentedControlProps<T>) {
  const styles = useSegments();
  // Where each segment was laid out, so the card can sit under the chosen one.
  const [boxes, setBoxes] = useState<Record<string, LayoutBox>>({});
  const chosen = boxes[String(value)];
  return (
    <Box style={[styles.segments, disabled && styles.disabled, style]}>
      {chosen && <Rect style={[styles.indicator, indicatorStyle]} {...chosen} />}
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            style={(press) => [styles.segment, resolveStyle(segmentStyle, { ...press, selected, disabled })]}
            disabled={disabled}
            onPress={() => onChange?.(option.value)}
            onLayout={(box) => setBoxes((all) => (sameBox(all[String(option.value)], box) ? all : { ...all, [option.value]: box }))}
          >
            {(press) => (
              <Label variant="strong" tone={selected ? "ink" : press.hovered ? "soft" : "muted"} transition={styles.motion.pop}
                     style={resolveStyle(labelStyle, { ...press, selected, disabled })}>
                {option.label}
              </Label>
            )}
          </Pressable>
        );
      })}
    </Box>
  );
}

function sameBox(a: LayoutBox | undefined, b: LayoutBox): boolean {
  return a !== undefined && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export const SegmentedControl = memo(SegmentedControlOf) as typeof SegmentedControlOf;

/** A slider's state, as its style functions see it. */
export interface SliderState {
  dragging: boolean;
  disabled: boolean;
}

const useSlider = makeStyles(({ colors, shadows, motion }) => ({
  ...StyleSheet.create({
    track: { height: 20, justifyContent: "center" },
    disabled: { opacity: 0.4 },
    rail: { position: "absolute", x: 0, y: 7, height: 6, radius: 3, fill: colors.track },
    fill: { position: "absolute", x: 0, y: 7, height: 6, radius: 3, fill: { from: colors.accentLight, to: colors.accent, angle: 0 } },
    hit: { position: "absolute", x: 0, y: 0, width: "100%", height: "100%" },
    thumb: { position: "absolute", y: 2, width: 16, height: 16, radius: 8, fill: colors.knob,
             shadow: { ...shadows.knob, blur: 4 } },
  }),
  motion,
}));

export interface SliderProps {
  /** Where it is, from `min` to `max`. */
  value: number;
  onValueChange?: (value: number) => void;
  /** Defaults to 0 and 1. */
  min?: number;
  max?: number;
  /** Values it snaps to, as a distance between them; continuous without one. */
  step?: number;
  /** Pixels; defaults to 160. */
  width?: number;
  disabled?: boolean;
  /** The box holding the parts. */
  style?: StateStyle<BoxProps, SliderState>;
  railStyle?: StateStyle<RectProps, SliderState>;
  fillStyle?: StateStyle<RectProps, SliderState>;
  thumbStyle?: StateStyle<RectProps, SliderState>;
}

const thumb = 16;

/**
 * A value along a track, dragged or clicked to. It renders only while dragged,
 * once per move the compositor reports, and only if the value changes.
 */
export const Slider = memo(function Slider({ value, onValueChange, min = 0, max = 1, step, width = 160, disabled = false,
                                             style, railStyle, fillStyle, thumbStyle }: SliderProps) {
  const styles = useSlider();
  const [dragging, setDragging] = useState(false);
  const last = useRef(value);
  last.current = value;
  const state: SliderState = { dragging, disabled };
  const fraction = Math.min(Math.max((value - min) / (max - min || 1), 0), 1);
  const travel = width - thumb;
  // A held press reports where the pointer is on the hit area even off it, so the
  // thumb follows the pointer anywhere and stops at the ends.
  const pick = (event: StagePointerEvent) => {
    let next = min + Math.min(Math.max((event.localX - thumb / 2) / travel, 0), 1) * (max - min);
    if (step) next = Math.min(max, min + Math.round((next - min) / step) * step);
    if (next !== last.current) onValueChange?.(next);
  };
  // While dragged the thumb follows the pointer at once; otherwise it glides.
  const follow = dragging ? undefined : styles.motion.glide;
  return (
    <Box style={[styles.track, disabled && styles.disabled, resolveStyle(style, state)]} width={width}>
      <Rect style={[styles.rail, resolveStyle(railStyle, state)]} width={width} />
      <Rect style={[styles.fill, resolveStyle(fillStyle, state)]} width={Math.max(6, thumb / 2 + fraction * travel)}
            transition={follow} />
      <Rect style={[styles.thumb, resolveStyle(thumbStyle, state)]} x={fraction * travel} transition={follow} />
      <Group
        style={styles.hit}
        cursor={disabled ? undefined : "pointer"}
        onPointerDown={disabled ? undefined : (event) => {
          setDragging(true);
          pick(event);
        }}
        onPointerMove={dragging ? pick : undefined}
        onPointerUp={() => setDragging(false)}
      />
    </Box>
  );
});
