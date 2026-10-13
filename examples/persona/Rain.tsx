import { memo } from "react";
import { Group, Rect, type Animation } from "proscenium";
import { raindrop } from "./paints.js";

/** The original's 80 drops, each with its place, speed, phase and drift from its index. */
const drops = 80;

/** The original's hash of a drop's index, for its random numbers. */
function hash(x: number, y: number): number {
  const value = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return value - Math.floor(value);
}

interface Frame {
  x: number;
  y: number;
  opacity: number;
}

/** The frame at U of a cycle given by KNOTS, straight between them; of two at one place, the later. */
function frameAt(knots: [number, Frame][], u: number): Frame {
  let index = 0;
  while (index < knots.length - 2 && knots[index + 1]![0] <= u) index++;
  const [u0, a] = knots[index]!;
  const [u1, b] = knots[index + 1]!;
  const t = u1 > u0 ? (u - u0) / (u1 - u0) : 1;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, opacity: a.opacity + (b.opacity - a.opacity) * t };
}

/** The cycle KNOTS describe as keyframes, starting PHASE of the way through. */
function cycle(knots: [number, Frame][], phase: number): Animation {
  const points: [number, Frame][] = [[0, frameAt(knots, phase)]];
  for (const [u, frame] of knots) {
    const at = (u - phase + 1) % 1;
    if (u > 0 && u < 1 && at > 0) points.push([at, frame]);
  }
  if (phase > 0) points.push([1 - phase, knots[knots.length - 1]![1]], [1 - phase, knots[0]![1]]);
  points.push([1, frameAt(knots, phase)]);
  points.sort((a, b) => a[0] - b[0]);
  return {
    x: points.map(([, frame]) => frame.x),
    y: points.map(([, frame]) => frame.y),
    opacity: points.map(([, frame]) => frame.opacity),
    offsets: points.map(([at]) => at),
    ease: "linear",
    iterations: Infinity,
  };
}

interface RainProps {
  width: number;
  height: number;
  /** How far down the windows reach; below them the carriage hides the rain. */
  visible: number;
  falling: boolean;
}

/**
 * The rain beyond the windows. Each drop is a small node the compositor moves
 * on its own. A drop falls a screen's height as the original's do, but only
 * the stretch the windows show is drawn: it waits out the rest of its fall,
 * hidden, at their foot.
 */
export const Rain = memo(function Rain({ width, height, visible, falling }: RainProps) {
  // Where a drop adds more than 3/255 of light; the original's glow fades to nothing beyond.
  const dropWidth = Math.ceil(width * 0.0055);
  const dropHeight = Math.ceil(height * 0.09);
  const shown = visible / height;
  return (
    <Group>
      {Array.from({ length: drops }, (_, index) => {
        const [across, speed, phase, drift] = [0.3, 1.7, 2.5, 3.9].map((salt) => hash(index, salt)) as
          [number, number, number, number];
        // The original falls fract(phase + seconds · 0.02 · (4 + 5 · speed)) of the way down.
        const seconds = 1 / (0.02 * (4 + 5 * speed));
        const at = (down: number, opacity: number): Frame => ({
          x: width * (across + (drift - 0.5) * 0.02 * down) - dropWidth / 2,
          y: height * down - dropHeight * 0.6,
          opacity,
        });
        const knots: [number, Frame][] = [
          [0, at(0, 0)], [0.05, at(0.05, 1)], [shown, at(shown, 1)], [shown, at(shown, 0)], [1, at(shown, 0)],
        ];
        return (
          <Rect
            key={index}
            width={dropWidth}
            height={dropHeight}
            opacity={0}
            interactive={false}
            shaders={[{
              id: "drop",
              shader: raindrop,
              uniforms: { tint: [0.75 + 0.15 * across, 0.9 + 0.05 * across, 1, 1], screen: [width, height], seed: across },
            }]}
            animate={falling ? { ...cycle(knots, phase), duration: seconds, key: `${width}x${height}` } : undefined}
          />
        );
      })}
    </Group>
  );
});
