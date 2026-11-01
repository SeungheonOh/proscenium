/**
 * Thermoptic camouflage as a window's opening and closing, after Ghost in the
 * Shell. Closing, the whole window turns at once into what is behind it, bent by
 * a rippling refraction that splits a little into colours, its outline and the
 * edges of what it showed glinting faintly; then the ripple settles and nothing
 * is left. Its shadow fades as the cloak takes hold. Opening plays it backwards:
 * the window uncloaks out of what is behind it.
 *
 * `amount` runs the whole of it, 0 to 1, and is its clock too: the ripple moves
 * as it rises, so the effect needs no `time` and costs nothing while it rests.
 */
import { effectShader, tween } from "proscenium";
import { noise } from "../lib/effects.js";

/** Seconds the cloak takes, either way. */
export const cloakDuration = 1.1;

const camo = effectShader({
  uniforms: { amount: 1, margin: 1 },
  extent: { uniforms: { margin: 1 } },
  reads: { backdrop: true },
  gate: "amount",
  source: `${noise}
float rounded_box(vec2 p, vec2 half_size, float r) {
  vec2 q = abs(p) - half_size + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}
float lightness(vec2 p) {
  return dot(content(p).rgb, vec3(0.299, 0.587, 0.114));
}
vec4 effect(vec2 position) {
  vec4 color = content(position);
  vec2 half_size = size * 0.5;
  float d = rounded_box(position - half_size, half_size, min(radius, min(half_size.x, half_size.y)));
  float inside = clamp(0.5 - d / pixel, 0.0, 1.0);

  // The whole window cloaks at once, then the cloak settles into nothing.
  float cloaked = smoothstep(0.0, 0.55, amount);
  float settle = smoothstep(0.6, 1.0, amount);

  // The cloak bends what is behind like rippled glass, most along the window's outline.
  float phase = amount * 6.0;
  vec2 ripple = vec2(noise(position / 46.0 + vec2(phase, 0.0)), noise(position / 46.0 + vec2(13.7, -phase))) - 0.5;
  float rim = exp(-abs(d) / (10.0 * pixel));
  vec2 bend = ripple * (14.0 + 26.0 * rim) * pixel * (1.0 - settle);
  vec3 behind = vec3(backdrop(position + bend * 1.08).r, backdrop(position + bend).g, backdrop(position + bend * 0.92).b);
  // What the window showed lingers as a faint shimmer of its edges.
  float e = 2.0 * pixel;
  float edge = length(vec2(lightness(position + vec2(e, 0.0)) - lightness(position - vec2(e, 0.0)),
                           lightness(position + vec2(0.0, e)) - lightness(position - vec2(0.0, e))));
  vec3 shimmer = vec3(0.55, 0.85, 1.0) * (edge * 0.6 + rim * 0.25);
  vec4 cloak = vec4(behind + shimmer, 1.0) * color.a * (1.0 - settle);

  vec4 body = mix(color, cloak, cloaked);
  // Its shadow goes as the cloak takes hold.
  vec4 shadow = color * (1.0 - cloaked);
  return mix(shadow, body, inside);
}`,
});

/**
 * Uncloaking as a window opens and cloaking away as it closes, with MARGIN for
 * what it draws beyond its box (its shadow): its use of the effect, and the
 * `shaders` its `initial` and `exit` take.
 */
export function cloak(margin: number) {
  return {
    use: { id: "camo", shader: camo, uniforms: { amount: 0, margin }, transition: tween(cloakDuration, "ease-in-out") },
    cloaked: { camo: { amount: 1 } },
  };
}
