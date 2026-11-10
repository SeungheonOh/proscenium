/**
 * What every Warlock popup is built from: keyboard focus that moves through
 * its controls, a scrolling list that keeps the focused control in view, the
 * popup's glass frame with its title and status line, and the one kind of
 * control Warlock has, a button with a label, an optional detail line and a glyph.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  Box,
  Group,
  Image,
  instant,
  paintShader,
  filterShader,
  Rect,
  Text,
  tween,
  useKeyboardGrab,
  type BoxProps,
  type Color,
  type Shading,
  type StageElement,
  type StageKeyEvent,
  type StagePointerEvent,
  type StageWheelEvent,
  type TextProps,
  type Transition,
} from "proscenium";
import {
  createTheme,
  darkTheme,
  lightTheme,
  TextField,
  ThemeProvider,
  type TextFieldHandle,
} from "proscenium/ui";
import { glyphs, type GlyphName } from "./glyphs.js";
import {
  alpha,
  pressSeconds,
  standardEasing,
  stateSeconds,
  themed,
  useWarlockTheme,
  type WarlockTheme,
} from "./theme.js";
import { useWarlock } from "./WarlockProvider.js";

// ---------------------------------------------------------------------------
// Glyphs

/** Draws an image's shape in one colour: Warlock's glyphs take the colour of the text beside them. */
const tintFilter = filterShader({
  uniforms: { tint: 4 },
  gate: { uniform: "tint", component: 3 },
  source: `
vec4 filter(vec4 color, vec2 position) {
  return vec4(tint.rgb, 1.0) * tint.a * color.a;
}
`,
});

const tints = new Map<string, readonly Shading[]>();

function tinted(color: Color): readonly Shading[] {
  const key = String(color);
  let shaders = tints.get(key);
  if (!shaders)
    tints.set(key, (shaders = [{ id: "tint", shader: tintFilter, uniforms: { tint: color } }]));
  return shaders;
}

export interface GlyphProps extends Omit<BoxProps, "children" | "width" | "height"> {
  name: GlyphName;
  /** Its side in pixels, before the text size scales it; 20 by default. */
  size?: number;
  color?: Color;
}

/** One of Warlock's glyphs, in the text colour or COLOR. */
export function Glyph({ name, size = 20, color, ...box }: GlyphProps) {
  const theme = useWarlockTheme();
  const side = theme.rem(size);
  return (
    <Image
      src={glyphs[name]}
      width={side}
      height={side}
      flexShrink={0}
      interactive={false}
      shaders={tinted(color ?? theme.palette.text)}
      {...box}
    />
  );
}

// ---------------------------------------------------------------------------
// Where things are, for focus order and for scrolling the focused control into view

interface Point {
  x: number;
  y: number;
}

/** Where the content this context is given to starts, in its scrolling list's content. */
const OffsetContext = createContext<() => Point>(() => ({ x: 0, y: 0 }));

/**
 * A Box that knows where it is: controls inside it take their place in the
 * focus order, and scroll into view, by where they really are. Wrap anything
 * that holds controls and is not the list itself in one.
 */
export function Region({ children, ...box }: BoxProps) {
  const parent = useContext(OffsetContext);
  const element = useRef<StageElement>(null);
  const offset = useCallback(() => {
    const from = parent();
    const layout = element.current?.layout;
    return layout ? { x: from.x + layout.x, y: from.y + layout.y } : from;
  }, [parent]);
  return (
    <Box ref={element} {...box}>
      <OffsetContext.Provider value={offset}>{children}</OffsetContext.Provider>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Keyboard focus

interface FocusItem {
  /** Sorts before position: controls of a lower group come first, e.g. a column's before the next column's. */
  group: number;
  disabled: boolean;
  /** Where its box is in the list's content, or null before it has one. */
  box: () => { x: number; y: number; width: number; height: number } | null;
  press: () => void;
  /** A control that takes focus in its own way, as a text field does. */
  onFocus?: (focused: boolean) => void;
}

class FocusStore {
  focused: string | null = null;
  /** Whether focus shows: it came by keyboard, or the popup put it there. */
  visible = false;
  readonly items = new Map<string, FocusItem>();
  private readonly listeners = new Set<() => void>();
  reveal: (box: { y: number; height: number }) => void = () => undefined;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  focus(id: string | null, visible: boolean): void {
    if (this.focused === id && this.visible === visible) return;
    const previous = this.focused;
    this.focused = id;
    this.visible = visible;
    if (previous !== id) {
      if (previous !== null) this.items.get(previous)?.onFocus?.(false);
      if (id !== null) this.items.get(id)?.onFocus?.(true);
    }
    const box = id === null ? null : this.items.get(id)?.box();
    if (box && visible) this.reveal(box);
    for (const listener of [...this.listeners]) listener();
  }

  /** Enabled controls in reading order: by group, then top to bottom, then left to right. */
  order(): string[] {
    const placed = [...this.items]
      .filter(([, item]) => !item.disabled)
      .map(([id, item]) => ({ id, item, box: item.box() }));
    placed.sort((a, b) => {
      if (a.item.group !== b.item.group) return a.item.group - b.item.group;
      const ay = a.box?.y ?? 0;
      const by = b.box?.y ?? 0;
      // Controls whose tops are within a few pixels share a row.
      if (Math.abs(ay - by) > 6) return ay - by;
      return (a.box?.x ?? 0) - (b.box?.x ?? 0);
    });
    return placed.map((entry) => entry.id);
  }

  /** Move focus BY controls; past either end it wraps, or stays. */
  move(by: number, wrap: boolean): void {
    const order = this.order();
    if (order.length === 0) return;
    const from = this.focused === null ? -1 : order.indexOf(this.focused);
    let to = from < 0 ? (by > 0 ? 0 : order.length - 1) : from + by;
    if (wrap) to = (to + order.length) % order.length;
    else to = Math.min(Math.max(to, 0), order.length - 1);
    this.focus(order[to]!, true);
  }

  edge(last: boolean): void {
    const order = this.order();
    if (order.length > 0) this.focus(order[last ? order.length - 1 : 0]!, true);
  }

  press(): void {
    const item = this.focused === null ? undefined : this.items.get(this.focused);
    if (item && !item.disabled) item.press();
  }
}

const FocusContext = createContext<FocusStore | null>(null);

export interface FocusScopeProps {
  /** The control focused as the popup opens. */
  initial?: string;
  /**
   * What the arrow keys do: Up and Down move through the controls and stop at
   * the ends ("list"), go round ("menu"), or do nothing ("none").
   */
  arrows?: "list" | "menu" | "none";
  onEscape: () => void;
  /** A key before the scope acts on it; return true to say it was handled. */
  onKey?: (event: StageKeyEvent) => boolean;
  children?: ReactNode;
}

/** Holds the keyboard for a popup and moves focus among the controls inside. */
export function FocusScope({
  initial,
  arrows = "list",
  onEscape,
  onKey,
  children,
}: FocusScopeProps) {
  const store = useMemo(() => new FocusStore(), []);

  // Children register before this runs, so the first control can take focus at once.
  useLayoutEffect(() => {
    if (initial !== undefined && store.focused === null) store.focus(initial, true);
  }, [initial]);

  const handle = useKeys(store, arrows, onEscape, onKey);
  useKeyboardGrab(handle);
  return <FocusContext.Provider value={store}>{children}</FocusContext.Provider>;
}

function useKeys(
  store: FocusStore,
  arrows: "list" | "menu" | "none",
  onEscape: () => void,
  onKey: ((event: StageKeyEvent) => boolean) | undefined,
): (event: StageKeyEvent) => void {
  return (event) => {
    if (!event.pressed) return;
    if (onKey?.(event)) return;
    const shift = event.modifiers.includes("shift");
    const plain = event.modifiers.length === 0;
    switch (event.key) {
      case "Tab":
      case "ISO_Left_Tab":
        store.move(shift || event.key === "ISO_Left_Tab" ? -1 : 1, true);
        return;
      case "Down":
      case "Up":
        if (arrows !== "none" && plain)
          store.move(event.key === "Down" ? 1 : -1, arrows === "menu");
        return;
      case "Home":
      case "End":
        if (arrows !== "none" && plain) store.edge(event.key === "End");
        return;
      case "Return":
      case "KP_Enter":
      case "space":
        if (!event.repeat) store.press();
        return;
      case "Escape":
        if (!event.repeat) onEscape();
        return;
    }
  };
}

/** The popup's focus, to move it from code: `focus.focus("close")`. */
export function useFocus(): { focus: (id: string | null) => void; focused: () => string | null } {
  const store = useContext(FocusContext);
  return useMemo(
    () => ({
      focus: (id: string | null) => store?.focus(id, true),
      focused: () => store?.focused ?? null,
    }),
    [store],
  );
}

export interface FocusableOptions {
  disabled?: boolean;
  onPress?: () => void;
  /** Controls of a lower group come first in the focus order; 0 by default. */
  group?: number;
  onFocus?: (focused: boolean) => void;
}

/**
 * Makes a control one the keyboard reaches. Returns whether it has focus that
 * shows, a ref for its box, and a function to give it focus from a press.
 */
export function useFocusable(
  id: string,
  { disabled = false, onPress, group = 0, onFocus }: FocusableOptions,
) {
  const store = useContext(FocusContext);
  const offset = useContext(OffsetContext);
  const element = useRef<StageElement>(null);
  const latest = useRef({ onPress, onFocus });
  latest.current = { onPress, onFocus };

  useLayoutEffect(() => {
    if (!store) return;
    store.items.set(id, {
      group,
      disabled,
      box: () => {
        const layout = element.current?.layout;
        if (!layout) return null;
        const from = offset();
        return {
          x: from.x + layout.x,
          y: from.y + layout.y,
          width: layout.width,
          height: layout.height,
        };
      },
      press: () => latest.current.onPress?.(),
      onFocus: (focused) => latest.current.onFocus?.(focused),
    });
    return () => {
      store.items.delete(id);
    };
  }, [store, id, group, disabled, offset]);

  // A control that goes away, or can no longer be used, gives its focus to the first that can.
  useEffect(() => {
    if (!store) return;
    if (disabled && store.focused === id) store.edge(false);
    return () => {
      if (store.focused === id)
        queueMicrotask(() => !store.items.has(id) && store.focused === id && store.edge(false));
    };
  }, [store, id, disabled]);

  const focused = useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    () => store !== null && store.focused === id && store.visible,
  );
  const take = useCallback(() => store?.focus(id, false), [store, id]);
  return { focused, element, take };
}

const noSubscription = () => () => undefined;

/** The ring round the control the keyboard is on: a gap in the surface's colour, then the ring. */
const focusRing = paintShader({
  uniforms: { ring: 4, gap: 4, on: 1 },
  extent: { pad: 5 },
  gate: "on",
  source: `
vec4 paint(vec2 p) {
  vec2 q = abs(p - size * 0.5) - size * 0.5 + radius;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
  float outer = clamp((4.0 - d) / pixel + 0.5, 0.0, 1.0);
  float middle = clamp((2.0 - d) / pixel + 0.5, 0.0, 1.0);
  float inner = clamp(-d / pixel + 0.5, 0.0, 1.0);
  vec4 line = vec4(ring.rgb * ring.a, ring.a) * (outer - middle);
  vec4 space = vec4(gap.rgb * gap.a, gap.a) * (middle - inner);
  return (line + space) * on;
}
`,
});

const rings = new Map<string, readonly Shading[]>();

/** The focus ring's shaders for a control, lit or not. */
export function ringShaders(theme: WarlockTheme, on: boolean): readonly Shading[] {
  const key = `${theme.palette.focus}|${theme.palette.surface}|${on}`;
  let shaders = rings.get(key);
  if (!shaders) {
    shaders = [
      {
        id: "focus",
        shader: focusRing,
        layer: "over",
        uniforms: { ring: theme.palette.focus, gap: theme.palette.surface, on: on ? 1 : 0 },
      },
    ];
    rings.set(key, shaders);
  }
  return shaders;
}

// ---------------------------------------------------------------------------
// The scrolling list of a popup

/** Pixels per wheel notch. */
const notch = 48;
/** Room kept round the focused control, so its ring is never cut off. */
const gutter = 6;

export interface ScrollAreaProps extends Omit<BoxProps, "children" | "onWheel"> {
  children?: ReactNode;
  /** The Box holding the content: its gap, direction and padding. */
  content?: BoxProps;
}

/** A column that scrolls with the wheel and keeps the focused control in view. */
export function ScrollArea({ children, content, ...box }: ScrollAreaProps) {
  const theme = useWarlockTheme();
  const store = useContext(FocusContext);
  const [height, setHeight] = useState(0);
  const [width, setWidth] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const [offset, setOffset] = useState(0);
  const max = Math.max(0, Math.round(contentHeight - height));
  const clamped = Math.min(Math.max(offset, 0), max);
  const view = useRef({ height, max, clamped });
  view.current = { height, max, clamped };

  useLayoutEffect(() => {
    if (!store) return;
    store.reveal = ({ y, height: tall }) => {
      const { height, max, clamped } = view.current;
      let next = clamped;
      if (y - gutter < clamped) next = y - gutter;
      else if (y + tall + gutter > clamped + height) next = y + tall + gutter - height;
      setOffset(Math.round(Math.min(Math.max(next, 0), max)));
    };
    return () => {
      store.reveal = () => undefined;
    };
  }, [store]);

  const wheel = (event: StageWheelEvent) => {
    if (event.orientation !== "vertical" || max === 0) return;
    event.stopPropagation();
    const notched = event.source === "wheel" || event.source === "wheel-tilt";
    const step = notched ? (event.discrete || Math.sign(event.delta)) * notch : event.delta;
    setOffset(Math.round(Math.min(Math.max(clamped + step, 0), max)));
  };

  const thumb = max > 0 && height > 0 ? Math.max(24, (height * height) / contentHeight) : 0;
  const origin = useCallback(() => ({ x: 0, y: 0 }), []);
  return (
    <Box
      flexDirection="column"
      clip
      {...box}
      onLayout={(layout) => {
        setHeight(layout.height);
        setWidth(layout.width);
      }}
      onWheel={wheel}
    >
      <Box
        position="absolute"
        x={0}
        y={-clamped}
        width="100%"
        flexDirection="column"
        transition={instant}
        {...content}
        onLayout={(layout) => setContentHeight(layout.height)}
      >
        <OffsetContext.Provider value={origin}>{children}</OffsetContext.Provider>
      </Box>
      {thumb > 0 && (
        <Rect
          position="absolute"
          x={width - 5}
          y={max > 0 ? ((height - thumb) * clamped) / max : 0}
          width={3}
          height={thumb}
          radius={1.5}
          fill={alpha(theme.palette.text, 0.28)}
          transition={instant}
        />
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// The popup's frame

/** The inner width of the popup's list, in pixels: lay grids out in it. */
export function usePopupWidth(): number {
  const box = usePopupBox();
  return box ? box.width - 40 - 2 * gutter : 0;
}

/** The width of a cell spanning SPAN of COLUMNS equal columns GAP apart across WIDTH. */
export function columnWidth(width: number, columns: number, gap: number, span = 1): number {
  const column = (width - gap * (columns - 1)) / columns;
  return Math.floor(column * span + gap * (span - 1));
}

export interface PopupFrameProps extends FocusScopeProps {
  title: string;
  /** The line under the title; the taskbar's status chip says it too. */
  status: string;
  /** Applications shows no heading. */
  hideTitle?: boolean;
  /** The list's own layout: its gap, and whether it wraps as a grid. */
  list?: BoxProps;
}

const popupWidth = 700;
const popupHeight = 420;
/** Where a popup hangs under the bar, from the output's left edge. */
const popupLeft = 50;
const screenMargin = 4;

/** Where the popup goes on its output, and how big it is. */
export function usePopupBox(): { x: number; y: number; width: number; height: number } | null {
  const { popup, outputs } = useWarlock();
  const theme = useWarlockTheme();
  const output = outputs.find((candidate) => candidate.name === popup?.output);
  if (!popup || !output) return null;
  const width = Math.min(popupWidth, output.width - 2 * screenMargin);
  const height = Math.min(popupHeight, output.height - theme.barHeight - screenMargin);
  const clampX = (x: number) =>
    Math.min(Math.max(x, screenMargin), output.width - width - screenMargin);
  if (!popup.anchor) return { x: clampX(popupLeft), y: theme.barHeight, width, height };
  let y = popup.anchor.y;
  // A menu that would cross the bottom edge opens upward if it fits there.
  if (y + height > output.height && popup.anchor.y - height >= 0) y = popup.anchor.y - height;
  y = Math.min(Math.max(y, screenMargin), output.height - height - screenMargin);
  return { x: clampX(popup.anchor.x), y, width, height };
}

const usePopupStyles = themed((theme) => ({
  frame: {
    flexDirection: "column",
    paddingX: 20,
    paddingTop: 20,
    paddingBottom: 16,
    radius: 14,
    fill: theme.skin.glass,
    blur: theme.glass ? 30 : undefined,
    border: {
      width: 1,
      color: alpha(theme.palette.borderEssential, theme.theme === "high-contrast" ? 1 : 0.7),
    },
    shadow: theme.shadows.popup,
  } satisfies BoxProps,
  title: { ...theme.type.title, marginBottom: 2, maxLines: 1 } satisfies TextProps,
  status: { ...theme.type.status, marginBottom: 14 } satisfies TextProps,
}));

/**
 * A popup: Warlock's glass panel with a title, a status line and a scrolling
 * list of controls, which holds the keyboard while it shows. Render it inside
 * the popup's Screen; it places itself.
 */
export function PopupFrame({
  title,
  status,
  hideTitle = false,
  list,
  children,
  ...focus
}: PopupFrameProps) {
  const styles = usePopupStyles();
  const box = usePopupBox();
  const { setPopupStatus, keepPopup } = useWarlock();
  useEffect(() => setPopupStatus(status), [status]);
  if (!box) return null;
  return (
    <FocusScope {...focus}>
      <Box
        style={styles.frame}
        {...box}
        paddingTop={hideTitle ? 16 : 20}
        // A press on the panel keeps it: only one outside it dismisses.
        onPointerDown={keepPopup}
      >
        {!hideTitle && <Text style={styles.title}>{title}</Text>}
        <Text style={styles.status} marginBottom={hideTitle ? 10 : 14}>
          {status}
        </Text>
        <ScrollArea flexGrow={1} content={{ padding: gutter, gap: 2, ...list }}>
          {children}
        </ScrollArea>
      </Box>
    </FocusScope>
  );
}

// ---------------------------------------------------------------------------
// The control

export type ButtonVariant =
  /** Clear until the pointer or a press. */
  | "plain"
  /** Clear, smaller and in the secondary colour: Close and Refresh. */
  | "quiet"
  /** A faint tile with a hairline edge. */
  | "tile"
  /** Outlined on the tile fill. */
  | "outline"
  /** The one filled, affirmative action of a block. */
  | "primary";

export interface PopupButtonProps extends Omit<
  BoxProps,
  "children" | "onPointerDown" | "onPointerUp" | "onPointerMove"
> {
  /** Its name in the focus order; unique in its popup. */
  id: string;
  label: string;
  /** The line under the label, or beside it with `inlineDetail`. */
  detail?: string;
  glyph?: GlyphName;
  /** The glyph's colour, if not the label's: Warlock draws some in its red. */
  glyphColor?: Color;
  glyphSize?: number;
  variant?: ButtonVariant;
  /** Chosen: the red wash, a bar at its leading edge, and bolder text. */
  selected?: boolean;
  /** Shown but not usable: secondary text and a slashed ring at the label's end. */
  disabled?: boolean;
  onPress?: () => void;
  /** A press of the right button, or the Menu key while it has focus. */
  onContext?: (event: StagePointerEvent | null) => void;
  /** Glyph above a centred label, as launcher and Files tiles have it. */
  stacked?: boolean;
  /** Controls of a lower group come first in the focus order. */
  group?: number;
  labelStyle?: TextProps;
  detailStyle?: TextProps;
  /** Drawn in the button before its glyph and label, e.g. a card's picture. */
  leading?: ReactNode;
  /** Drawn in the button after its label, e.g. a pill or a check. */
  children?: ReactNode;
}

const leftButton = 272;
const rightButton = 273;

const useButtonStyles = themed((theme) => {
  const { palette, skin } = theme;
  const edge = (color: string) => ({ width: 1, color });
  return {
    base: {
      flexDirection: "row",
      alignItems: "center",
      minHeight: theme.rem(36),
      paddingX: 12,
      paddingY: 6,
      radius: 10,
      gap: 10,
      flexShrink: 0,
    } satisfies BoxProps,
    stacked: {
      flexDirection: "column",
      justifyContent: "center",
      gap: 8,
      paddingY: 12,
    } satisfies BoxProps,
    rest: {
      plain: { fill: alpha(palette.text, 0), border: edge(alpha(palette.text, 0)) },
      quiet: { fill: alpha(palette.text, 0), border: edge(alpha(palette.text, 0)) },
      tile: { fill: skin.tile, border: edge(skin.hairline) },
      outline: { fill: skin.tile, border: edge(alpha(palette.text, 0.2)) },
      primary: {
        fill: palette.actionFill,
        border: edge(theme.theme === "dawn" ? palette.brandText : palette.onAction),
      },
    } satisfies Record<ButtonVariant, BoxProps>,
    hover: {
      plain: { fill: skin.hover },
      quiet: { fill: skin.hover },
      tile: { fill: skin.hover, border: edge(alpha(palette.text, 0.18)) },
      outline: { fill: skin.hover },
      primary: { fill: palette.actionFillHover },
    } satisfies Record<ButtonVariant, BoxProps>,
    press: {
      plain: { fill: skin.press },
      quiet: { fill: skin.press },
      tile: { fill: skin.press },
      outline: { fill: skin.press },
      primary: { fill: palette.actionFillPressed },
    } satisfies Record<ButtonVariant, BoxProps>,
    selected: {
      fill: skin.selected,
      border: edge(alpha(palette.brandText, 0.55)),
    } satisfies BoxProps,
    selectedHover: { fill: skin.selectedHover } satisfies BoxProps,
    selectedPress: { fill: skin.selectedPress } satisfies BoxProps,
    disabled: {
      fill: palette.surfaceRecessed,
      border: edge(alpha(palette.text, 0)),
    } satisfies BoxProps,
    label: theme.type.label,
    labelQuiet: {
      ...theme.type.labelStrong,
      size: theme.rem(13),
      color: palette.textSecondary,
    } satisfies TextProps,
    labelStrong: theme.type.labelStrong,
    labelPrimary: { ...theme.type.labelStrong, color: palette.onAction } satisfies TextProps,
    detail: theme.type.detail,
    entering: {
      default: instant,
      fill: tween(stateSeconds, [...standardEasing]),
    } satisfies Transition,
    pressing: {
      default: instant,
      fill: tween(pressSeconds, [...standardEasing]),
    } satisfies Transition,
    still: { default: instant } satisfies Transition,
  };
});

/** Warlock's button: a label, perhaps a detail line and a glyph; the keyboard reaches it in its popup. */
export function PopupButton({
  id,
  label,
  detail,
  glyph,
  glyphColor,
  glyphSize,
  variant = "plain",
  selected = false,
  disabled = false,
  onPress,
  onContext,
  stacked = false,
  group,
  labelStyle,
  detailStyle,
  leading,
  children,
  style,
  ...box
}: PopupButtonProps) {
  const theme = useWarlockTheme();
  const styles = useButtonStyles();
  const { motion } = useWarlock();
  const { focused, element, take } = useFocusable(id, { disabled, onPress, group });
  const [hovered, setHovered] = useState(false);
  const [held, setHeld] = useState<"over" | "off" | null>(null);
  const button = useRef(leftButton);
  const lit = hovered && !disabled;
  const pressed = held === "over" && !disabled;

  const look = disabled
    ? styles.disabled
    : selected
      ? [styles.selected, lit && styles.selectedHover, pressed && styles.selectedPress]
      : [styles.rest[variant], lit && styles.hover[variant], pressed && styles.press[variant]];
  const color = disabled
    ? theme.palette.textSecondary
    : variant === "primary" && !selected
      ? theme.palette.onAction
      : variant === "quiet"
        ? theme.palette.textSecondary
        : theme.palette.text;
  const labelLook =
    variant === "primary"
      ? styles.labelPrimary
      : variant === "quiet"
        ? styles.labelQuiet
        : selected
          ? styles.labelStrong
          : styles.label;
  // Only a fill coming in under the pointer or a press glides, and only with full motion.
  const transition =
    motion === "reduced" || disabled || selected
      ? styles.still
      : pressed
        ? styles.pressing
        : lit
          ? styles.entering
          : styles.still;

  const over = (event: StagePointerEvent) => {
    const layout = event.currentTarget.layout;
    return (
      layout !== null &&
      event.localX >= 0 &&
      event.localY >= 0 &&
      event.localX <= layout.width &&
      event.localY <= layout.height
    );
  };

  return (
    <Box
      ref={element}
      style={[styles.base, stacked && styles.stacked, look, style]}
      shaders={ringShaders(theme, focused)}
      transition={transition}
      {...box}
    >
      {leading}
      {glyph && (
        <Glyph
          name={glyph}
          size={glyphSize ?? (stacked ? 28 : 20)}
          color={disabled ? color : (glyphColor ?? color)}
        />
      )}
      <Box
        flexDirection="column"
        flexGrow={stacked ? 0 : 1}
        flexShrink={1}
        alignItems={stacked ? "center" : "stretch"}
        gap={2}
      >
        <Box flexDirection="row" alignItems="center" gap={8}>
          <Text
            style={[labelLook, { color }, labelStyle]}
            flexShrink={1}
            align={stacked ? "center" : "start"}
          >
            {label}
          </Text>
          {disabled && <Glyph name="unavailable" size={12} color={color} />}
        </Box>
        {detail !== undefined && detail !== "" && (
          <Text style={[styles.detail, detailStyle]} align={stacked ? "center" : "start"}>
            {detail}
          </Text>
        )}
      </Box>
      {children}
      <Group
        position="absolute"
        x={0}
        y={0}
        width="100%"
        height="100%"
        cursor={disabled ? "not-allowed" : "pointer"}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onPointerDown={(event) => {
          button.current = event.button ?? leftButton;
          if (disabled) return;
          setHeld("over");
          if (button.current === leftButton) take();
        }}
        onPointerMove={held ? (event) => setHeld(over(event) ? "over" : "off") : undefined}
        onPointerUp={(event) => {
          if (held === null) return;
          setHeld(null);
          if (!over(event) || disabled) return;
          if (button.current === leftButton) onPress?.();
          else if (button.current === rightButton) onContext?.(event);
        }}
      />
    </Box>
  );
}

/** A hairline across the list, between groups of controls. */
export function Hairline(props: BoxProps) {
  const theme = useWarlockTheme();
  return (
    <Rect
      height={1}
      alignSelf="stretch"
      marginX={8}
      marginY={4}
      fill={theme.skin.hairline}
      {...props}
    />
  );
}

/** A line of text in the list that is not a control. */
export function Note({ children, ...box }: BoxProps) {
  const theme = useWarlockTheme();
  return (
    <Box paddingX={12} paddingY={6} {...box}>
      <Text style={theme.type.status} flexShrink={1}>
        {children}
      </Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// A text field in a popup

export interface PopupFieldProps extends Omit<BoxProps, "children"> {
  id: string;
  value: string;
  onChangeText: (text: string) => void;
  onSubmit?: (text: string) => void;
  placeholder?: string;
  /** A key before the field acts on it; return true to say it was handled. */
  onKey?: (event: StageKeyEvent) => boolean;
  /** Escape in the field: what the popup's Escape does. */
  onEscape: () => void;
  /** A glyph at the field's start, as the search field's magnifier. */
  glyph?: GlyphName;
  /** Round ends, as the search field has. */
  pill?: boolean;
  mono?: boolean;
  group?: number;
}

/** A field to type into that takes its turn in the popup's focus order. */
export function PopupField({
  id,
  value,
  onChangeText,
  onSubmit,
  placeholder,
  onKey,
  onEscape,
  glyph,
  pill = false,
  mono = false,
  group,
  ...box
}: PopupFieldProps) {
  const theme = useWarlockTheme();
  const store = useContext(FocusContext);
  const field = useRef<TextFieldHandle>(null);
  const { focused, element } = useFocusable(id, {
    group,
    onPress: () => field.current?.focus(),
    onFocus: (focused) => (focused ? field.current?.focus() : field.current?.blur()),
  });
  // The field draws with the SDK's control theme; give it Warlock's colours.
  const fieldTheme = useMemo(
    () =>
      createTheme(
        {
          colors: {
            ink: theme.palette.text,
            faint: theme.palette.textSecondary,
            accent: theme.palette.brandText,
            accentLine: alpha(theme.palette.text, 0),
            accentClear: alpha(theme.palette.text, 0),
            hover: alpha(theme.palette.text, 0),
            press: alpha(theme.palette.text, 0),
            raised: alpha(theme.palette.text, 0),
          },
          font: mono ? theme.type.code.font! : theme.type.label.font!,
        },
        theme.theme === "dawn" ? lightTheme : darkTheme,
      ),
    [theme, mono],
  );
  const height = theme.rem(pill ? 46 : 44);
  const text = {
    ...(mono ? theme.type.code : theme.type.label),
    size: theme.rem(pill ? 15 : 14),
    color: theme.palette.text,
  };
  return (
    <Box
      ref={element}
      flexDirection="row"
      alignItems="center"
      height={height}
      radius={pill ? height / 2 : 6}
      paddingLeft={glyph ? 16 : 4}
      paddingRight={8}
      gap={4}
      fill={pill ? theme.skin.tile : theme.palette.surfaceRecessed}
      border={{ width: 1, color: theme.palette.borderEssential }}
      shaders={ringShaders(theme, focused)}
      transition={instant}
      flexShrink={0}
      {...box}
    >
      {glyph && <Glyph name={glyph} size={18} color={theme.palette.textSecondary} />}
      <Box flexGrow={1} flexShrink={1} flexDirection="column">
        <ThemeProvider theme={fieldTheme}>
          <TextField
            ref={field}
            value={value}
            onChangeText={onChangeText}
            onSubmit={onSubmit}
            placeholder={placeholder}
            textStyle={text}
            placeholderStyle={{ ...text, color: theme.palette.textSecondary }}
            style={{
              fill: alpha(theme.palette.text, 0),
              border: { width: 0 },
              paddingX: 8,
              paddingY: 0,
            }}
            onFocusChange={(has) => {
              if (has) store?.focus(id, true);
              else if (store?.focused === id) store.focus(null, false);
            }}
            onKey={(event) => {
              if (onKey?.(event)) return true;
              if (event.key === "Tab" || event.key === "ISO_Left_Tab") {
                store?.move(
                  event.modifiers.includes("shift") || event.key === "ISO_Left_Tab" ? -1 : 1,
                  true,
                );
                return true;
              }
              if (event.key === "Escape") {
                if (!event.repeat) onEscape();
                return true;
              }
              return false;
            }}
          />
        </ThemeProvider>
      </Box>
    </Box>
  );
}
