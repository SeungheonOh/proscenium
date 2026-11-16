// Host element props and their canonical wire form.
//
// Each host type lists the fields it accepts. A field turns one ergonomic
// prop (`rotation` in degrees, CSS colors) into flat wire properties, so the
// compositor only ever validates scalars and colors. Decorations (`fill`,
// `border`, `shadow`, `blur`, `dim`, `grid`) become uses of the standard
// shaders, before the node's own `shaders`.

import { isAbsolute, resolve } from "node:path";
import type { ReactNode, Ref } from "react";
import { type Color, toWireColor } from "./color.js";
import type { StageClickEvent, StageContextMenuEvent, StageDragEvent, StageElement, StageErrorEvent,
  StageEvent, StageFocusEvent, StageGestureEvent, StageKeyboardEvent, StageLoadEvent, StageMeasureEvent,
  StagePointerEvent, StageRequestEvent, StageResizeEvent, StageScrollEvent, StageSelectEvent,
  StageSubmitEvent, StageTextInputEvent, StageWheelEvent } from "./events.js";
import type { Dimension, FlexContainerProps, FlexItemProps, LayoutBox } from "./layout.js";
import { type Animation, wireAnimations } from "./animation.js";
import { isMotion, type Motion, wireMotion } from "./motion.js";
import { backdropBlurWith, type BoxFeatures, boxInsetShadow, boxPaintWith, boxShadowWith, dimFilter,
  gradientPaint, planePaint, type Shading, type UniformValue, wireShading, wireUniforms } from "./shader.js";
import type { WireProps, WireValue } from "./protocol.js";
import { radians, type Transform, type TransformFunction, wireTransform } from "./transform.js";

/** Four values in CSS order: top, right, bottom, left (`border-width`, `padding`). */
export type Edges = readonly [number, number, number, number];

/** Four values in CSS order: top-left, top-right, bottom-right, bottom-left (`border-radius`). */
export type Corners = readonly [number, number, number, number];

/** One corner radius for every corner, or four in CSS order. */
export type Radius = number | Corners;

/** A gradient's stop: a color, spaced as CSS spaces stops without positions, or a color at 0 to 1. */
export type GradientStop = Color | readonly [Color, number];

/**
 * Up to four stops interpolated in Oklab, dithered so they never band: CSS
 * `linear-gradient(in oklab, …)` at `angle` degrees (0 = left to right), or
 * `radial-gradient(circle farthest-corner at <center>, in oklab, …)`.
 */
export interface Gradient {
  stops: readonly GradientStop[];
  angle?: number;
  shape?: "linear" | "radial";
  /** A radial gradient's center, as a fraction of the box; [0.5, 0.5] by default. */
  center?: readonly [number, number];
}

/**
 * A solid color; a two-stop linear gradient interpolated as CSS does by default (`from`,
 * `to`, ANGLE in degrees, 0 = left to right); or a Gradient of up to four stops in Oklab.
 */
export type Paint = Color | { from: Color; to: Color; angle?: number } | Gradient;

/** As one CSS `box-shadow`: offset, blur, spread (negative pulls it in), and `inset` inside the box. */
export interface Shadow {
  color?: Color;
  blur?: number;
  x?: number;
  y?: number;
  spread?: number;
  inset?: boolean;
}

/**
 * A border along the inside of the box, as CSS `border`: `width` for every side or four
 * (top, right, bottom, left), each drawn a whole number of output pixels, at least one;
 * `color` a color or a two-stop gradient; `dash` dashed (`border-style: dashed`), with
 * dashes three times the width long, or this long.
 */
export interface Border {
  width?: number | Edges;
  color?: Color | { from: Color; to: Color; angle?: number };
  dash?: boolean | number;
}

export interface Grid {
  kind?: "dots" | "lines" | "none";
  color?: Color;
  spacing?: number;
  /** Dot radius or line half-width in output pixels. */
  size?: number;
}

/** Theme cursor names, as in CSS; "none" hides the pointer. */
export type Cursor = "none" | "default" | "pointer" | "text" | "crosshair" | "move" | "grab"
  | "grabbing" | "not-allowed" | "help" | "wait" | "progress" | "zoom-in" | "zoom-out"
  | "ew-resize" | "ns-resize" | "nwse-resize" | "nesw-resize";

export interface CursorProps {
  /** Pointer shape over this node and its children, unless they set their own. */
  cursor?: Cursor;
}

export interface TransformProps {
  x?: number;
  y?: number;
  /**
   * Transform functions, applied about the origin as CSS applies them:
   * `[perspective(800), rotateY(20), scale(1.1)]`. They compose in 3D through
   * the scene, and input lands where the node shows however it is turned.
   */
  transform?: Transform;
  opacity?: number;
  /** Transform origin as a fraction of the node's size; defaults to the center. */
  originX?: number;
  originY?: number;
  visible?: boolean;
  /**
   * As CSS `backface-visibility`: `"hidden"` leaves the node, and what it holds,
   * undrawn and untouchable while it is turned away from the viewer, as a face
   * of a cube or the back of a card.
   */
  backface?: "visible" | "hidden";
}

/** Props shared through objects, merged under the element's own; later entries win. */
export type Style<P> = Partial<P> | false | null | undefined | readonly Style<P>[];

export interface ShaderProps {
  /**
   * Shaders the node uses: paints drawn under its content (after its shadow and
   * backdrop blur, before its fill and border) or over it, at most one filter
   * of its content (a window's `dim` is one) and at most one effect drawing it
   * and its children.
   */
  shaders?: readonly Shading[];
  /** A shader of the node failed to build; the node shows without it. */
  onError?: (event: StageErrorEvent) => void;
}

/** Props of every node a <Box> can lay out. */
export interface ElementProps<P> extends FlexItemProps {
  ref?: Ref<StageElement>;
  /** Called after a commit in which a <Box> gave this node a new box. */
  onLayout?: (layout: LayoutBox) => void;
  style?: Style<P>;
}

export interface ShapeProps extends TransformProps {
  /** Logical pixels; percentages resolve inside a <Box>. */
  width?: Dimension;
  height?: Dimension;
  /** Corner radius: one, or four in CSS order (top-left, top-right, bottom-right, bottom-left). */
  radius?: Radius;
  border?: Border;
  /** A shadow, or a list of them as CSS `box-shadow` lists them: the first on top. */
  shadow?: Shadow | readonly Shadow[];
  /** Backdrop blur radius: frosted glass over whatever is drawn behind. */
  blur?: number;
}

/** Paint fields that can animate, as accepted by `initial` and `exit`. */
export type PaintValues = Color | { from?: Color; to?: Color; angle?: number } | Gradient;

/** Props that can be animated, as accepted by `initial` and `exit`. */
export interface AnimatedValues {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** Animates function by function between lists of the same functions; see `TransformProps`. */
  transform?: Transform;
  opacity?: number;
  radius?: Radius;
  fill?: PaintValues;
  /** Text color. */
  color?: Color;
  border?: { width?: number | Edges; color?: Color | { from?: Color; to?: Color; angle?: number } };
  shadow?: Shadow | readonly Shadow[];
  grid?: Omit<Grid, "kind">;
  blur?: number;
  dim?: number;
  /** Uniforms of shaders by use id; as a transition, the motion of uses without their own. */
  shaders?: Record<string, Record<string, UniformValue>>;
}

/**
 * One motion for every prop, or motions per prop. `borderAngle` and
 * `fillAngle` target a gradient's angle alone, e.g. to spin a border forever
 * while its colors and width still settle normally.
 */
export type Transition = Motion | ({ default?: Motion }
  & { [K in keyof AnimatedValues | "borderAngle" | "fillAngle"]?: Motion });

export interface MotionProps {
  /** How changes animate: one motion for every prop, or per prop. */
  transition?: Transition;
  /** Values the node starts from when it first appears. */
  initial?: AnimatedValues;
  /** Values the node animates to after it is removed, before disappearing. */
  exit?: AnimatedValues;
  /** Nodes sharing a layoutId hand over their on-screen state when one replaces the other. */
  layoutId?: string;
  /**
   * Keyframe animations the compositor plays over the props, such as
   * `{ x: [0, -8, 8, 0], composite: "add", duration: 0.3 }`, or a list of them.
   */
  animate?: Animation | readonly Animation[] | null | false;
}

export interface PointerHandlers {
  onPointerDown?: (event: StagePointerEvent) => void;
  onPointerMove?: (event: StagePointerEvent) => void;
  onPointerUp?: (event: StagePointerEvent) => void;
  onPointerEnter?: (event: StagePointerEvent) => void;
  onPointerLeave?: (event: StagePointerEvent) => void;
  onWheel?: (event: StageWheelEvent) => void;
}

/**
 * States of a control the compositor resolves itself as the pointer and keys come, in the
 * frame that shows them, as CSS `:hover`, `:active`, `:focus-within`, `:focus` and
 * `:focus-visible`. `hover` holds while the pointer is over the node or its children;
 * `pressed` while a primary press begun on it is held and the pointer is still over it,
 * or Space is held on it focused; `focusWithin` while it or a node under it has keyboard
 * focus (a field's frame around its text); `focus` while it has keyboard focus, and
 * `focusVisible` when that came by keyboard. Where several hold, the later in this order
 * wins: hover, focusWithin, focus, focusVisible, pressed.
 */
export type StateName = "hover" | "pressed" | "focusWithin" | "focus" | "focusVisible";

/**
 * What a state shows in place of the node's own values: the values `initial` and `exit`
 * take, moving with the node's `transition`. A decoration's uniforms change only on a
 * node that has the decoration; a `fill`, `border`, `shadow` or `blur` that only states
 * name is added transparent for them.
 */
export type StateValues = AnimatedValues;

export interface States extends Partial<Record<StateName, StateValues>> {
  /**
   * Show the states of the nearest node at or above this one with `stateGroup` instead
   * of its own, as Tailwind's `group-hover`: a button's label and icon change with the
   * button.
   */
  group?: boolean;
}

/** Handlers of a node the compositor serves as a control: clicks, menus, focus and keys. */
export interface ControlHandlers {
  /** A primary press let go of over the node, or Enter or Space on it focused; bubbles. */
  onClick?: (event: StageClickEvent) => void;
  /** The second click of a quick pair; the clicks still come first. */
  onDoubleClick?: (event: StageClickEvent) => void;
  /** A click of another button, as the middle one. */
  onAuxClick?: (event: StageClickEvent) => void;
  /** The secondary button went down, or Menu or Shift+F10 on the node focused; bubbles. */
  onContextMenu?: (event: StageContextMenuEvent) => void;
  onFocus?: (event: StageFocusEvent) => void;
  onBlur?: (event: StageFocusEvent) => void;
  /** Keys while the node, or one under it, has keyboard focus; they bubble. */
  onKeyDown?: (event: StageKeyboardEvent) => void;
  onKeyUp?: (event: StageKeyboardEvent) => void;
}

export interface ControlProps extends ControlHandlers {
  /** Values to show while states hold, resolved in the compositor with no round trip. */
  states?: States;
  /** Children with `states.group` show this node's states. */
  stateGroup?: boolean;
  /**
   * Take keyboard focus, as the DOM's `tabindex`: a press on the node (or a child)
   * focuses it, and Tab and Shift+Tab reach it in tree order when it is 0 or more.
   * While a node has focus, keys go to it, not to windows.
   */
  tabIndex?: number;
}

/**
 * A group whose content scrolls natively, as CSS `overflow: auto`: the compositor keeps
 * the offset, moves and clips the children, and scrolls with the wheel and fingers.
 */
export interface ScrollProps {
  /** The axes it scrolls along. In a <Box>, its content's extent is sent as laid out. */
  scroll?: "x" | "y" | "both";
  /** While the end is in view, keep it in view as the content grows: a chat or a log. */
  stickToEnd?: boolean;
  /**
   * As CSS `overscroll-behavior`: "auto" passes what it cannot scroll to the container
   * around it, "contain" keeps it, "none" also keeps fingers from stretching past the ends.
   */
  overscroll?: "auto" | "contain" | "none";
  /** The content's size, when no <Box> lays it out. */
  contentWidth?: number;
  contentHeight?: number;
  /**
   * On a child of a scrolling group: its scroll thumb along that axis. The compositor
   * places it along the track, its declared `y` (or `x`) being the inset at either end
   * and its `height` (or `width`) the shortest it gets, and shows it while scrolling;
   * dragging it scrolls.
   */
  scrollThumb?: "x" | "y";
  /** Tab and Shift+Tab keep within this subtree while focus is in it: a menu, a dialog. */
  focusScope?: boolean;
  /** Where the offset is headed, coalesced. */
  onScroll?: (event: StageScrollEvent) => void;
}

/**
 * A draggable node follows the pointer inside the compositor, with no round
 * trip. Store the position from onDragEnd: once the drag ends, the node returns
 * to the x/y it is declared at.
 */
export interface PassThroughProps {
  /** False lets the pointer pass through this node to what is below; its children still take it. */
  interactive?: boolean;
}

export interface DragProps {
  draggable?: boolean;
  onDragStart?: (event: StageDragEvent) => void;
  /** Coalesced progress; use it for feedback, not to drive x/y. */
  onDrag?: (event: StageDragEvent) => void;
  onDragEnd?: (event: StageDragEvent) => void;
}

export interface GroupProps extends TransformProps, MotionProps, PointerHandlers, DragProps,
  PassThroughProps, CursorProps, ShaderProps, ControlProps, ScrollProps, ElementProps<GroupProps> {
  /**
   * Size of the group's box, for its transform origin, `clip` and shaders. A
   * sized group with pointer handlers catches the pointer anywhere inside it.
   */
  width?: Dimension;
  height?: Dimension;
  /** Corner radius of the box, as its shaders see it: one, or four in CSS order. */
  radius?: Radius;
  /**
   * Hide children outside the box, as CSS `overflow: hidden`: outside its rounded corners
   * too, where it keeps upright on screen.
   */
  clip?: boolean;
  /**
   * Draw the node and its children as one layer that `opacity` fades, as CSS `opacity`
   * does, instead of fading each part on its own, where overlapping parts show through
   * each other. Costs an offscreen pass only while the node is translucent.
   */
  groupOpacity?: boolean;
  children?: ReactNode;
}

/** A group drawing a rounded box: its decoration props are those of `boxPaint`. */
export interface RectProps extends ShapeProps, MotionProps, PointerHandlers, DragProps,
  PassThroughProps, CursorProps, ShaderProps, ControlProps, ScrollProps, ElementProps<RectProps> {
  fill?: Paint;
  /** Hide children outside the box, as CSS `overflow: hidden`, its rounded corners too. */
  clip?: boolean;
  /** Fade the node and its children as one layer, as CSS `opacity` does; see GroupProps. */
  groupOpacity?: boolean;
  children?: ReactNode;
}

/** A Rect that lays out its children with flexbox. */
export interface BoxProps extends Omit<RectProps, "style">, FlexContainerProps {
  style?: Style<BoxProps>;
}

/** Lines drawn with text, as CSS `text-decoration-line` names them. */
export type TextDecoration = "none" | "underline" | "line-through" | "underline line-through";

/** Text content: a string, or children that are strings and numbers. */
export type TextContent = string | number | readonly (string | number)[];

/**
 * A text label, laid out by Pango. The node's box is the text's measured size,
 * or `width` wide when given; it is reported through onMeasure. A <Text> inside
 * another styles its part of the text, as in React Native:
 * `<Text>Saved <Text weight="bold" color="#8f8">3</Text> files</Text>`; there
 * only `color`, `font`, `size`, `weight`, `italic`, `letterSpacing`, `features`,
 * `tabularNumbers` and `decoration` apply.
 */
export interface TextProps extends TransformProps, MotionProps, PointerHandlers, DragProps,
  PassThroughProps, CursorProps, ShaderProps, ControlProps, EditableTextProps, ElementProps<TextProps> {
  /** The text; string children are used when it is omitted. */
  text?: string;
  /** Read the text as Pango markup: <b>, <i>, <span foreground="#f80">, … */
  markup?: boolean;
  color?: Color;
  /** Family, or a comma-separated list of families. */
  font?: string;
  /** Font size in pixels. Animate `transform` rather than this. */
  size?: number;
  weight?: number | "normal" | "bold";
  italic?: boolean;
  /** Wrap width; `align` applies within it. In a <Box>, the width the Box gives it. */
  width?: Dimension;
  /** With `editable`, the box's height; a plain text's height is its lines'. */
  height?: Dimension;
  align?: "start" | "center" | "end";
  /** Line height as a multiple of the font's own. */
  lineHeight?: number;
  /** With `width`: end with an ellipsis after this many lines. */
  maxLines?: number;
  /** Pixels added after each character, as CSS `letter-spacing`; negative tightens. */
  letterSpacing?: number;
  /**
   * OpenType features, as CSS `font-feature-settings`: `{ tnum: true, liga: false }`, or
   * the CSS text, `'"tnum" 1, "liga" 0'`.
   */
  features?: Readonly<Record<string, boolean | number>> | string;
  /** Figures of one width, for clocks and counters: CSS `font-variant-numeric: tabular-nums`. */
  tabularNumbers?: boolean;
  /** Lines through the text, as CSS `text-decoration-line`. */
  decoration?: TextDecoration;
  /** Its size, or with `editable` the size of its text up to `maxLines` lines. */
  onMeasure?: (event: StageMeasureEvent) => void;
  /** Strings, numbers and nested <Text>s; with `markup`, strings are markup. */
  children?: ReactNode;
}

/**
 * A text the compositor edits itself, as an `<input>` or, `multiline`, a `<textarea>`: give
 * it `tabIndex` to take focus, and it keeps its own text, caret, selection and undo
 * history, takes keys and pointer presses in the same frame, and draws its caret and
 * selection. `text` is its value: declared with the `valueRevision` the latest `onInput`
 * carried, it replaces what is typed only when it is not that report's echo. The kit's
 * `TextField` is built on it.
 */
export interface EditableTextProps {
  /** Edit the text in the compositor, as an `<input>`: see EditableTextProps. */
  editable?: boolean;
  /** Lines that wrap and Return types, as a `<textarea>`; else one line that scrolls. */
  multiline?: boolean;
  /** Selectable and copyable, not editable: `readonly`. */
  readOnly?: boolean;
  /** Bullets for every character, never copied: `type="password"`. */
  password?: boolean;
  /** At most this many UTF-16 code units, as `maxlength` counts. */
  maxLength?: number;
  /** Shown while the text is empty: `placeholder`. */
  placeholder?: string;
  /** The placeholder's color, as `::placeholder`; by default the text's, faded. */
  placeholderColor?: Color;
  /** CSS `caret-color`; by default the text's. */
  caretColor?: Color;
  /** The selection's color, as `::selection` `background-color`; drawn under the text. */
  selectionColor?: Color;
  /**
   * Keys it leaves alone, sent as keydown instead with no default action, e.g. Up and
   * Down for a history, Tab for completion: keysym names, with modifiers as
   * "Control+Return". A keydown is not a veto the director could answer in time.
   */
  captureKeys?: readonly string[];
  /** The `revision` of the latest `onInput` heard; see EditableTextProps. */
  valueRevision?: number;
  /** In a multiline field Return submits and Shift+Return types a line break. */
  submitOnEnter?: boolean;
  /** Focus selects all the text, so typing replaces it. */
  selectOnFocus?: boolean;
  /**
   * The keys it takes: "emacs" (the default), the usual keys and the readline and Emacs
   * bindings, or "standard", a browser's. See docs/GUIDE.md for both lists.
   */
  keymap?: "emacs" | "standard";
  /**
   * Space between the box and its text, as CSS `padding` on the input: the text clips to
   * the box, and presses in the padding place the caret too. One number, or top, right,
   * bottom, left.
   */
  contentInset?: number | readonly [number, number, number, number];
  /** Its text changed by typing, pasting, undo: the DOM's `input`. Coalesced. */
  onInput?: (event: StageTextInputEvent) => void;
  /** Return in one line, or with `submitOnEnter`: the text as it stood then. */
  onSubmit?: (event: StageSubmitEvent) => void;
  /** The caret or selection moved: the DOM's `select`, also for a caret alone. Coalesced. */
  onSelect?: (event: StageSelectEvent) => void;
}

/**
 * An image file decoded off the compositor thread: PNG, JPEG, WebP, GIF, SVG
 * and whatever else gdk-pixbuf reads. Without `width` and `height` it takes its
 * natural size; with one of them it keeps its aspect ratio.
 */
export interface ImageProps extends ShapeProps, MotionProps, PointerHandlers, DragProps,
  PassThroughProps, CursorProps, ShaderProps, ControlProps, ElementProps<ImageProps> {
  /** Absolute path, a path relative to the world file, or an imported image. */
  src: string;
  /** How the image fills the box; "fill" stretches it. */
  fit?: "fill" | "contain" | "cover";
  onLoad?: (event: StageLoadEvent) => void;
  /** The image did not load, or a shader of the node failed to build. */
  onError?: (event: StageErrorEvent) => void;
}

export interface WindowProps extends ShapeProps, MotionProps, ShaderProps, ElementProps<WindowProps> {
  /** Window id from `useWindows()`. */
  window: number;
  /** Move natively with a "move" binding or the client's own title bar. */
  movable?: boolean;
  /** Resize natively with a "resize" binding or the client's own edges. */
  resizable?: boolean;
  onDragStart?: (event: StageDragEvent) => void;
  onDrag?: (event: StageDragEvent) => void;
  onDragEnd?: (event: StageDragEvent) => void;
  onResizeStart?: (event: StageResizeEvent) => void;
  onResize?: (event: StageResizeEvent) => void;
  onResizeEnd?: (event: StageResizeEvent) => void;
  /** Darken the content, 0..1, e.g. for inactive windows. */
  dim?: number;
  fullscreen?: boolean;
  maximized?: boolean;
  /** Ask the client to draw square, shadowless edges. */
  tiled?: boolean;
  focusable?: boolean;
  interactive?: boolean;
  onPointerEnter?: (event: StagePointerEvent) => void;
  onPointerLeave?: (event: StagePointerEvent) => void;
  /** Client-side decorations asked to move or resize; the pointer is captured
   * by this node until release, delivering onPointerMove/onPointerUp. */
  onMoveRequest?: (event: StageRequestEvent) => void;
  onResizeRequest?: (event: StageRequestEvent) => void;
  onPointerMove?: (event: StagePointerEvent) => void;
  onPointerUp?: (event: StagePointerEvent) => void;
  onFullscreenRequest?: (event: StageRequestEvent) => void;
  onMaximizeRequest?: (event: StageRequestEvent) => void;
  onMinimizeRequest?: (event: StageRequestEvent) => void;
  /**
   * The client asked for the window to be shown and focused, e.g. for a link
   * opened from another application. Without a handler it is focused where it is.
   */
  onActivateRequest?: (event: StageRequestEvent) => void;
  /** Drawn over the content, in the window's coordinates; one taking the pointer keeps it from the client. */
  children?: ReactNode;
}

/**
 * A window drawn once more, live: its frames as they come, scaled to the box
 * (its own size without one), with the decorations a Window takes. It takes no
 * input and does not configure the window.
 */
export interface MirrorProps extends ShapeProps, MotionProps, ShaderProps, ElementProps<MirrorProps> {
  /** Window id from `useWindows()`. */
  window: number;
  /** Darken the content, 0..1. */
  dim?: number;
}

/** The plane its paints cover; `fill` and `grid` are those of `planePaint`. */
export interface BackgroundProps extends Omit<TransformProps, "originX" | "originY">, MotionProps,
  PointerHandlers, CursorProps, ShaderProps {
  fill?: Color;
  grid?: Grid;
  /** Dragging or scrolling the empty plane pans the camera natively, with momentum. */
  pan?: boolean;
}

/**
 * Declares an output's camera. The camera itself lives in the compositor, so
 * pans and zooms track input exactly; x/y/zoom/rotation apply when they first
 * appear and whenever they change. Read it with useCamera() and move it from
 * code with moveCamera().
 */
export interface CameraProps {
  /** Output name; omit to apply to every output without its own camera. */
  output?: string;
  /** World point shown at the output's center. */
  x?: number;
  y?: number;
  zoom?: number;
  /** Degrees. */
  rotation?: number;
  minZoom?: number;
  maxZoom?: number;
  /** Transition for declared changes and moveCamera() without its own. */
  transition?: Motion;
}

export interface ScreenProps extends Omit<TransformProps, "originX" | "originY">, MotionProps {
  /** Output name; omit to show on every output. */
  output?: string;
  children?: ReactNode;
}

export type ModifierName = "super" | "logo" | "shift" | "ctrl" | "control" | "alt";

/**
 * Work a binding performs inside the compositor, in the same frame as the input.
 * "move"/"resize" act on the movable/resizable window (or draggable node) under
 * the pointer; "pan"/"zoom" act on the camera of the output under it.
 */
export type BindingAction = "move" | "resize" | "pan" | "zoom";

/**
 * Screen space this world keeps for UI it draws itself, such as a bar: the
 * output's `workArea` and window layouts leave it free.
 */
export interface ReserveProps {
  /** Output name; omit to reserve on every output. */
  output?: string;
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

export interface ShortcutProps {
  /** For example "Super+Shift+Return". */
  keys: string;
  repeat?: boolean;
  onPress?: () => void;
  onRelease?: () => void;
}

export interface PointerBindingProps {
  button?: "left" | "right" | "middle" | number;
  modifiers?: ModifierName | ModifierName[];
  action?: Exclude<BindingAction, "zoom">;
  onDown?: (event: StagePointerEvent) => void;
  onMove?: (event: StagePointerEvent) => void;
  onUp?: (event: StagePointerEvent) => void;
}

export interface WheelBindingProps {
  modifiers?: ModifierName | ModifierName[];
  action?: "pan" | "zoom";
  onWheel?: (event: StageWheelEvent) => void;
}

export interface GestureBindingProps {
  gesture: "swipe" | "pinch" | "hold";
  fingers?: number;
  modifiers?: ModifierName | ModifierName[];
  action?: "pan" | "zoom";
  onBegin?: (event: StageGestureEvent) => void;
  onUpdate?: (event: StageGestureEvent) => void;
  onEnd?: (event: StageGestureEvent) => void;
}

export type HostType =
  | "group" | "rect" | "box" | "text" | "image" | "web" | "window" | "mirror" | "background" | "camera"
  | "screen" | "reserve"
  | "shortcut" | "pointer-binding" | "wheel-binding" | "gesture-binding";

type Props = Record<string, unknown>;
type Writer = (value: never, out: WireProps) => void;

/**
 * Writers whose one wire property depends on their value alone, and which write
 * it for every value ACCEPTS takes: an update changing only such props can
 * write them over the previous wire props instead of normalizing again.
 */
const plainWriters = new Map<Writer, { wire: string; accepts: (value: unknown) => boolean }>();

function plain(wire: string, accepts: (value: unknown) => boolean, write: Writer): Writer {
  plainWriters.set(write, { wire, accepts });
  return write;
}

const isDefined = (value: unknown) => value !== undefined;
const isNumber = (value: unknown) => typeof value === "number";

function number(name: string): Writer {
  return plain(name, isDefined, (value: number, out) => { out[name] = value; });
}

function flag(name: string): Writer {
  return (value: boolean, out) => { out[name] = Boolean(value); };
}

/** A size; percentages only mean something to layout. */
function size(name: string): Writer {
  return plain(name, isNumber, (value: Dimension, out) => {
    if (typeof value === "number") out[name] = value;
  });
}

function text(name: string): Writer {
  return plain(name, isDefined, (value: string, out) => { out[name] = value; });
}

const color = (name: string): Writer =>
  plain(name, isDefined, (value: Color, out) => { out[name] = toWireColor(value); });

function isGradient(value: unknown): value is { from?: Color; to?: Color; angle?: number } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasStops(value: unknown): value is Gradient {
  return isGradient(value) && Array.isArray((value as Gradient).stops);
}
const rotation = plain("rotation", isDefined, (value: number, out) => { out.rotation = value * radians; });
const transformFunctions = plain("transform", isDefined, (value: Transform, out) => {
  out.transform = wireTransform(value);
});

const modifierNames: Record<string, string> = {
  super: "logo", logo: "logo", meta: "logo", shift: "shift", ctrl: "control", control: "control",
  alt: "alt",
};

function modifierList(value: string | string[]): string[] {
  return [...new Set((Array.isArray(value) ? value : [value]).map((name) => {
    const modifier = modifierNames[name.toLowerCase()];
    if (!modifier) throw new TypeError(`Unknown modifier ${JSON.stringify(name)}`);
    return modifier;
  }))].sort();
}

const keyAliases: Record<string, string> = {
  enter: "Return", esc: "Escape", space: "space", pageup: "Prior", pagedown: "Next",
  plus: "plus", minus: "minus", comma: "comma", period: "period", slash: "slash",
};

const shortcutKeys: Writer = (value: string, out) => {
  const parts = value.split("+").map((part) => part.trim()).filter(Boolean);
  const key = parts.pop();
  if (!key) throw new TypeError(`Shortcut ${JSON.stringify(value)} has no key`);
  out.key = keyAliases[key.toLowerCase()] ?? key;
  out.modifiers = modifierList(parts);
};

const buttons: Record<string, number> = { left: 272, right: 273, middle: 274 };

// Background and screen nodes have no size, so they take no transform origin.
const placement: Record<string, Writer> = {
  x: number("x"), y: number("y"), transform: transformFunctions, opacity: number("opacity"),
  visible: flag("visible"), backface: text("backface"),
};
const transform: Record<string, Writer> = {
  ...placement, originX: number("originX"), originY: number("originY"),
};

/** One radius, or four corners. */
const radius = plain("radius", isDefined, (value: Radius, out) => {
  out.radius = typeof value === "number" ? value : [...value];
});

const box: Record<string, Writer> = {
  ...transform, width: size("width"), height: size("height"), radius,
};

const modifiers: Writer = (value: string | string[], out) => { out.modifiers = modifierList(value); };

/** Chords as an editable text's `captureKeys` takes them: "Control+Return", "PageUp". */
const captureKeys: Writer = (value: string | readonly string[], out) => {
  const chords = typeof value === "string" ? value.split(/[\s,]+/) : value;
  out.captureKeys = chords.filter(Boolean).map((chord) => {
    const parts = chord.split("+");
    const key = parts.pop()!;
    return [...parts, keyAliases[key.toLowerCase()] ?? key].join("+");
  }).join(" ");
};

let assetBase = process.cwd();

/** Directory relative asset paths resolve against: the running world file's. */
export function setAssetBase(directory: string): void {
  assetBase = directory;
}

export function resolveAsset(path: string): string {
  return isAbsolute(path) ? path : resolve(assetBase, path);
}

const fontWeights: Record<string, number> = { normal: 400, bold: 700 };

function fontWeight(value: unknown): number {
  return typeof value === "number" ? value : fontWeights[String(value)] ?? 400;
}

export function isTextContent(value: unknown): value is TextContent {
  const atom = (item: unknown) => typeof item === "string" || typeof item === "number";
  return atom(value) || (Array.isArray(value) && value.every(atom));
}

export function textContent(value: TextContent): string {
  return Array.isArray(value) ? value.join("") : String(value);
}

const markupEscapes: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
};

export function escapeMarkup(text: string): string {
  return text.replace(/[&<>"']/g, (char) => markupEscapes[char]!);
}

/** The weight and style around a nested <Text>, which its children inherit. */
export interface SpanFont {
  weight: number;
  italic: boolean;
}

function hexColor(red: number, green: number, blue: number): string {
  return `#${[red, green, blue].map((channel) =>
    Math.round(channel * 255).toString(16).padStart(2, "0")).join("")}`;
}

/** Pango span attributes for a nested <Text>'s PROPS, and the font it passes on. */
export function spanAttributes(props: Props, outer: SpanFont): [string, SpanFont] {
  const font: SpanFont = {
    weight: props.weight === undefined ? outer.weight : fontWeight(props.weight),
    italic: props.italic === undefined ? outer.italic : Boolean(props.italic),
  };
  const sized = typeof props.size === "number";
  let attributes = "";
  // A pixel size is a whole font description, which resets weight and style
  // too, so a sized span states them again.
  if (sized) attributes += ` font="${props.size}px"`;
  if (typeof props.font === "string") attributes += ` font_family="${escapeMarkup(props.font)}"`;
  if (sized || font.weight !== outer.weight) attributes += ` weight="${font.weight}"`;
  if (sized || font.italic !== outer.italic) {
    attributes += ` style="${font.italic ? "italic" : "normal"}"`;
  }
  if (typeof props.letterSpacing === "number") {
    attributes += ` letter_spacing="${Math.round(props.letterSpacing * 1024)}"`;
  }
  const spanFeatures = joinFeatures(featureText(props.features), props.tabularNumbers ? '"tnum" 1' : "");
  if (spanFeatures) attributes += ` font_features="${escapeMarkup(spanFeatures)}"`;
  if (typeof props.decoration === "string") {
    attributes += ` underline="${props.decoration.includes("underline") ? "single" : "none"}"`;
    attributes += ` strikethrough="${props.decoration.includes("line-through")}"`;
  }
  if (props.color !== undefined) {
    const [red, green, blue, alpha] = toWireColor(props.color as Color);
    attributes += ` foreground="${hexColor(red, green, blue)}"`;
    if (alpha < 1) attributes += ` fgalpha="${Math.max(1, Math.round(alpha * 100))}%"`;
  }
  return [attributes, font];
}

const cursor = text("cursor");

/** What makes a drawn node a control. */
const control = { stateGroup: flag("stateGroup"), tabIndex: number("tabIndex") };

/** CSS font-feature-settings text of FEATURES. */
function featureText(features: unknown): string {
  if (typeof features === "string") return features;
  if (!features || typeof features !== "object") return "";
  return Object.entries(features as Record<string, boolean | number>)
    .map(([tag, value]) => `"${tag}" ${typeof value === "number" ? value : value ? 1 : 0}`).join(", ");
}

/** FIRST and SECOND, feature lists, as one. */
function joinFeatures(first: unknown, second: string): string {
  return [typeof first === "string" ? first : "", second].filter(Boolean).join(", ");
}

const features: Writer = (value: unknown, out) => {
  const text = featureText(value);
  if (text) out.fontFeatures = joinFeatures(out.fontFeatures, text);
};

const tabularNumbers: Writer = (value: boolean, out) => {
  if (value) out.fontFeatures = joinFeatures(out.fontFeatures, '"tnum" 1');
};

const group = {
  ...box, clip: flag("clip"), groupOpacity: flag("groupOpacity"), draggable: flag("draggable"),
  interactive: flag("interactive"), cursor,
  ...control, focusScope: flag("focusScope"), scroll: text("scroll"), stickToEnd: flag("stickToEnd"),
  overscroll: text("overscroll"), scrollThumb: text("scrollThumb"), contentWidth: number("contentWidth"),
  contentHeight: number("contentHeight"),
};

const fields: Record<HostType, Record<string, Writer>> = {
  group,
  rect: group,
  box: group,
  text: {
    ...transform, text: text("text"), markup: flag("markup"), color: color("color"),
    font: text("font"), size: number("fontSize"),
    weight: (value: number | string, out) => { out.fontWeight = fontWeight(value); },
    italic: flag("italic"), width: size("width"), align: text("align"),
    lineHeight: number("lineHeight"), maxLines: number("maxLines"), draggable: flag("draggable"),
    interactive: flag("interactive"), cursor, ...control, letterSpacing: number("letterSpacing"), features,
    tabularNumbers, decoration: text("decoration"), height: size("height"),
    editable: flag("editable"), multiline: flag("multiline"), readOnly: flag("readOnly"),
    password: flag("password"), maxLength: number("maxLength"), placeholder: text("placeholder"),
    placeholderColor: color("placeholderColor"), caretColor: color("caretColor"),
    selectionColor: color("selectionColor"), captureKeys, valueRevision: number("valueRevision"),
    submitOnEnter: flag("submitOnEnter"), selectOnFocus: flag("selectOnFocus"), keymap: text("keymap"),
    contentInset: (value: number | readonly number[], out) => {
      out.padding = typeof value === "number" ? value : [...value];
    },
  },
  image: {
    ...box, fit: text("fit"), draggable: flag("draggable"), interactive: flag("interactive"),
    cursor, ...control,
    src: (value: string, out) => { out.src = resolveAsset(value); },
  },
  web: {
    ...box, src: text("src"), data: text("data"), revision: number("revision"),
    focusable: flag("focusable"), interactive: flag("interactive"), autoFocus: flag("autoFocus"),
    frameTag: number("frameTag"), cursor,
  },
  window: {
    ...box, window: number("window"),
    fullscreen: flag("fullscreen"), maximized: flag("maximized"),
    tiled: flag("tiled"), focusable: flag("focusable"), interactive: flag("interactive"),
    movable: flag("movable"), resizable: flag("resizable"),
  },
  mirror: { ...box, window: number("window") },
  background: { ...placement, pan: flag("pan"), cursor },
  camera: {
    output: text("output"), x: number("x"), y: number("y"), zoom: number("zoom"), rotation,
    minZoom: number("minZoom"), maxZoom: number("maxZoom"),
  },
  screen: { ...placement, output: text("output") },
  reserve: { output: text("output"), top: number("top"), right: number("right"),
             bottom: number("bottom"), left: number("left") },
  shortcut: { keys: shortcutKeys, repeat: flag("repeat") },
  "pointer-binding": {
    button: (value: string | number, out) => {
      out.button = typeof value === "number" ? value : buttons[value] ?? 272;
    },
    modifiers, action: text("action"),
  },
  "wheel-binding": { modifiers, action: text("action") },
  "gesture-binding": { gesture: text("gesture"), fingers: number("fingers"), modifiers, action: text("action") },
};

/** Node props `initial`, `exit` and per-prop transitions may name. */
const animatedNames = new Set(["x", "y", "width", "height", "transform", "opacity", "radius", "color"]);

/** Transition keys of decorations and shaders, which their uses carry themselves. */
const shadingKeys = new Set(["fill", "fillAngle", "border", "borderAngle", "shadow", "grid", "blur",
                             "dim", "shaders"]);

/** Host types whose nodes take shaders. */
export const shaderTypes = new Set<HostType>(["group", "rect", "box", "text", "image", "web", "window",
                                              "mirror", "background"]);

/** How a decorated node's box paint draws its `border`: inside its box under the content, over
 * the content, or outside the box as a frame. These nodes also take `shadow` and `blur`. */
const borders: Partial<Record<HostType, "inside" | "over" | "frame">> = {
  rect: "inside", box: "inside", image: "over", web: "frame", window: "frame", mirror: "frame",
};

type Uniforms = Record<string, UniformValue>;
type Motions = Partial<Record<string, Motion>>;

const clear = toWireColor("transparent");

const fillNames = ["fill", "fillEnd", "fillAngle"] as const;
const borderColorNames = ["borderColor", "borderColorEnd", "borderAngle"] as const;

/** The uniforms of fill or border color VALUE as START, END and ANGLE; with COMPLETE, solid. */
function paintUniforms(value: PaintValues | undefined, names: readonly [string, string, string],
                       complete: boolean, out: Uniforms): void {
  const start = names[0], end = names[1], angle = names[2];
  // A gradient of stops is a paint of its own, under the box's border.
  if (hasStops(value)) value = undefined;
  if (value === undefined) {
    if (complete) {
      out[start] = clear;
      out[end] = clear;
      out[angle] = 0;
    }
  } else if (!isGradient(value)) {
    out[start] = out[end] = toWireColor(value);
    if (complete) out[angle] = 0;
  } else {
    const from = value.from === undefined ? undefined : toWireColor(value.from);
    if (from || complete) out[start] = from ?? clear;
    if (value.to !== undefined || complete) out[end] = value.to === undefined ? from ?? clear : toWireColor(value.to);
    if (value.angle !== undefined || complete) out[angle] = (value.angle ?? 0) * radians;
  }
}

/** Whether RADIUS gives its corners radii of their own. */
function ownCorners(radius: unknown): boolean {
  return Array.isArray(radius) && radius.some((corner) => corner !== radius[0]);
}

/**
 * What the box paints of PROPS draw beyond the plain ones, from their values, `initial`,
 * `exit` and `animate`: each feature is a program of its own, so a plain box costs what
 * it did before there were any.
 */
function boxFeatures(props: Props): BoxFeatures {
  const states = props.states as Record<string, unknown> | undefined;
  const all = [props, props.initial as Props | undefined, props.exit as Props | undefined,
    ...(states ? Object.values(states).filter((values): values is Props => typeof values === "object" && values !== null) : [])];
  const animations = props.animate ? [props.animate].flat() as Props[] : [];
  const corners = all.some((values) => ownCorners(values?.radius))
    || animations.some((animation) => Array.isArray(animation.radius)
      && (animation.radius as unknown[]).some((frame) => Array.isArray(frame)));
  const sides = all.some((values) => Array.isArray((values?.border as Border | undefined)?.width));
  const dash = all.some((values) => Boolean((values?.border as Border | undefined)?.dash));
  return { corners, sides, dash };
}

/** The box paint's uniforms of PROPS, for a box paint with FEATURES; with COMPLETE, every one. */
function boxUniforms(type: HostType, props: Props, complete: boolean, features: BoxFeatures): Uniforms {
  const out: Uniforms = {};
  const style = borders[type];
  paintUniforms(style === "inside" ? props.fill as PaintValues | undefined : undefined,
                fillNames, complete, out);
  const border = props.border as Border | undefined;
  const width = border?.width;
  if (width !== undefined || complete) {
    // The widest side, and how much thinner each side is, left, top, right, bottom.
    const sides = typeof width === "object" ? width : null;
    const widest = sides ? Math.max(0, ...sides) : width as number | undefined ?? 0;
    out.border = widest;
    if (features.sides) {
      out.borderTrim = sides
        ? [widest - sides[3], widest - sides[0], widest - sides[1], widest - sides[2]]
        : [0, 0, 0, 0];
    }
    out.outset = style === "frame" ? widest : 0;
    if (features.dash && (border?.dash !== undefined || complete)) {
      out.dash = !border?.dash ? 0 : typeof border.dash === "number" ? border.dash : 3 * widest;
    }
  }
  paintUniforms(border?.color, borderColorNames, complete, out);
  return out;
}

/** A `shadow` paint's uniforms; with COMPLETE, every one. */
function shadowUniforms(shadow: Shadow, complete: boolean): Uniforms {
  const out: Uniforms = {};
  if (shadow.color !== undefined || complete) out.color = shadow.color === undefined ? clear : toWireColor(shadow.color);
  for (const key of ["blur", "spread", "x", "y"] as const) {
    if (shadow[key] !== undefined || complete) out[key] = shadow[key] ?? 0;
  }
  return out;
}

const noShadows: readonly Shadow[] = [];

function shadowList(value: unknown): readonly Shadow[] {
  return !value ? noShadows : Array.isArray(value) ? value as readonly Shadow[] : [value as Shadow];
}

/** The use ids of the INSET or outer shadows of LIST, first on top, with each shadow. */
function shadowUses(list: readonly Shadow[], inset: boolean): [string, Shadow][] {
  const out: [string, Shadow][] = [];
  for (const shadow of list) {
    if (Boolean(shadow.inset) !== inset) continue;
    const base = inset ? "insetShadow" : "shadow";
    out.push([out.length ? `${base}${out.length + 1}` : base, shadow]);
  }
  return out;
}

/** Straight sRGB to Oklab (Björn Ottosson, 2020), alpha kept. */
function oklab(color: Color): [number, number, number, number] {
  const [r, g, b, a] = toWireColor(color).map((channel, index) => index === 3 ? channel
    : channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4) as number[];
  const l = Math.cbrt(0.4122214708 * r! + 0.5363325363 * g! + 0.0514459929 * b!);
  const m = Math.cbrt(0.2119034982 * r! + 0.6806995451 * g! + 0.1073969566 * b!);
  const s = Math.cbrt(0.0883024619 * r! + 0.2817188376 * g! + 0.6299787005 * b!);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
          1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
          0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s, a!];
}

/** The gradient paint's uniforms of GRADIENT; with COMPLETE, every one. */
function gradientUniforms(gradient: Gradient, complete: boolean): Uniforms {
  const out: Uniforms = {};
  const stops = gradient.stops;
  if (stops.length) {
    if (stops.length > 4) throw new TypeError(`A gradient has at most 4 stops, not ${stops.length}`);
    const colors = stops.map((stop) => isStopAt(stop) ? stop[0] : stop);
    const at = stops.map((stop) => isStopAt(stop) ? stop[1] : NaN);
    // As CSS places stops without positions: the ends at 0 and 1, the rest evenly between.
    if (Number.isNaN(at[0])) at[0] = 0;
    if (Number.isNaN(at[at.length - 1])) at[at.length - 1] = 1;
    for (let index = 1; index < at.length; index++) {
      if (!Number.isNaN(at[index]!)) {
        at[index] = Math.max(at[index]!, at[index - 1]!);
        continue;
      }
      let next = index;
      while (Number.isNaN(at[next]!)) next++;
      const from = at[index - 1]!, step = (at[next]! - from) / (next - index + 1);
      for (let k = index; k < next; k++) at[k] = from + step * (k - index + 1);
    }
    for (let k = 0; k < 4; k++) out[`color${k}`] = oklab(colors[Math.min(k, colors.length - 1)]!);
    out.stops = [0, 1, 2, 3].map((k) => k < at.length ? at[k]! : 1) as unknown as UniformValue;
  } else if (complete) {
    for (let k = 0; k < 4; k++) out[`color${k}`] = clear;
    out.stops = [0, 1, 1, 1];
  }
  if (gradient.angle !== undefined || complete) out.angle = (gradient.angle ?? 0) * radians;
  if (gradient.shape !== undefined || complete) out.shape = gradient.shape === "radial" ? 1 : 0;
  if (gradient.center !== undefined || complete) out.center = [...gradient.center ?? [0.5, 0.5]] as [number, number];
  return out;
}

function isStopAt(stop: GradientStop): stop is readonly [Color, number] {
  return Array.isArray(stop) && stop.length === 2 && typeof stop[1] === "number" && typeof stop[0] !== "number";
}

/** The plane's uniforms of a background's PROPS; with COMPLETE, every one. */
function planeUniforms(props: Props, complete: boolean): Uniforms {
  const out: Uniforms = {};
  if (props.fill !== undefined || complete)
    out.color = props.fill === undefined ? clear : toWireColor(props.fill as Color);
  const grid = props.grid as Grid | undefined;
  const shown = grid !== undefined && grid.kind !== "none";
  if (shown || complete) {
    if (grid?.color !== undefined || complete)
      out.gridColor = shown ? toWireColor(grid?.color ?? "#ffffff24") : clear;
    if (grid?.spacing !== undefined || complete) out.spacing = grid?.spacing ?? 32;
    if (grid?.size !== undefined || complete) out.weight = grid?.size ?? 1;
    if (complete) out.lines = grid?.kind === "lines" ? 1 : 0;
  }
  return out;
}

type Parts = Record<string, Motion>;

/** PARTS with each of NAMES moving with MOTION, unless it is absent. */
function addParts(parts: Parts | null, motion: Motion | undefined, names: readonly string[]): Parts | null {
  if (!motion) return parts;
  parts ??= {};
  for (const name of names) parts[name] = motion;
  return parts;
}

/** Motions by uniform from addParts, the rest moving with FALLBACK. */
function partMotions(parts: Parts | null, fallback?: Motion): Shading["transition"] {
  if (!parts) return fallback;
  if (fallback) parts.default = fallback;
  return parts;
}

const gradientNames = ["color0", "color1", "color2", "color3", "stops", "angle", "center"] as const;
const planeColorNames = ["color"] as const;
const planeGridNames = ["gridColor", "spacing", "weight"] as const;
const fillAngleNames = ["fillAngle"] as const;
const borderNames = ["border", "borderTrim", "borderColor", "borderColorEnd", "borderAngle", "outset",
                     "dash"] as const;
const borderAngleNames = ["borderAngle"] as const;
const noShadings: readonly Shading[] = [];

/**
 * The wire `shaders` of PROPS in the order they draw: the shadow, the backdrop
 * blur, the node's own paints under its content, then its fill and border; its
 * own paints over its content follow, and its filter and effect. Each moves
 * with its decoration's transition, else `transition.shaders`, else the node's
 * default.
 */
function wireShaders(type: HostType, props: Props): WireValue[] | undefined {
  if (props.fill === undefined && props.grid === undefined && !props.shadow && typeof props.blur !== "number"
      && props.border === undefined && props.shaders == null && typeof props.dim !== "number") {
    return undefined;
  }
  const transition = props.transition as Transition | undefined;
  const motions: Motions = transition && !isMotion(transition) ? transition as Motions : {};
  const fallback = motions.shaders;
  const under: Shading[] = [], over: Shading[] = [];
  const style = borders[type];
  if (type === "background" && (props.fill !== undefined || props.grid !== undefined)) {
    under.push({ id: "plane", shader: planePaint, uniforms: planeUniforms(props, true),
                 transition: partMotions(addParts(addParts(null, motions.fill, planeColorNames),
                                                  motions.grid, planeGridNames), fallback) });
  }
  const features = boxFeatures(props);
  // As CSS lists shadows, the first on top: drawn last.
  const shadows = style ? shadowList(props.shadow) : noShadows;
  for (const [id, shadow] of shadowUses(shadows, false).reverse()) {
    under.push({ id, shader: boxShadowWith(features), uniforms: shadowUniforms(shadow, true),
                 transition: motions.shadow ?? fallback });
  }
  const insets: Shading[] = shadowUses(shadows, true).reverse().map(([id, shadow]) =>
    ({ id, shader: boxInsetShadow, uniforms: shadowUniforms(shadow, true), transition: motions.shadow ?? fallback }));
  const blur = typeof props.blur === "number" && style
    ? { id: "blur", shader: backdropBlurWith(features), uniforms: { blur: props.blur },
        transition: motions.blur ?? fallback }
    : null;
  const gradient: Shading | null = style === "inside" && hasStops(props.fill) ? {
    id: "gradient", shader: gradientPaint, uniforms: gradientUniforms(props.fill, true),
    transition: partMotions(addParts(addParts(null, motions.fill, gradientNames), motions.fillAngle,
                                     ["angle"]), fallback),
  } : null;
  const decorated = props.border !== undefined
    || (style === "inside" && props.fill !== undefined && !gradient);
  const box: Shading | null = decorated ? {
    id: "box", shader: boxPaintWith(features), uniforms: boxUniforms(type, props, true, features),
    layer: style === "over" ? "over" : "under",
    transition: partMotions(addParts(addParts(addParts(addParts(null,
      motions.fill, fillNames), motions.fillAngle, fillAngleNames),
      motions.border, borderNames), motions.borderAngle, borderAngleNames), fallback),
  } : null;
  // Own paints under the content go between what lies behind the box and its fill: a
  // frame's border lies outside the box, so the backdrop blur inside it comes last.
  const own = (props.shaders as readonly Shading[] | undefined) ?? noShadings;
  const ownUnder = own.length === 0 ? noShadings
    : own.filter((shading) => shading.shader.stage === "paint" && shading.layer !== "over");
  const rest = own.length === 0 ? noShadings : own.filter((shading) => !ownUnder.includes(shading));
  if (style === "frame") {
    under.push(...ownUnder);
    if (box) under.push(box);
    if (blur) under.push(blur);
    under.push(...insets);
  } else {
    if (blur) under.push(blur);
    under.push(...ownUnder);
    if (gradient) under.push(gradient);
    if (box && style === "over") over.push(box, ...insets);
    else if (box) under.push(box, ...insets);
    else under.push(...insets);
  }
  if ((type === "window" || type === "mirror") && typeof props.dim === "number")
    under.push({ id: "dim", shader: dimFilter, uniforms: { amount: props.dim }, transition: motions.dim ?? fallback });
  const all = [...under, ...over, ...rest];
  if (!all.length) return undefined;
  if (!shaderTypes.has(type)) throw new TypeError(`A ${type} takes no shaders`);
  checkShaders(type, all);
  return all.map((shading) => wireShading(shading, fallback));
}

/** Throw on uses the compositor would reject, before they cost the node its whole update. */
function checkShaders(type: HostType, uses: readonly Shading[]): void {
  if (uses.length > 8) throw new TypeError(`A node uses at most 8 shaders, not ${uses.length}`);
  const ids = new Set<string>();
  const stages = { paint: 0, filter: 0, effect: 0 };
  for (const use of uses) {
    if (ids.has(use.id)) {
      throw new TypeError(`Two shaders of a ${type} share id ${JSON.stringify(use.id)} (decorations use `
        + "box, gradient, shadow, shadow2…, insetShadow…, blur, dim and plane)");
    }
    ids.add(use.id);
    stages[use.shader.stage]++;
  }
  if (stages.filter > 1) throw new TypeError("A node takes one filter (a window's dim is one)");
  if (stages.effect > 1) throw new TypeError("A node takes one effect");
  if (stages.filter && (type === "group" || type === "rect" || type === "box"))
    throw new TypeError(`A ${type} has no content to filter`);
  if (type === "background" && stages.paint !== uses.length)
    throw new TypeError("A background takes only paints");
}

/** `initial` or `exit` values of the shaders VALUES name: the decorations' and the node's own. */
function wireShaderTargets(type: HostType, values: Props, features: BoxFeatures): WireProps | undefined {
  if (!shaderTypes.has(type)) return undefined;
  const out: Record<string, Uniforms> = {};
  const add = (id: string, uniforms: Uniforms) => {
    if (Object.keys(uniforms).length) out[id] = { ...out[id], ...uniforms };
  };
  if (values.shadow && borders[type]) {
    const list = shadowList(values.shadow);
    for (const inset of [false, true]) {
      for (const [id, shadow] of shadowUses(list, inset)) add(id, shadowUniforms(shadow, false));
    }
  }
  if (hasStops(values.fill) && borders[type] === "inside") add("gradient", gradientUniforms(values.fill, false));
  if (typeof values.blur === "number" && borders[type]) add("blur", { blur: values.blur });
  if (typeof values.dim === "number" && (type === "window" || type === "mirror")) add("dim", { amount: values.dim });
  if (type === "background") add("plane", planeUniforms(values, false));
  else if (borders[type]) add("box", boxUniforms(type, values, false, features));
  for (const [id, uniforms] of Object.entries((values.shaders as Record<string, Uniforms> | undefined) ?? {}))
    add(id, uniforms);
  const wire: WireProps = {};
  for (const [id, uniforms] of Object.entries(out)) wire[id] = wireUniforms(uniforms);
  return Object.keys(wire).length ? wire : undefined;
}

const handlerEvents: Record<string, string> = {
  onPointerDown: "pointerdown", onPointerMove: "pointermove", onPointerUp: "pointerup",
  onPointerEnter: "pointerenter", onPointerLeave: "pointerleave", onWheel: "wheel",
  onPress: "press", onRelease: "release", onDown: "down", onMove: "move", onUp: "up",
  onBegin: "begin", onUpdate: "update", onEnd: "end",
  onMoveRequest: "moverequest", onResizeRequest: "resizerequest",
  onDragStart: "dragstart", onDrag: "drag", onDragEnd: "dragend",
  onResizeStart: "resizestart", onResize: "resize", onResizeEnd: "resizeend",
  onFullscreenRequest: "fullscreenrequest", onMaximizeRequest: "maximizerequest",
  onMinimizeRequest: "minimizerequest", onActivateRequest: "activaterequest",
  onMeasure: "measure", onLoad: "load", onError: "error", onMessage: "message",
  onClick: "click", onDoubleClick: "dblclick", onAuxClick: "auxclick", onContextMenu: "contextmenu",
  onFocus: "focus", onBlur: "blur", onKeyDown: "keydown", onKeyUp: "keyup", onScroll: "scroll",
  onInput: "input", onSubmit: "submit", onSelect: "select",
};

function wireTransition(transition: Transition): WireProps {
  if (isMotion(transition)) return { default: wireMotion(transition) };
  const out: WireProps = {};
  for (const [name, motion] of Object.entries(transition)) {
    if (!motion || shadingKeys.has(name)) continue;
    if (name !== "default" && !animatedNames.has(name)) throw new TypeError(`Cannot transition ${JSON.stringify(name)}`);
    out[name] = wireMotion(motion);
  }
  return out;
}

function writeFields(type: HostType, props: Props, out: WireProps, only?: Set<string>): void {
  const accepted = fields[type];
  for (const name in props) {
    const value = props[name];
    if (value === undefined || (only && !only.has(name))) continue;
    const write = accepted[name];
    if (write) write(value as never, out);
  }
}


/** Props a <Box> reads to place and size a node. */
const layoutKeys = new Set([
  "x", "y", "width", "height", "minWidth", "minHeight", "maxWidth", "maxHeight", "aspectRatio",
  "flexGrow", "flexShrink", "flexBasis", "alignSelf", "position", "display",
  "margin", "marginX", "marginY", "marginTop", "marginRight", "marginBottom", "marginLeft",
  "flexDirection", "flexWrap", "justifyContent", "alignItems", "alignContent",
  "gap", "rowGap", "columnGap",
  "padding", "paddingX", "paddingY", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "scroll",
]);

/** The host type the compositor knows a node as: a Rect or a Box is a group. */
export function wireType(type: HostType): string {
  return type === "box" || type === "rect" ? "group" : type;
}

export type EventHandler = (event: StageEvent) => void;

export interface Normalized {
  wire: WireProps;
  handlers: Map<string, EventHandler>;
  /** What a <Box> reads to lay the node out. */
  style: Props;
  onLayout: ((layout: LayoutBox) => void) | null;
}

function mergeStyle(style: unknown, into: Props): void {
  if (Array.isArray(style)) for (const entry of style) mergeStyle(entry, into);
  else if (style && typeof style === "object") Object.assign(into, style);
}

/** PROPS over the objects of their `style` prop, as in React Native. */
function withStyle(props: Props): Props {
  const merged: Props = {};
  mergeStyle(props.style, merged);
  for (const [name, value] of Object.entries(props)) if (value !== undefined) merged[name] = value;
  return merged;
}

const settle: EventHandler = () => {};

/** Translate host element props into wire props, handlers and layout style. */
export function normalizeProps(type: HostType, given: Props): Normalized {
  const props = given.style ? withStyle(given) : given;
  const wire: WireProps = {};
  const handlers = new Map<string, EventHandler>();
  const style: Props = {};
  writeFields(type, props, wire);
  if (type === "text" && props.text === undefined && isTextContent(props.children)) {
    wire.text = textContent(props.children);
  }
  for (const name in props) {
    const value = props[name];
    if (value === undefined) continue;
    if (layoutKeys.has(name)) style[name] = value;
    const event = handlerEvents[name];
    if (event && typeof value === "function") handlers.set(event, value as EventHandler);
  }
  if (style.display === "none") wire.visible = false;
  // After a native move or resize the host returns the node to its declared
  // place, unless a handler declares another; for that it hears every one end.
  if ((wire.movable || wire.draggable) && !handlers.has("dragend")) handlers.set("dragend", settle);
  if (wire.resizable && !handlers.has("resizeend")) handlers.set("resizeend", settle);
  if (handlers.size > 0) wire.handlers = [...handlers.keys()].sort();
  if (props.transition) {
    const transition = wireTransition(props.transition as Transition);
    if (Object.keys(transition).length) wire.transition = transition;
  }
  const states = props.states as States | undefined;
  const shaders = wireShaders(type, states ? withStateDecorations(type, props, states) : props);
  if (shaders) wire.shaders = shaders;
  // A box clips its children inside its border, as CSS clips to the padding box.
  const clipBorder = (props.border as Border | undefined)?.width;
  if (props.clip && borders[type] === "inside" && clipBorder) {
    wire.clipInset = typeof clipBorder === "number" ? clipBorder : [...clipBorder];
  }
  if (states) wire.states = wireStates(type, states, boxFeatures(props));
  for (const key of ["initial", "exit"] as const) {
    if (props[key]) {
      const values: WireProps = {};
      // A copy: only its own props, as writeFields reads every enumerable one.
      writeFields(type, { ...props[key] as Props }, values, animatedNames);
      const targets = wireShaderTargets(type, props[key] as Props, boxFeatures(props));
      if (targets) values.shaders = targets;
      wire[key] = values;
    }
  }
  // The compositor starts from `initial` only the props a node sets: one left at its default
  // (opacity 1, no transform) is set to it, so it too starts from `initial`.
  const initial = props.initial as AnimatedValues | undefined;
  if (initial?.opacity !== undefined && props.opacity === undefined) writeFields(type, { opacity: 1 }, wire);
  if (initial?.transform !== undefined && props.transform === undefined) {
    writeFields(type, { transform: unmoved(initial.transform) }, wire);
  }
  if (props.animate) wire.animate = wireAnimations(props.animate as Animation | Animation[], type);
  if (typeof props.layoutId === "string") wire.layoutId = props.layoutId;
  const onLayout = typeof props.onLayout === "function"
    ? props.onLayout as (layout: LayoutBox) => void
    : null;
  return { wire, handlers, style, onLayout };
}

const stateNames: readonly StateName[] = ["hover", "focusWithin", "focus", "focusVisible", "pressed"];

/** `states` on the wire: each state's values written as `initial` and `exit` are. */
function wireStates(type: HostType, states: States, features: BoxFeatures): WireProps {
  const out: WireProps = {};
  for (const name of stateNames) {
    const values = states[name];
    if (!values) continue;
    const wire: WireProps = {};
    writeFields(type, { ...values as Props }, wire, animatedNames);
    const targets = wireShaderTargets(type, values as Props, features);
    if (targets) wire.shaders = targets;
    out[name] = wire;
  }
  if (states.group) out.group = true;
  return out;
}

/** PROPS with transparent decorations its states name and it lacks, for them to change. */
function withStateDecorations(type: HostType, props: Props, states: States): Props {
  let out = props;
  const add = (name: string, value: unknown) => {
    if (out === props) out = { ...props };
    out[name] = value;
  };
  for (const name of stateNames) {
    const values = states[name];
    if (!values) continue;
    if (values.fill !== undefined && props.fill === undefined && borders[type] === "inside") add("fill", "transparent");
    if (values.border !== undefined && props.border === undefined && borders[type]) add("border", { width: 0 });
    if (values.shadow && borders[type]) {
      // Each shadow a state shows needs one of the node's to change, outer and inset alike.
      const own = shadowList(out.shadow), shown = shadowList(values.shadow);
      const missing = (inset: boolean) =>
        shadowUses(shown, inset).length - shadowUses(own, inset).length;
      const extra: Shadow[] = [];
      for (const inset of [false, true]) {
        for (let k = missing(inset); k > 0; k--) extra.push(inset ? { inset: true } : {});
      }
      if (extra.length) add("shadow", [...own, ...extra]);
    }
    if (values.blur !== undefined && typeof props.blur !== "number" && borders[type]) add("blur", 0);
  }
  return out;
}

/** TRANSFORM's functions, each doing nothing: what a node with no transform of its own shows. */
function unmoved(transform: Transform): Transform {
  const functions = (typeof transform[0] === "string" ? [transform] : transform) as readonly TransformFunction[];
  return functions.map(([name, ...parameters]): TransformFunction => {
    switch (name) {
      case "translate": return [name, 0, 0, 0];
      case "scale": return [name, 1, 1, 1];
      case "rotate": return [name, ...parameters.slice(0, 3), 0];
      case "skew": return [name, 0, 0];
      default: return [name, ...parameters];
    }
  });
}

function sameValue(left: WireValue | undefined, right: WireValue | undefined): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) if (!sameValue(left[index], right[index])) return false;
    return true;
  }
  const leftProps = left as Record<string, WireValue>, rightProps = right as Record<string, WireValue>;
  let count = 0;
  for (const key in leftProps) {
    if (!sameValue(leftProps[key], rightProps[key])) return false;
    count++;
  }
  return count === keyCount(rightProps);
}

function keyCount(object: object): number {
  let count = 0;
  for (const _ in object) count++;
  return count;
}

/**
 * Changed wire props; a prop that disappeared is sent as null to restore its
 * default. `initial` applies only when a node is created, so it never changes.
 */
export function diffWire(previous: WireProps, next: WireProps): WireProps | null {
  let changes: WireProps | null = null;
  for (const key in next) {
    if (key !== "initial" && !sameValue(previous[key], next[key])) (changes ??= {})[key] = next[key]!;
  }
  for (const key in previous) {
    if (key !== "initial" && !(key in next)) (changes ??= {})[key] = null;
  }
  return changes;
}

/** diffWire of NEXT and PREVIOUS where they can differ only in KEYS, which both have. */
export function diffKeys(previous: WireProps, next: WireProps, keys: readonly string[]): WireProps | null {
  let changes: WireProps | null = null;
  if (keys.length === 1) {
    const key = keys[0]!;
    if (!sameValue(previous[key], next[key])) changes = { [key]: next[key]! };
  } else if (keys.length > 1) {
    // In the order diffWire would find them.
    for (const key in next) {
      if (keys.includes(key) && !sameValue(previous[key], next[key])) (changes ??= {})[key] = next[key]!;
    }
  }
  return changes;
}

// Updates.
//
// An update mostly changes a few props, such as x and y every frame. When each
// prop that changed writes a wire field of its own, or is read only by layout or
// as a handler, the node's wire props with those fields written again are what
// normalizeProps would make of its new props, and only those fields can differ:
// fills, borders, shadows, shaders and motions are neither converted nor
// compared again. As in React DOM, a prop holding the same object as before is
// unchanged; one holding a new object is unchanged when it is equal in value,
// with its keys in the same order.

/** How a host type takes a change of one prop. */
type Change =
  /** It writes its own wire field, and is read by layout too with LAYOUT. */
  | { kind: "field"; write: Writer; wire: string; accepts: (value: unknown) => boolean; layout: boolean }
  /** Read only by layout. */
  | { kind: "layout" }
  | { kind: "handler"; event: string }
  | { kind: "onLayout" }
  /** A Text's string children, which are its text. */
  | { kind: "content" }
  /** Read in other ways: an update that changes its value normalizes the props again. */
  | { kind: "other" };

/** Props normalizeProps reads besides fields, layout props and handlers. */
const derivedKeys = ["style", "transition", "fill", "border", "shadow", "blur", "grid", "dim", "shaders",
                     "initial", "exit", "animate", "layoutId", "states"];

/** How TYPE takes a change of each prop it reads; the rest it ignores. */
function changesOf(type: HostType): Map<string, Change> {
  const changes = new Map<string, Change>();
  const other: Change = { kind: "other" };
  for (const name of derivedKeys) changes.set(name, other);
  // `display: "none"` also hides the node.
  for (const name of layoutKeys) changes.set(name, name === "display" ? other : { kind: "layout" });
  for (const name in handlerEvents) changes.set(name, { kind: "handler", event: handlerEvents[name]! });
  changes.set("onLayout", { kind: "onLayout" });
  if (type === "text") changes.set("children", { kind: "content" });
  for (const name in fields[type]) {
    const write = fields[type][name]!;
    const plain = plainWriters.get(write);
    changes.set(name, plain ? { kind: "field", write, ...plain, layout: layoutKeys.has(name) } : other);
  }
  return changes;
}

const changeKinds = Object.fromEntries((Object.keys(fields) as HostType[])
  .map((type) => [type, changesOf(type)])) as Record<HostType, Map<string, Change>>;

/** How much of a prop's value sameInput looks at before calling it changed. */
const inputBudget = 4096;
const maxInputDepth = 12;
let budget = 0;
/** Keys of an object at each depth of sameInput, reused. */
const inputKeys: string[][] = [];

/**
 * Whether prop values A and B normalize alike: equal primitives, functions by
 * identity, and arrays and plain objects equal in their items, keys and key order.
 */
function sameInput(a: unknown, b: unknown, depth: number): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (depth === maxInputDepth || --budget < 0) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index++) if (!sameInput(a[index], b[index], depth + 1)) return false;
    return true;
  }
  const prototype = Object.getPrototypeOf(a);
  if ((prototype !== Object.prototype && prototype !== null) || Object.getPrototypeOf(b) !== prototype) {
    return false;
  }
  const left = a as Props, right = b as Props;
  const keys = (inputKeys[depth] ??= []);
  keys.length = 0;
  for (const key in left) keys.push(key);
  let index = 0;
  for (const key in right) if (keys[index++] !== key) return false;
  if (index !== keys.length) return false;
  for (index = 0; index < keys.length; index++) {
    if (!sameInput(left[keys[index]!], right[keys[index]!], depth + 1)) return false;
  }
  return true;
}

/** What normalizeProps made of a node's props, as the node keeps it. */
export interface NormalizedNode {
  declared: WireProps;
  handlers: Map<string, EventHandler>;
  style: Props;
  onLayout: ((layout: LayoutBox) => void) | null;
  /**
   * Whether `declared` holds a NaN, unknown until a patch asks. Normalizing
   * makes such a value anew, unequal to itself, so every update sends it again;
   * those updates keep normalizing to go on doing so.
   */
  holdsNaN: boolean | undefined;
}

/** Whether VALUE is or holds a NaN. */
function holdsNaN(value: WireValue | undefined): boolean {
  if (typeof value === "number") return value !== value;
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) {
    for (const item of value) if (holdsNaN(item)) return true;
    return false;
  }
  for (const key in value) if (holdsNaN(value[key])) return true;
  return false;
}

/** Scratch lists of patchProps, reused so that an update allocates only what it keeps. */
const previousKeys: string[] = [];
const patched: string[] = [];
const patchedWire: string[] = [];

/**
 * Brings NODE, normalized from PREVIOUS props, up to date with NEXT without
 * normalizing again, when every prop that changed writes its own wire field, is
 * read only by layout or is a handler. Returns the wire props that may have
 * changed (a list valid until the next call), or null, leaving NODE as it was,
 * when NEXT has to be normalized.
 */
export function patchProps(type: HostType, previous: Props, next: Props,
                           node: NormalizedNode): readonly string[] | null {
  node.holdsNaN ??= holdsNaN(node.declared);
  if (node.holdsNaN) return null;
  const changes = changeKinds[type];
  previousKeys.length = 0;
  for (const key in previous) previousKeys.push(key);
  patched.length = 0;
  budget = inputBudget;
  let index = 0;
  // The same props in the same order, so that what they make keeps its order too.
  for (const key in next) {
    if (previousKeys[index++] !== key) return null;
    const value = next[key], before = previous[key];
    if (value === before) continue;
    const change = changes.get(key);
    if (!change) continue;
    switch (change.kind) {
      case "field":
        if (!change.accepts(value) || !change.accepts(before)) return null;
        break;
      case "layout":
        if (value === undefined || before === undefined) return null;
        break;
      case "handler":
      case "onLayout":
        if (typeof value !== "function" || typeof before !== "function") return null;
        break;
      case "content": {
        // Read only without `text`; `style` might hold that.
        if (next.style) return null;
        if (next.text !== undefined) continue;
        const shown = isTextContent(value);
        if (shown !== isTextContent(before)) return null;
        if (!shown) continue;
        break;
      }
      case "other":
        if (!sameInput(before, value, 0)) return null;
        continue;
    }
    patched.push(key);
  }
  if (index !== previousKeys.length) return null;

  // What may throw comes first, so that NODE changes only once nothing can.
  let declared = node.declared, style = node.style;
  patchedWire.length = 0;
  for (const key of patched) {
    const change = changes.get(key)!;
    const value = next[key];
    if (change.kind === "field" || change.kind === "content") {
      if (declared === node.declared) declared = { ...declared };
      if (change.kind === "field") change.write(value as never, declared);
      else declared.text = textContent(value as TextContent);
      patchedWire.push(change.kind === "field" ? change.wire : "text");
    }
    if (change.kind === "layout" || (change.kind === "field" && change.layout)) {
      if (style === node.style) style = { ...style };
      style[key] = value;
    }
  }
  for (const key of patched) {
    const change = changes.get(key)!;
    if (change.kind === "handler") node.handlers.set(change.event, next[key] as EventHandler);
    else if (change.kind === "onLayout") node.onLayout = next[key] as (layout: LayoutBox) => void;
  }
  node.declared = declared;
  node.style = style;
  for (const key of patchedWire) if (holdsNaN(declared[key])) node.holdsNaN = true;
  return patchedWire;
}
