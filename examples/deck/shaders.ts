/** The deck's shaders: the table's swirl of paint, and a card's foil and burn. */

import { effectShader, paintShader } from "proscenium";
import { noise } from "../lib/effects.js";

/** Swirling paint in red, blue and ink, in chunky pixels, after Balatro's table; it turns with `time`. */
export const paintSwirl = paintShader({
  reads: { time: true },
  opaque: {},
  source: `
vec4 paint(vec2 position) {
  vec2 cell = floor(position / 5.0) * 5.0;
  vec2 uv = (cell - 0.5 * size) / size.y;
  float t = time * 0.12;
  float reach = length(uv);
  float angle = atan(uv.y, uv.x) + 2.6 * reach - t;
  vec2 p = vec2(cos(angle), sin(angle)) * reach * 3.4;
  for (int i = 0; i < 5; i++) {
    p += 0.38 * vec2(sin(p.y * 1.7 + t * 1.9), cos(p.x * 1.3 - t * 1.4));
  }
  float paint = 0.5 + 0.5 * sin(p.x * 1.2 + p.y * 0.9);
  vec3 color = mix(vec3(0.0, 0.42, 0.62), vec3(0.87, 0.27, 0.23), smoothstep(0.42, 0.58, paint));
  float ink = 1.0 - smoothstep(0.02, 0.12, abs(paint - 0.5));
  color = mix(color, vec3(0.09, 0.13, 0.15), ink * 0.85);
  color *= 1.0 - 0.5 * dot(uv, uv);
  return vec4(color, 1.0);
}`,
});

/**
 * A card: a band of foil light that slides as the card leans (`light`, the lean
 * from -0.5 to 0.5), strong as `amount`; and burning away as `burn` goes from 0
 * to 1. `margin` is room for the card's shadow.
 */
export const cardFoil = effectShader({
  uniforms: { amount: 1, light: 2, burn: 1, margin: 1 },
  extent: { uniforms: { margin: 1 } },
  reads: { local: true },
  gate: ["amount", "burn"],
  source: `${noise}
vec4 effect(vec2 position) {
  vec4 color = content(position);
  vec2 uv = position / size;
  float band = dot(uv - 0.5 + light * 0.9, vec2(0.8, 0.6));
  float glint = exp(-band * band * 28.0) * amount;
  vec3 foil = 0.6 + 0.4 * cos(6.2832 * (0.7 * uv.x + 0.4 * uv.y + light.x) + vec3(0.0, 2.1, 4.2));
  color.rgb += glint * 0.4 * foil * color.a;
  float grain = noise(uv * vec2(24.0, 24.0 * size.y / size.x)) * 0.75 + noise(uv * 90.0) * 0.25;
  float threshold = burn * 1.15 - 0.075;
  float keep = smoothstep(threshold, threshold + 0.05, grain);
  float rim = keep * (1.0 - smoothstep(threshold + 0.05, threshold + 0.12, grain)) * step(0.001, burn);
  return vec4(color.rgb * keep + vec3(1.0, 0.55, 0.15) * rim * color.a, color.a * keep);
}`,
});
