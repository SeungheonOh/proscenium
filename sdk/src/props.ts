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
import type { StageDragEvent, StageElement, StageErrorEvent, StageEvent,
  StageGestureEvent, StageLoadEvent, StageMeasureEvent, StagePointerEvent,
  StageRequestEvent, StageResizeEvent, StageWheelEvent } from "./events.js";
import type { Dimension, FlexContainerProps, FlexItemProps, LayoutBox } from "./layout.js";
import { type Animation, wireAnimations } from "./animation.js";
import { isMotion, type Motion, wireMotion } from "./motion.js";
import { backdropBlur, boxPaint, boxShadow, dimFilter, planePaint, type Shading, type UniformValue,
  wireShading, wireUniforms } from "./shader.js";
import type { WireProps, WireValue } from "./protocol.js";
import { radians, type Transform, wireTransform } from "./transform.js";

/** A solid color, or a two-stop linear gradient; ANGLE is in degrees, 0 = left to right. */
export type Paint = Color | { from: Color; to: Color; angle?: number };

export interface Shadow {
  color?: Color;
  blur?: number;
  x?: number;
  y?: number;
  spread?: number;
}

export interface Border {
  width?: number;
  color?: Paint;
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
  radius?: number;
  border?: Border;
  shadow?: Shadow;
  /** Backdrop blur radius: frosted glass over whatever is drawn behind. */
  blur?: number;
}

/** Paint fields that can animate, as accepted by `initial` and `exit`. */
export type PaintValues = Color | { from?: Color; to?: Color; angle?: number };

/** Props that can be animated, as accepted by `initial` and `exit`. */
export interface AnimatedValues {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** Animates function by function between lists of the same functions; see `TransformProps`. */
  transform?: Transform;
  opacity?: number;
  radius?: number;
  fill?: PaintValues;
  /** Text color. */
  color?: Color;
  border?: { width?: number; color?: PaintValues };
  shadow?: Shadow;
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
  PassThroughProps, CursorProps, ShaderProps, ElementProps<GroupProps> {
  /**
   * Size of the group's box, for its transform origin, `clip` and shaders. A
   * sized group with pointer handlers catches the pointer anywhere inside it.
   */
  width?: Dimension;
  height?: Dimension;
  /** Corner radius of the box, as its shaders see it. */
  radius?: number;
  /** Hide children outside the box (axis-aligned on screen). */
  clip?: boolean;
  children?: ReactNode;
}

/** A group drawing a rounded box: its decoration props are those of `boxPaint`. */
export interface RectProps extends ShapeProps, MotionProps, PointerHandlers, DragProps,
  PassThroughProps, CursorProps, ShaderProps, ElementProps<RectProps> {
  fill?: Paint;
  /** Hide children outside the box (axis-aligned on screen). */
  clip?: boolean;
  children?: ReactNode;
}

/** A Rect that lays out its children with flexbox. */
export interface BoxProps extends Omit<RectProps, "style">, FlexContainerProps {
  style?: Style<BoxProps>;
}

/** Text content: a string, or children that are strings and numbers. */
export type TextContent = string | number | readonly (string | number)[];

/**
 * A text label, laid out by Pango. The node's box is the text's measured size,
 * or `width` wide when given; it is reported through onMeasure. A <Text> inside
 * another styles its part of the text, as in React Native:
 * `<Text>Saved <Text weight="bold" color="#8f8">3</Text> files</Text>`; there
 * only `color`, `font`, `size`, `weight` and `italic` apply.
 */
export interface TextProps extends TransformProps, MotionProps, PointerHandlers, DragProps,
  PassThroughProps, CursorProps, ShaderProps, ElementProps<TextProps> {
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
  align?: "start" | "center" | "end";
  /** Line height as a multiple of the font's own. */
  lineHeight?: number;
  /** With `width`: end with an ellipsis after this many lines. */
  maxLines?: number;
  onMeasure?: (event: StageMeasureEvent) => void;
  /** Strings, numbers and nested <Text>s; with `markup`, strings are markup. */
  children?: ReactNode;
}

/**
 * An image file decoded off the compositor thread: PNG, JPEG, WebP, GIF, SVG
 * and whatever else gdk-pixbuf reads. Without `width` and `height` it takes its
 * natural size; with one of them it keeps its aspect ratio.
 */
export interface ImageProps extends ShapeProps, MotionProps, PointerHandlers, DragProps,
  PassThroughProps, CursorProps, ShaderProps, ElementProps<ImageProps> {
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

const box: Record<string, Writer> = {
  ...transform, width: size("width"), height: size("height"), radius: number("radius"),
};

const modifiers: Writer = (value: string | string[], out) => { out.modifiers = modifierList(value); };

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
  if (props.color !== undefined) {
    const [red, green, blue, alpha] = toWireColor(props.color as Color);
    attributes += ` foreground="${hexColor(red, green, blue)}"`;
    if (alpha < 1) attributes += ` fgalpha="${Math.max(1, Math.round(alpha * 100))}%"`;
  }
  return [attributes, font];
}

const cursor = text("cursor");

const group = {
  ...box, clip: flag("clip"), draggable: flag("draggable"), interactive: flag("interactive"), cursor,
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
    interactive: flag("interactive"), cursor,
  },
  image: {
    ...box, fit: text("fit"), draggable: flag("draggable"), interactive: flag("interactive"),
    cursor,
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

/** The box paint's uniforms of PROPS; with COMPLETE, every one. */
function boxUniforms(type: HostType, props: Props, complete: boolean): Uniforms {
  const out: Uniforms = {};
  const style = borders[type];
  paintUniforms(style === "inside" ? props.fill as PaintValues | undefined : undefined,
                fillNames, complete, out);
  const border = props.border as { width?: number; color?: PaintValues } | undefined;
  if (border?.width !== undefined || complete) {
    out.border = border?.width ?? 0;
    out.outset = style === "frame" ? out.border : 0;
  }
  paintUniforms(border?.color, borderColorNames, complete, out);
  return out;
}

/** The `shadow` paint's uniforms; with COMPLETE, every one. */
function shadowUniforms(shadow: Shadow, complete: boolean): Uniforms {
  const out: Uniforms = {};
  if (shadow.color !== undefined || complete) out.color = shadow.color === undefined ? clear : toWireColor(shadow.color);
  for (const key of ["blur", "spread", "x", "y"] as const) {
    if (shadow[key] !== undefined || complete) out[key] = shadow[key] ?? 0;
  }
  return out;
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

const planeColorNames = ["color"] as const;
const planeGridNames = ["gridColor", "spacing", "weight"] as const;
const fillAngleNames = ["fillAngle"] as const;
const borderNames = ["border", "borderColor", "borderColorEnd", "borderAngle", "outset"] as const;
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
  if (props.shadow && style)
    under.push({ id: "shadow", shader: boxShadow, uniforms: shadowUniforms(props.shadow as Shadow, true),
                 transition: motions.shadow ?? fallback });
  const blur = typeof props.blur === "number" && style
    ? { id: "blur", shader: backdropBlur, uniforms: { blur: props.blur }, transition: motions.blur ?? fallback }
    : null;
  const decorated = props.border !== undefined || (style === "inside" && props.fill !== undefined);
  const box: Shading | null = decorated ? {
    id: "box", shader: boxPaint, uniforms: boxUniforms(type, props, true),
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
  } else {
    if (blur) under.push(blur);
    under.push(...ownUnder);
    if (box && style === "over") over.push(box);
    else if (box) under.push(box);
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
        + "box, shadow, blur, dim and plane)");
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
function wireShaderTargets(type: HostType, values: Props): WireProps | undefined {
  if (!shaderTypes.has(type)) return undefined;
  const out: Record<string, Uniforms> = {};
  const add = (id: string, uniforms: Uniforms) => {
    if (Object.keys(uniforms).length) out[id] = { ...out[id], ...uniforms };
  };
  if (values.shadow && borders[type]) add("shadow", shadowUniforms(values.shadow as Shadow, false));
  if (typeof values.blur === "number" && borders[type]) add("blur", { blur: values.blur });
  if (typeof values.dim === "number" && (type === "window" || type === "mirror")) add("dim", { amount: values.dim });
  if (type === "background") add("plane", planeUniforms(values, false));
  else if (borders[type]) add("box", boxUniforms(type, values, false));
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
  const shaders = wireShaders(type, props);
  if (shaders) wire.shaders = shaders;
  for (const key of ["initial", "exit"] as const) {
    if (props[key]) {
      const values: WireProps = {};
      // A copy: only its own props, as writeFields reads every enumerable one.
      writeFields(type, { ...props[key] as Props }, values, animatedNames);
      const targets = wireShaderTargets(type, props[key] as Props);
      if (targets) values.shaders = targets;
      wire[key] = values;
    }
  }
  if (props.animate) wire.animate = wireAnimations(props.animate as Animation | Animation[], type);
  if (typeof props.layoutId === "string") wire.layoutId = props.layoutId;
  const onLayout = typeof props.onLayout === "function"
    ? props.onLayout as (layout: LayoutBox) => void
    : null;
  return { wire, handlers, style, onLayout };
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
                     "initial", "exit", "animate", "layoutId"];

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
