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
export { backdropBlur, boxPaint, boxShadow, dimFilter, effectShader, filterShader, paintShader,
  planePaint } from "./shader.js";
export type { Bound, BoundForm, EffectDefinition, FilterDefinition, PaintDefinition,
  Region, Shader, ShaderStage, Shading, Sides, UniformComponent, UniformValue } from "./shader.js";
export { Web } from "./web.js";
export type { WebProps } from "./web.js";
export type { CubicBezier, Easing, EasingFunction, Motion, SpringOptions,
  TweenOptions } from "./motion.js";
export type { Color } from "./color.js";
export type { AnimatedValues, BackgroundProps, BindingAction, Border, BoxProps, CameraProps, Cursor,
  DragProps, ElementProps, GestureBindingProps, Grid, GroupProps, ImageProps, MirrorProps,
  ModifierName, Paint,
  PaintValues, PointerBindingProps, RectProps, ReserveProps, ScreenProps, Shadow, ShaderProps,
  ShapeProps, ShortcutProps, Style, TextContent, TextProps, Transition,
  WheelBindingProps, WindowProps } from "./props.js";
export type { Dimension, FlexContainerProps, FlexItemProps, LayoutBox } from "./layout.js";
export type { Modifier, StageBubblingEvent, StageDragEvent, StageElement,
  StageErrorEvent, StageEvent, StageGestureEvent, StageInputEvent, StageKeyEvent, StageLoadEvent,
  StageMeasureEvent,
  StagePointerEvent, StageRequestEvent, StageResizeEvent,
  StageWheelEvent } from "./events.js";
export type { CameraInfo, OutputInfo, Rectangle, ShareInfo, WindowInfo } from "./store.js";
import type { CameraInfo } from "./store.js";
export type { CameraMove, Screenshot, ShareSource } from "./session.js";
export { encodePng } from "./png.js";
import type { Motion } from "./motion.js";
import { currentSession, type CameraMove, type Screenshot, type ShareSource } from "./session.js";

/** Give keyboard focus to WINDOW on the first seat, or clear it with null. */
export function focus(window: number | null): void {
  currentSession().focus(window);
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
