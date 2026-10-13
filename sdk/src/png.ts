import { promisify } from "node:util";
import { crc32, deflate } from "node:zlib";
import type { Screenshot } from "./session.js";

const compress = promisify(deflate);

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Encode a screenshot as PNG, compressing off the director's event loop. */
export async function encodePng({ width, height, pixels }: Screenshot): Promise<Buffer> {
  const stride = width * 4;
  // Every row starts with filter type 0.
  const rows = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    rows.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", await compress(rows, { level: 6 })), chunk("IEND", new Uint8Array()),
  ]);
}
