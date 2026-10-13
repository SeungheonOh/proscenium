// Transform functions for the `transform` prop, as CSS has them.
//
// A transform lists functions in the order they read; the last applies to the
// node first, about its origin. They compose as 4x4 matrices through the scene,
// so a parent's perspective shows its children's turns in depth. Angles are in
// degrees, distances in the parent's units; z points toward the viewer.

import type { WireValue } from "./protocol.js";

/** One transform function, in the canonical wire form the helpers below produce. */
export type TransformFunction = readonly [name: string, ...parameters: number[]];

/** One function, or a list applied as CSS applies `transform: a b c`. */
export type Transform = TransformFunction | readonly TransformFunction[];

/** Radians in a degree. */
export const radians = Math.PI / 180;

export function translate(x: number, y = 0, z = 0): TransformFunction {
  return ["translate", x, y, z];
}

export function translateZ(z: number): TransformFunction {
  return ["translate", 0, 0, z];
}

/** Scales by X along x, Y along y (X by default) and Z along z. */
export function scale(x: number, y = x, z = 1): TransformFunction {
  return ["scale", x, y, z];
}

/** Turns DEGREES clockwise about the vector (X, Y, Z), as CSS `rotate3d()`. */
export function rotate3d(x: number, y: number, z: number, degrees: number): TransformFunction {
  return ["rotate", x, y, z, degrees * radians];
}

/** Turns clockwise in the plane, as CSS `rotate()`. */
export function rotate(degrees: number): TransformFunction {
  return rotate3d(0, 0, 1, degrees);
}

/** Tilts about the horizontal axis: positive turns the top edge away. */
export function rotateX(degrees: number): TransformFunction {
  return rotate3d(1, 0, 0, degrees);
}

/** Tilts about the vertical axis: positive turns the right edge away. */
export function rotateY(degrees: number): TransformFunction {
  return rotate3d(0, 1, 0, degrees);
}

export const rotateZ = rotate;

/** Slants by X degrees along x and Y along y. */
export function skew(x: number, y = 0): TransformFunction {
  return ["skew", x * radians, y * radians];
}

/** Views what follows from DISTANCE in front: nearer is more dramatic, 0 is none. */
export function perspective(distance: number): TransformFunction {
  return ["perspective", distance];
}

/** Any matrix, as the sixteen numbers of CSS `matrix3d()`, column by column. */
export function matrix3d(...values: number[]): TransformFunction {
  if (values.length !== 16) throw new TypeError("matrix3d takes 16 numbers");
  return ["matrix", ...values];
}

function isFunction(transform: Transform): transform is TransformFunction {
  return typeof transform[0] === "string";
}

/** TRANSFORM as the wire's list of functions. */
export function wireTransform(transform: Transform): WireValue {
  const functions = isFunction(transform) ? [transform] : transform as readonly TransformFunction[];
  return functions.map((entry) => [...entry]);
}
