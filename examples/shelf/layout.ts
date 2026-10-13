/**
 * Where books stand. Every window keeps the size of the reading area, so its
 * client never resizes; a book is the window as its cover, with a spine, a back
 * cover and the top edge of its pages built round it in 3D, all in the window's
 * own units. On the shelf the book is turned a quarter round, spine out, and
 * scaled down; open, it lies flat over the reading area, pixel for pixel.
 */

import {
  rotateX,
  rotateY,
  scale,
  translate,
  translateZ,
  type Rectangle,
  type Transform,
} from "proscenium";

/** How a book stands: the top of its spine's outer edge at (x, y), and how it is turned. */
export interface Pose {
  x: number;
  y: number;
  /** Toward the viewer, in pixels. */
  z: number;
  /** Degrees about the vertical: 90 shows the spine, 0 the cover. */
  turn: number;
  /** Degrees about the horizontal, top toward the viewer. */
  tilt: number;
  scale: number;
}

export interface Shelf {
  /** Where the open book lies. */
  reading: Rectangle;
  /** The top of the plank books stand on, and its extent. */
  plankY: number;
  plankLeft: number;
  plankRight: number;
  /** A book's height on the shelf before its own variation. */
  bookHeight: number;
}

export function shelfLayout(area: Rectangle): Shelf {
  const strip = Math.min(260, area.height * 0.27);
  const margin = 18;
  return {
    reading: {
      x: area.x + margin,
      y: area.y + margin,
      width: area.width - 2 * margin,
      height: area.height - strip - 2 * margin,
    },
    plankY: area.y + area.height - 40,
    plankLeft: area.x + area.width * 0.06,
    plankRight: area.x + area.width * 0.94,
    bookHeight: strip - 64,
  };
}

/** A stable number in 0..1 for a window, so its book keeps its look. */
export function variation(window: number, salt: number): number {
  const x = Math.sin(window * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** A book's height and spine thickness on the shelf, in pixels. */
export function bookSize(window: number, shelf: Shelf): { height: number; thickness: number } {
  return {
    height: shelf.bookHeight * (0.82 + 0.18 * variation(window, 1)),
    thickness: 30 + 22 * variation(window, 2),
  };
}

/**
 * Where each book stands on the shelf, left to right, the row centered on the
 * plank; the spine's right edge is the pose's x.
 */
export function shelfPoses(
  books: readonly number[],
  shelf: Shelf,
  read: Rectangle,
): Map<number, Pose> {
  const gap = 4;
  const sizes = books.map((id) => bookSize(id, shelf));
  const total = sizes.reduce((sum, size) => sum + size.thickness + gap, -gap);
  let x = (shelf.plankLeft + shelf.plankRight) / 2 - total / 2;
  const poses = new Map<number, Pose>();
  books.forEach((id, index) => {
    const { height, thickness } = sizes[index]!;
    x += thickness;
    poses.set(id, {
      x,
      y: shelf.plankY - height,
      z: 0,
      turn: 90,
      tilt: 0,
      scale: height / read.height,
    });
    x += gap;
  });
  return poses;
}

/** A book the pointer is on comes a little way off the shelf. */
export function hovered(pose: Pose): Pose {
  return { ...pose, z: pose.z + 64, y: pose.y - 20, turn: pose.turn - 8 };
}

/** The switcher's choice comes most of the way out and turns its cover to the light. */
export function chosen(pose: Pose): Pose {
  return { ...pose, z: pose.z + 90, y: pose.y - 34, turn: 58, scale: pose.scale * 1.12 };
}

export function openPose(read: Rectangle): Pose {
  return { x: read.x, y: read.y, z: 0, turn: 0, tilt: 0, scale: 1 };
}

/**
 * POSE as a book's transform; every pose lists the same functions, so any change
 * animates. The book scales in depth too, or its spine would keep the window's
 * scale while the rest shrank.
 */
export function placement(pose: Pose): Transform {
  return [
    translate(pose.x, pose.y),
    translateZ(pose.z),
    rotateY(pose.turn),
    rotateX(pose.tilt),
    scale(pose.scale, pose.scale, pose.scale),
  ];
}
