/**
 * Stacks: windows piled one behind another like cards, the top one where it
 * was and each one under it a step up and to the left, so every edge peeks
 * out. A stack moves as one; expanded, its windows are laid out side by side
 * again where the stack sits. Canvas coordinates.
 */
import type { Rectangle } from "proscenium";
import type { Point } from "./snapping.js";
import { bounds } from "./magnetism.js";
import { tidy } from "./tidy.js";
import { middle } from "./tiling.js";

/** How far each window in a pile sits from the one above it, up and to the left. */
export const pileStep = 28;
/** Between windows when a stack is spread out. */
export const spreadGap = 32;

/**
 * Where each of WINDOWS goes in a pile, bottom first, given where they are: the
 * last (the top) stays put and the rest step back behind it.
 */
export function pile(windows: readonly number[], places: ReadonlyMap<number, Rectangle>): Map<number, Rectangle> {
  return pileAt(windows, places.get(windows.at(-1)!)!, places);
}

/**
 * Where each of WINDOWS goes in a pile, bottom first, whose front slot is at
 * FRONT, with ROOM empty slots in front of the top window: one makes space for
 * a window about to join.
 */
export function pileAt(
  windows: readonly number[],
  front: Point,
  places: ReadonlyMap<number, Rectangle>,
  room = 0,
): Map<number, Rectangle> {
  const n = windows.length;
  return new Map(
    windows.map((id, i) => {
      const back = (n - 1 - i + room) * pileStep;
      return [id, { ...places.get(id)!, x: front.x - back, y: front.y - back }] as const;
    }),
  );
}

/** Where a stack's front slot is: its top window's top left. */
export function frontOf(stack: readonly number[], places: ReadonlyMap<number, Rectangle>): Point {
  const top = places.get(stack.at(-1)!)!;
  return { x: top.x, y: top.y };
}

/** STACK, bottom first, turned until WINDOW is on top, the others keeping their turn. */
export function toFront(stack: readonly number[], window: number): number[] {
  const at = stack.indexOf(window);
  return [...stack.slice(at + 1), ...stack.slice(0, at + 1)];
}

/** How a window shows in a fan: where its box goes, and how it is tilted and shrunk about its middle. */
export interface FanPose {
  rect: Rectangle;
  /** Degrees, clockwise. */
  angle: number;
  scale: number;
  /**
   * Where it catches the pointer, about the same middle: a card lifted out still
   * reaches down to where it sat, so it never slips out from under the pointer.
   */
  reach: Rectangle;
}

/**
 * A stack fanned out like a hand of cards over where it sits: ORDER left to
 * right, each one over the one before so every title shows, tilted along an
 * arc, the one at CHOSEN lifted out of the hand.
 */
export function fanAt(
  order: readonly number[],
  places: ReadonlyMap<number, Rectangle>,
  chosen: number,
): Map<number, FanPose> {
  const rects = order.map((id) => places.get(id)!);
  const centre = middle(bounds(rects));
  const n = order.length;
  const scale = Math.max(0.5, 0.78 - Math.max(0, n - 3) * 0.06);
  const height = Math.max(...rects.map((r) => r.height)) * scale;
  // The cards turn about a point well below the hand.
  const radius = 5 * height;
  const step = Math.min(7, 28 / Math.max(1, n - 1));
  return new Map(
    order.map((id, i) => {
      const angle = (i - (n - 1) / 2) * step;
      const turn = (angle * Math.PI) / 180;
      const lift = i === chosen ? height * 0.08 : 0;
      const r = rects[i]!;
      const x = centre.x + radius * Math.sin(turn) - r.width / 2;
      const y = centre.y + radius * (1 - Math.cos(turn)) - lift - r.height / 2;
      const rect = { ...r, x, y };
      if (i !== chosen) return [id, { rect, angle, scale, reach: rect }] as const;
      // Shown, it spans from its lifted top to the bottom it had in the hand.
      const grown = scale * 1.04;
      const top = y + r.height / 2 - (r.height * grown) / 2;
      const bottom = y + lift + r.height / 2 + (r.height * scale) / 2;
      const tall = (bottom - top) / grown;
      const reach = { ...rect, y: (top + bottom) / 2 - tall / 2, height: tall };
      return [id, { rect, angle, scale: grown, reach }] as const;
    }),
  );
}

/**
 * How a fan of ORDER layers, bottom first: the card at CHOSEN on top, each
 * neighbour under it, and the farther out, the lower, so every card shows its
 * outer edge; of two as far out, the right one is over the left.
 */
export function fanLayers(order: readonly number[], chosen: number): number[] {
  const far = (i: number) => Math.abs(i - chosen);
  return order
    .map((id, i) => ({ id, i }))
    .sort((a, b) => far(b.i) - far(a.i) || a.i - b.i)
    .map((card) => card.id);
}

/**
 * Where each of WINDOWS goes spread out from a stack, sizes kept, in a grid
 * from the stack's top left, bottom of the pile first.
 */
export function spread(windows: readonly number[], places: ReadonlyMap<number, Rectangle>): Map<number, Rectangle> {
  const rects = windows.map((id) => places.get(id)!);
  const corner = bounds(rects);
  // Laid out in the pile's order: a row of steps reads left to right, bottom first.
  const inOrder = rects.map((r, i) => ({ ...r, x: i, y: 0 }));
  const laid = tidy(inOrder, { x: corner.x - spreadGap, y: corner.y - spreadGap }, spreadGap);
  return new Map(windows.map((id, i) => [id, laid.rects[i]!] as const));
}

/** Only the windows in IDS, and no stack left with fewer than two. */
export function pruneStacks(stacks: readonly (readonly number[])[], ids: ReadonlySet<number>): number[][] {
  return stacks.map((s) => s.filter((id) => ids.has(id))).filter((s) => s.length > 1);
}

/** The stack WINDOW is in, bottom first, or null. */
export function stackOf(stacks: readonly (readonly number[])[], window: number): readonly number[] | null {
  return stacks.find((s) => s.includes(window)) ?? null;
}

/**
 * The windows that move with WINDOW: WINDOW first, then everything reachable
 * through RELATIONS (its stack, the selection it is in).
 */
export function closure(window: number, relations: readonly ((id: number) => readonly number[])[]): number[] {
  const out = [window];
  const seen = new Set(out);
  for (let i = 0; i < out.length; i++) {
    for (const relate of relations) {
      for (const other of relate(out[i]!)) {
        if (seen.has(other)) continue;
        seen.add(other);
        out.push(other);
      }
    }
  }
  return out;
}
