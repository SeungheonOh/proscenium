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

/** Where the pointer was, in every space, for events that may come from keys instead. */
type PointerPosition = Omit<StagePointerEvent, keyof StageBubblingEvent | "button" | "modifiers"
  | "window" | "relatedTarget">;

/**
 * A press and release of one button over the same node, as the DOM's `click` (the
 * primary button), `auxclick` (the others) and `dblclick` (the second primary click in
 * quick succession). It goes to the nearest node holding where the press began and where
 * it ended, and bubbles; letting go elsewhere sends none. Enter, or Space as it is let
 * go, clicks a focused node too, with `count` 0 and no pointer position.
 */
export interface StageClickEvent extends StageBubblingEvent, Partial<PointerPosition> {
  /** Linux input button code (272 left, 273 right, 274 middle). */
  button: number;
  /** Presses in quick succession, as the DOM's `detail`: 1, 2 for a double click, 3, …; 0 from keys. */
  count: number;
  modifiers: Modifier[];
}

/**
 * The secondary button went down over a node, or Menu or Shift+F10 was pressed on a
 * focused one: open a context menu at the pointer (`screenX`/`screenY`, or `x`/`y`).
 * Bubbles. From the keyboard, `keyboard` is set, and `x`/`y` and `localX`/`localY` are
 * the node's bottom left.
 */
export interface StageContextMenuEvent extends StageBubblingEvent, Partial<PointerPosition> {
  keyboard?: boolean;
  modifiers: Modifier[];
}

/** A node took or lost keyboard focus (`focus`, `blur`); these do not bubble. */
export interface StageFocusEvent {
  /** On focus: it came by keyboard, so `focusVisible` shows. */
  visible?: boolean;
}

/**
 * A key pressed (`keydown`, repeating while held) or released (`keyup`) while a node has
 * keyboard focus; it goes to that node and bubbles. Shortcuts take their keys first.
 */
export interface StageKeyboardEvent extends StageBubblingEvent {
  /** Its keysym's name with the modifiers applied, e.g. "Return", "a", "A", "Tab". */
  key: string;
  /** What it types, e.g. "a"; empty for keys that type nothing. */
  text: string;
  /** Evdev key code, the same whatever the layout. */
  code: number;
  repeat: boolean;
  modifiers: Modifier[];
}

/** Where a scroll container's offset is headed; coalesced, and does not bubble. */
export interface StageScrollEvent {
  scrollX: number;
  scrollY: number;
}

/** Input `useInput` heard, on its way to its target as ever. */
export interface StageInputEvent {
  kind: "key" | "button" | "wheel" | "gesture";
  /** For a key, its keysym name, e.g. "Return". */
  key?: string;
  /** For a button, its Linux input code (272 left, 273 right, 274 middle). */
  button?: number;
}

/** A key `useKeyboardGrab` took: pressed, repeated while held, or released. */
export interface StageKeyEvent {
  /** Its keysym's name with the modifiers applied, e.g. "Return", "a", "A", "question". */
  key: string;
  /** What it types, e.g. "a"; empty for keys that type nothing. */
  text: string;
  /** Evdev key code, the same whatever the layout. */
  code: number;
  pressed: boolean;
  /** A press the compositor repeats while the key is held. */
  repeat: boolean;
  modifiers: Modifier[];
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

/** Where an editable text's selection lies, in UTF-16 code units, as a string indexes. */
export interface StageSelection {
  selectionStart: number;
  selectionEnd: number;
  /** "backward" when the caret is at its start, as the DOM's `selectionDirection`. */
  selectionDirection: "forward" | "backward";
}

/** An editable text's text changed (`input`), with the revision to declare back. */
export interface StageTextInputEvent extends StageSelection {
  text: string;
  revision: number;
  /** It answers a value the director declared: that value, and what was typed since after it. */
  replaced?: boolean;
}

/** Return in an editable text: the text as it stood then. */
export interface StageSubmitEvent {
  text: string;
  revision: number;
}

/** An editable text's caret or selection moved. */
export type StageSelectEvent = StageSelection;

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
  | StageDragEvent | StageResizeEvent | StageMeasureEvent | StageErrorEvent | StageClickEvent
  | StageContextMenuEvent | StageFocusEvent | StageKeyboardEvent | StageScrollEvent | StageTextInputEvent
  | StageSubmitEvent;

/** Convert a wire event's kebab-case fields into a handler argument. */
export function toStageEvent(message: WireEvent): StageEvent {
  const event: Record<string, WireValue> = {};
  for (const [key, value] of Object.entries(message)) {
    if (key === "type" || key === "node" || key === "name") continue;
    event[key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
  }
  return event as unknown as StageEvent;
}
