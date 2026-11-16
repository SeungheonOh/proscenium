import { memo, useRef, useState, type ReactNode } from "react";
import { Box, Group, Rect } from "../components.js";
import { instant } from "../motion.js";
import type { Color } from "../color.js";
import type { StageClickEvent, StageElement, StageKeyboardEvent, StagePointerEvent } from "../events.js";
import type { LayoutBox } from "../layout.js";
import type { BoxProps, ImageProps, PointerHandlers, RectProps, Shadow, States, Style, TextProps } from "../props.js";
import { currentSession } from "../session.js";
import { Glyph } from "./glyphs.js";
import { cache, controlTransition, groupStates, ringed } from "./parts.js";
import { Pressable, type PressState } from "./Pressable.js";
import { resolveStyle, StyleSheet, type StateStyle } from "./styles.js";
import { makeStyles, type Theme } from "./theme.js";
import { Icon, Label, type Tone } from "./views.js";

// Every control takes `style` for its root and a style for each of its parts. Its looks
// by state (under the pointer, held down, focused from the keyboard) are `states` the
// compositor resolves in the frame the pointer or key arrives, made once per theme, so
// hovering and pressing render nothing. Every control is reached by Tab, shows the
// theme's focus ring when focus came by keyboard, and answers the keys its native
// counterpart does.
//
// A style that is a function of the control's state still works, as Pressable's does:
// the control then follows its state in React as well, rendering as it changes.

/** A pressable control's state, as its style functions see it. */
export interface ControlState extends PressState {
  selected: boolean;
  disabled: boolean;
}

/** Image props a style may set. */
type ImageStyle = Omit<ImageProps, "src" | "ref" | "style" | `on${string}`>;

const isFunction = (value: unknown): value is (...args: never[]) => unknown => typeof value === "function";

/** Whether any of STYLES is a function of state, so the control must follow its state in React. */
function tracks(...styles: unknown[]): boolean {
  return styles.some(isFunction);
}

/** Focus by keyboard, shown: for a control moving focus itself, as arrow keys do in a group. */
function focusVisible(node: StageElement | null | undefined): void {
  if (node) currentSession().focusNode(node, { visible: true });
}

export type ButtonVariant = "plain" | "tinted" | "filled" | "outline" | "danger";
export type ButtonSize = "small" | "medium" | "large";

const buttonTones: Record<ButtonVariant, Tone> = {
  plain: "ink", tinted: "accent", filled: "onAccent", outline: "ink", danger: "onAccent",
};

/** A button's look at rest and its states, by variant and whether it is selected. */
function buttonLook(theme: Theme, variant: ButtonVariant, selected: boolean): { rest: BoxProps; states: States } {
  const { colors, shadows } = theme;
  // Filled buttons catch the light along their top edge, a hairline inside.
  const highlight: Shadow = { inset: true, y: 1, blur: 0, color: "#ffffff26" };
  const own: Record<ButtonVariant, { fill: Color; hover: Color; press: Color; border: Color; shadow: Shadow[] }> = {
    plain: { fill: colors.clear, hover: colors.hover, press: colors.press, border: colors.accentClear, shadow: [] },
    tinted: { fill: colors.accentSoft, hover: colors.accentSoftHover, press: colors.accentSoftPress,
              border: colors.accentClear, shadow: [] },
    filled: { fill: colors.accent, hover: colors.accentHover, press: colors.accentPress, border: colors.accentClear,
              shadow: [highlight, ...shadows.control] },
    outline: { fill: colors.field, hover: colors.fieldHover, press: colors.fieldPress, border: colors.border,
               shadow: shadows.control },
    danger: { fill: colors.danger, hover: colors.dangerHover, press: colors.dangerHover, border: colors.accentClear,
              shadow: [highlight, ...shadows.control] },
  };
  let look = own[variant];
  // A picked tool keeps its tint whatever the pointer does.
  if (selected && (variant === "plain" || variant === "tinted" || variant === "outline")) {
    look = { fill: colors.accentTint, hover: colors.accentSoftHover, press: colors.accentSoftPress,
             border: colors.accentLine, shadow: [] };
  }
  const ring = ringed(theme, look.shadow);
  return {
    rest: { fill: look.fill, border: { width: 1, color: look.border }, shadow: ring.rest },
    states: { hover: { fill: look.hover }, pressed: { fill: look.press }, focusVisible: { shadow: ring.focus } },
  };
}

const useButton = makeStyles((theme) => {
  const { radii, controls } = theme;
  const transition = controlTransition(theme);
  return {
    looks: cache((key) => {
      const [variant, selected] = key.split(":") as [ButtonVariant, string];
      return buttonLook(theme, variant, selected === "true");
    }),
    sizes: StyleSheet.create({
      small: { height: controls.small, paddingX: 8, gap: 5, radius: radii.sm },
      medium: { height: controls.medium, paddingX: 12, gap: 6, radius: radii.sm },
      large: { height: controls.large, paddingX: 14, gap: 8, radius: radii.sm },
    }) satisfies Record<ButtonSize, BoxProps>,
    ...StyleSheet.create({
      base: { flexDirection: "row", alignItems: "center", justifyContent: "center", transition },
      disabled: { opacity: 0.45 },
    }),
  };
});

export interface ButtonProps extends Omit<BoxProps, "children" | "style" | keyof PointerHandlers> {
  /** Its words; leave out for an icon alone. */
  label?: string;
  /** An image path or an imported image, before the label, tinted as the label is. */
  icon?: string;
  /** Something after the label: a chevron, a count. */
  trailing?: ReactNode;
  /**
   * Plain (the default) shows only under the pointer; tinted is a soft accent; filled is
   * the solid accent; outline a surface with an edge; danger is filled in the danger color.
   */
  variant?: ButtonVariant;
  /** 24, 28 (the default) or 32 pixels high: the theme's `controls`. */
  size?: ButtonSize;
  /** On, as a tool picked in a toolbar: tinted and ringed with the accent. */
  selected?: boolean;
  disabled?: boolean;
  /** Takes keyboard focus, shown, as it appears; see Pressable. */
  autoFocus?: boolean;
  /** Pressed: a click, or Enter or Space (the event's `count` is then 0). */
  onPress?: (event: StageClickEvent) => void;
  style?: StateStyle<BoxProps, ControlState>;
  labelStyle?: StateStyle<TextProps, ControlState>;
  iconStyle?: StateStyle<ImageStyle, ControlState>;
}

/**
 * A button with a label, an icon or both: `<Button label="Save" variant="filled" onPress={save} />`.
 * Enter and Space press it when it has keyboard focus.
 */
export const Button = memo(function Button({ label, icon, trailing, variant = "plain", size = "medium", selected = false,
                                             disabled = false, onPress, style, labelStyle, iconStyle,
                                             ...props }: ButtonProps) {
  const styles = useButton();
  const look = styles.looks(`${variant}:${selected}`);
  const iconSize = size === "small" ? 14 : 16;
  const tone = buttonTones[variant];
  const base = [styles.base, styles.sizes[size], look.rest, disabled && styles.disabled];
  const content = (state: ControlState) => (
    <>
      {icon && <Icon src={icon} size={iconSize} tone={tone} style={resolveStyle(iconStyle, state)} />}
      {label !== undefined && <Label variant="label" tone={tone} style={resolveStyle(labelStyle, state)}>{label}</Label>}
      {trailing}
    </>
  );
  if (tracks(style, labelStyle, iconStyle)) {
    return (
      <Pressable {...props} disabled={disabled} onPress={onPress} states={look.states}
                 style={(press) => [base, resolveStyle(style, { ...press, selected, disabled })]}>
        {(press) => content({ ...press, selected, disabled })}
      </Pressable>
    );
  }
  const state: ControlState = { hovered: false, pressed: false, focused: false, selected, disabled };
  return (
    <Pressable {...props} disabled={disabled} onPress={onPress} states={look.states}
               style={[base, style as Style<BoxProps>]}>
      {content(state)}
    </Pressable>
  );
});

export interface IconButtonProps extends Omit<BoxProps, "children" | "style" | keyof PointerHandlers> {
  /** An image path or an imported image; or give children to draw something else. */
  icon?: string;
  children?: ReactNode;
  /** Its side, in pixels; defaults to 32. */
  size?: number;
  /** The icon's side; defaults to 18. */
  iconSize?: number;
  /** The icon's color, the variant's own by default; null keeps the image's own colors. */
  iconTint?: Color | null;
  /** As a Button's; plain by default. */
  variant?: ButtonVariant;
  /** On, as a tool picked in a toolbar. */
  selected?: boolean;
  disabled?: boolean;
  /** Takes keyboard focus, shown, as it appears; see Pressable. */
  autoFocus?: boolean;
  onPress?: (event: StageClickEvent) => void;
  style?: StateStyle<BoxProps, ControlState>;
  iconStyle?: StateStyle<ImageStyle, ControlState>;
}

const useIconButton = makeStyles((theme) => StyleSheet.create({
  base: { alignItems: "center", justifyContent: "center", radius: theme.radii.sm, transition: controlTransition(theme) },
  disabled: { opacity: 0.45 },
}));

/** A square button holding an icon, as in a toolbar: `<IconButton icon={pen} selected={tool === "pen"} onPress={…} />`. */
export const IconButton = memo(function IconButton({ icon, children, size = 32, iconSize = 18, iconTint, variant = "plain",
                                                     selected = false, disabled = false, onPress, style, iconStyle,
                                                     ...props }: IconButtonProps) {
  const styles = useIconButton();
  const look = useButton().looks(`${variant}:${selected}`);
  const base = [styles.base, look.rest, disabled && styles.disabled];
  const content = (state: ControlState) => (icon
    ? <Icon src={icon} size={iconSize} tone={buttonTones[variant]} tint={iconTint} style={resolveStyle(iconStyle, state)} />
    : children);
  if (tracks(style, iconStyle)) {
    return (
      <Pressable {...props} width={size} height={size} disabled={disabled} onPress={onPress} states={look.states}
                 style={(press) => [base, resolveStyle(style, { ...press, selected, disabled })]}>
        {(press) => content({ ...press, selected, disabled })}
      </Pressable>
    );
  }
  return (
    <Pressable {...props} width={size} height={size} disabled={disabled} onPress={onPress} states={look.states}
               style={[base, style as Style<BoxProps>]}>
      {content({ hovered: false, pressed: false, focused: false, selected, disabled })}
    </Pressable>
  );
});

/** A switch's state, as its style functions see it. */
export interface SwitchState extends PressState {
  value: boolean;
  disabled: boolean;
}

const switchWidth = 32, switchHeight = 18, knobSide = 14;

const useSwitch = makeStyles((theme) => {
  const { colors, shadows, motion } = theme;
  const ring = ringed(theme);
  return {
    ...StyleSheet.create({
      track: { width: switchWidth, height: switchHeight, radius: switchHeight / 2, paddingX: 2, alignItems: "center",
               shadow: ring.rest, transition: controlTransition(theme) },
      on: { justifyContent: "flex-end", fill: colors.accent },
      off: { justifyContent: "flex-start", fill: colors.control },
      disabled: { opacity: 0.45 },
      knob: { width: knobSide, height: knobSide, radius: knobSide / 2, fill: colors.knob, shadow: shadows.knob,
              transition: { default: motion.fade, x: motion.glide } },
    }),
    onStates: { hover: { fill: colors.accentHover }, focusVisible: { shadow: ring.focus } } satisfies States,
    offStates: { hover: { fill: colors.controlHover }, focusVisible: { shadow: ring.focus } } satisfies States,
  };
});

export interface SwitchProps {
  value: boolean;
  onValueChange?: (value: boolean) => void;
  disabled?: boolean;
  /** The track. */
  style?: StateStyle<BoxProps, SwitchState>;
  knobStyle?: StateStyle<RectProps, SwitchState>;
}

/** An on/off switch; the knob slides across as the compositor animates its new place. Space toggles it. */
export const Switch = memo(function Switch({ value, onValueChange, disabled = false, style, knobStyle }: SwitchProps) {
  const styles = useSwitch();
  const base = [styles.track, value ? styles.on : styles.off, disabled && styles.disabled];
  const states = value ? styles.onStates : styles.offStates;
  const toggle = () => onValueChange?.(!value);
  if (tracks(style, knobStyle)) {
    return (
      <Pressable disabled={disabled} onPress={toggle} states={states}
                 style={(press) => [base, resolveStyle(style, { ...press, value, disabled })]}>
        {(press) => <Rect style={[styles.knob, resolveStyle(knobStyle, { ...press, value, disabled })]} />}
      </Pressable>
    );
  }
  return (
    <Pressable disabled={disabled} onPress={toggle} states={states} style={[base, style as Style<BoxProps>]}>
      <Rect style={[styles.knob, knobStyle as Style<RectProps>]} />
    </Pressable>
  );
});

// As tall as a medium control: segments 4 short of it inside the track's 2 either side,
// the chosen card's corners following the track's, 2 pixels in.
const useSegments = makeStyles((theme) => {
  const { colors, radii, controls, motion, shadows } = theme;
  const ring = ringed(theme);
  return {
    ...StyleSheet.create({
      segments: { flexDirection: "row", padding: 2, radius: radii.md, fill: colors.well },
      disabled: { opacity: 0.45 },
      segment: { height: controls.medium - 4, paddingX: 12, radius: radii.md - 2, alignItems: "center",
                 justifyContent: "center", shadow: ring.rest, transition: controlTransition(theme) },
      // Raised off the well: a hairline edge and a shadow close under it.
      indicator: { position: "absolute", radius: radii.md - 2, fill: colors.raised,
                   border: { width: 1, color: colors.line }, shadow: shadows.control, transition: motion.glide },
    }),
    segmentStates: { focusVisible: { shadow: ring.focus } } satisfies States,
    // Unchosen labels brighten as the pointer comes over their segment.
    labelStates: groupStates({ hover: { color: colors.ink } }),
    labelMotion: motion.fade,
  };
});

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

/**
 * One of a few choices, side by side; a light card glides under the chosen one. Tab
 * reaches the chosen segment, and the arrow keys, Home and End choose another, as a
 * group of radio buttons does.
 */
function SegmentedControlOf<T extends string | number>({ options, value, onChange, disabled = false, style, segmentStyle,
                                                         labelStyle, indicatorStyle }: SegmentedControlProps<T>) {
  const styles = useSegments();
  // Where each segment was laid out, so the card can sit under the chosen one.
  const [boxes, setBoxes] = useState<Record<string, LayoutBox>>({});
  const nodes = useRef(new Map<string, StageElement>());
  const chosen = boxes[String(value)];
  const index = options.findIndex((option) => option.value === value);
  const onKeyDown = disabled ? undefined : (event: StageKeyboardEvent) => {
    const last = options.length - 1;
    const next = { Left: index - 1, Up: index - 1, Right: index + 1, Down: index + 1, Home: 0, End: last }[event.key];
    if (next === undefined || options.length === 0) return;
    const option = options[Math.min(Math.max(next, 0), last)]!;
    if (option.value !== value) onChange?.(option.value);
    focusVisible(nodes.current.get(String(option.value)));
  };
  return (
    <Box style={[styles.segments, disabled && styles.disabled, style]} onKeyDown={onKeyDown}>
      {chosen && <Rect style={[styles.indicator, indicatorStyle]} {...chosen} />}
      {options.map((option, at) => {
        const selected = option.value === value;
        const state = (press: PressState): ControlState => ({ ...press, selected, disabled });
        const resting = state({ hovered: false, pressed: false, focused: false });
        const tracked = tracks(segmentStyle, labelStyle);
        // Tab reaches the chosen segment, or the first while none is.
        const reached = selected || (index < 0 && at === 0);
        const label = (control: ControlState) => (
          <Label variant="label" tone={selected ? "ink" : "muted"} transition={styles.labelMotion}
                 states={selected ? undefined : styles.labelStates} style={resolveStyle(labelStyle, control)}>
            {option.label}
          </Label>
        );
        return (
          <Pressable
            key={option.value}
            ref={(node: StageElement | null) => {
              if (node) nodes.current.set(String(option.value), node);
              else nodes.current.delete(String(option.value));
            }}
            states={styles.segmentStates}
            tabIndex={reached ? 0 : -1}
            style={tracked ? (press) => [styles.segment, resolveStyle(segmentStyle, state(press))]
                           : [styles.segment, segmentStyle as Style<BoxProps>]}
            disabled={disabled}
            onPress={() => onChange?.(option.value)}
            onLayout={(box) => setBoxes((all) => (sameBox(all[String(option.value)], box) ? all : { ...all, [option.value]: box }))}
          >
            {tracked ? (press: PressState) => label(state(press)) : label(resting)}
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
  /** Held down, whether or not it has moved yet. */
  dragging: boolean;
  /** Always false: the pointer over it shows through `states`, without rendering. */
  hovered: boolean;
  disabled: boolean;
}

const thumb = 16, railHeight = 4, sliderHeight = 20;

const useSlider = makeStyles((theme) => {
  const { colors, shadows, motion } = theme;
  const ring = ringed(theme, shadows.knob);
  const halo = (color: Color, spread: number): Shadow[] => [...shadows.knob, { color, blur: 0, spread }];
  return {
    ...StyleSheet.create({
      track: { height: sliderHeight, justifyContent: "center", cursor: "pointer" },
      disabled: { opacity: 0.45 },
      rail: { position: "absolute", x: 0, y: (sliderHeight - railHeight) / 2, height: railHeight, radius: railHeight / 2,
              fill: colors.track },
      fill: { position: "absolute", x: 0, y: (sliderHeight - railHeight) / 2, height: railHeight, radius: railHeight / 2,
              fill: colors.accent },
      hit: { position: "absolute", x: 0, y: 0, width: "100%", height: "100%" },
      thumb: { position: "absolute", y: (sliderHeight - thumb) / 2, width: thumb, height: thumb, radius: thumb / 2,
               fill: colors.knob, shadow: ring.rest },
    }),
    // Under the pointer a soft halo grows round the thumb, held a firmer one; focus shows the ring.
    thumbStates: groupStates({
      hover: { shadow: halo(colors.accentSoft, 4) },
      focusVisible: { shadow: ring.focus },
      pressed: { shadow: halo(colors.accentSoftHover, 5) },
    }),
    motion,
  };
});

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

/** VALUE moved by KEY (an arrow, Page Up or Down, Home or End), or undefined for keys that move nothing. */
export function sliderKey(key: string, value: number, min: number, max: number, step?: number, coarse = false): number | undefined {
  const unit = step ?? (max - min) / 100;
  const big = Math.max(unit, step ? Math.round((max - min) / 10 / step) * step : (max - min) / 10);
  const by = coarse ? big : unit;
  let next: number;
  switch (key) {
    case "Left": case "Down": case "KP_Left": case "KP_Down": next = value - by; break;
    case "Right": case "Up": case "KP_Right": case "KP_Up": next = value + by; break;
    case "Page_Down": case "Next": next = value - big; break;
    case "Page_Up": case "Prior": next = value + big; break;
    case "Home": next = min; break;
    case "End": next = max; break;
    default: return undefined;
  }
  if (step) next = min + Math.round((next - min) / step) * step;
  // Whole steps can still carry float error; trim it.
  next = Number(next.toPrecision(12));
  return Math.min(Math.max(next, min), max);
}

/**
 * A value along a track, dragged or clicked to, or moved with the arrow keys (Shift for
 * bigger steps), Page Up and Down, Home and End. It renders only while dragged, once per
 * move the compositor reports, and only if the value changes; hovering renders nothing.
 */
export const Slider = memo(function Slider({ value, onValueChange, min = 0, max = 1, step, width = 160, disabled = false,
                                             style, railStyle, fillStyle, thumbStyle }: SliderProps) {
  const styles = useSlider();
  const [dragging, setDragging] = useState(false);
  // Moved since it was pressed: from then on the thumb follows the pointer at once.
  const [moved, setMoved] = useState(false);
  const last = useRef(value);
  last.current = value;
  const state: SliderState = { dragging, hovered: false, disabled };
  const fraction = Math.min(Math.max((value - min) / (max - min || 1), 0), 1);
  const travel = width - thumb;
  // A held press reports where the pointer is on the hit area even off it, so the
  // thumb follows the pointer anywhere and stops at the ends.
  const pick = (event: StagePointerEvent) => {
    let next = min + Math.min(Math.max((event.localX - thumb / 2) / travel, 0), 1) * (max - min);
    if (step) next = Math.min(max, min + Math.round((next - min) / step) * step);
    if (next !== last.current) onValueChange?.(next);
  };
  // While dragged the thumb follows the pointer at once; a click, and anything else, glides.
  const follow = dragging && moved ? undefined : styles.motion.glide;
  const thumbMotion = { default: styles.motion.fade, x: follow ?? instant };
  return (
    <Box style={[styles.track, disabled && styles.disabled, resolveStyle(style, state)]} width={width}
         stateGroup tabIndex={disabled ? undefined : 0} cursor={disabled ? undefined : "pointer"}
         onKeyDown={disabled ? undefined : (event) => {
           const next = sliderKey(event.key, last.current, min, max, step, event.modifiers.includes("shift"));
           if (next !== undefined && next !== last.current) onValueChange?.(next);
         }}>
      <Rect style={[styles.rail, resolveStyle(railStyle, state)]} width={width} />
      <Rect style={[styles.fill, resolveStyle(fillStyle, state)]} width={Math.max(railHeight, thumb / 2 + fraction * travel)}
            transition={follow} />
      <Rect style={[styles.thumb, resolveStyle(thumbStyle, state)]} states={disabled ? undefined : styles.thumbStates}
            x={fraction * travel} transition={thumbMotion} />
      <Group
        style={styles.hit}
        onPointerDown={disabled ? undefined : (event) => {
          if ((event.button ?? 272) !== 272) return;
          setDragging(true);
          setMoved(false);
          pick(event);
        }}
        onPointerMove={dragging ? (event) => {
          if (!moved) setMoved(true);
          pick(event);
        } : undefined}
        onPointerUp={dragging ? () => setDragging(false) : undefined}
      />
    </Box>
  );
});

/** A checkbox's state, as its style functions see it. */
export interface CheckboxState extends PressState {
  value: boolean;
  disabled: boolean;
}

const checkSide = 16;

const useCheckbox = makeStyles((theme) => {
  const { colors, radii, shadows } = theme;
  const transition = controlTransition(theme);
  const empty = ringed(theme, shadows.control);
  const ticked = ringed(theme);
  return {
    ...StyleSheet.create({
      row: { flexDirection: "row", alignItems: "center", gap: 8 },
      disabled: { opacity: 0.45 },
      box: { width: checkSide, height: checkSide, radius: radii.xs, alignItems: "center", justifyContent: "center",
             transition },
      on: { fill: colors.accent, border: { width: 1, color: colors.accent }, shadow: ticked.rest },
      off: { fill: colors.field, border: { width: 1, color: colors.border }, shadow: empty.rest },
      tick: { transition },
    }),
    onStates: groupStates({ hover: { fill: colors.accentHover, border: { color: colors.accentHover } },
                            focusVisible: { shadow: ticked.focus } }),
    offStates: groupStates({ hover: { border: { color: colors.borderHover } }, focusVisible: { shadow: empty.focus } }),
    colors,
  };
});

export interface CheckboxProps {
  value: boolean;
  onValueChange?: (value: boolean) => void;
  /** Words after the box, which take presses too. */
  label?: string;
  disabled?: boolean;
  style?: StateStyle<BoxProps, CheckboxState>;
  boxStyle?: StateStyle<BoxProps, CheckboxState>;
  labelStyle?: StateStyle<TextProps, CheckboxState>;
}

/**
 * A box ticked on and off, with an optional label: `<Checkbox value={done} onValueChange={setDone} label="Done" />`.
 * Space toggles it when it has keyboard focus, which rings the box.
 */
export const Checkbox = memo(function Checkbox({ value, onValueChange, label, disabled = false, style, boxStyle,
                                                 labelStyle }: CheckboxProps) {
  const styles = useCheckbox();
  const toggle = () => onValueChange?.(!value);
  const content = (state: CheckboxState) => (
    <>
      <Box style={[styles.box, value ? styles.on : styles.off, resolveStyle(boxStyle, state)]}
           states={disabled ? undefined : value ? styles.onStates : styles.offStates}>
        <Glyph shape="check" size={12} stroke={1.75} color={styles.colors.onAccent} style={styles.tick}
               opacity={value ? 1 : 0} />
      </Box>
      {label !== undefined && <Label style={resolveStyle(labelStyle, state)}>{label}</Label>}
    </>
  );
  if (tracks(style, boxStyle, labelStyle)) {
    return (
      <Pressable disabled={disabled} onPress={toggle}
                 style={(press) => [styles.row, disabled && styles.disabled, resolveStyle(style, { ...press, value, disabled })]}>
        {(press) => content({ ...press, value, disabled })}
      </Pressable>
    );
  }
  return (
    <Pressable disabled={disabled} onPress={toggle} style={[styles.row, disabled && styles.disabled, style as Style<BoxProps>]}>
      {content({ hovered: false, pressed: false, focused: false, value, disabled })}
    </Pressable>
  );
});

export interface ProgressBarProps {
  /** How far along, from 0 to 1; null for work of unknown length, which sweeps. */
  value: number | null;
  /** Pixels, or a percentage of its Box; defaults to filling it. */
  width?: BoxProps["width"];
  /** The bar's color; the accent by default. */
  color?: Color;
  style?: Style<BoxProps>;
  fillStyle?: Style<RectProps>;
}

const useProgress = makeStyles(({ colors, motion, breathe }) => ({
  ...StyleSheet.create({
    track: { height: 6, radius: 3, fill: colors.track, clip: true, alignSelf: "stretch" },
    fill: { position: "absolute", x: 0, y: 0, height: 6, radius: 3, transition: motion.glide },
  }),
  colors,
  breathe,
}));

const fromNothing = { width: 0 } as const;

/**
 * How much of something is done, as a filling bar. Its fill glides to each new value;
 * work of unknown length fills the bar and breathes, and once its length is known the fill
 * starts again from nothing rather than shrinking back from full.
 */
export const ProgressBar = memo(function ProgressBar({ value, width, color, style, fillStyle }: ProgressBarProps) {
  const styles = useProgress();
  const known = value !== null;
  const wasKnown = useRef(known);
  const grows = known && !wasKnown.current;
  wasKnown.current = known;
  const fraction = value === null ? 1 : Math.min(Math.max(value, 0), 1);
  return (
    <Box style={[styles.track, style]} width={width}>
      <Rect key={known ? "known" : "unknown"} style={[styles.fill, fillStyle]} fill={color ?? styles.colors.accent}
            width={`${fraction * 100}%`} initial={grows ? fromNothing : undefined}
            animate={known ? undefined : styles.breathe} />
    </Box>
  );
});

