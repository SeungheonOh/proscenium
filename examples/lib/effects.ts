/**
 * Shaders of the examples. Effects define `vec4 effect(vec2 position)` over the
 * node as drawn (`content`); paints `vec4 paint(vec2 position)` over its box.
 * Positions are in local pixels, colors premultiplied.
 */

import { effectShader, paintShader, tween } from "proscenium";

/**
 * Value noise in 0..1, smooth at the scale of one unit. The hash is arithmetic
 * (Dave Hoskins' hash12): a sine per lattice point costs far more on most GPUs.
 */
export const noise = `
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
`;

/**
 * Burns away into noise as `amount` goes from 0 to 1, with a glowing rim; at 0 it
 * is skipped. `margin` is room around the box for what the node draws beyond it,
 * such as its shadow.
 */
export const dissolve = effectShader({
  uniforms: { amount: 1, margin: 1 },
  extent: { uniforms: { margin: 1 } },
  reads: { local: true },
  gate: "amount",
  source: `${noise}
vec4 effect(vec2 position) {
  vec4 color = content(position);
  float grain = noise(position / 22.0) * 0.75 + noise(position / 5.0) * 0.25;
  float threshold = amount * 1.15 - 0.075;
  float keep = smoothstep(threshold, threshold + 0.05, grain);
  float rim = keep * (1.0 - smoothstep(threshold + 0.05, threshold + 0.12, grain)) * step(0.001, amount);
  return vec4(color.rgb * keep + vec3(0.2, 0.8, 1.0) * rim * color.a, color.a * keep);
}`,
});

/**
 * Burning in as a window opens and away as it closes, with MARGIN for what it
 * draws beyond its box: its use of `dissolve`, and the `shaders` its `initial`
 * and `exit` take to burn it.
 */
export function burn(margin: number) {
  return {
    use: { id: "dissolve", shader: dissolve, uniforms: { amount: 0, margin }, transition: tween(0.5, "ease-out") },
    burnt: { dissolve: { amount: 1 } },
  };
}

/** Warms colors toward candlelight by `amount`. */
export const warmth = effectShader({
  uniforms: { amount: 1 },
  reads: { local: true },
  gate: "amount",
  source: `
vec4 effect(vec2 position) {
  vec4 color = content(position);
  return vec4(mix(color.rgb, color.rgb * vec3(1.0, 0.8, 0.58), amount), color.a);
}`,
});

/** Signed distance to a rounded box centered at the origin. */
const roundedBox = `
float rounded_box(vec2 p, vec2 half_size, float r) {
  vec2 q = abs(p) - half_size + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}
`;

/**
 * Liquid glass under a rounded card's fill: what is behind is frosted by
 * `frost` and bends like a lens toward the rim, splitting a little into colors.
 */
export const liquidGlass = paintShader({
  uniforms: { frost: 1 },
  reads: { backdrop: { blur: "frost" } },
  gate: "frost",
  source: `${roundedBox}
vec4 paint(vec2 position) {
  vec2 half_size = size * 0.5;
  vec2 local = position - half_size;
  float r = min(radius, min(half_size.x, half_size.y));
  float d = rounded_box(local, half_size, r);
  // The rim, 0 in the middle and 1 at the edge, bends the view along the surface normal.
  vec2 e = vec2(0.5, 0.0);
  vec2 normal = normalize(vec2(rounded_box(local + e.xy, half_size, r) - rounded_box(local - e.xy, half_size, r),
                               rounded_box(local + e.yx, half_size, r) - rounded_box(local - e.yx, half_size, r)) + 1e-5);
  float rim = pow(clamp(1.0 + d / 14.0, 0.0, 1.0), 2.0);
  vec2 bend = -normal * rim * 10.0;
  vec3 glass = backdrop(position + bend).rgb;
  // Colors part at the rim, where the surface bends the most.
  glass.r = mix(glass.r, backdrop(position + bend * 1.35).r, rim * 0.6);
  glass.b = mix(glass.b, backdrop(position + bend * 0.65).b, rim * 0.6);
  // A soft sheen along the top rim.
  float sheen = rim * smoothstep(half_size.y, -half_size.y * 0.2, local.y) * 0.18;
  return vec4(glass + sheen, 1.0) * clamp(0.5 - d / pixel, 0.0, 1.0);
}`,
});

/**
 * An old CRT over the whole output, fading in with `amount`: a bulging screen,
 * scanlines, an aperture grille, color fringes and dark corners.
 */
export const crt = effectShader({
  uniforms: { amount: 1 },
  gate: "amount",
  source: `
vec4 effect(vec2 position) {
  vec4 plain = content(position);
  vec2 centered = position / size * 2.0 - 1.0;
  vec2 bent = centered * (1.0 + 0.07 * amount * dot(centered, centered));
  vec2 source = (bent * 0.5 + 0.5) * size;
  float inside = step(abs(bent.x), 1.0) * step(abs(bent.y), 1.0);
  float fringe = 1.4 * amount;
  vec3 color = vec3(content(source + vec2(fringe, 0.0)).r, content(source).g,
                    content(source - vec2(fringe, 0.0)).b);
  float row = position.y / pixel;
  float column = position.x / pixel;
  float scanline = 0.82 + 0.18 * sin(row * 3.14159);
  vec3 grille = vec3(0.86) + 0.14 * vec3(mod(column, 3.0) < 1.0, mod(column + 1.0, 3.0) < 1.0,
                                         mod(column + 2.0, 3.0) < 1.0);
  float vignette = smoothstep(1.75, 0.7, length(bent));
  vec3 tube = color * scanline * grille * vignette * 1.2 * inside;
  return vec4(mix(plain.rgb, tube, amount), 1.0);
}`,
});

/** A round lens `reach` wide magnifying what is under the pointer `zoom` times; it opens with `amount`. */
export const magnifier = effectShader({
  uniforms: { amount: 1, reach: 1, zoom: 1 },
  reads: { pointer: true },
  gate: "amount",
  source: `
vec4 effect(vec2 position) {
  vec2 offset = position - pointer;
  float distance = length(offset);
  float lens = reach * amount;
  vec4 plain = content(position);
  if (distance > lens + 3.0) return plain;
  // A little extra magnification toward the rim, as a glass lens has.
  float rim = distance / max(lens, 1.0);
  vec4 zoomed = content(pointer + offset / (zoom * (1.0 + 0.15 * rim * rim)));
  float edge = smoothstep(lens - 1.5, lens + 1.0, distance);
  float ring = (smoothstep(lens - 4.0, lens - 2.0, distance) - edge) * 0.7;
  return mix(zoomed, plain, edge) + vec4(vec3(ring), 0.0);
}`,
});
