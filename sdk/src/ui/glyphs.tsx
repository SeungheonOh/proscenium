import { memo } from "react";
import { Group, Rect } from "../components.js";
import type { Color } from "../color.js";
import type { GroupProps, States } from "../props.js";
import { rotate } from "../transform.js";

// Small marks the kit draws itself, as strokes of round-ended Rects, rather than as
// font glyphs (whose metrics and coverage depend on whichever font has them) or as
// image files (which a package of TypeScript cannot ship): a tick, chevrons, a dot.
// Each is a polyline in a 24-unit square, scaled to its size.

export type GlyphShape = "check" | "chevron-right" | "chevron-left" | "chevron-down" | "chevron-up" | "dot" | "dash"
  | "search" | "close";

type Point = readonly [number, number];

const shapes: Record<string, readonly Point[]> = {
  close: [[6.5, 6.5], [17.5, 17.5]],
  closeOther: [[17.5, 6.5], [6.5, 17.5]],
  handle: [[15.5, 15.5], [20, 20]],
  check: [[4.5, 12.5], [9.5, 17.5], [19.5, 6.5]],
  "chevron-right": [[9.5, 6], [15.5, 12], [9.5, 18]],
  "chevron-left": [[14.5, 6], [8.5, 12], [14.5, 18]],
  "chevron-down": [[6, 9.5], [12, 15.5], [18, 9.5]],
  "chevron-up": [[6, 14.5], [12, 8.5], [18, 14.5]],
  dash: [[6, 12], [18, 12]],
};

interface Segment {
  x: number;
  y: number;
  width: number;
  transform: ReturnType<typeof rotate>;
}

const made = new Map<string, readonly Segment[]>();

/** SHAPE's strokes at SIZE with STROKE thickness: each a Rect's place, length and turn, made once. */
function segments(shape: string, size: number, stroke: number): readonly Segment[] {
  const key = `${shape}:${size}:${stroke}`;
  let list = made.get(key);
  if (list) return list;
  const unit = size / 24;
  const points = shapes[shape];
  list = points.slice(1).map((end, index) => {
    const start = points[index]!;
    const dx = (end[0] - start[0]) * unit, dy = (end[1] - start[1]) * unit;
    // Each stroke runs half its thickness past both ends, so joints close and ends are round.
    const length = Math.hypot(dx, dy) + stroke;
    const cx = (start[0] + end[0]) / 2 * unit, cy = (start[1] + end[1]) / 2 * unit;
    return { x: cx - length / 2, y: cy - stroke / 2, width: length, transform: rotate(Math.atan2(dy, dx) * 180 / Math.PI) };
  });
  made.set(key, list);
  return list;
}

export interface GlyphProps extends Omit<GroupProps, "children" | "width" | "height"> {
  shape: GlyphShape;
  /** Its side, in pixels; defaults to 16. */
  size?: number;
  /** Stroke thickness, in pixels; defaults to a twelfth of the size, at least 1.5. */
  stroke?: number;
  color: Color;
  /** States of the strokes, e.g. `{ group: true, hover: { fill: … } }` to follow a control. */
  strokeStates?: States;
}

/** A mark drawn with strokes: `<Glyph shape="chevron-right" size={14} color={colors.muted} />`. */
export const Glyph = memo(function Glyph({ shape, size = 16, stroke, color, strokeStates, ...group }: GlyphProps) {
  const thickness = stroke ?? Math.max(1.5, size / 12);
  if (shape === "dot") {
    const side = Math.round(size * 0.375);
    return (
      <Group width={size} height={size} {...group}>
        <Rect x={(size - side) / 2} y={(size - side) / 2} width={side} height={side} radius={side / 2} fill={color}
              states={strokeStates} />
      </Group>
    );
  }
  if (shape === "search") {
    // A lens, as a ring, and its handle.
    const unit = size / 24, ring = 13 * unit;
    return (
      <Group width={size} height={size} {...group}>
        <Rect x={4 * unit} y={4 * unit} width={ring} height={ring} radius={ring / 2}
              border={{ width: thickness, color }} states={strokeStates} />
        {segments("handle", size, thickness).map((segment, index) => (
          <Rect key={index} x={segment.x} y={segment.y} width={segment.width} height={thickness} radius={thickness / 2}
                fill={color} transform={segment.transform} states={strokeStates} />
        ))}
      </Group>
    );
  }
  const strokes = shape === "close"
    ? [...segments("close", size, thickness), ...segments("closeOther", size, thickness)]
    : segments(shape, size, thickness);
  return (
    <Group width={size} height={size} {...group}>
      {strokes.map((segment, index) => (
        <Rect key={index} x={segment.x} y={segment.y} width={segment.width} height={thickness} radius={thickness / 2}
              fill={color} transform={segment.transform} states={strokeStates} />
      ))}
    </Group>
  );
});
