import type { LayoutBox } from "./layout.js";
import type { WireEvent, WireValue } from "./protocol.js";

export type Modifier = "shift" | "control" | "alt" | "logo";

/** A rendered node, as refs and event targets see it. */
export interface StageElement {
  readonly id: number;
  readonly type: string;
  /** Its box in its parent's space once a <Box> laid it out, else null. */
  readonly layout: LayoutBox | null;
}

/** Pointer events bubble from the node under the pointer through its ancestors, as in the DOM. */
export interface StageBubblingEvent {
  /** The node the event happened on. */
  target: StageElement;
  /** The node whose handler is running. */
  currentTarget: StageElement;
  /** Keep the event from reaching the ancestors of the current node. */
  stopPropagation(): void;
}

/** Pointer position in every space a handler may need. */
export interface StagePointerEvent extends StageBubblingEvent {
  /** Output under the pointer and the position in its logical pixels. */
  output: string;
  screenX: number;
  screenY: number;
  /** Position in world space, through that output's camera. */
  worldX: number;
  worldY: number;
  /** Position in the target node's parent space: add to its x/y when dragging. */
  x: number;
  y: number;
  /** Position in the target node's own space. */
  localX: number;
  localY: number;
  modifiers: Modifier[];
  /** Linux input button code (272 left, 273 right, 274 middle). */
  button?: number;
  /** For bindings: the window under the pointer, if any. */
  window?: number | null;
  /** For pointerenter and pointerleave: the node the pointer came from or went to. */
  relatedTarget?: StageElement | null;
}

export interface StageWheelEvent extends StagePointerEvent {
  orientation: "vertical" | "horizontal";
  delta: number;
  discrete: number;
  source: "wheel" | "finger" | "continuous" | "wheel-tilt";
}

export interface StageGestureEvent extends Partial<StagePointerEvent> {
  fingers: number;
  /** Movement since the previous update, in logical pixels. */
  dx: number;
  dy: number;
  /** Pinch scale relative to the gesture start, and rotation in degrees. */
  scale: number;
  rotation: number;
  cancelled: boolean;
}

export interface StageRequestEvent extends Partial<StagePointerEvent> {
  /** Requested state for fullscreen/maximize/minimize requests. */
  value?: boolean;
  /** xdg_toplevel resize edges for resize requests. */
  edges?: number;
}

/** Position a native drag left a node at, in its parent space. */
export interface StageDragEvent {
  x: number;
  y: number;
}

/** Box a native resize left a window with, in its parent space. */
export interface StageResizeEvent extends StageDragEvent {
  width: number;
  height: number;
}

/** Size a text node measured at, or an image's natural size once decoded. */
export interface StageMeasureEvent {
  width: number;
  height: number;
}

export type StageLoadEvent = StageMeasureEvent;

export interface StageErrorEvent {
  message: string;
}

export type StageEvent = StagePointerEvent | StageWheelEvent | StageGestureEvent | StageRequestEvent
  | StageDragEvent | StageResizeEvent | StageMeasureEvent | StageErrorEvent;

/** Convert a wire event's kebab-case fields into a handler argument. */
export function toStageEvent(message: WireEvent): StageEvent {
  const event: Record<string, WireValue> = {};
  for (const [key, value] of Object.entries(message)) {
    if (key === "type" || key === "node" || key === "name") continue;
    event[key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
  }
  return event as unknown as StageEvent;
}
