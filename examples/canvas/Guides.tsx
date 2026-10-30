import { Group, Rect, useCamera } from "proscenium";
import type { Guide } from "./snapping.js";

/** Sunlight's guide pink. */
const pink = "#ff529e";

/**
 * The alignment guides holding the window in hand, on the canvas over every
 * window: hairlines at any zoom, and a gap marked like a dimension, with a tick
 * at each end.
 */
export function Guides({ guides }: { guides: readonly Guide[] }) {
  const zoom = useCamera()?.zoom ?? 1;
  if (guides.length === 0) return null;
  const width = 1 / zoom;
  const tick = 4 / zoom;
  const lines: { x: number; y: number; width: number; height: number }[] = [];
  for (const g of guides) {
    const horizontal = g.from.y === g.to.y;
    const x = Math.min(g.from.x, g.to.x);
    const y = Math.min(g.from.y, g.to.y);
    lines.push(
      horizontal
        ? { x, y: y - width / 2, width: Math.abs(g.to.x - g.from.x), height: width }
        : { x: x - width / 2, y, width, height: Math.abs(g.to.y - g.from.y) },
    );
    if (g.kind !== "gap") continue;
    for (const end of [g.from, g.to])
      lines.push(
        horizontal
          ? { x: end.x - width / 2, y: end.y - tick, width, height: 2 * tick }
          : { x: end.x - tick, y: end.y - width / 2, width: 2 * tick, height: width },
      );
  }
  return (
    <Group interactive={false}>
      {lines.map((line, i) => (
        <Rect key={i} {...line} fill={pink} interactive={false} />
      ))}
    </Group>
  );
}
