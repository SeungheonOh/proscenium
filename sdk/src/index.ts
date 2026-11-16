export { Background, Box, Camera, GestureBinding, Group, Image, Mirror, PointerBinding, Rect,
  Reserve, Screen, Shortcut, Spacer, Text, WheelBinding, Window } from "./components.js";
export { useCamera, useClipboard, useCompositorInstance, useFocusedWindow, useInput, useKeyboardGrab,
  useModifiers, useOutputs,
  usePersistentReducer, usePersistentState, useShares, useWindow, useWindowIds, useWindows } from "./hooks.js";
export { ease, instant, spring, tween } from "./motion.js";
export { matrix3d, perspective, rotate, rotate3d, rotateX, rotateY, rotateZ, scale, skew, translate,
  translateZ } from "./transform.js";
export type { Transform, TransformFunction } from "./transform.js";
export type { AnimatableValues, Animation, AnimationTiming, Keyframes } from "./animation.js";
export { columns, dwindle, grid, inset, masterStack } from "./layouts.js";
export type { Area, ColumnOptions, GapOptions, MasterOptions, Placement } from "./layouts.js";
export { backdropBlur, backdropBlurWith, boxInsetShadow, boxPaint, boxPaintWith, boxShadow, boxShadowWith,
  dimFilter, effectShader, filterShader,
  gradientPaint, paintShader, planePaint } from "./shader.js";
export type { Bound, BoundForm, BoxFeatures, EffectDefinition, FilterDefinition, PaintDefinition,
  Region, Shader, ShaderStage, Shading, Sides, UniformComponent, UniformValue } from "./shader.js";
export { Web } from "./web.js";
export type { WebProps } from "./web.js";
export type { CubicBezier, Easing, EasingFunction, Motion, SpringOptions,
  TweenOptions } from "./motion.js";
export type { Color } from "./color.js";
export type { AnimatedValues, BackgroundProps, BindingAction, Border, BoxProps, CameraProps, Corners,
  Cursor, DragProps, Edges, ElementProps, Gradient, GradientStop, Radius, GestureBindingProps, Grid, GroupProps, ImageProps, MirrorProps,
  ModifierName, Paint, TextDecoration,
  PaintValues, PointerBindingProps, RectProps, ReserveProps, ScreenProps, Shadow, ShaderProps,
  ControlHandlers, ControlProps, ScrollProps, StateName, States, StateValues,
  EditableTextProps, ShapeProps, ShortcutProps, Style, TextContent, TextProps, Transition,
  WheelBindingProps, WindowProps } from "./props.js";
export type { Dimension, FlexContainerProps, FlexItemProps, LayoutBox } from "./layout.js";
export type { Modifier, StageBubblingEvent, StageDragEvent, StageElement,
  StageErrorEvent, StageEvent, StageGestureEvent, StageInputEvent, StageKeyEvent, StageLoadEvent,
  StageMeasureEvent,
  StagePointerEvent, StageRequestEvent, StageResizeEvent,
  StageWheelEvent, StageClickEvent, StageContextMenuEvent, StageFocusEvent, StageKeyboardEvent,
  StageScrollEvent, StageSelection, StageSelectEvent, StageSubmitEvent, StageTextInputEvent } from "./events.js";
export type { CameraInfo, OutputInfo, Rectangle, ShareInfo, WindowInfo } from "./store.js";
import type { CameraInfo } from "./store.js";
export type { CameraMove, Screenshot, ShareSource } from "./session.js";
export type { EditAction, InjectedPointer } from "./protocol.js";
export { encodePng } from "./png.js";
import type { Motion } from "./motion.js";
import { currentSession, type CameraMove, type Screenshot, type ShareSource } from "./session.js";
import type { EditAction, InjectedPointer } from "./protocol.js";
import type { StageElement } from "./events.js";
import type { ReactNode } from "react";
import type { TextProps } from "./props.js";
import type { LayoutBox } from "./layout.js";
import { reconciler } from "./host.js";

/** Give keyboard focus to WINDOW on the first seat, or clear it with null. */
export function focus(window: number | null): void {
  currentSession().focus(window);
}

/**
 * Give keyboard focus to NODE, a node with `tabIndex` (from a ref), or take it from
 * whatever node has it with null. `visible` shows its `focusVisible` state; by default it
 * shows when the latest input was a key.
 */
export function focusNode(node: StageElement | null, options?: { visible?: boolean }): void {
  currentSession().focusNode(node, options);
}

/**
 * Act on NODE, an editable Text, as its keys would: select START to END (UTF-16 code
 * units), select all, insert TEXT at the caret, delete the selection, undo, redo, cut,
 * copy or paste. After what is committed, so a node just rendered is there.
 */
export function editText(node: StageElement, command: { action: EditAction; start?: number; end?: number;
                                                        direction?: "forward" | "backward"; text?: string }): void {
  currentSession().editText(node, command);
}

/**
 * The sizes TEXTS take in STYLE (a Text's props: font, size, weight, letterSpacing, …),
 * each wrapped to `style.width` when it is a number, as the compositor's Pango lays them
 * out: e.g. the widths of a line's prefixes, to find the character under the pointer.
 * One round trip for the lot.
 */
export function measureText(style: TextProps, texts: readonly string[]): Promise<{ width: number; height: number }[]> {
  return currentSession().measureText(style, texts);
}

/**
 * CHILDREN rendered as children of NODE (from a ref), wherever this element sits in the
 * tree, as React DOM's `createPortal`: context, events and state stay with this element.
 * The UI kit's overlays mount menus and popovers above everything this way.
 */
export function createPortal(children: ReactNode, node: StageElement, key?: string | null): ReactNode {
  return reconciler.createPortal(children, node, null, key ?? null) as unknown as ReactNode;
}

/**
 * Hear NODE's new boxes (from a ref, laid out by a <Box>) as its own `onLayout` would,
 * from anywhere: e.g. a popover re-placing itself as the control it hangs from moves.
 * Returns a function that stops.
 */
export function watchLayout(node: StageElement, listener: (box: LayoutBox) => void): () => void {
  return (node as unknown as { container: { watchLayout: typeof watchLayout } }).container.watchLayout(node, listener);
}

/** Scroll NODE, a node with `scroll` (from a ref), to OFFSET, with TRANSITION or at once. */
export function scrollTo(node: StageElement, offset: { x?: number; y?: number }, transition?: Motion): void {
  currentSession().scrollTo(node, offset, transition);
}

/** Ask WINDOW's client to close. */
export function close(window: number): void {
  currentSession().close(window);
}

/** Answer screen-sharing request ID with what to share. */
export function acceptShare(id: number, source: ShareSource): void {
  currentSession().acceptShare(id, source);
}

/** Decline screen-sharing request ID, or stop that share. */
export function cancelShare(id: number): void {
  currentSession().cancelShare(id);
}

/** Capture a window, or an output or a region of it (the first output by default). */
export function screenshot(source?: ShareSource): Promise<Screenshot> {
  return currentSession().screenshot(source);
}

/** Start a Wayland client of this compositor; a string runs through /bin/sh. */
export function launch(command: string | readonly string[]): void {
  currentSession().launch(command);
}

/**
 * Where OUTPUT's camera (or the first output's) is headed now, without
 * subscribing: for event handlers that need it once, e.g. to fly from it.
 */
export function getCamera(output?: string): CameraInfo | undefined {
  return currentSession().store.camera(output);
}

/** Move a camera (every output's, unless OUTPUT is given), always, even to where it already was. */
export function moveCamera(move: CameraMove, options?: { output?: string; transition?: Motion }): void {
  currentSession().moveCamera(move, options);
}

/** Put DATA on the clipboard as MIME, e.g. a screenshot's PNG as "image/png". */
export function copyData(mime: string, data: Uint8Array): Promise<void> {
  return currentSession().copyData(mime, data);
}

/** Move the pointer to (X, Y) on OUTPUT, in its logical pixels, as if it had moved there. */
export function warpPointer(output: string, x: number, y: number): void {
  currentSession().warpPointer(output, x, y);
}

/**
 * Pointer EVENTS straight to WINDOW, wherever it shows or not and wherever the
 * pointer is, as an agent at the computer sends them: the window's surface
 * under each point gets them, a press focuses the window, and the pointer goes
 * back to what it is over after. The window keeps drawing a while, shown or
 * not; no events just does that, e.g. after typing into it.
 */
export function injectPointer(window: number, events: readonly InjectedPointer[]): void {
  currentSession().injectPointer(window, events);
}
