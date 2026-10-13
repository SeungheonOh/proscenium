// Keyframe animations, played by the compositor over a node's props.
//
// Each animated prop becomes one track on one wire property. Keyframes given
// as a function of progress, and easing functions, are sampled here, so the
// compositor only ever interpolates numbers and colors on its own clock.

import { type Color, toWireColor } from "./color.js";
import { type HostType, shaderTypes } from "./props.js";
import { type UniformValue, wireUniform } from "./shader.js";
import { type Easing, resolveEasing, sampleCount } from "./motion.js";
import { contentId, type WireValue } from "./protocol.js";
import { radians, type Transform, wireTransform } from "./transform.js";

/** The props keyframes can drive, and the value each keyframe takes. */
export interface AnimatableValues {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Transform functions; every keyframe lists the same ones. */
  transform: Transform;
  opacity: number;
  radius: number;
  blur: number;
  dim: number;
  /** A solid fill. */
  fill: Color;
  /** Text color. */
  color: Color;
  borderWidth: number;
  borderColor: Color;
  /** Degrees. */
  borderAngle: number;
  /** Degrees. */
  fillAngle: number;
  shadowColor: Color;
  shadowBlur: number;
  shadowX: number;
  shadowY: number;
  shadowSpread: number;
}

/** Values at evenly spaced (or `offsets`) points of an iteration, or a function of its progress. */
export type Keyframes<V> = readonly V[] | ((progress: number) => V);

/** When and how keyframes play, as in the Web Animations API. */
export interface AnimationTiming {
  /** Seconds per iteration; 0.5 by default. */
  duration?: number;
  /** Seconds before the first iteration, during which the prop keeps its own value. */
  delay?: number;
  /** Shapes each iteration's progress. */
  ease?: Easing;
  /** How many times it plays, or Infinity; 1 by default. */
  iterations?: number;
  direction?: "normal" | "reverse" | "alternate" | "alternate-reverse";
  /** "add" adds the keyframes to the prop's own value, e.g. to shake it; "replace" by default. */
  composite?: "replace" | "add";
  /** Where each keyframe sits in an iteration, rising from 0 to 1. */
  offsets?: readonly number[];
  /**
   * The animation's identity. An animation keeps running across renders while it
   * stays the same and starts over when it changes; a new key replays it.
   */
  key?: string | number;
}

/**
 * Keyframes for one or more props with their timing:
 * `{ x: [0, -8, 8, 0], composite: "add", duration: 0.3 }`. Finished animations
 * leave the prop at its own value.
 */
export type Animation = AnimationTiming & {
  [K in keyof AnimatableValues]?: Keyframes<AnimatableValues[K]>;
} & {
  /** Keyframes of shader uniforms, by use id and uniform name. */
  shaders?: Record<string, Record<string, Keyframes<UniformValue>>>;
};

const number = (value: number): WireValue => value;
const angle = (value: number): WireValue => value * radians;
const color = (value: Color): WireValue => toWireColor(value);

type Track = [string, (value: never) => WireValue];

type Tracks = Partial<{ [K in keyof AnimatableValues]: Track[] }>;

const nodeTracks: Tracks = {
  x: [["x", number]], y: [["y", number]], width: [["width", number]],
  height: [["height", number]], transform: [["transform", wireTransform]],
  opacity: [["opacity", number]], radius: [["radius", number]], color: [["color", color]],
};

/**
 * Wire properties and keyframe conversion of each animatable prop of a node
 * of TYPE. Decorations animate the uniforms of the standard shaders' uses
 * (see props.ts): a solid fill both ends of the box's gradient, a frame's
 * border its outset too.
 */
function decorationTracks(type: HostType): Tracks {
  const frame = type === "window" || type === "web";
  return {
    ...nodeTracks,
    blur: [["shaders.blur.blur", number]], dim: [["shaders.dim.amount", number]],
    fill: type === "background" ? [["shaders.plane.color", color]]
      : [["shaders.box.fill", color], ["shaders.box.fillEnd", color]],
    borderWidth: frame ? [["shaders.box.border", number], ["shaders.box.outset", number]]
      : [["shaders.box.border", number]],
    borderColor: [["shaders.box.borderColor", color], ["shaders.box.borderColorEnd", color]],
    borderAngle: [["shaders.box.borderAngle", angle]], fillAngle: [["shaders.box.fillAngle", angle]],
    shadowColor: [["shaders.shadow.color", color]], shadowBlur: [["shaders.shadow.blur", number]],
    shadowX: [["shaders.shadow.x", number]], shadowY: [["shaders.shadow.y", number]],
    shadowSpread: [["shaders.shadow.spread", number]],
  };
}

const tables = new Map<HostType, Tracks>();

function tracks(type: HostType): Tracks {
  let table = tables.get(type);
  if (!table) tables.set(type, table = shaderTypes.has(type) ? decorationTracks(type) : nodeTracks);
  return table;
}

function lerp(from: WireValue, to: WireValue, fraction: number): WireValue {
  if (Array.isArray(from) && Array.isArray(to)) {
    if (from.length !== to.length) throw new TypeError("Keyframes must have the same shape");
    return from.map((low, index) => lerp(low, to[index]!, fraction));
  }
  // A transform function's name.
  if (typeof from === "string") return from;
  return (from as number) + ((to as number) - (from as number)) * fraction;
}

/** KEYFRAMES at PROGRESS, extrapolating past the ends as the compositor does. */
function interpolate(keyframes: WireValue[], offsets: readonly number[], progress: number): WireValue {
  let index = offsets.findIndex((offset, position) => position > 0 && offset > progress);
  if (index < 0) index = offsets.length - 1;
  const span = offsets[index]! - offsets[index - 1]!;
  return lerp(keyframes[index - 1]!, keyframes[index]!,
              span > 0 ? (progress - offsets[index - 1]!) / span : 1);
}

function evenly(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index / (count - 1));
}

function wireTrack(name: string, convert: (value: never) => WireValue, frames: Keyframes<never>,
                   timing: AnimationTiming) {
  const duration = timing.duration ?? 0.5;
  let keyframes = typeof frames === "function"
    ? evenly(Math.min(256, Math.max(8, Math.ceil(duration * 60)) + 1)).map((progress) => convert(frames(progress)))
    : frames.map(convert);
  let offsets: readonly number[] | undefined = timing.offsets;
  let ease = resolveEasing(timing.ease ?? "linear");
  // An easing function is applied here, by resampling the keyframes evenly in time.
  if (typeof ease === "function") {
    const shaped = ease;
    const at = offsets ?? evenly(keyframes.length);
    const source = keyframes;
    keyframes = evenly(sampleCount(duration) + 1).map((time) => interpolate(source, at, shaped(time)));
    offsets = undefined;
    ease = null;
  }
  const track: Record<string, WireValue> = { property: name, keyframes, duration };
  if (offsets) track.offsets = [...offsets];
  if (ease) track.ease = ease;
  if (timing.delay) track.delay = timing.delay;
  if (timing.iterations !== undefined && timing.iterations !== 1) {
    track.iterations = timing.iterations === Infinity ? "forever" : timing.iterations;
  }
  if (timing.direction && timing.direction !== "normal") track.direction = timing.direction;
  if (timing.composite === "add") track.composite = "add";
  track.id = timing.key === undefined ? contentId(JSON.stringify(track)) : `${timing.key}/${name}`;
  return track;
}

/** The wire tracks of ANIMATE on a node of TYPE, one per animated wire property. */
export function wireAnimations(animate: Animation | readonly Animation[],
                               type: HostType = "group"): WireValue[] {
  const list = Array.isArray(animate) ? animate as readonly Animation[] : [animate as Animation];
  const table = tracks(type);
  return list.flatMap((animation) => [
    ...(Object.keys(table) as (keyof AnimatableValues)[])
      .filter((property) => animation[property] !== undefined)
      .flatMap((property) => table[property]!.map((track) =>
        wireTrack(...track, animation[property] as Keyframes<never>, animation))),
    ...Object.entries((shaderTypes.has(type) && animation.shaders) || {}).flatMap(([shading, uniforms]) =>
      Object.entries(uniforms).map(([uniform, frames]) =>
        wireTrack(`shaders.${shading}.${uniform}`, wireUniform as (value: never) => WireValue,
                  frames as Keyframes<never>, animation))),
  ]);
}
