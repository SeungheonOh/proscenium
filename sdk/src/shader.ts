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
 * reads `size` (the box), `radius` (its corner radius, the largest of four),
 * `radii` (its corners: top-left, top-right, bottom-right, bottom-left), `pixel` (local units per
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
    /** `to_output(p)`, `from_output(p)` and `output_size`: where the node lies on its output. */
    output?: boolean;
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
  reads?: { time?: boolean; pointer?: boolean; output?: boolean };
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
    /** `to_output(p)`, `from_output(p)` and `output_size`: where the node lies on its output. */
    output?: boolean;
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
  for (const name of Object.keys(uniforms)) out[name] = wireUniform(uniforms[name]!);
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

/*
 * GLSL the standard shaders share. Corners come one by one from the prelude's `radii`
 * (top-left, top-right, bottom-right, bottom-left, as CSS border-radius lists them); the
 * corner a point sees is that of its quadrant of the box. A shader drawing every corner
 * alike reads `radius` instead, which a batched paint passes in one float rather than
 * four: the common box stays as cheap as it was.
 */
const BOX_DISTANCE = `
float box_distance(vec2 point, vec2 half_size, float corner) {
  vec2 q = abs(point) - half_size + corner;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - corner;
}
`;
const BOX_CORNER = `
float box_corner(vec2 point, vec4 corners) {
  return point.x < 0.0 ? (point.y < 0.0 ? corners.x : corners.w)
                       : (point.y < 0.0 ? corners.y : corners.z);
}
`;

/** The GLSL of a point's corner radius: its own with CORNERS, else the node's one. */
const cornerOf = (corners: boolean | undefined, point: string) =>
  corners ? `box_corner(${point}, radii)` : "radius";

/*
 * Noise of a buffer pixel, -1 to 1 with a triangular distribution: the sum of two of Dave
 * Hoskins' hashes ("Hash without Sine", MIT), less one. Added to a gradient's color in
 * 8-bit steps, it keeps a long, gentle gradient from banding. Unlike interleaved gradient
 * noise, whose lines along a fixed angle show over a wide, flat gradient, it has no
 * structure along any axis, and the triangular distribution keeps its brightness
 * unrelated to the gradient's. It depends only on the pixel, so a repaint draws what a
 * full redraw does.
 */
const DITHER = `
float box_hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float box_dither() {
  vec2 p = gl_FragCoord.xy;
  return box_hash(p) + box_hash(p + vec2(57.31, 113.97)) - 1.0;
}
`;

/** What a box paint, shadow or blur draws beyond the plain one: each its own program. */
export interface BoxFeatures {
  /** Corners of their own: the node's `radius` of four. */
  corners?: boolean;
  /** Border sides of their own widths (`borderTrim`). */
  sides?: boolean;
  /** A dashed border (`dash`). */
  dash?: boolean;
}

function variant<T>(cache: Map<string, T>, features: BoxFeatures, make: () => T): T {
  const key = `${features.corners ? "c" : ""}${features.sides ? "s" : ""}${features.dash ? "d" : ""}`;
  let shader = cache.get(key);
  if (!shader) cache.set(key, shader = make());
  return shader;
}

/*
 * Where a box without a fill draws nothing: the inside of the border, its widest side
 * less what each side is thinner by
 * (`borderTrim`), inset from the box's corners by the most a rounded corner (at least
 * 0.29 of its radius) reaches into the inscribed rectangle, and two pixels: one for the
 * antialiased edge, one for a border under a pixel drawn a pixel wide.
 */
const TRIM: readonly Sides[] = [[-1, 0, 0, 0], [0, -1, 0, 0], [0, 0, -1, 0], [0, 0, 0, -1]];
const boxInside = (sides: boolean | undefined): Bound => [
  { uniforms: { border: 1, outset: -1, ...sides ? { borderTrim: TRIM } : {} }, pixel: 2 },
  { uniforms: { border: 0.7, outset: -0.7,
                ...sides ? { borderTrim: TRIM.map((row) => row.map((v) => v * 0.7) as unknown as Sides) } : {} },
    radius: 0.3, pixel: 2 },
];

/*
 * Where an opaque fill covers: the box, grown by `outset`, inset by the most its rounded
 * corners (at least 0.29 of their radius) reach into the inscribed rectangle and a pixel
 * for the antialiased edge. The fill runs under the border, as CSS paints a background
 * to the border box, so a border over it never lets through what lies behind.
 */
const BOX_COVER: Bound = [
  { uniforms: { outset: -1 }, pixel: 1 },
  { uniforms: { outset: -0.7 }, radius: 0.3, pixel: 1 },
];

const boxPaints = new Map<string, Shader<"paint">>();

/**
 * A rounded box's fill and border, each a color or a two-stop linear gradient at an
 * angle in radians, 0 running left to right, interpolated as CSS does by default. The
 * box is the node's grown by `outset`, its corners too, and the border runs along its
 * inside edge, `border` wide, over the fill, which reaches under it to the box's edge
 * (CSS `background-clip: border-box`): a window's border lies outside its content with
 * `outset` equal to `border`. Border widths snap to whole output pixels, at least one, as
 * browsers draw them. Its FEATURES add corners of their own; sides thinner than `border`
 * by `borderTrim` (left, top, right, bottom); and with `dash`, dashes `dash` long with
 * gaps as long, fitted to the outline (its straight sides and corner arcs) so they meet
 * where they start, as SVG dashes a closed path.
 */
export function boxPaintWith(features: BoxFeatures): Shader<"paint"> {
  return variant(boxPaints, features, () => {
    const { corners, sides, dash } = features;
    const when = [{ uniform: "fill", component: 3 }, { uniform: "fillEnd", component: 3 }];
    return paintShader({
      uniforms: {
        fill: 4, fillEnd: 4, fillAngle: 1, border: 1, ...sides ? { borderTrim: 4 } : {}, borderColor: 4,
        borderColorEnd: 4, borderAngle: 1, outset: 1, ...dash ? { dash: 1 } : {},
      },
      extent: { uniforms: { outset: 1 }, pixel: 1 },
      opaque: { inset: BOX_COVER, when },
      hole: { inset: boxInside(sides), when },
      gate: [...when, "border"],
      source: `${BOX_DISTANCE}${corners ? BOX_CORNER : ""}${DITHER}
float box_gradient(vec2 point, vec2 half_size, float angle) {
  vec2 direction = vec2(cos(angle), sin(angle));
  float reach = abs(half_size.x * direction.x) + abs(half_size.y * direction.y);
  return clamp(0.5 + 0.5 * dot(point, direction) / max(reach, 1e-4), 0.0, 1.0);
}
vec4 box_paint(vec4 start, vec4 end, float angle, vec2 point, vec2 half_size) {
  vec4 color = vec4(start.rgb * start.a, start.a);
  if (end == start) return color;
  color = mix(color, vec4(end.rgb * end.a, end.a), box_gradient(point, half_size, angle));
  return vec4(color.rgb + box_dither() / 255.0 * color.a, color.a);
}
float box_width(float width) {
  return width > 0.0 ? max(1.0, floor(width / pixel + 0.01)) * pixel : 0.0;
}
${dash ? `float box_dash(vec2 point, vec2 half_size, vec4 corners, float corner) {
  float quarter = 1.5707963;
  float top = 2.0 * half_size.x - corners.x - corners.y;
  float right = 2.0 * half_size.y - corners.y - corners.z;
  float bottom = 2.0 * half_size.x - corners.z - corners.w;
  float left = 2.0 * half_size.y - corners.w - corners.x;
  vec4 arcs = corners * quarter;
  float total = top + right + bottom + left + arcs.x + arcs.y + arcs.z + arcs.w;
  // Where the point lies along the outline, clockwise from the top side's start.
  vec2 side = vec2(point.x < 0.0 ? -1.0 : 1.0, point.y < 0.0 ? -1.0 : 1.0);
  vec2 from_center = point - side * (half_size - corner);
  float along;
  if (corner > 0.0 && from_center.x * side.x > 0.0 && from_center.y * side.y > 0.0) {
    float turned = atan(abs(from_center.y), abs(from_center.x)) / quarter;
    if (side.y < 0.0 && side.x > 0.0) along = top + arcs.y * (1.0 - turned);
    else if (side.x > 0.0) along = top + arcs.y + right + arcs.z * turned;
    else if (side.y > 0.0) along = top + arcs.y + right + arcs.z + bottom + arcs.w * (1.0 - turned);
    else along = total - arcs.x * (1.0 - turned);
  } else if (half_size.x - abs(point.x) < half_size.y - abs(point.y)) {
    along = side.x > 0.0 ? top + arcs.y + point.y + half_size.y - corners.y
                         : top + arcs.y + right + arcs.z + bottom + arcs.w + half_size.y - corners.w - point.y;
  } else {
    along = side.y < 0.0 ? point.x + half_size.x - corners.x
                         : top + arcs.y + right + arcs.z + half_size.x - corners.z - point.x;
  }
  float period = total / max(1.0, floor(total / (2.0 * dash) + 0.5));
  float phase = abs(fract(along / period) - 0.5) - 0.25;
  return clamp(0.5 + phase * period / pixel, 0.0, 1.0);
}` : ""}
vec4 paint(vec2 position) {
  vec2 half_size = size * 0.5 + outset;
  vec2 point = position - size * 0.5;
  float corner = min(${cornerOf(corners, "point")} + outset, min(half_size.x, half_size.y));
  float distance = box_distance(point, half_size, corner);
  float outer = clamp(0.5 - distance / pixel, 0.0, 1.0);
  if (outer <= 0.0) return vec4(0.0);
  float inner = clamp(0.5 - (distance + box_width(border)) / pixel, 0.0, 1.0);
${sides ? `  if (borderTrim != vec4(0.0)) {
    vec4 widths = vec4(box_width(border - borderTrim.x), box_width(border - borderTrim.y),
                       box_width(border - borderTrim.z), box_width(border - borderTrim.w));
    vec2 inner_half = half_size - 0.5 * (widths.xy + widths.zw);
    vec2 inner_point = point - 0.5 * (widths.xy - widths.zw);
    float inner_corner = max(0.0, corner - max(point.x < 0.0 ? widths.x : widths.z,
                                               point.y < 0.0 ? widths.y : widths.w));
    inner = inner_half.x > 0.0 && inner_half.y > 0.0
      ? clamp(0.5 - box_distance(inner_point, inner_half,
                                 min(inner_corner, min(inner_half.x, inner_half.y))) / pixel, 0.0, 1.0)
      : 0.0;
    inner = min(inner, outer);
  }
` : ""}  vec4 inside = box_paint(fill, fillEnd, fillAngle, point, half_size);
  float edge = outer - inner;
${dash ? `  if (edge > 0.0 && dash > 0.0) {
    vec4 corners = min(${corners ? "radii" : "vec4(radius)"} + outset, min(half_size.x, half_size.y));
    edge *= box_dash(point, half_size, corners, corner);
  }
` : ""}  vec4 line = edge > 0.0
    ? box_paint(borderColor, borderColorEnd, borderAngle, point, half_size) : vec4(0.0);
  line *= edge;
  return line + inside * (outer * (1.0 - line.a));
}
`,
    });
  });
}

/** The plain box paint: one radius for every corner, one border width, solid. */
export const boxPaint = boxPaintWith({});

/*
 * The Gaussian blur of a rounded box, 0 to 1: Evan Wallace's "Fast Rounded Rectangle
 * Shadows" (public domain), exact along X with four samples along Y, its rows taking the
 * left and right corners of their half of the box.
 */
const SHADOW = `
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
float shadow_row(float x, float y, float sigma, vec4 corners, vec2 half_size) {
  float left = y < 0.0 ? corners.x : corners.w, right = y < 0.0 ? corners.y : corners.z;
  float left_delta = min(half_size.y - left - abs(y), 0.0);
  float right_delta = min(half_size.y - right - abs(y), 0.0);
  float to_left = half_size.x - left + sqrt(max(0.0, left * left - left_delta * left_delta));
  float to_right = half_size.x - right + sqrt(max(0.0, right * right - right_delta * right_delta));
  vec2 integral = 0.5 + 0.5 * shadow_erf((x + vec2(-to_right, to_left)) * (0.70710678 / sigma));
  return integral.y - integral.x;
}
float shadow_coverage(vec2 point, vec2 half_size, vec4 corners, float sigma) {
  float largest = max(max(corners.x, corners.y), max(corners.z, corners.w));
  if (all(lessThan(abs(point), half_size - largest - 3.0 * sigma))) return 1.0;
  float start = clamp(-3.0 * sigma, point.y - half_size.y, point.y + half_size.y);
  float end = clamp(3.0 * sigma, point.y - half_size.y, point.y + half_size.y);
  float stride = (end - start) / 4.0;
  float row = start + stride * 0.5;
  float value = 0.0;
  for (int i = 0; i < 4; i++) {
    value += shadow_row(point.x, point.y - row, sigma, corners, half_size) * shadow_gaussian(row, sigma) * stride;
    row += stride;
  }
  return value;
}
`;

const boxShadows = new Map<string, Shader<"paint">>();

/**
 * A drop shadow under a rounded box, as CSS `box-shadow`: the Gaussian of the box offset
 * by `x`, `y` and grown by `spread` (shrunk, when negative), its corners with it. As CSS
 * clips an outer shadow out of the border box, it draws nothing inside the node's own
 * rounded box, so a translucent box never shows its own shadow, and its middle is a hole:
 * the shadow is drawn, and repainted, as a ring. With `corners` in its FEATURES, the box's
 * corners are its own.
 */
export function boxShadowWith(features: BoxFeatures): Shader<"paint"> {
  return variant(boxShadows, { corners: features.corners }, () => paintShader({
    uniforms: { color: 4, blur: 1, spread: 1, x: 1, y: 1 },
    // Three standard deviations (a sigma is half the blur) beyond the grown, offset box;
    // a pixel and a half for the antialiased edge of a shadow hardly blurred.
    extent: {
      uniforms: { blur: [1.5, 1.5, 1.5, 1.5], spread: [1, 1, 1, 1], x: [-1, 0, 1, 0], y: [0, -1, 0, 1] },
      floor: { blur: 1 },
    },
    // Inside the box, less what its corners round away and a pixel for its edge.
    hole: { inset: { radius: 0.3, pixel: 1 } },
    gate: { uniform: "color", component: 3 },
    source: `${BOX_DISTANCE}${features.corners ? BOX_CORNER : ""}${SHADOW}
vec4 paint(vec2 position) {
  vec4 tint = vec4(color.rgb * color.a, color.a);
  vec2 half_size = size * 0.5 + spread;
  if (half_size.x <= 0.0 || half_size.y <= 0.0) return vec4(0.0);
  vec2 half_box = size * 0.5;
  vec2 from_middle = position - half_box;
  float own = min(${cornerOf(features.corners, "from_middle")}, min(half_box.x, half_box.y));
  float outside = clamp(0.5 + box_distance(from_middle, half_box, own) / pixel, 0.0, 1.0);
  if (outside <= 0.0) return vec4(0.0);
  tint *= outside;
  vec2 point = position - size * 0.5 - vec2(x, y);
  float sigma = max(blur * 0.5, 0.5 * pixel);
  vec4 corners = min(max(${features.corners ? "radii" : "vec4(radius)"} + spread, 0.0),
                     min(half_size.x, half_size.y));
  return tint * shadow_coverage(point, half_size, corners, sigma);
}
`,
  }));
}

/** The plain drop shadow: one radius for every corner. */
export const boxShadow = boxShadowWith({});

/**
 * An inner shadow, as CSS `box-shadow: inset`: inside the rounded box, the shadow the
 * box's edge casts onto it, offset by `x`, `y` and reaching `spread` further in. Its
 * middle, beyond the blur, draws nothing and is never shaded: the shadow is a ring.
 */
export const boxInsetShadow = paintShader({
  uniforms: { color: 4, blur: 1, spread: 1, x: 1, y: 1 },
  extent: { pixel: 1 },
  // The box the edge's shadow falls from is the node's shrunk by `spread` and offset;
  // three sigmas inside it, and inside its rounded corners, the shadow is gone.
  hole: {
    inset: {
      uniforms: { blur: [1.5, 1.5, 1.5, 1.5], spread: [1, 1, 1, 1], x: [1, 0, -1, 0], y: [0, 1, 0, -1] },
      floor: { blur: 1 }, radius: 0.3, pixel: 1,
    },
  },
  gate: { uniform: "color", component: 3 },
  source: `${BOX_DISTANCE}${BOX_CORNER}${SHADOW}
vec4 paint(vec2 position) {
  vec2 half_box = size * 0.5;
  vec2 point = position - half_box;
  float corner = min(box_corner(point, radii), min(half_box.x, half_box.y));
  float inside = clamp(0.5 - box_distance(point, half_box, corner) / pixel, 0.0, 1.0);
  if (inside <= 0.0) return vec4(0.0);
  vec2 half_size = half_box - spread;
  float lit = 0.0;
  if (half_size.x > 0.0 && half_size.y > 0.0) {
    float sigma = max(blur * 0.5, 0.5 * pixel);
    vec4 corners = min(max(radii - spread, 0.0), min(half_size.x, half_size.y));
    lit = shadow_coverage(point - vec2(x, y), half_size, corners, sigma);
  }
  return vec4(color.rgb * color.a, color.a) * ((1.0 - lit) * inside);
}
`,
});

/**
 * A gradient of up to four stops filling the rounded box, as CSS
 * `linear-gradient(in oklab, …)` or `radial-gradient(in oklab, …)`: colors `color0` to
 * `color3` are Oklab (L, a, b) with straight alpha, at `stops` (0 to 1, rising), and
 * interpolate in Oklab, premultiplied, then dither. A linear one (`shape` 0) runs at
 * `angle` radians, 0 left to right, over the CSS gradient line; a radial one (`shape` 1)
 * is a circle about `center` (a fraction of the box) reaching its farthest corner.
 * Fewer stops repeat the last.
 */
export const gradientPaint = paintShader({
  uniforms: { color0: 4, color1: 4, color2: 4, color3: 4, stops: 4, angle: 1, shape: 1, center: 2 },
  extent: { pixel: 1 },
  opaque: {
    inset: { radius: 0.3, pixel: 1 },
    when: [0, 1, 2, 3].map((k) => ({ uniform: `color${k}`, component: 3 })),
  },
  gate: [0, 1, 2, 3].map((k) => ({ uniform: `color${k}`, component: 3 })),
  source: `${BOX_DISTANCE}${BOX_CORNER}${DITHER}
vec3 gradient_srgb(vec3 lab) {
  vec3 lms = mat3(1.0, 1.0, 1.0, 0.3963377774, -0.1055613458, -0.0894841775,
                  0.2158037573, -0.0638541728, -1.2914855480) * lab;
  lms = lms * lms * lms;
  vec3 linear = mat3(4.0767416621, -1.2684380046, -0.0041960863,
                     -3.3077115913, 2.6097574011, -0.7034186147,
                     0.2309699292, -0.3413193965, 1.7076147010) * lms;
  linear = clamp(linear, 0.0, 1.0);
  return mix(linear * 12.92, 1.055 * pow(linear, vec3(1.0 / 2.4)) - 0.055,
             step(vec3(0.0031308), linear));
}
vec4 gradient_premultiplied(vec4 color) {
  return vec4(color.xyz * color.w, color.w);
}
vec4 paint(vec2 position) {
  vec2 half_size = size * 0.5;
  vec2 point = position - half_size;
  float corner = min(box_corner(point, radii), min(half_size.x, half_size.y));
  float coverage = clamp(0.5 - box_distance(point, half_size, corner) / pixel, 0.0, 1.0);
  if (coverage <= 0.0) return vec4(0.0);
  float t;
  if (shape < 0.5) {
    vec2 direction = vec2(cos(angle), sin(angle));
    float reach = abs(half_size.x * direction.x) + abs(half_size.y * direction.y);
    t = 0.5 + 0.5 * dot(point, direction) / max(reach, 1e-4);
  } else {
    vec2 middle = center * size;
    vec2 far = max(abs(middle), abs(size - middle));
    t = length(position - middle) / max(length(far), 1e-4);
  }
  t = clamp(t, 0.0, 1.0);
  vec4 from = color0, to = color0;
  float k = 0.0;
  if (t <= stops.x) {
    k = 0.0;
  } else if (t <= stops.y) {
    from = color0; to = color1; k = (t - stops.x) / max(stops.y - stops.x, 1e-5);
  } else if (t <= stops.z) {
    from = color1; to = color2; k = (t - stops.y) / max(stops.z - stops.y, 1e-5);
  } else if (t <= stops.w) {
    from = color2; to = color3; k = (t - stops.z) / max(stops.w - stops.z, 1e-5);
  } else {
    from = color3; to = color3;
  }
  vec4 mixed = mix(gradient_premultiplied(from), gradient_premultiplied(to), k);
  if (mixed.w <= 0.0) return vec4(0.0);
  vec3 rgb = gradient_srgb(mixed.xyz / mixed.w) + box_dither() / 255.0;
  return vec4(rgb * mixed.w, mixed.w) * coverage;
}
`,
});

const backdropBlurs = new Map<string, Shader<"paint">>();

/**
 * Frosted glass: what is drawn behind the rounded box, blurred by `blur` local units;
 * with `corners` in its FEATURES, the box's corners are its own.
 */
export function backdropBlurWith(features: BoxFeatures): Shader<"paint"> {
  return variant(backdropBlurs, { corners: features.corners }, () => paintShader({
    uniforms: { blur: 1 },
    reads: { backdrop: { blur: "blur" } },
    gate: "blur",
    source: `${BOX_DISTANCE}${features.corners ? BOX_CORNER : ""}
vec4 paint(vec2 position) {
  vec2 half_size = size * 0.5;
  vec2 point = position - half_size;
  float corner = min(${cornerOf(features.corners, "point")}, min(half_size.x, half_size.y));
  float coverage = clamp(0.5 - box_distance(point, half_size, corner) / pixel, 0.0, 1.0);
  return vec4(backdrop(position).rgb, 1.0) * coverage;
}
`,
  }));
}

/** Frosted glass: what is drawn behind the rounded box, blurred by `blur` local units. */
export const backdropBlur = backdropBlurWith({});

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
