/**
 * Stacks: windows piled one behind another like cards, the top one where it
 * was and each one under it a step up and to the left, so every edge peeks
 * out. A stack moves as one; expanded, its windows are laid out side by side
 * again where the stack sits. Canvas coordinates.
 */
import type { Rectangle } from "proscenium";
import { bounds } from "./magnetism.js";
import { tidy } from "./tidy.js";

/** How far each window in a pile sits from the one above it, up and to the left. */
export const pileStep = 28;
/** Between windows when a stack is spread out. */
export const spreadGap = 32;

/**
 * Where each of WINDOWS goes in a pile, bottom first, given where they are: the
 * last (the top) stays put and the rest step back behind it.
 */
export function pile(windows: readonly number[], places: ReadonlyMap<number, Rectangle>): Map<number, Rectangle> {
  const top = places.get(windows.at(-1)!)!;
  const n = windows.length;
  return new Map(
    windows.map((id, i) => {
      const r = places.get(id)!;
      const back = (n - 1 - i) * pileStep;
      return [id, { ...r, x: top.x - back, y: top.y - back }] as const;
    }),
  );
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
 * through RELATIONS (its bonded group, its stack, the selection it is in).
 */
export function closure(window: number, relations: readonly ((id: number) => readonly number[])[]): number[] {
  const out = [window];
  const seen = new Set(out);
  for (let i = 0; i < out.length; i++)
    for (const relate of relations)
      for (const other of relate(out[i]!))
        if (!seen.has(other)) {
          seen.add(other);
          out.push(other);
        }
  return out;
}
