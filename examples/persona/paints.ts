/**
 * The shaders of the desktop's native parts, from the original's QML and GLSL:
 * the rain, the music's hills, the date's wave and the record's grooves.
 */

import { filterShader, paintShader } from "proscenium";

/**
 * A drop of rain, as the original's stars shader draws each of its 80: a thin
 * bright streak with a faint tail above it, centred at 60% of the box's height.
 * It returns no alpha, so it adds its light to what lies behind. `screen` is the
 * output's size, which the original's shape is reckoned in.
 */
export const raindrop = paintShader({
  uniforms: { tint: 4, screen: 2, seed: 1 },
  reads: { time: true },
  source: `
vec4 paint(vec2 position) {
  vec2 delta = (position - size * vec2(0.5, 0.6)) / screen;
  delta.x *= 16.0 / 9.0;
  float dist = length(vec2(delta.x * 12.0, delta.y * 1.5));
  float core = min(0.00004 / (dist * dist + 0.00001), 1.0);
  float tail = min(0.00002 / (abs(delta.x * 14.0) + abs(delta.y * 0.8) + 0.0008), 1.0) * step(delta.y, 0.0);
  float shimmer = 0.75 + 0.25 * sin(time * 0.6 * (1.0 + seed * 2.0) + seed * 80.0);
  return vec4(tint.rgb * min(core + tail, 1.0) * shimmer, 0.0);
}`,
});

/** Bars the spectrum shader takes, four to a uniform. */
export const spectrumBars = 52;

const barUniforms = Object.fromEntries(Array.from({ length: spectrumBars / 4 }, (_, index) => [`bars${index}`, 4]));
// GLSL ES 1.0 indexes vectors only by constants: the group of four, then the one in it.
const barLookup = `  int group = i / 4;
  vec4 four = bars0;
${Array.from({ length: spectrumBars / 4 - 1 }, (_, index) =>
  `  if (group == ${index + 1}) four = bars${index + 1};`).join("\n")}
  int place = i - group * 4;
  return place == 0 ? four.x : place == 1 ? four.y : place == 2 ? four.z : four.w;`;

/**
 * The original's cava visualizer: a soft white hill through the bar heights
 * (`count` of them, 0..1), the curve through their midpoints, over a faint,
 * larger copy of itself.
 */
export const spectrum = paintShader({
  uniforms: { ...barUniforms, count: 1 },
  gate: "count",
  source: `
float bar(int i) {
${barLookup}
}
/** Whether P, in pixels, lies under the hill. */
float under(vec2 p) {
  float padding = size.x * 0.03;
  float step = (size.x - 2.0 * padding) / (count - 1.0);
  float x = (p.x - padding) / step;
  if (x < 0.0 || x > count - 1.0) return 0.0;
  // The quadratic through the midpoints either side of bar i, with bar i as its control point.
  int i = int(floor(x + 0.5));
  float t = x + 0.5 - float(i);
  float before = i > 0 ? (bar(i - 1) + bar(i)) * 0.5 : bar(0);
  float after = i < int(count) - 1 ? (bar(i) + bar(i + 1)) * 0.5 : bar(i);
  float h = (1.0 - t) * (1.0 - t) * before + 2.0 * t * (1.0 - t) * bar(i) + t * t * after;
  return clamp((p.y - (size.y - h * size.y * 0.9)) / pixel + 0.5, 0.0, 1.0);
}
float shade(float x) {
  float u = x / size.x;
  return u < 0.3 ? mix(0.12, 0.25, u / 0.3) : u < 0.5 ? mix(0.25, 0.3, (u - 0.3) / 0.2)
       : u < 0.7 ? mix(0.3, 0.25, (u - 0.5) / 0.2) : mix(0.25, 0.12, (u - 0.7) / 0.3);
}
vec4 paint(vec2 position) {
  vec2 shadow = (position - vec2(0.0, -10.0)) / vec2(1.02, 1.05);
  float back = under(shadow) * shade(shadow.x) * 0.3;
  float front = under(position) * shade(position.x);
  float alpha = front + back * (1.0 - front);
  return vec4(alpha);
}`,
});

/**
 * The date, cut out of the lighter wave rolling by behind it: where a glyph
 * crosses the band, the band's blue shows through. The band's edges follow
 * the original's wave8.png, a width of 500 rolling past every 10 seconds.
 */
export const dateWave = filterShader({
  reads: { time: true },
  source: `
vec4 filter(vec4 color, vec2 position) {
  float across = mod(position.x + time * 50.0, 500.0) / 500.0;
  float bend = cos(6.2831853 * (across - 0.03));
  // In the 140 pixel tall image, drawn 120 tall.
  float top = (56.0 + 12.0 * bend) * 120.0 / 140.0;
  float bottom = (124.0 - 4.0 * bend) * 120.0 / 140.0;
  float inside = clamp(position.y - top + 0.5, 0.0, 1.0) * clamp(bottom - position.y + 0.5, 0.0, 1.0);
  return vec4(11.0, 157.0, 255.0, 255.0) / 255.0 * 0.5 * color.a * inside;
}`,
});

/** The record's grooves, as the original's album cover mask: four rings, a thin one and the spindle. */
export const grooves = filterShader({
  source: `
float ring(float r, float centre, float half_width) {
  return clamp((half_width - abs(r - centre)) / (pixel / size.x * 400.0) + 0.5, 0.0, 1.0);
}
vec4 filter(vec4 color, vec2 position) {
  float r = length(position / size - 0.5) * 400.0;
  float mask = max(max(ring(r, 186.0, 14.0), ring(r, 153.5, 14.0)), max(ring(r, 121.0, 14.0), ring(r, 88.5, 14.0)));
  mask = max(mask, max(ring(r, 56.0, 1.0), ring(r, 0.0, 10.0)));
  return color * mask;
}`,
});

/**
 * The theme's moon: a lit and a dark half, and over them an ellipse as wide
 * as `turn` (the cosine of the phase) that is the terminator.
 */
export const moon = paintShader({
  uniforms: { turn: 1, waxing: 1 },
  source: `
vec4 paint(vec2 position) {
  vec2 p = position / size * 2.0 - 1.0;
  vec3 lit = vec3(1.0, 0.906, 0.0);
  vec3 dark = vec3(0.188, 0.173, 0.141);
  vec3 color = (p.x < 0.0) == (waxing > 0.5) ? lit : dark;
  if (abs(p.x) < abs(turn) * sqrt(max(0.0, 1.0 - p.y * p.y))) color = turn >= 0.0 ? dark : lit;
  float inside = clamp((1.0 - length(p)) * size.x * 0.5 / pixel + 0.5, 0.0, 1.0);
  return vec4(color, 1.0) * inside;
}`,
});
