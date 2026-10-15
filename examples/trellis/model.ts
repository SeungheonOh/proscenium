/**
 * Trellis's arrangement, as plain data: a tree of weighted splits whose leaves
 * are panels (tab groups of windows) and the one Desktop, where windows float.
 * Splits divide their box by weight, with no gaps; a split inside a split on the
 * same axis is flattened, and one with a single child is that child.
 *
 * The view frames a node, or a run of neighbours in a split, and maps that box
 * onto the screen with its own scale on each axis, so whatever is framed fills
 * the screen and the windows in it take the sizes they get there (see
 * `mapper`). Gaps are added on screen, so they keep their size at any depth.
 */

export type Axis = "x" | "y";
export type Side = "left" | "right" | "top" | "bottom";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Split {
  kind: "split";
  id: string;
  axis: Axis;
  children: Node[];
  weights: number[];
}

/** A tab group: its windows, front to back in the strip, and the one shown. */
export interface Panel {
  kind: "panel";
  id: string;
  windows: number[];
  active: number;
}

export interface Desk {
  kind: "desktop";
  id: "desktop";
}

export type Node = Split | Panel | Desk;

/** What the view frames: a node, or children FROM to TO of a split. */
export type Target = { node: string } | { split: string; from: number; to: number };

/** A panel floating on the Desktop: its box from the Desktop's top left, in layout units. */
export interface Float {
  panel: Panel;
  rect: Rect;
}

export const desk: Desk = { kind: "desktop", id: "desktop" };

export function newId(prefix: string): string {
  return prefix + Math.random().toString(36).slice(2, 9);
}

export function panelOf(windows: number[], active = windows[0] ?? 0): Panel {
  return { kind: "panel", id: newId("p"), windows, active };
}

export const axisOf = (side: Side): Axis => (side === "left" || side === "right" ? "x" : "y");
const before = (side: Side) => side === "left" || side === "top";

/* Tree. */

/** The tree as normalized: no empty panels, no lone children, no same-axis nesting. */
export function normalize(node: Node): Node | null {
  if (node.kind === "panel") {
    const windows = node.windows;
    if (!windows.length) return null;
    return windows.includes(node.active) ? node : { ...node, active: windows[0]! };
  }
  if (node.kind === "desktop") return node;
  const children: Node[] = [];
  const weights: number[] = [];
  node.children.forEach((child, index) => {
    const kept = normalize(child);
    if (!kept) return;
    const weight = node.weights[index] ?? 1;
    if (kept.kind === "split" && kept.axis === node.axis) {
      const total = sum(kept.weights);
      kept.children.forEach((grandchild, at) => {
        children.push(grandchild);
        weights.push((weight * kept.weights[at]!) / total);
      });
    } else {
      children.push(kept);
      weights.push(weight);
    }
  });
  if (!children.length) return null;
  if (children.length === 1) return children[0]!;
  return { ...node, children, weights };
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/** Every node, depth first, with its parent split and its index there. */
export function* walk(
  node: Node,
  parent: Split | null = null,
  index = 0,
): Generator<{ node: Node; parent: Split | null; index: number }> {
  yield { node, parent, index };
  if (node.kind === "split") {
    for (let at = 0; at < node.children.length; at++) yield* walk(node.children[at]!, node, at);
  }
}

export function find(root: Node, id: string) {
  for (const entry of walk(root)) if (entry.node.id === id) return entry;
  return null;
}

/** The panel holding WINDOW, if it is docked. */
export function panelHolding(root: Node, window: number): Panel | null {
  for (const { node } of walk(root)) {
    if (node.kind === "panel" && node.windows.includes(window)) return node;
  }
  return null;
}

/** ROOT with REPLACE(node) in place of the node with ID; null removes it. */
export function replace(root: Node, id: string, replacement: (node: Node) => Node | null): Node {
  const visit = (node: Node): Node | null => {
    if (node.id === id) return replacement(node);
    if (node.kind !== "split") return node;
    const children: Node[] = [];
    const weights: number[] = [];
    node.children.forEach((child, index) => {
      const kept = visit(child);
      if (kept) {
        children.push(kept);
        weights.push(node.weights[index]!);
      }
    });
    return { ...node, children, weights };
  };
  return normalize(visit(root) ?? desk) ?? desk;
}

/** ROOT without WINDOW, its panel gone if it was the last. */
export function removeWindow(root: Node, window: number): Node {
  const panel = panelHolding(root, window);
  if (!panel) return root;
  return replace(root, panel.id, (node) => {
    const windows = (node as Panel).windows.filter((id) => id !== window);
    return windows.length ? { ...(node as Panel), windows } : null;
  });
}

/* Layout. */

/** Each node's box in layout space, ROOT filling AREA. */
export function layout(root: Node, area: Rect): Map<string, Rect> {
  const boxes = new Map<string, Rect>();
  const place = (node: Node, box: Rect) => {
    boxes.set(node.id, box);
    if (node.kind !== "split") return;
    const total = sum(node.weights);
    let at = node.axis === "x" ? box.x : box.y;
    node.children.forEach((child, index) => {
      const share = ((node.axis === "x" ? box.width : box.height) * node.weights[index]!) / total;
      place(child, node.axis === "x"
        ? { x: at, y: box.y, width: share, height: box.height }
        : { x: box.x, y: at, width: box.width, height: share });
      at += share;
    });
  };
  place(root, area);
  return boxes;
}

/** The box TARGET frames, or null when what it named is gone. */
export function targetBox(root: Node, boxes: Map<string, Rect>, target: Target): Rect | null {
  if ("node" in target) return boxes.get(target.node) ?? null;
  const entry = find(root, target.split);
  if (!entry || entry.node.kind !== "split" || target.to >= entry.node.children.length) return null;
  const parts = entry.node.children.slice(target.from, target.to + 1).map((child) => boxes.get(child.id)!);
  return union(parts);
}

export function union(rects: readonly Rect[]): Rect {
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Layout space to the screen with FRAME filling SCREEN, each axis scaled on its own; and back. */
export function mapper(frame: Rect, screen: Rect) {
  const sx = screen.width / frame.width;
  const sy = screen.height / frame.height;
  return {
    sx,
    sy,
    rect: (r: Rect): Rect => ({
      x: screen.x + (r.x - frame.x) * sx,
      y: screen.y + (r.y - frame.y) * sy,
      width: r.width * sx,
      height: r.height * sy,
    }),
    point: (x: number, y: number) => ({ x: frame.x + (x - screen.x) / sx, y: frame.y + (y - screen.y) / sy }),
  };
}

export function inset(r: Rect, by: number): Rect {
  const dx = Math.min(by, r.width / 2);
  const dy = Math.min(by, r.height / 2);
  return { x: r.x + dx, y: r.y + dy, width: r.width - 2 * dx, height: r.height - 2 * dy };
}

export const contains = (r: Rect, x: number, y: number) =>
  x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;

/* Framing. */

/** Every node and every run of two or more neighbours, as targets. */
export function targets(root: Node): Target[] {
  const all: Target[] = [];
  for (const { node } of walk(root)) {
    all.push({ node: node.id });
    if (node.kind !== "split") continue;
    const count = node.children.length;
    for (let from = 0; from < count; from++) {
      for (let to = from + 1; to < count; to++) {
        if (from === 0 && to === count - 1) continue;
        all.push({ split: node.id, from, to });
      }
    }
  }
  return all;
}

/** The target whose box best covers VIEW, by how much of the two they share. */
export function bestFit(root: Node, boxes: Map<string, Rect>, view: Rect): Target {
  let best: Target = { node: root.id };
  let score = -1;
  for (const target of targets(root)) {
    const box = targetBox(root, boxes, target);
    if (!box) continue;
    const shared = overlap(box, view);
    const value = shared / (box.width * box.height + view.width * view.height - shared);
    if (value > score + 1e-9) {
      score = value;
      best = target;
    }
  }
  return best;
}

function overlap(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

export const sameTarget = (a: Target, b: Target) =>
  "node" in a ? "node" in b && a.node === b.node
    : "split" in b && a.split === b.split && a.from === b.from && a.to === b.to;

/** The level around TARGET: a run's split, a node's parent; the root stays the root. */
export function stepOut(root: Node, target: Target): Target {
  if ("split" in target) return { node: target.split };
  const entry = find(root, target.node);
  return entry?.parent ? { node: entry.parent.id } : { node: root.id };
}

/** The level inside TARGET toward layout point (X, Y): a split's child there, a run's member. */
export function stepIn(root: Node, boxes: Map<string, Rect>, target: Target, x: number, y: number): Target {
  const children = "split" in target
    ? (find(root, target.split)?.node as Split).children.slice(target.from, target.to + 1)
    : (() => {
        const node = find(root, target.node)?.node;
        return node?.kind === "split" ? node.children : [];
      })();
  if (!children.length) return target;
  const under = children.find((child) => contains(boxes.get(child.id)!, x, y));
  return { node: (under ?? children[0]!).id };
}

/** The neighbour of TARGET in its split, BY places along, if there is one. */
export function neighbour(root: Node, target: Target, by: number): Target | null {
  if ("split" in target) {
    const split = find(root, target.split)?.node as Split | undefined;
    if (!split) return null;
    const from = target.from + by, to = target.to + by;
    if (from < 0 || to >= split.children.length) return null;
    return { split: target.split, from, to };
  }
  const entry = find(root, target.node);
  if (!entry?.parent) return null;
  const sibling = entry.parent.children[entry.index + by];
  return sibling ? { node: sibling.id } : null;
}

/* Docking. */

/** Where a dragged window would land. */
export type Drop =
  /** Into a panel's tab group, docked or floating. */
  | { kind: "tab"; panel: string }
  /** Beside a node, splitting it, or at its seam when its split runs the same way. */
  | { kind: "beside"; node: string; side: Side }
  /** Into a split between children INDEX - 1 and INDEX, beside everything on either side. */
  | { kind: "seam"; split: string; index: number }
  /** Around what the view frames, beside everything shown. */
  | { kind: "frame"; side: Side }
  /** Floating on the Desktop with its top left at (X, Y), in layout units from the Desktop's. */
  | { kind: "float"; x: number; y: number };

/** ROOT with PANEL docked as DROP says, and what the view should frame after a frame drop. */
export function dock(root: Node, drop: Drop, panel: Panel, framed: Target): { root: Node; framed: Target } {
  if (drop.kind === "tab") {
    const next = replace(root, drop.panel, (node) => {
      const into = node as Panel;
      return { ...into, windows: [...into.windows, ...panel.windows], active: panel.active };
    });
    return { root: next, framed };
  }
  if (drop.kind === "beside") return { root: besideNode(root, drop.node, drop.side, panel), framed };
  if (drop.kind === "seam") {
    const next = replace(root, drop.split, (node) => {
      const split = node as Split;
      const share = 1 / (split.children.length + 1);
      const total = sum(split.weights);
      const children = [...split.children];
      const weights = split.weights.map((weight) => (weight / total) * (1 - share));
      children.splice(drop.index, 0, panel);
      weights.splice(drop.index, 0, share);
      return { ...split, children, weights };
    });
    return { root: next, framed };
  }
  if (drop.kind === "frame") return dockAroundFrame(root, framed, drop.side, panel);
  return { root, framed };
}

/** NODE split in two along SIDE's axis with PANEL taking half; at the seam if its split runs that way. */
function besideNode(root: Node, id: string, side: Side, panel: Panel): Node {
  const axis = axisOf(side);
  const entry = find(root, id);
  if (entry?.parent && entry.parent.axis === axis) {
    const parent = entry.parent;
    const children = [...parent.children];
    children.splice(entry.index + (before(side) ? 0 : 1), 0, panel);
    return replace(root, parent.id, () => ({ ...parent, children, weights: children.map(() => 1) }));
  }
  return replace(root, id, (node) => ({
    kind: "split",
    id: newId("s"),
    axis,
    children: before(side) ? [panel, node] : [node, panel],
    weights: [1, 1],
  }));
}

/** PANEL beside everything FRAMED shows, and FRAMED widened to take it in. */
function dockAroundFrame(root: Node, framed: Target, side: Side, panel: Panel): { root: Node; framed: Target } {
  const axis = axisOf(side);
  // The new panel takes a quarter of what the view shows.
  const pair = (node: Node): Split => ({
    kind: "split",
    id: newId("s"),
    axis,
    children: before(side) ? [panel, node] : [node, panel],
    weights: before(side) ? [1, 3] : [3, 1],
  });
  if ("split" in framed) {
    const split = find(root, framed.split)?.node as Split | undefined;
    if (!split) return { root, framed };
    const run = split.weights.slice(framed.from, framed.to + 1);
    const children = [...split.children];
    const weights = [...split.weights];
    if (split.axis === axis) {
      // A run along the same axis takes the panel in at its end.
      const at = before(side) ? framed.from : framed.to + 1;
      children.splice(at, 0, panel);
      weights.splice(at, 0, sum(run) / 3);
      const next = replace(root, split.id, () => ({ ...split, children, weights }));
      return { root: next, framed: { split: split.id, from: framed.from, to: framed.to + 1 } };
    }
    // Across it, the run becomes a group of its own, with the panel beside it.
    const group: Split = {
      kind: "split",
      id: newId("s"),
      axis: split.axis,
      children: split.children.slice(framed.from, framed.to + 1),
      weights: run,
    };
    const wrapper = pair(group);
    children.splice(framed.from, run.length, wrapper);
    weights.splice(framed.from, run.length, sum(run));
    return { root: replace(root, split.id, () => ({ ...split, children, weights })), framed: { node: wrapper.id } };
  }
  const entry = find(root, framed.node) ?? find(root, root.id)!;
  const node = entry.node;
  if (entry.parent && entry.parent.axis === axis) {
    // A node whose split runs this way takes the panel at its seam, framed together.
    const parent = entry.parent;
    const children = [...parent.children];
    const weights = [...parent.weights];
    children.splice(entry.index + (before(side) ? 0 : 1), 0, panel);
    weights.splice(entry.index + (before(side) ? 0 : 1), 0, parent.weights[entry.index]! / 3);
    const next = replace(root, parent.id, () => ({ ...parent, children, weights }));
    return { root: next, framed: { split: parent.id, from: entry.index, to: entry.index + 1 } };
  }
  const wrapper = pair(node);
  return { root: replace(root, node.id, () => wrapper), framed: { node: wrapper.id } };
}

/** SPLIT's weights with the seam before child INDEX moved to AT, a share of the split's length. */
export function moveSeam(split: Split, index: number, at: number, least = 0.04): number[] {
  const total = sum(split.weights);
  const shares = split.weights.map((weight) => weight / total);
  const start = sum(shares.slice(0, index - 1));
  const pair = shares[index - 1]! + shares[index]!;
  const first = Math.min(pair - least, Math.max(least, at - start));
  const weights = [...shares];
  weights[index - 1] = first;
  weights[index] = pair - first;
  return weights;
}
