/**
 * The options menu's screen shaders, which the original sets as Hyprland's
 * screen_shader: whole-output effects, each skipped while its `amount` is 0.
 */

import { effectShader } from "proscenium";

/** Takes a fifth of the blue away. */
export const bluelight = effectShader({
  uniforms: { amount: 1 },
  reads: { local: true },
  gate: "amount",
  source: `
vec4 effect(vec2 position) {
  vec4 color = content(position);
  return vec4(color.rg, color.b * (1.0 - 0.2 * amount), color.a);
}`,
});

/** Inverts every color. */
export const inversion = effectShader({
  uniforms: { amount: 1 },
  reads: { local: true },
  gate: "amount",
  source: `
vec4 effect(vec2 position) {
  vec4 color = content(position);
  return vec4(mix(color.rgb, color.a - color.rgb, amount), color.a);
}`,
});

/**
 * E-ink: gray ink on warm paper with grain, dithering and darker edges, from
 * snes19xx's surface-dots reading mode, as the original uses it.
 */
export const greyscale = effectShader({
  uniforms: { amount: 1 },
  reads: { local: true },
  gate: "amount",
  source: `
// A 4x4 Bayer matrix, built from the 2x2 one: GLSL ES 1.0 cannot index a matrix by a variable.
float bayer2(vec2 p) {
  vec2 b = mod(floor(p), 2.0);
  return 2.0 * b.x + 3.0 * b.y - 4.0 * b.x * b.y;
}
float bayer(vec2 p) {
  return (4.0 * bayer2(p) + bayer2(p * 0.5)) / 16.0;
}
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float paper_texture(vec2 uv) {
  float n = hash(uv * 0.3) * 0.6 + hash(uv * 0.8) * 0.4 + hash(uv * 2.5) * 0.3
          + hash(uv * 6.0) * 0.2 + hash(uv * 15.0) * 0.1;
  return n / 1.6;
}
float directional_grain(vec2 uv) {
  vec2 direction = vec2(0.7, 0.3);
  return (hash(uv * 3.0 + direction * 2.0) * 0.5 + hash(uv * 8.0 + direction * 5.0) * 0.3) / 0.8;
}
vec4 effect(vec2 position) {
  vec4 color = content(position);
  vec3 rgb = color.a > 0.0 ? color.rgb / color.a : vec3(0.0);
  float gray = pow(dot(rgb, vec3(0.299, 0.587, 0.114)), 1.2);
  gray = smoothstep(0.08, 0.92, gray);
  gray += smoothstep(0.3, 0.5, gray) * (1.0 - smoothstep(0.5, 0.7, gray)) * 0.1;
  float texture_mask = smoothstep(0.5, 0.95, gray);
  gray += (paper_texture(position * 0.3) - 0.5) * 0.035 * texture_mask;
  gray += (directional_grain(position * 0.4) - 0.5) * 0.025 * texture_mask * 0.7;
  gray += (bayer(position) - 0.5) * 0.025 * texture_mask;
  gray *= 1.0 - smoothstep(0.4, 1.2, length(position / size - 0.5)) * 0.15;
  gray = clamp(gray, 0.0, 1.0);
  vec3 paper = vec3(0.94, 0.92, 0.86);
  float variation = hash(position * 0.08) * 0.02;
  paper += vec3(variation, variation * 0.5, -variation * 0.2);
  vec3 ink = mix(vec3(0.10, 0.10, 0.12), paper, gray);
  return vec4(mix(rgb, ink, amount) * color.a, color.a);
}`,
});
