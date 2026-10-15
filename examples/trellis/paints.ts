import { paintShader } from "proscenium";

/**
 * The wallpaper: TrellisWM's dark field of lime, green, teal and violet light,
 * laid over `screen` (its size, at `origin` in the node), brighter on the
 * Desktop (`desk`: x, y, width, height in the node) and dimmed around it, where
 * windows are docked, with a faint ring at the Desktop's edge. `amount` fades
 * it in.
 */
export const wallpaper = paintShader({
  uniforms: { amount: 1, screen: 2, origin: 2, desk: 4 },
  gate: "amount",
  source: `
float roundedBox(vec2 p, vec2 center, vec2 halfSize, float radius) {
  vec2 q = abs(p - center) - halfSize + radius;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
}

vec4 paint(vec2 position) {
  vec2 uv = (position - origin) / max(screen, vec2(1.0));
  vec3 color = vec3(0.039, 0.043, 0.039);
  // CSS's radial gradients, bottom first, each from its colour to clear at its stop.
  color = mix(color, vec3(0.239, 0.165, 0.439), clamp(1.0 - length((uv - vec2(0.62, 1.04)) / vec2(0.70, 0.90)) / 0.66, 0.0, 1.0));
  color = mix(color, vec3(0.047, 0.353, 0.369), clamp(1.0 - length((uv - vec2(0.88, 0.26)) / vec2(0.52, 0.72)) / 0.62, 0.0, 1.0));
  color = mix(color, vec3(0.173, 0.416, 0.090), clamp(1.0 - length((uv - vec2(0.12, 0.18)) / vec2(0.58, 0.80)) / 0.62, 0.0, 1.0));
  color = mix(color, vec3(0.710, 0.941, 0.408), 0.34 * clamp(1.0 - length((uv - vec2(0.38, 0.62)) / vec2(0.34, 0.46)) / 0.70, 0.0, 1.0));
  float edge = roundedBox(position, desk.xy + 0.5 * desk.zw, 0.5 * desk.zw, 12.0);
  float inside = 1.0 - smoothstep(-0.5, 0.5, edge);
  color *= mix(0.42, 1.25, inside);
  float ring = 1.0 - smoothstep(0.0, 1.5, abs(edge + 0.75));
  color = mix(color, vec3(1.0), 0.22 * ring * step(1.0, desk.z));
  return vec4(color, 1.0) * amount;
}`,
});
