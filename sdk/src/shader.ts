// Shaders: everything a node looks like beyond its own content.
//
// A shader is GLSL the compositor builds once, defined by id; nodes then use it
// in their `shaders`, with uniforms that animate like any prop. A paint draws
// over the node's box, under or over its content; a filter recolors the node's
// own pixels as they are drawn; an effect draws the node through a shader that
// reads it. Fills, borders, shadows, backdrop blur, dimming and the background
// grid are shaders of this module. See docs/SHADERS.md.

import { type Color, toWireColor } from "./color.js";
import { type Motion, wireMotion } from "./motion.js";
import { contentId, type Op, type WireProps, type WireValue } from "./protocol.js";

/** Left, top, right and bottom. */
export type Sides = readonly [number, number, number, number];

/** A float, vec2 or vec4 uniform; a color is a vec4 of straight (not premultiplied) RGBA. */
export type UniformValue = number | readonly [number, number]
  | readonly [number, number, number, number] | Color;

/** A uniform's component: its name for the first, or the uniform and which. */
export type UniformComponent = string | { uniform: string; component?: number };

/**
 * Four distances, one per side, linear in what a shader shows: `pad` local
 * units, `pixel` output pixels, `radius` times the node's corner radius, and
 * each uniform component's value, first raised to its `floor`, times its
 * coefficients (a number for every side, four sides, or a row of sides per
 * component). The compositor evaluates it every frame from the values on
 * screen, so what it bounds stays exactly as tight as the shader as it animates.
 */
export interface BoundForm {
  pad?: number | Sides;
  pixel?: number | Sides;
  radius?: number | Sides;
  uniforms?: Record<string, number | Sides | readonly Sides[]>;
  floor?: Record<string, number>;
}

/** A form, or up to four of them standing for the largest, side by side. */
export type Bound = BoundForm | readonly BoundForm[];

/** The node's box inset by `inset`, while every component of `when` is at least 1 (opaque) or at most 0 (hole). */
export interface Region {
  inset?: Bound;
  when?: UniformComponent | readonly UniformComponent[];
}

interface Definition {
  /** GLSL ES 1.0, the stage's entry point and what it needs. */
  source: string;
  /** Uniforms by name and number of values (1, 2 or 4), in declaration order. */
  uniforms?: Record<string, 1 | 2 | 4>;
  /**
   * Components of which at least one must be above zero for the shader to show
   * anything; while none is, it is skipped and costs nothing.
   */
  gate?: UniformComponent | readonly UniformComponent[];
}

/**
 * A paint defines `vec4 paint(vec2 position)`, the premultiplied color at a
 * point in the node's local units, drawn over its box grown by `extent`. It
 * reads `size` (the box), `radius` (its corner radius), `pixel` (local units per
 * output pixel), its uniforms, and what `reads` asks for. Drawn with every
 * uniform at zero, it should show nothing: that is where a paint added to a
 * shown node fades in from, and where a removed one fades out to.
 */
export interface PaintDefinition extends Definition {
  reads?: {
    /** `time`, the seconds its clock has run; while it runs the output repaints every frame. */
    time?: boolean;
    /** `pointer`, in local units; the output repaints it as the pointer moves. */
    pointer?: boolean;
    /** `backdrop(position)`: what is drawn behind, blurred by the `blur` uniform's local units. */
    backdrop?: boolean | { blur: string };
  };
  /** How far it draws beyond the box. Pixels outside it are never shaded. */
  extent?: Bound;
  /** Where it is fully opaque, so what it hides is never drawn. */
  opaque?: Region;
  /** Where it draws nothing: a border is drawn, and repaints, as a ring. */
  hole?: Region;
}

/**
 * A filter defines `vec4 filter(vec4 color, vec2 position)`: the node's own
 * premultiplied color at a point, as its window, page, image or text draws it,
 * to what it shows instead. It reads `size`, `radius`, `pixel`, its uniforms,
 * and `time` and `pointer` when it asks.
 */
export interface FilterDefinition extends Definition {
  reads?: { time?: boolean; pointer?: boolean };
  /** Opaque pixels stay opaque through it, always or while `when` holds. */
  opaque?: true | { when?: UniformComponent | readonly UniformComponent[] };
}

/**
 * An effect defines `vec4 effect(vec2 position)`, drawing the node and its
 * children, rendered offscreen first, with `content(position)`; with
 * `backdrop`, `backdrop(position)` is what is behind it. It reads `size`,
 * `radius`, `pixel`, its uniforms, and `time` and `pointer` when it asks.
 */
export interface EffectDefinition extends Definition {
  reads?: {
    time?: boolean;
    pointer?: boolean;
    backdrop?: boolean;
    /** It reads `content` only at its own position, so changes repaint only where they are. */
    local?: boolean;
  };
  /** Room around the box it draws into, e.g. for a glow or a ripple. */
  extent?: Bound;
}

export type ShaderStage = "paint" | "filter" | "effect";

export interface Shader<Stage extends ShaderStage = ShaderStage> {
  /** Derived from the definition: equal definitions share one program. */
  readonly id: string;
  readonly stage: Stage;
  /** The commit op defining it. */
  readonly op: Op;
}

/** A node's use of a shader, in its `shaders`. */
export interface Shading {
  /**
   * Names the use on its node: across renders and remounts its values animate
   * on from there. The decoration props use "box", "shadow", "blur", "dim" and
   * "plane".
   */
  id: string;
  shader: Shader;
  /** Values by name; uniforms left out are 0. */
  uniforms?: Record<string, UniformValue>;
  /** A paint's place: under the node's content (the default) or over it; either way under its children. */
  layer?: "under" | "over";
  /** A paint's or effect's: the node's box, or the whole output, positions then in output pixels. */
  area?: "box" | "output";
  /** Whether its clock runs, for a shader reading `time`; stopped, `time` holds. */
  time?: boolean;
  /** How its uniforms animate: one motion, or motions by uniform and a `default`. */
  transition?: Motion | ({ default?: Motion } & { [uniform: string]: Motion | undefined });
}

function wireComponent(component: UniformComponent): WireProps {
  return typeof component === "string" ? { uniform: component } : { ...component };
}

function wireComponents(value: UniformComponent | readonly UniformComponent[]): WireValue {
  return Array.isArray(value)
    ? (value as readonly UniformComponent[]).map(wireComponent)
    : wireComponent(value as UniformComponent);
}

function copy(value: unknown): WireValue {
  return JSON.parse(JSON.stringify(value)) as WireValue;
}

function wireRegion(region: Region): WireProps {
  const out: WireProps = {};
  if (region.inset) out.inset = copy(region.inset);
  if (region.when !== undefined) out.when = wireComponents(region.when);
  return out;
}

const shaders = new Map<string, Shader>();

function define<Stage extends ShaderStage>(stage: Stage, definition: PaintDefinition | FilterDefinition
  | EffectDefinition): Shader<Stage> {
  const body: WireProps = { stage, source: definition.source, uniforms: { ...definition.uniforms } };
  if (definition.reads) body.reads = copy(definition.reads);
  if (definition.gate !== undefined) body.gate = wireComponents(definition.gate);
  if ("extent" in definition && definition.extent) body.extent = copy(definition.extent);
  if ("hole" in definition && definition.hole) body.hole = wireRegion(definition.hole);
  const opaque = (definition as { opaque?: true | Region }).opaque;
  if (opaque) body.opaque = opaque === true ? {} : wireRegion(opaque);
  const content = JSON.stringify(body);
  const id = `s${contentId(content)}${content.length.toString(36)}`;
  const known = shaders.get(id);
  if (known) return known as Shader<Stage>;
  const shader: Shader<Stage> = Object.freeze({ id, stage, op: { op: "shader", id, ...body } as Op });
  shaders.set(id, shader);
  return shader;
}

/** A paint: drawn over a node's box, under or over its content. */
export function paintShader(definition: PaintDefinition): Shader<"paint"> {
  return define("paint", definition);
}

/** A filter: recolors a node's own pixels as they are drawn. A node takes one. */
export function filterShader(definition: FilterDefinition): Shader<"filter"> {
  return define("filter", definition);
}

/** An effect: draws a node and its children through a shader reading them. A node takes one. */
export function effectShader(definition: EffectDefinition): Shader<"effect"> {
  return define("effect", definition);
}

/**
 * Ops defining the shaders OPS use that the compositor has not been sent yet,
 * by SENT, to go first in their commit.
 */
export function shaderOps(ops: readonly Op[], sent: Set<string>): Op[] {
  const defines: Op[] = [];
  for (const op of ops) {
    if ((op.op !== "create" && op.op !== "set") || !Array.isArray(op.props.shaders)) continue;
    for (const shading of op.props.shaders as WireProps[]) {
      const id = shading.shader as string;
      if (sent.has(id)) continue;
      const shader = shaders.get(id);
      if (!shader) continue;
      sent.add(id);
      defines.push(shader.op);
    }
  }
  return defines;
}

/** A uniform's wire value: a color (a string, or three numbers) becomes a vec4. */
export function wireUniform(value: UniformValue): WireValue {
  return typeof value === "number" ? value
    : typeof value === "string" || value.length === 3 ? toWireColor(value as Color)
    : [...(value as readonly number[])];
}

export function wireUniforms(uniforms: Record<string, UniformValue>): WireProps {
  const out: WireProps = {};
  for (const [name, value] of Object.entries(uniforms)) out[name] = wireUniform(value);
  return out;
}

/** A use's transition on the wire: one motion, or motions by uniform. */
function wireShadingMotion(motion: Shading["transition"]): WireValue | undefined {
  if (!motion) return undefined;
  if ("type" in motion) return wireMotion(motion as Motion);
  const out: WireProps = {};
  for (const [name, part] of Object.entries(motion)) if (part) out[name] = wireMotion(part);
  return Object.keys(out).length ? out : undefined;
}

/** The wire form of SHADING, moving with MOTION unless it has its own transition. */
export function wireShading(shading: Shading, motion?: Motion): WireProps {
  const out: WireProps = { id: shading.id, shader: shading.shader.id };
  if (shading.uniforms) out.uniforms = wireUniforms(shading.uniforms);
  if (shading.layer === "over") out.layer = "over";
  if (shading.area === "output") out.area = "output";
  if (shading.time === false) out.time = false;
  const transition = wireShadingMotion(shading.transition ?? motion);
  if (transition) out.transition = transition;
  return out;
}

/* The standard library. */

const BOX_DISTANCE = `
float box_distance(vec2 point, vec2 half_size, float corner) {
  vec2 q = abs(point) - half_size + corner;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - corner;
}
`;

/*
 * Where the fill shows whole, which is also where a box without a fill draws
 * nothing: the inside of the border, inset from the box's corners by the most a
 * rounded corner (at least 0.29 of its radius) reaches into the inscribed
 * rectangle, and a pixel for the antialiased edge.
 */
const BOX_INSIDE: Bound = [
  { uniforms: { border: 1, outset: -1 }, pixel: 1 },
  { uniforms: { border: 0.7, outset: -0.7 }, radius: 0.3, pixel: 1 },
];

/**
 * A rounded box's fill and border, each a color or a two-stop linear gradient
 * at an angle in radians, 0 running left to right. The box is the node's grown
 * by `outset`, its corners too, and the border runs `border` wide along its
 * inside edge: a window's border lies outside its content with `outset` equal
 * to `border`.
 */
export const boxPaint = paintShader({
  uniforms: {
    fill: 4, fillEnd: 4, fillAngle: 1, border: 1, borderColor: 4, borderColorEnd: 4,
    borderAngle: 1, outset: 1,
  },
  extent: { uniforms: { outset: 1 }, pixel: 1 },
  opaque: { inset: BOX_INSIDE, when: [{ uniform: "fill", component: 3 }, { uniform: "fillEnd", component: 3 }] },
  hole: { inset: BOX_INSIDE, when: [{ uniform: "fill", component: 3 }, { uniform: "fillEnd", component: 3 }] },
  gate: [{ uniform: "fill", component: 3 }, { uniform: "fillEnd", component: 3 }, "border"],
  source: `${BOX_DISTANCE}
float box_gradient(vec2 point, vec2 half_size, float angle) {
  vec2 direction = vec2(cos(angle), sin(angle));
  float reach = abs(half_size.x * direction.x) + abs(half_size.y * direction.y);
  return clamp(0.5 + 0.5 * dot(point, direction) / max(reach, 1e-4), 0.0, 1.0);
}
vec4 box_paint(vec4 start, vec4 end, float angle, vec2 point, vec2 half_size) {
  vec4 color = vec4(start.rgb * start.a, start.a);
  if (end == start) return color;
  return mix(color, vec4(end.rgb * end.a, end.a), box_gradient(point, half_size, angle));
}
vec4 paint(vec2 position) {
  vec2 half_size = size * 0.5 + outset;
  vec2 point = position - size * 0.5;
  float corner = min(radius + outset, min(half_size.x, half_size.y));
  float distance = box_distance(point, half_size, corner);
  float outer = clamp(0.5 - distance / pixel, 0.0, 1.0);
  float inner = clamp(0.5 - (distance + border) / pixel, 0.0, 1.0);
  vec4 inside = inner > 0.0 ? box_paint(fill, fillEnd, fillAngle, point, half_size) : vec4(0.0);
  vec4 edge = outer > inner
    ? box_paint(borderColor, borderColorEnd, borderAngle, point, half_size) : vec4(0.0);
  return inside * inner + edge * (outer - inner);
}
`,
});

/**
 * A drop shadow under a rounded box, the Gaussian of the box offset by `x`, `y`
 * and grown by `spread`: after Evan Wallace, "Fast Rounded Rectangle Shadows"
 * (public domain), exact along X with four samples along Y. Deep inside the box
 * the Gaussian lies wholly within it and the shadow is full, as under a
 * translucent window, where integrating would cost the most.
 */
export const boxShadow = paintShader({
  uniforms: { color: 4, blur: 1, spread: 1, x: 1, y: 1 },
  // Three standard deviations (a sigma is half the blur) beyond the grown, offset box;
  // a pixel and a half for the antialiased edge of a shadow hardly blurred.
  extent: {
    uniforms: { blur: [1.5, 1.5, 1.5, 1.5], spread: [1, 1, 1, 1], x: [-1, 0, 1, 0], y: [0, -1, 0, 1] },
    floor: { blur: 1 },
  },
  gate: { uniform: "color", component: 3 },
  source: `
float shadow_gaussian(float x, float sigma) {
  return exp(-(x * x) / (2.0 * sigma * sigma)) / (2.5066282746 * sigma);
}
vec2 shadow_erf(vec2 x) {
  vec2 s = sign(x);
  vec2 a = abs(x);
  x = 1.0 + (0.278393 + (0.230389 + 0.078108 * (a * a)) * a) * a;
  x *= x;
  return s - s / (x * x);
}
float shadow_row(float x, float y, float sigma, float corner, vec2 half_size) {
  float delta = min(half_size.y - corner - abs(y), 0.0);
  float curved = half_size.x - corner + sqrt(max(0.0, corner * corner - delta * delta));
  vec2 integral = 0.5 + 0.5 * shadow_erf((x + vec2(-curved, curved)) * (0.70710678 / sigma));
  return integral.y - integral.x;
}
vec4 paint(vec2 position) {
  vec4 tint = vec4(color.rgb * color.a, color.a);
  vec2 half_size = size * 0.5 + spread;
  if (half_size.x <= 0.0 || half_size.y <= 0.0) return vec4(0.0);
  vec2 point = position - size * 0.5 - vec2(x, y);
  float sigma = max(blur * 0.5, 0.5 * pixel);
  float corner = min(max(radius + spread, 0.0), min(half_size.x, half_size.y));
  if (all(lessThan(abs(point), half_size - corner - 3.0 * sigma))) return tint;
  float start = clamp(-3.0 * sigma, point.y - half_size.y, point.y + half_size.y);
  float end = clamp(3.0 * sigma, point.y - half_size.y, point.y + half_size.y);
  float stride = (end - start) / 4.0;
  float row = start + stride * 0.5;
  float value = 0.0;
  for (int i = 0; i < 4; i++) {
    value += shadow_row(point.x, point.y - row, sigma, corner, half_size) * shadow_gaussian(row, sigma) * stride;
    row += stride;
  }
  return tint * value;
}
`,
});

/** Frosted glass: what is drawn behind the rounded box, blurred by `blur` local units. */
export const backdropBlur = paintShader({
  uniforms: { blur: 1 },
  reads: { backdrop: { blur: "blur" } },
  gate: "blur",
  source: `${BOX_DISTANCE}
vec4 paint(vec2 position) {
  vec2 half_size = size * 0.5;
  float corner = min(radius, min(half_size.x, half_size.y));
  float coverage = clamp(0.5 - box_distance(position - half_size, half_size, corner) / pixel, 0.0, 1.0);
  return vec4(backdrop(position).rgb, 1.0) * coverage;
}
`,
});

/** Darkens a node's content by `amount`, 0 to 1, e.g. an inactive window's. */
export const dimFilter = filterShader({
  uniforms: { amount: 1 },
  gate: "amount",
  opaque: true,
  source: `
vec4 filter(vec4 color, vec2 position) {
  return vec4(color.rgb * (1.0 - clamp(amount, 0.0, 1.0)), color.a);
}
`,
});

/**
 * A background's plane: `color` under a grid in `gridColor` of dots, or with
 * `lines` of lines, `spacing` units apart and `weight` output pixels thick,
 * which fades out where it would become a dense texture.
 */
export const planePaint = paintShader({
  uniforms: { color: 4, gridColor: 4, spacing: 1, weight: 1, lines: 1 },
  gate: [{ uniform: "color", component: 3 }, { uniform: "gridColor", component: 3 }],
  opaque: { when: { uniform: "color", component: 3 } },
  source: `
vec4 paint(vec2 position) {
  float gap = max(spacing, 1e-3);
  vec2 cell = abs(fract(position / gap + 0.5) - 0.5) * gap / pixel;
  float distance = lines > 0.5 ? min(cell.x, cell.y) : length(cell);
  float coverage = clamp(weight + 0.5 - distance, 0.0, 1.0) * smoothstep(4.0, 12.0, gap / pixel);
  vec4 grid = vec4(gridColor.rgb * gridColor.a, gridColor.a) * coverage;
  return grid + vec4(color.rgb * color.a, color.a) * (1.0 - grid.a);
}
`,
});
