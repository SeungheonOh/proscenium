import type { Rectangle } from "proscenium";

export type Direction = readonly [dx: number, dy: number];

/** A work area to lay out in before any output is known. */
export const fallbackArea: Rectangle = { x: 0, y: 0, width: 1280, height: 800 };

/** Arrow and Vim keys as directions on screen. */
export const directions: Record<string, Direction> = {
  Left: [-1, 0],
  Right: [1, 0],
  Up: [0, -1],
  Down: [0, 1],
  H: [-1, 0],
  L: [1, 0],
  K: [0, -1],
  J: [0, 1],
};

function center(box: Rectangle) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** The box nearest to `from` in `direction`, preferring boxes straight ahead. */
export function neighbour(
  boxes: ReadonlyMap<number, Rectangle>,
  from: number,
  [dx, dy]: Direction,
): number | null {
  const origin = boxes.get(from);
  if (!origin) return null;
  const start = center(origin);
  let best: number | null = null;
  let bestScore = Infinity;
  for (const [id, box] of boxes) {
    const { x, y } = center(box);
    const along = (x - start.x) * dx + (y - start.y) * dy;
    const across = Math.abs((x - start.x) * dy - (y - start.y) * dx);
    const score = along + 2 * across;
    if (id !== from && along > 0 && score < bestScore) {
      best = id;
      bestScore = score;
    }
  }
  return best;
}

/** The box, other than `skip`, that contains the point. */
export function boxAt(
  boxes: ReadonlyMap<number, Rectangle>,
  x: number,
  y: number,
  skip?: number,
): number | null {
  for (const [id, box] of boxes) {
    const inside = x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
    if (id !== skip && inside) return id;
  }
  return null;
}

/** A box `fraction` the size of `area`, centered in it. */
export function centered(area: Rectangle, fraction: number): Rectangle {
  const width = area.width * fraction;
  const height = area.height * fraction;
  return {
    x: area.x + (area.width - width) / 2,
    y: area.y + (area.height - height) / 2,
    width,
    height,
  };
}

/** The smallest box containing all of `boxes`, or null when there are none. */
export function union(boxes: Iterable<Rectangle>): Rectangle | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const box of boxes) {
    left = Math.min(left, box.x);
    top = Math.min(top, box.y);
    right = Math.max(right, box.x + box.width);
    bottom = Math.max(bottom, box.y + box.height);
  }
  return left <= right ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}
