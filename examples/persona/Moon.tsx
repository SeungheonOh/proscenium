import { Rect } from "proscenium";
import { moon } from "./paints.js";

/** The moon's phase as the clock reckons it: degrees from 360 (new) down, snapping to new and full. */
export function moonPhase(date: Date): number {
  const days = (date.getTime() - new Date("2024-03-10T15:00:00").getTime()) / 86400000;
  const degree = 360 - Math.floor(((days % 29.5) / 29.5) * 360);
  if (degree >= 355 || degree <= 5) return 0;
  if (degree >= 175 && degree <= 185) return 180;
  return degree;
}

/** The theme's moon at DEGREE of its phase. */
export function Moon({ x, y, size, degree }: { x: number; y: number; size: number; degree: number }) {
  return (
    <Rect x={x} y={y} width={size} height={size} interactive={false}
          shaders={[{ id: "moon", shader: moon,
                      uniforms: { turn: Math.cos((degree * Math.PI) / 180), waxing: degree < 180 ? 1 : 0 } }]} />
  );
}
