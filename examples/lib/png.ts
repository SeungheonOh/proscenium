/**
 * PNG decoding for what the compositor's SDK only encodes: 8-bit, not
 * interlaced, grey, grey and alpha, RGB or RGBA, as Chromium's canvas and
 * `encodePng` write them.
 */

import { inflateSync } from "node:zlib";

/** DATA's pixels as straight RGBA, top row first. */
export function decodePng(data: Uint8Array): { width: number; height: number; pixels: Uint8Array } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = 8, width = 0, height = 0, type = 0;
  const parts: Uint8Array[] = [];
  while (at + 8 <= data.length) {
    const length = view.getUint32(at);
    const name = String.fromCharCode(...data.subarray(at + 4, at + 8));
    const body = data.subarray(at + 8, at + 8 + length);
    if (name === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      type = body[9]!;
      if (body[8] !== 8 || body[12] !== 0 || ![0, 2, 4, 6].includes(type)) throw new Error("An 8-bit PNG, not interlaced, without a palette.");
    } else if (name === "IDAT") {
      parts.push(body);
    } else if (name === "IEND") {
      break;
    }
    at += 12 + length;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[type]!;
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const rows = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = rows.subarray(y * stride, (y + 1) * stride);
    const up = y ? rows.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[i - channels]! : 0, b = up ? up[i]! : 0, c = up && i >= channels ? up[i - channels]! : 0;
      let value = line[i]!;
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[i] = value & 255;
    }
  }
  if (channels === 4) return { width, height, pixels: rows };
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0, o = 0; i < width * height; i++, o += 4) {
    const s = i * channels;
    const grey = channels <= 2;
    pixels[o] = rows[s]!;
    pixels[o + 1] = grey ? rows[s]! : rows[s + 1]!;
    pixels[o + 2] = grey ? rows[s]! : rows[s + 2]!;
    pixels[o + 3] = channels === 2 ? rows[s + 1]! : 255;
  }
  return { width, height, pixels };
}
