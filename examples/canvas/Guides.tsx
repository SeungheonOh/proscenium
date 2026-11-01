import { Group, Rect, type Rectangle } from "proscenium";
import { useScreenPixel } from "./ScreenSized.js";
import type { Guide } from "./snapping.js";

/** Sunlight's guide pink. */
const pink = "#ff529e";

/**
 * The alignment guides holding the window in hand, on the canvas over every
 * window: hairlines at any zoom, and a gap marked like a dimension, with a tick
 * at each end.
 */
export function Guides({ guides }: { guides: readonly Guide[] }) {
  const pixel = useScreenPixel();
  if (guides.length === 0) return null;
  const hairline = pixel;
  const tick = 4 * pixel;
  const lines: Rectangle[] = [];
  for (const guide of guides) {
    const { from, to } = guide;
    const horizontal = from.y === to.y;
    const x = Math.min(from.x, to.x);
    const y = Math.min(from.y, to.y);
    lines.push(
      horizontal
        ? { x, y: y - hairline / 2, width: Math.abs(to.x - from.x), height: hairline }
        : { x: x - hairline / 2, y, width: hairline, height: Math.abs(to.y - from.y) },
    );
    if (guide.kind !== "gap") continue;
    for (const end of [from, to]) {
      lines.push(
        horizontal
          ? { x: end.x - hairline / 2, y: end.y - tick, width: hairline, height: 2 * tick }
          : { x: end.x - tick, y: end.y - hairline / 2, width: 2 * tick, height: hairline },
      );
    }
  }
  return (
    <Group>
      {lines.map((line, i) => (
        <Rect key={i} {...line} fill={pink} />
      ))}
    </Group>
  );
}
