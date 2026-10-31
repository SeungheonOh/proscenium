/**
 * Magnetic polarity, after Sunlight's (spacefarm-digital/sunlight,
 * Polarity.swift): every window is ⊕ or ⊖, ⊕ to begin with. Like poles push,
 * as magnet mode always did; bring a window near an opposite pole, faces lined
 * up, and the other is pulled in to the gap and bonds: the two are now a group
 * that moves, coasts, drops onto the grid and undoes as one. Alt-drag a member
 * to pull it out, flip it to eject it, or ungroup it.
 *
 * Which windows have bonded, by window id. A window in no group is a group of
 * itself; plain data, so undo keeps a copy.
 */
import type { Rectangle } from "proscenium";
import { adjacent, type Pole } from "./magnetism.js";

export interface Grouping {
  /** The group each bonded window is in. */
  of: Readonly<Record<number, number>>;
  /** The number the next new group takes. */
  next: number;
}

export const noGroups: Grouping = { of: {}, next: 0 };

/** The window and everyone bonded to it, the window first and the rest in id order. */
export function members(g: Grouping, id: number): number[] {
  const group = g.of[id];
  if (group === undefined) return [id];
  const rest = Object.entries(g.of)
    .filter(([other, n]) => n === group && Number(other) !== id)
    .map(([other]) => Number(other))
    .sort((a, b) => a - b);
  return [id, ...rest];
}

/** Two windows bond: their groups become one. */
export function merge(g: Grouping, a: number, b: number): Grouping {
  if (a === b) return g;
  const ga = g.of[a];
  const gb = g.of[b];
  if (ga === undefined && gb === undefined) return { of: { ...g.of, [a]: g.next, [b]: g.next }, next: g.next + 1 };
  if (gb === undefined) return { of: { ...g.of, [b]: ga! }, next: g.next };
  if (ga === undefined) return { of: { ...g.of, [a]: gb }, next: g.next };
  if (ga === gb) return g;
  const of: Record<number, number> = {};
  for (const [id, n] of Object.entries(g.of)) of[Number(id)] = n === gb ? ga : n;
  return { of, next: g.next };
}

/**
 * The window leaves its group, and the rest is split into the pieces that
 * still sit together, so a window pulled out of the middle doesn't leave a
 * rigid pair with a hole in it. RECTS are where the members are.
 */
export function remove(g: Grouping, id: number, rects: ReadonlyMap<number, Rectangle>, gap: number): Grouping {
  const group = g.of[id];
  if (group === undefined) return g;
  const rest = members(g, id).slice(1);
  const of: Record<number, number> = { ...g.of };
  delete of[id];
  let next = g.next;
  split(rest, rects, gap).forEach((piece, i) => {
    if (piece.length < 2) for (const m of piece) delete of[m];
    else if (i > 0) {
      for (const m of piece) of[m] = next;
      next++;
    } else for (const m of piece) of[m] = group;
  });
  return { of, next };
}

/** The window's whole group goes free. */
export function dissolve(g: Grouping, id: number): Grouping {
  const group = g.of[id];
  if (group === undefined) return g;
  const of: Record<number, number> = {};
  for (const [other, n] of Object.entries(g.of)) if (n !== group) of[Number(other)] = n;
  return { of, next: g.next };
}

/** Only the windows in IDS, and no group left with a single member. */
export function prune(g: Grouping, ids: ReadonlySet<number>): Grouping {
  const counts = new Map<number, number>();
  for (const [id, n] of Object.entries(g.of)) if (ids.has(Number(id))) counts.set(n, (counts.get(n) ?? 0) + 1);
  const of: Record<number, number> = {};
  let changed = false;
  for (const [id, n] of Object.entries(g.of)) {
    if (ids.has(Number(id)) && (counts.get(n) ?? 0) > 1) of[Number(id)] = n;
    else changed = true;
  }
  return changed ? { of, next: g.next } : g;
}

/** The groups with more than one member, each as its ids. */
export function groups(g: Grouping): number[][] {
  const by = new Map<number, number[]>();
  for (const [id, n] of Object.entries(g.of)) by.set(n, [...(by.get(n) ?? []), Number(id)]);
  return [...by.values()].filter((ids) => ids.length > 1);
}

/**
 * IDS in the pieces that sit together, each connected by windows side by side
 * no more than GAP apart. An id without a rect goes in the first piece.
 */
export function split(ids: readonly number[], rects: ReadonlyMap<number, Rectangle>, gap: number): number[][] {
  const pieces: number[][] = [];
  const seen = new Set<number>();
  const homeless: number[] = [];
  for (const start of ids) {
    if (seen.has(start)) continue;
    seen.add(start);
    const r0 = rects.get(start);
    if (!r0) {
      homeless.push(start);
      continue;
    }
    const piece = [start];
    const queue = [r0];
    while (queue.length) {
      const r = queue.pop()!;
      for (const other of ids) {
        const o = rects.get(other);
        if (seen.has(other) || !o || !adjacent(r, o, gap)) continue;
        seen.add(other);
        piece.push(other);
        queue.push(o);
      }
    }
    pieces.push(piece);
  }
  if (homeless.length) {
    if (pieces.length) pieces[0]!.push(...homeless);
    else pieces.push(homeless);
  }
  return pieces;
}

/** Each window's pole and the groups, kept with the canvas. */
export interface PolarityState {
  /** The compositor instance the window ids belong to. */
  instance: string | null;
  /** Windows not named are ⊕. */
  poles: Readonly<Record<number, Pole>>;
  grouping: Grouping;
}

export const glyph: Record<Pole, string> = { plus: "⊕", minus: "⊖" };
/** The poles' tints: a magnet's red north and blue south. */
export const tint: Record<Pole, string> = { plus: "#e0443e", minus: "#2f6fed" };

export function flipped(pole: Pole): Pole {
  return pole === "plus" ? "minus" : "plus";
}
