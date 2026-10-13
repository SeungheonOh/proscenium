import type { WireColor } from "./protocol.js";

/**
 * A CSS hex color (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`), `rgb()`/`rgba()`,
 * `transparent`, `white`, `black`, or straight-alpha components in 0..1.
 */
export type Color = string | readonly [number, number, number, number?];

const cache = new Map<string, WireColor>();

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function parse(text: string): WireColor {
  const value = text.trim().toLowerCase();
  if (value === "transparent") return [0, 0, 0, 0];
  if (value === "white") return [1, 1, 1, 1];
  if (value === "black") return [0, 0, 0, 1];
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value);
  if (hex) {
    let digits = hex[1]!;
    if (digits.length <= 4) digits = [...digits].map((digit) => digit + digit).join("");
    const channel = (index: number) => parseInt(digits.slice(index * 2, index * 2 + 2), 16) / 255;
    return [channel(0), channel(1), channel(2), digits.length === 8 ? channel(3) : 1];
  }
  const functional = /^rgba?\(\s*([^)]*)\)$/.exec(value);
  if (functional) {
    const parts = functional[1]!.split(/[\s,/]+/).filter(Boolean);
    if (parts.length === 3 || parts.length === 4) {
      const [red, green, blue] = parts.slice(0, 3).map((part) =>
        part.endsWith("%") ? parseFloat(part) / 100 : parseFloat(part) / 255);
      const alpha = parts[3] === undefined ? 1
        : parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
      const color: WireColor = [red!, green!, blue!, alpha];
      if (color.every(Number.isFinite)) return color.map(clamp) as WireColor;
    }
  }
  throw new TypeError(`Unsupported color ${JSON.stringify(text)}`);
}

export function toWireColor(color: Color): WireColor {
  if (typeof color !== "string") {
    return [clamp(color[0]), clamp(color[1]), clamp(color[2]), clamp(color[3] ?? 1)];
  }
  let parsed = cache.get(color);
  if (!parsed) {
    parsed = parse(color);
    // Generated colors (e.g. per-frame strings) must not grow the cache forever.
    if (cache.size >= 512) cache.clear();
    cache.set(color, parsed);
  }
  return parsed;
}
