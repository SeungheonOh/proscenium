// Qt's easing curves, which the original animates with, as CSS easings.

type Curve = (t: number) => number;

const back = (overshoot: number): Curve => (t) => (t - 1) ** 2 * ((overshoot + 1) * (t - 1) + overshoot) + 1;

export const curves = {
  inQuad: (t: number) => t * t,
  outQuad: (t: number) => 1 - (1 - t) ** 2,
  inCubic: (t: number) => t ** 3,
  outCubic: (t: number) => 1 - (1 - t) ** 3,
  inOutQuart: (t: number) => (t < 0.5 ? 8 * t ** 4 : 1 - 8 * (t - 1) ** 4),
  inOutSine: (t: number) => (1 - Math.cos(Math.PI * t)) / 2,
  inExpo: (t: number) => (t === 0 || t === 1 ? t : 2 ** (10 * (t - 1)) - 0.001),
  outExpo: (t: number) => (t === 1 ? 1 : 1.001 * (1 - 2 ** (-10 * t))),
  outBack: back,
};

/** CURVE as a CSS linear() easing, sampled finely enough to look the same. */
export function easing(curve: Curve, samples = 40): string {
  const points = Array.from({ length: samples + 1 }, (_, index) => curve(index / samples).toFixed(4));
  return `linear(${points.join(", ")})`;
}

export const ease = {
  inQuad: easing(curves.inQuad),
  outQuad: easing(curves.outQuad),
  inCubic: easing(curves.inCubic),
  outCubic: easing(curves.outCubic),
  inOutQuart: easing(curves.inOutQuart),
  inOutSine: easing(curves.inOutSine),
  inExpo: easing(curves.inExpo),
  outExpo: easing(curves.outExpo),
  outBack: (overshoot: number) => easing(back(overshoot)),
};

/** Resolves after MILLISECONDS. */
export const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
