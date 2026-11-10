/**
 * Warlock's portal: what a window opens through and closes into. A ring of red
 * ember fragments ignites at the window's middle, turns as it grows out through
 * the window's corners and fades, while a cover in the desktop's colour opens
 * over the window like an iris; closing, the ring alone draws back into the
 * middle of where the window was. The window itself is never scaled or faded.
 * Timings and shapes are those of Warlock's effects.css.
 */

import { memo } from "react";
import {
  Group,
  paintShader,
  Rect,
  rotate,
  scale,
  type Animation,
  type Rectangle,
} from "proscenium";
import { useWarlockTheme } from "./theme.js";

export const portalOpenSeconds = 0.52;
export const portalCloseSeconds = 0.36;

type Bezier = readonly [number, number, number, number];

/** A CSS cubic-bezier easing as a function of progress. */
function bezier([x1, y1, x2, y2]: Bezier): (progress: number) => number {
  const curve = (a: number, b: number, t: number) =>
    3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  return (progress) => {
    let low = 0;
    let high = 1;
    for (let step = 0; step < 24; step++) {
      const middle = (low + high) / 2;
      if (curve(x1, x2, middle) < progress) low = middle;
      else high = middle;
    }
    return curve(y1, y2, (low + high) / 2);
  };
}

interface Stop {
  /** Where in the animation this value holds, 0..1. */
  at: number;
  value: number;
  /** How the value moves on to the next stop. */
  ease?: Bezier;
}

/** A value over an animation's progress, through STOPS, each stretch with its own easing, as CSS keyframes have it. */
function track(stops: readonly Stop[]): (progress: number) => number {
  const eases = stops.map((stop) => (stop.ease ? bezier(stop.ease) : (t: number) => t));
  return (progress) => {
    if (progress <= stops[0]!.at) return stops[0]!.value;
    for (let index = 0; index + 1 < stops.length; index++) {
      const from = stops[index]!;
      const to = stops[index + 1]!;
      if (progress <= to.at) {
        const local = to.at === from.at ? 1 : (progress - from.at) / (to.at - from.at);
        return from.value + (to.value - from.value) * eases[index]!(local);
      }
    }
    return stops[stops.length - 1]!.value;
  };
}

// Opening: ignite 0-120 ms, expand 120-380, resolve 380-460, settle 460-520.
const ignite: Bezier = [0.16, 0, 0.3, 1];
const expand: Bezier = [0.2, 0.72, 0.2, 1];
const resolve: Bezier = [0.2, 0, 0, 1];
const settle: Bezier = [0, 0, 0.2, 1];
const a = 0.2308;
const b = 0.7308;
const c = 0.8846;

const openScale = track([
  { at: 0, value: 0.04, ease: ignite },
  { at: a, value: 0.16, ease: expand },
  { at: b, value: 1, ease: resolve },
  { at: c, value: 1.02, ease: settle },
  { at: 1, value: 1.03 },
]);
const openTurn = track([
  { at: 0, value: 0, ease: ignite },
  { at: a, value: 2, ease: expand },
  { at: b, value: 12 },
  { at: 1, value: 12 },
]);
const openGlow = track([
  { at: 0, value: 0, ease: ignite },
  { at: a, value: 0.95, ease: expand },
  { at: b, value: 0.8, ease: resolve },
  { at: c, value: 0.25, ease: settle },
  { at: 1, value: 0 },
]);
/** How far the cover's hole has opened: 1.414 reaches the window's corners. */
const openAperture = track([
  { at: 0, value: 0, ease: ignite },
  { at: a, value: 0.16, ease: expand },
  { at: b, value: 1.46 },
  { at: 1, value: 1.46 },
]);
const coverOpacity = track([
  { at: 0, value: 1 },
  { at: b, value: 1 },
  { at: c, value: 0 },
  { at: 1, value: 0 },
]);

// Closing: release 0-90 ms, contract 90-270, disperse 270-360.
const closeScale = track([
  { at: 0, value: 1, ease: [0.4, 0, 1, 1] },
  { at: 0.25, value: 0.98, ease: [0.4, 0, 0.2, 1] },
  { at: 0.75, value: 0.06, ease: [0, 0, 0.2, 1] },
  { at: 1, value: 0.02 },
]);
const closeTurn = track([
  { at: 0, value: 0, ease: [0.4, 0, 1, 1] },
  { at: 0.25, value: -1, ease: [0.4, 0, 0.2, 1] },
  { at: 0.75, value: -8 },
  { at: 1, value: -8 },
]);
const closeGlow = track([
  { at: 0, value: 0, ease: [0.4, 0, 1, 1] },
  { at: 0.25, value: 0.85 },
  { at: 0.75, value: 0.85, ease: [0, 0, 0.2, 1] },
  { at: 1, value: 0 },
]);

/**
 * The ring, over a box 1.42 times the window's: an ellipse through the window's
 * corners, cut into fragments by angle, with a red glow between them.
 */
const ring = paintShader({
  uniforms: { brand: 4, action: 4, spark: 4 },
  source: `
vec4 lit(vec4 color, float amount) {
  return vec4(color.rgb * color.a, color.a) * amount;
}
/* How far ANGLE (degrees) is from a wedge WIDTH wide that repeats every PERIOD, from START. */
float away(float angle, float start, float period, float width) {
  float local = mod(angle - start, period);
  return max(0.0, min(local - width, period - local));
}
vec4 paint(vec2 p) {
  vec2 q = p - size * 0.5;
  float rho = length(q / (size * 0.5));
  float band = clamp((rho - 0.905) / 0.02, 0.0, 1.0) * (1.0 - clamp((rho - 0.97) / 0.025, 0.0, 1.0));
  if (band <= 0.0) return vec4(0.0);
  float angle = degrees(atan(q.x, -q.y));
  /* Half an output pixel of softening, in degrees at this distance from the middle. */
  float degree = degrees(pixel / max(length(q), 1.0));
  float first = away(angle, 7.0, 11.0, 1.6);
  float second = away(angle, 12.0, 11.0, 1.2);
  float hot = away(angle, 2.0, 23.0, 0.6);
  vec4 color = lit(spark, clamp(1.0 - hot / degree, 0.0, 1.0));
  color = mix(color, lit(action, 1.0), clamp(1.0 - second / degree, 0.0, 1.0));
  color = mix(color, lit(brand, 1.0), clamp(1.0 - first / degree, 0.0, 1.0));
  /* The glow: the action colour spreading six pixels along the ring from each fragment. */
  float reach = degrees(6.0 / max(length(q), 1.0));
  float near = min(first, second);
  float glow = 0.7 * exp(-(near * near) / (reach * reach * 0.5));
  vec4 under = lit(action, glow);
  return (color + under * (1.0 - color.a)) * band;
}
`,
});

/** The cover over an opening window: the desktop's colour outside a growing elliptical hole. */
const cover = paintShader({
  uniforms: { tint: 4, open: 1 },
  source: `
vec4 paint(vec2 p) {
  vec2 q = abs(p - size * 0.5) - size * 0.5 + radius;
  float box = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
  float inside = clamp(0.5 - box / pixel, 0.0, 1.0);
  float rho = length((p - size * 0.5) / (size * 0.5));
  float solid = clamp((rho - open) / 0.006, 0.0, 1.0);
  return vec4(tint.rgb * tint.a, tint.a) * solid * inside;
}
`,
});

const ringOpen: Animation = {
  transform: (t) => [scale(openScale(t)), rotate(openTurn(t))],
  opacity: openGlow,
  duration: portalOpenSeconds,
  ease: "linear",
};
const ringClose: Animation = {
  transform: (t) => [scale(closeScale(t)), rotate(closeTurn(t))],
  opacity: closeGlow,
  duration: portalCloseSeconds,
  ease: "linear",
};
const coverOpen: Animation = {
  shaders: { cover: { open: openAperture } },
  opacity: coverOpacity,
  duration: portalOpenSeconds,
  ease: "linear",
};

export interface PortalProps {
  /** The window's frame, in the space the portal is drawn in. */
  rect: Rectangle;
  kind: "open" | "close";
}

/**
 * One portal over RECT, played once from when it is first shown. It takes no
 * input; remove it once its time has passed.
 */
export const Portal = memo(function Portal({ rect, kind }: PortalProps) {
  const { palette } = useWarlockTheme();
  const reach = 0.21;
  return (
    <Group x={rect.x} y={rect.y} interactive={false}>
      {kind === "open" && (
        <Rect
          width={rect.width}
          height={rect.height}
          radius={10}
          opacity={0}
          interactive={false}
          shaders={[{ id: "cover", shader: cover, uniforms: { tint: palette.canvas, open: 1.46 } }]}
          animate={coverOpen}
        />
      )}
      <Rect
        x={-reach * rect.width}
        y={-reach * rect.height}
        width={(1 + 2 * reach) * rect.width}
        height={(1 + 2 * reach) * rect.height}
        opacity={0}
        interactive={false}
        shaders={[
          {
            id: "ring",
            shader: ring,
            uniforms: { brand: palette.brandText, action: palette.actionFill, spark: "#ffd2c8" },
          },
        ]}
        animate={kind === "open" ? ringOpen : ringClose}
      />
    </Group>
  );
});
