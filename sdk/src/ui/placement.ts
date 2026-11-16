// Where floating things go: a node's box on its output, and a surface placed beside an
// anchor so it never leaves the output, flipping to the other side and shifting along
// the edge as a browser's popover positioning does.
//
// Pure functions of plain boxes, except `anchorRect`, which reads the director's own
// copy of the tree: a node's place is the sum of its and its ancestors' x and y up to
// the Screen holding it, or through the camera for a node in the world. Transforms and
// scroll offsets the compositor owns are not in that sum, so a rectangle read from a
// pointer event on the node (`rememberAnchor`) corrects it from then on.

import type { StageElement, StagePointerEvent } from "../events.js";
import type { LayoutBox } from "../layout.js";
import type { CameraInfo, OutputInfo } from "../store.js";

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A box on an output, in its logical pixels. */
export interface OutputRect extends Bounds {
  output: string;
}

export type Side = "top" | "bottom" | "left" | "right";
export type Align = "start" | "center" | "end";

export interface PlaceOptions {
  /** The side of the anchor to go on; flips to the other when only that has room. Defaults to bottom. */
  side?: Side;
  /** Which edges line up along that side; defaults to start (left, or top). */
  align?: Align;
  /** Pixels between the anchor and the surface. */
  gap?: number;
  /** Pixels kept clear at the edges of the bounds. */
  margin?: number;
  /**
   * When the aligned edge leaves too little room, line up the other edge instead of
   * shifting: a context menu opening left of the pointer near the right edge.
   */
  flipAlign?: boolean;
}

export interface Placement {
  x: number;
  y: number;
  /** The side it went on, after any flip. */
  side: Side;
  /** Where the anchor is, as a fraction of the surface: the origin it grows from. */
  originX: number;
  originY: number;
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high));

const opposite: Record<Side, Side> = { top: "bottom", bottom: "top", left: "right", right: "left" };

/**
 * Where a surface of SIZE goes beside ANCHOR within BOUNDS: on `side` if it fits there,
 * else on the opposite side if that fits, else on whichever has more room, then shifted
 * along the side to stay within the bounds.
 */
export function place(anchor: Bounds, size: { width: number; height: number }, bounds: Bounds,
                      options: PlaceOptions = {}): Placement {
  const { side: wanted = "bottom", align = "start", gap = 4, margin = 8, flipAlign = false } = options;
  const vertical = wanted === "top" || wanted === "bottom";
  const low = { x: bounds.x + margin, y: bounds.y + margin };
  const high = { x: bounds.x + bounds.width - margin, y: bounds.y + bounds.height - margin };

  // Along the main axis: the room each side leaves, and where the surface would start.
  const main = (side: Side) => {
    switch (side) {
      case "bottom": return { at: anchor.y + anchor.height + gap, room: high.y - (anchor.y + anchor.height + gap) - size.height };
      case "top": return { at: anchor.y - gap - size.height, room: anchor.y - gap - size.height - low.y };
      case "right": return { at: anchor.x + anchor.width + gap, room: high.x - (anchor.x + anchor.width + gap) - size.width };
      case "left": return { at: anchor.x - gap - size.width, room: anchor.x - gap - size.width - low.x };
    }
  };
  let side = wanted;
  const first = main(wanted), second = main(opposite[wanted]);
  if (first.room < 0 && (second.room >= 0 || second.room > first.room)) side = opposite[wanted];
  const along = main(side).at;

  // Across: aligned to the anchor's edge, or flipped to the other edge, then shifted inside.
  const start = vertical ? anchor.x : anchor.y;
  const extent = vertical ? anchor.width : anchor.height;
  const length = vertical ? size.width : size.height;
  const [lo, hi] = vertical ? [low.x, high.x] : [low.y, high.y];
  let across = align === "start" ? start : align === "end" ? start + extent - length : start + (extent - length) / 2;
  if (flipAlign) {
    if (align !== "end" && across + length > hi) across = start + extent - length;
    else if (align === "end" && across < lo) across = start;
  }
  across = clamp(across, lo, hi - length);
  const mainClamped = vertical ? clamp(along, low.y, high.y - size.height) : clamp(along, low.x, high.x - size.width);

  const x = Math.round(vertical ? across : mainClamped);
  const y = Math.round(vertical ? mainClamped : across);
  const centerX = anchor.x + anchor.width / 2, centerY = anchor.y + anchor.height / 2;
  const originX = side === "right" ? 0 : side === "left" ? 1 : clamp((centerX - x) / (size.width || 1), 0, 1);
  const originY = side === "bottom" ? 0 : side === "top" ? 1 : clamp((centerY - y) / (size.height || 1), 0, 1);
  return { x, y, side, originX, originY };
}

/** The tree as the director holds it: what a ref or an event target is underneath. */
interface TreeNode {
  type: string;
  parent: TreeNode | null;
  wire: Record<string, unknown>;
  layout: LayoutBox | null;
}

const asTree = (node: StageElement) => node as unknown as TreeNode;

const corrections = new WeakMap<object, { dx: number; dy: number; output: string }>();

/** NODE's size, as laid out or as declared. */
function sizeOf(node: TreeNode): { width: number; height: number } {
  const width = node.layout?.width ?? node.wire.width;
  const height = node.layout?.height ?? node.wire.height;
  return { width: typeof width === "number" ? width : 0, height: typeof height === "number" ? height : 0 };
}

/** NODE's top left in the space of ANCESTOR (exclusive), or null if it is not under it. */
function offsetWithin(node: TreeNode, ancestor: TreeNode): { x: number; y: number } | null {
  let x = 0, y = 0;
  for (let at: TreeNode | null = node; at && at !== ancestor; at = at.parent) {
    x += typeof at.wire.x === "number" ? at.wire.x : 0;
    y += typeof at.wire.y === "number" ? at.wire.y : 0;
    if (!at.parent) return null;
  }
  return { x, y };
}

/** A world point on OUTPUT through its camera (rotation aside), or null without one. */
function throughCamera(x: number, y: number, output: OutputInfo, camera: CameraInfo | undefined) {
  if (!camera) return { x, y, zoom: 1 };
  return { x: (x - camera.x) * camera.zoom + output.width / 2, y: (y - camera.y) * camera.zoom + output.height / 2,
           zoom: camera.zoom };
}

/**
 * NODE's box on an output, from the director's tree: the sum of x and y up to its
 * Screen, or through the camera of the output showing it for a node in the world.
 * A correction remembered from a pointer event on it applies.
 */
export function anchorRect(node: StageElement, outputs: readonly OutputInfo[],
                           camera: (output: string) => CameraInfo | undefined = () => undefined): OutputRect | null {
  const tree = asTree(node);
  if (!outputs.length) return null;
  const { width, height } = sizeOf(tree);
  let x = 0, y = 0, screen: TreeNode | null = null;
  for (let at: TreeNode | null = tree; at; at = at.parent) {
    x += typeof at.wire.x === "number" ? at.wire.x : 0;
    y += typeof at.wire.y === "number" ? at.wire.y : 0;
    if (at.type === "screen") {
      screen = at;
      break;
    }
  }
  let rect: OutputRect;
  if (screen) {
    const name = typeof screen.wire.output === "string" ? screen.wire.output : outputs[0]!.name;
    rect = { output: name, x, y, width, height };
  } else {
    // In the world: on the output whose camera shows it, else the first.
    const shown = outputs.map((output) => ({ output, at: throughCamera(x, y, output, camera(output.name)) }));
    const pick = shown.find(({ output, at }) => at.x >= 0 && at.y >= 0 && at.x < output.width && at.y < output.height)
      ?? shown[0]!;
    rect = { output: pick.output.name, x: pick.at.x, y: pick.at.y, width: width * pick.at.zoom, height: height * pick.at.zoom };
  }
  const correction = corrections.get(node);
  if (correction) rect = { ...rect, output: correction.output, x: rect.x + correction.dx, y: rect.y + correction.dy };
  return rect;
}

/**
 * NODE's box on its output from a pointer EVENT that came to it or to a node under it,
 * which knows where the pointer really was, whatever scrolled or moved: remembered for
 * `anchorRect` to correct by from then on. Null when the event has no position.
 */
export function rememberAnchor(node: StageElement, event: Partial<StagePointerEvent>,
                               outputs: readonly OutputInfo[]): OutputRect | null {
  if (event.screenX === undefined || event.screenY === undefined || event.localX === undefined
      || event.localY === undefined || !event.target || !event.output) return null;
  const offset = offsetWithin(asTree(event.target), asTree(node));
  if (!offset) return null;
  const x = event.screenX - event.localX - offset.x, y = event.screenY - event.localY - offset.y;
  corrections.delete(node);
  const tree = anchorRect(node, outputs);
  if (tree) corrections.set(node, { dx: x - tree.x, dy: y - tree.y, output: event.output });
  const { width, height } = sizeOf(asTree(node));
  return { output: event.output, x, y, width, height };
}

/** Whether NODE takes keyboard focus, so focus can be given back to it. */
export function takesFocus(node: StageElement | null | undefined): node is StageElement {
  return !!node && typeof asTree(node).wire.tabIndex === "number";
}

/** The bounds a floating surface keeps within on OUTPUT: all of it. */
export function outputBounds(outputs: readonly OutputInfo[], name: string): Bounds | null {
  const output = outputs.find((candidate) => candidate.name === name);
  return output ? { x: 0, y: 0, width: output.width, height: output.height } : null;
}
