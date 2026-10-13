/**
 * Rooms on the infinite canvas. Every room is the size of the main output, so a
 * room entered at 100% fills the screen pixel for pixel; where it sits is free.
 */

import type { CameraMove, OutputInfo, Rectangle } from "proscenium";
import { union } from "../lib/geometry.js";

export interface Room {
  id: number;
  /** Top-left corner on the canvas. */
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** The size of every room: the main output's. */
export function roomSize(output: OutputInfo | undefined): Size {
  return { width: output?.width ?? 1920, height: output?.height ?? 1080 };
}

/** Space kept between rooms. */
export function roomGap(size: Size): number {
  return Math.round(size.width * 0.12);
}

export function roomRect(room: Room, size: Size): Rectangle {
  return { x: room.x, y: room.y, ...size };
}

function overlap(a: Rectangle, b: Rectangle, gap: number): boolean {
  return (
    a.x < b.x + b.width + gap &&
    b.x < a.x + a.width + gap &&
    a.y < b.y + b.height + gap &&
    b.y < a.y + a.height + gap
  );
}

/**
 * Where `room` lands near (x, y) without overlapping the others: each overlap
 * pushes it out the shortest way, until it is clear.
 */
export function clearSpot(rooms: readonly Room[], room: Room, size: Size): Room {
  const gap = roomGap(size);
  let { x, y } = room;
  for (let pass = 0; pass < 16; pass++) {
    const here = { x, y, ...size };
    const other = rooms.find(
      (candidate) => candidate.id !== room.id && overlap(here, roomRect(candidate, size), gap),
    );
    if (!other) break;
    const pushes = [
      { x: other.x - gap - size.width, y },
      { x: other.x + size.width + gap, y },
      { x, y: other.y - gap - size.height },
      { x, y: other.y + size.height + gap },
    ];
    const distance = (spot: { x: number; y: number }) => Math.hypot(spot.x - x, spot.y - y);
    ({ x, y } = pushes.reduce((best, spot) => (distance(spot) < distance(best) ? spot : best)));
  }
  return { ...room, x, y };
}

/** The room containing a canvas point. */
export function roomAt(rooms: readonly Room[], size: Size, x: number, y: number): Room | null {
  return (
    rooms.findLast(
      (room) => x >= room.x && x <= room.x + size.width && y >= room.y && y <= room.y + size.height,
    ) ?? null
  );
}

/** The camera that shows a room's box filling `output`. */
export function roomCamera(room: Rectangle, output: OutputInfo): CameraMove {
  return {
    x: room.x + room.width / 2,
    y: room.y + room.height / 2,
    zoom: Math.min(output.width / room.width, output.height / room.height),
  };
}

/** The camera that shows every room on `output`, with some canvas around them. */
export function overviewCamera(rooms: readonly Room[], size: Size, output: OutputInfo): CameraMove {
  const all = union(rooms.map((room) => roomRect(room, size)));
  if (!all) return { x: 0, y: 0, zoom: 1 };
  const margin = roomGap(size);
  const fit = Math.min(
    output.width / (all.width + 2 * margin),
    output.height / (all.height + 2 * margin),
  );
  return { x: all.x + all.width / 2, y: all.y + all.height / 2, zoom: Math.min(fit, 1) };
}
