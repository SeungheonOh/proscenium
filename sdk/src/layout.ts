// Flexbox layout with Yoga, the engine behind React Native and Ink.
//
// A <Box> lays out its children like a `display: flex` div. Layout runs in the
// director at each commit and reaches the compositor as plain x/y/width/height,
// so a node's `transition` animates layout changes like any other. Text sizes
// come from the compositor's own Pango measurements: a commit whose text is not
// measured yet waits for them (one round trip), so text never jumps into place.

import Yoga, {
  Align,
  Direction,
  Display,
  Edge,
  FlexDirection,
  Gutter,
  Justify,
  MeasureMode,
  PositionType,
  Wrap,
  type Node,
} from "yoga-layout";
import type { WireProps, WireValue } from "./protocol.js";

/** A node's box in its parent's space, in logical pixels. */
export interface LayoutBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Logical pixels, or a percentage of the parent Box. */
export type Dimension = number | `${number}%`;
type Length = Dimension | "auto";

/** How a node sizes and places itself inside a <Box>. */
export interface FlexItemProps {
  flexGrow?: number;
  flexShrink?: number;
  flexBasis?: Length;
  alignSelf?: "auto" | "flex-start" | "center" | "flex-end" | "stretch" | "baseline";
  /** "absolute" takes the node out of the flow; `x`/`y` then place it in its parent. */
  position?: "relative" | "absolute";
  minWidth?: Dimension;
  minHeight?: Dimension;
  maxWidth?: Dimension;
  maxHeight?: Dimension;
  aspectRatio?: number;
  margin?: number;
  marginX?: number;
  marginY?: number;
  marginTop?: number;
  marginRight?: number;
  marginBottom?: number;
  marginLeft?: number;
  /** "none" removes the node from layout and hides it. */
  display?: "flex" | "none";
}

/** How a <Box> arranges its children; the defaults are the web's. */
export interface FlexContainerProps extends FlexItemProps {
  flexDirection?: "row" | "column" | "row-reverse" | "column-reverse";
  flexWrap?: "nowrap" | "wrap" | "wrap-reverse";
  justifyContent?:
    | "flex-start" | "center" | "flex-end" | "space-between" | "space-around" | "space-evenly";
  alignItems?: "flex-start" | "center" | "flex-end" | "stretch" | "baseline";
  alignContent?:
    | "flex-start" | "center" | "flex-end" | "stretch" | "space-between" | "space-around";
  gap?: number;
  rowGap?: number;
  columnGap?: number;
  padding?: number;
  paddingX?: number;
  paddingY?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
}

const config = Yoga.Config.create();
// Row direction, flex-shrink 1 and stretched lines, as in CSS.
config.setUseWebDefaults(true);
config.setPointScaleFactor(1);

const directions = {
  row: FlexDirection.Row,
  column: FlexDirection.Column,
  "row-reverse": FlexDirection.RowReverse,
  "column-reverse": FlexDirection.ColumnReverse,
};
const wraps = { nowrap: Wrap.NoWrap, wrap: Wrap.Wrap, "wrap-reverse": Wrap.WrapReverse };
const justifications = {
  "flex-start": Justify.FlexStart,
  center: Justify.Center,
  "flex-end": Justify.FlexEnd,
  "space-between": Justify.SpaceBetween,
  "space-around": Justify.SpaceAround,
  "space-evenly": Justify.SpaceEvenly,
};
const alignments = {
  auto: Align.Auto,
  "flex-start": Align.FlexStart,
  center: Align.Center,
  "flex-end": Align.FlexEnd,
  stretch: Align.Stretch,
  baseline: Align.Baseline,
  "space-between": Align.SpaceBetween,
  "space-around": Align.SpaceAround,
};

type Style = Record<string, unknown>;

function lookup<T>(table: Record<string, T>, value: unknown, fallback: T): T {
  return typeof value === "string" && value in table ? table[value]! : fallback;
}

function length(value: unknown): Length | undefined {
  return typeof value === "number" || typeof value === "string" ? (value as Length) : undefined;
}

function edges(style: Style, prefix: "margin" | "padding"): [Edge, unknown][] {
  return [
    [Edge.All, style[prefix]],
    [Edge.Horizontal, style[`${prefix}X`]],
    [Edge.Vertical, style[`${prefix}Y`]],
    [Edge.Top, style[`${prefix}Top`]],
    [Edge.Right, style[`${prefix}Right`]],
    [Edge.Bottom, style[`${prefix}Bottom`]],
    [Edge.Left, style[`${prefix}Left`]],
  ];
}

/**
 * Set every layout property of NODE from STYLE, so a removed prop returns to
 * its default. A <Box> also reads the container properties.
 */
export function applyLayoutStyle(node: Node, style: Style, container: boolean): void {
  const absolute = style.position === "absolute";
  node.setPositionType(absolute ? PositionType.Absolute : PositionType.Relative);
  node.setPosition(Edge.Left, typeof style.x === "number" ? style.x : undefined);
  node.setPosition(Edge.Top, typeof style.y === "number" ? style.y : undefined);
  node.setDisplay(style.display === "none" ? Display.None : Display.Flex);

  node.setWidth(length(style.width) ?? "auto");
  node.setHeight(length(style.height) ?? "auto");
  node.setMinWidth(length(style.minWidth) as number | undefined);
  node.setMinHeight(length(style.minHeight) as number | undefined);
  node.setMaxWidth(length(style.maxWidth) as number | undefined);
  node.setMaxHeight(length(style.maxHeight) as number | undefined);
  node.setAspectRatio(typeof style.aspectRatio === "number" ? style.aspectRatio : undefined);

  node.setFlexGrow(typeof style.flexGrow === "number" ? style.flexGrow : 0);
  node.setFlexShrink(typeof style.flexShrink === "number" ? style.flexShrink : 1);
  node.setFlexBasis(length(style.flexBasis) ?? "auto");
  node.setAlignSelf(lookup(alignments, style.alignSelf, Align.Auto));
  for (const [edge, value] of edges(style, "margin")) {
    node.setMargin(edge, length(value) ?? undefined);
  }

  if (!container) return;
  node.setFlexDirection(lookup(directions, style.flexDirection, FlexDirection.Row));
  node.setFlexWrap(lookup(wraps, style.flexWrap, Wrap.NoWrap));
  node.setJustifyContent(lookup(justifications, style.justifyContent, Justify.FlexStart));
  node.setAlignItems(lookup(alignments, style.alignItems, Align.Stretch));
  node.setAlignContent(lookup(alignments, style.alignContent, Align.Stretch));
  node.setGap(Gutter.All, typeof style.gap === "number" ? style.gap : undefined);
  node.setGap(Gutter.Row, typeof style.rowGap === "number" ? style.rowGap : undefined);
  node.setGap(Gutter.Column, typeof style.columnGap === "number" ? style.columnGap : undefined);
  for (const [edge, value] of edges(style, "padding")) {
    node.setPadding(edge, length(value) as number | undefined);
  }
}

export function createLayoutNode(): Node {
  return Yoga.Node.create(config);
}

export function calculateLayout(root: Node): void {
  root.calculateLayout(undefined, undefined, Direction.LTR);
}

/** Wire props a text's size depends on, besides its wrap width. */
export const textKeys = [
  "text", "markup", "font", "fontSize", "fontWeight", "italic", "lineHeight", "maxLines",
] as const;

export interface MeasureRequest {
  key: number;
  props: WireProps;
}

interface Size {
  width: number;
  height: number;
}

/**
 * Text sizes as the compositor measures them, cached by style and wrap width.
 * Until a size is known, layout uses an estimate and the request waits in
 * `pending` for the container to send.
 */
export class TextMetrics {
  private readonly sizes = new Map<string, Size>();
  private readonly pending = new Map<string, MeasureRequest>();
  private readonly keys = new Map<number, string>();
  private nextKey = 1;

  /** NODE's size for WIRE's text, wrapped to MAX-WIDTH when it is given. */
  measure(wire: WireProps, maxWidth?: number): Size {
    const props: WireProps = {};
    for (const key of textKeys) if (wire[key] !== undefined) props[key] = wire[key] as WireValue;
    if (maxWidth !== undefined) props.width = Math.floor(maxWidth);
    const id = JSON.stringify(props);
    const known = this.sizes.get(id);
    if (known) return known;
    if (!this.pending.has(id)) {
      const key = this.nextKey++;
      this.keys.set(key, id);
      this.pending.set(id, { key, props });
    }
    return estimate(props);
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }

  takePending(): MeasureRequest[] {
    const requests = [...this.pending.values()];
    this.pending.clear();
    return requests;
  }

  resolve(results: readonly { key: number; width: number; height: number }[]): void {
    for (const { key, width, height } of results) {
      const id = this.keys.get(key);
      if (id === undefined) continue;
      this.keys.delete(key);
      this.remember(id, { width, height });
    }
  }

  /** Accept the estimates for REQUESTS, e.g. when the compositor does not answer. */
  settle(requests: readonly MeasureRequest[]): void {
    for (const { key, props } of requests) {
      const id = this.keys.get(key);
      if (id === undefined) continue;
      this.keys.delete(key);
      this.remember(id, estimate(props));
    }
  }

  private remember(id: string, size: Size): void {
    // A bounded cache: the oldest sizes go first.
    if (this.sizes.size >= 4096) this.sizes.delete(this.sizes.keys().next().value!);
    // Whole pixels, so a Box's rounded size always holds its text.
    this.sizes.set(id, { width: Math.ceil(size.width), height: Math.ceil(size.height) });
  }
}

function estimate(props: WireProps): Size {
  const size = typeof props.fontSize === "number" ? props.fontSize : 14;
  const text = String(props.text ?? "");
  const lines = (props.markup ? text.replace(/<[^>]*>/g, "") : text).split("\n");
  const longest = Math.max(...lines.map((line) => line.length));
  const width = longest * size * 0.55;
  const wrapped = typeof props.width === "number" ? Math.min(width, props.width) : width;
  return { width: wrapped, height: lines.length * size * 1.3 };
}

/** A Yoga measure function sizing a text node from METRICS. */
export function textMeasure(metrics: TextMetrics, wire: () => WireProps) {
  return (width: number, widthMode: MeasureMode): Size => {
    const props = wire();
    const natural = metrics.measure(props);
    if (widthMode === MeasureMode.Undefined || natural.width <= width) return natural;
    // A single line ellipsizes instead of wrapping.
    if (props.maxLines === 1) return { width, height: natural.height };
    return metrics.measure(props, width);
  };
}
