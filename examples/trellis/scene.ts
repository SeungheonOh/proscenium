/**
 * What the arrangement looks like on screen for a framing: every panel's box,
 * each window's size and the scale it is drawn at, collapsed groups, seams, and
 * what a drag over any point would do.
 */

import {
  contains,
  find,
  inset,
  layout,
  mapper,
  targetBox,
  walk,
  type Drop,
  type Float,
  type Node,
  type Rect,
  type Side,
  type Split,
  type Target,
} from "./model.js";

/** Screen pixels between neighbours, and around everything. */
export const gap = 10;
/** The glass strip of a tab group, above its window. */
export const stripHeight = 34;
/** Content lays out at no less than its client's own minimum, or this, and is drawn smaller below it. */
const contentMin = { width: 320, height: 200 };
/** Inside the Desktop, a floating window keeps this far from its edges. */
const floatMargin = 8;
/** On screen below this, a window shows its app's colour and icon. */
export const iconBelow = { width: 200, height: 140 };
/** A nested group whose every part is smaller than this becomes one tile. */
const tileBelow = 48;

export interface WindowView {
  id: number;
  /** Its box on screen. */
  rect: Rect;
  /** The size the client is given, and the scale it is drawn at to fill RECT. */
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
  /** Too small to use: it shows its app's colour and icon. */
  icon: boolean;
  /** Behind another tab, or inside a collapsed group. */
  hidden: boolean;
  floating: boolean;
}

export interface PanelView {
  id: string;
  windows: number[];
  active: number;
  /** The panel's box: the strip, if it has one, then the window. */
  rect: Rect;
  tabbed: boolean;
  floating: boolean;
}

/** A group drawn as one tile, lined with its splits two levels deep. */
export interface TileView {
  id: string;
  rect: Rect;
  lines: { axis: "x" | "y"; at: number; from: number; to: number }[];
}

/** A seam between children INDEX - 1 and INDEX of a split, on screen. */
export interface SeamView {
  split: string;
  index: number;
  axis: "x" | "y";
  /** Its middle on the split's axis, and its extent across it. */
  at: number;
  from: number;
  to: number;
}

export interface Scene {
  /** What the root fills on screen when framed. */
  screen: Rect;
  map: ReturnType<typeof mapper>;
  boxes: Map<string, Rect>;
  /** Each node's box on screen, gaps taken out. */
  visual: Map<string, Rect>;
  desktop: Rect;
  panels: PanelView[];
  windows: Map<number, WindowView>;
  tiles: TileView[];
  seams: SeamView[];
  framed: Target;
}

export type Minimum = (window: number) => { width: number; height: number } | undefined;

/**
 * The scene of ROOT and FLOATING framed on FRAMED, the root filling AREA (the work area),
 * each window laid out at no less than its MINIMUM.
 */
export function sceneOf(
  root: Node,
  floating: readonly Float[],
  framed: Target,
  area: Rect,
  minimum: Minimum = () => undefined,
): Scene {
  const screen = inset(area, gap / 2);
  const boxes = layout(root, screen);
  const frame = targetBox(root, boxes, framed) ?? screen;
  const map = mapper(frame, screen);
  const visual = new Map<string, Rect>();
  for (const [id, box] of boxes) visual.set(id, inset(map.rect(box), gap / 2));
  const desktop = visual.get("desktop") ?? screen;

  const panels: PanelView[] = [];
  const windows = new Map<number, WindowView>();
  const tiles: TileView[] = [];
  const seams: SeamView[] = [];
  const framedNode = "node" in framed ? framed.node : framed.split;

  const placeWindows = (panel: PanelView, hidden: boolean) => {
    const content = panel.tabbed
      ? { ...panel.rect, y: panel.rect.y + stripHeight, height: Math.max(1, panel.rect.height - stripHeight) }
      : panel.rect;
    for (const id of panel.windows) {
      windows.set(id, {
        ...sized(id, content, area, minimum(id)),
        hidden: hidden || id !== panel.active,
        floating: panel.floating,
      });
    }
  };

  const visit = (node: Node, inside: boolean) => {
    if (node.kind === "panel") {
      const view: PanelView = {
        id: node.id,
        windows: node.windows,
        active: node.active,
        rect: visual.get(node.id)!,
        tabbed: node.windows.length > 1,
        floating: false,
      };
      panels.push(view);
      placeWindows(view, inside);
      return;
    }
    if (node.kind !== "split") return;
    const collapse = !inside && node.id !== framedNode && collapses(node, visual);
    if (collapse) tiles.push({ id: node.id, rect: visual.get(node.id)!, lines: linesOf(node, map, boxes, 2) });
    else if (!inside) seams.push(...seamsOf(node, map, boxes));
    for (const child of node.children) visit(child, inside || collapse);
  };
  visit(root, false);

  // Floating panels lie on the Desktop, from its top left, in layout units, kept inside it.
  const deskBox = boxes.get("desktop") ?? screen;
  for (const float of floating) {
    const room = { width: deskBox.width - 2 * floatMargin, height: deskBox.height - 2 * floatMargin };
    const width = Math.max(1, Math.min(float.rect.width, room.width));
    const height = Math.max(1, Math.min(float.rect.height, room.height));
    const x = Math.min(Math.max(float.rect.x, floatMargin), floatMargin + room.width - width);
    const y = Math.min(Math.max(float.rect.y, floatMargin), floatMargin + room.height - height);
    const rect = map.rect({ x: deskBox.x + x, y: deskBox.y + y, width, height });
    const view: PanelView = {
      id: float.panel.id,
      windows: float.panel.windows,
      active: float.panel.active,
      rect,
      tabbed: float.panel.windows.length > 1,
      floating: true,
    };
    panels.push(view);
    placeWindows(view, false);
  }
  return { screen, map, boxes, visual, desktop, panels, windows, tiles, seams, framed };
}

/**
 * A window filling RECT: given at least its minimum and at most twice the screen, and drawn
 * scaled to fit when that is not RECT's size.
 */
function sized(
  id: number,
  rect: Rect,
  area: Rect,
  minimum = contentMin,
): Omit<WindowView, "hidden" | "floating"> {
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const least = {
    width: Math.max(minimum.width || contentMin.width, 1),
    height: Math.max(minimum.height || contentMin.height, 1),
  };
  const small = Math.min(1, width / least.width, height / least.height);
  let clientWidth = width / small;
  let clientHeight = height / small;
  // Far past the screen's size, as beside a deep zoom, a window stops growing and is drawn larger.
  const large = Math.max(1, clientWidth / (2 * area.width), clientHeight / (2 * area.height));
  clientWidth = Math.max(1, Math.round(clientWidth / large));
  clientHeight = Math.max(1, Math.round(clientHeight / large));
  return {
    id,
    rect,
    width: clientWidth,
    height: clientHeight,
    scaleX: width / clientWidth,
    scaleY: height / clientHeight,
    icon: width < iconBelow.width || height < iconBelow.height,
  };
}

/** Whether SPLIT nests a group and every part of it is too small even for an icon. */
function collapses(split: Split, visual: Map<string, Rect>): boolean {
  if (!split.children.some((child) => child.kind === "split")) return false;
  for (const { node } of walk(split)) {
    if (node.kind === "split") continue;
    const box = visual.get(node.id)!;
    if (box.width >= tileBelow || box.height >= tileBelow) return false;
  }
  return true;
}

function seamsOf(split: Split, map: Scene["map"], boxes: Map<string, Rect>): SeamView[] {
  const box = map.rect(boxes.get(split.id)!);
  if (box.width < 40 || box.height < 40) return [];
  return split.children.slice(1).map((child, at) => {
    const edge = map.rect(boxes.get(child.id)!);
    return split.axis === "x"
      ? { split: split.id, index: at + 1, axis: "x", at: edge.x, from: box.y + gap / 2, to: box.y + box.height - gap / 2 }
      : { split: split.id, index: at + 1, axis: "y", at: edge.y, from: box.x + gap / 2, to: box.x + box.width - gap / 2 };
  });
}

function linesOf(split: Split, map: Scene["map"], boxes: Map<string, Rect>, depth: number): TileView["lines"] {
  if (depth === 0) return [];
  const lines: TileView["lines"] = [];
  const box = map.rect(boxes.get(split.id)!);
  split.children.forEach((child, index) => {
    const edge = map.rect(boxes.get(child.id)!);
    if (index > 0) {
      lines.push(split.axis === "x"
        ? { axis: "x", at: edge.x, from: box.y, to: box.y + box.height }
        : { axis: "y", at: edge.y, from: box.x, to: box.x + box.width });
    }
    if (child.kind === "split") lines.push(...linesOf(child, map, boxes, depth - 1));
  });
  return lines;
}

/* Dropping. */

/** The share of a panel along each edge whose drops dock beside it, not into it. */
const edgeShare = 0.28;
/** Within this of an empty stage's edge, a drop docks beside the Desktop. */
const deskEdge = 64;
/** How far from a seam's middle the pointer still finds it. */
const seamReach = gap / 2 + 10;

/** What a drop at (X, Y) on screen would do, or null for nothing. */
export function dropAt(scene: Scene, root: Node, x: number, y: number, dragged: number): Drop | null {
  // A window floating on the Desktop, above everything: its strip and middle take tabs.
  for (const panel of [...scene.panels].reverse()) {
    if (!panel.floating || !contains(panel.rect, x, y) || panel.windows.includes(dragged)) continue;
    const r = panel.rect;
    const middle = inset(r, Math.min(r.width, r.height) * 0.14);
    if (y < r.y + stripHeight || contains(middle, x, y)) return { kind: "tab", panel: panel.id };
    break;
  }

  // The band along the screen's edge docks beside everything the view shows.
  const band = Math.max(gap, 8);
  const edges: [Side, number][] = [
    ["left", x - scene.screen.x + gap / 2],
    ["right", scene.screen.x + scene.screen.width + gap / 2 - x],
    ["top", y - scene.screen.y + gap / 2],
    ["bottom", scene.screen.y + scene.screen.height + gap / 2 - y],
  ];
  const nearest = edges.reduce((best, edge) => (edge[1] < best[1] ? edge : best));
  if (nearest[1] <= band) return { kind: "frame", side: nearest[0] };

  // Seams beat panel edges; the nearest wins.
  let seam: Drop | null = null;
  let closest = seamReach;
  for (const s of scene.seams) {
    const along = s.axis === "x" ? y : x;
    if (along < s.from || along > s.to) continue;
    const distance = Math.abs((s.axis === "x" ? x : y) - s.at);
    if (distance <= closest) {
      closest = distance;
      seam = { kind: "seam", split: s.split, index: s.index };
    }
  }
  if (seam) return seam;

  // A collapsed group takes docks beside it, never into it.
  for (const tile of scene.tiles) {
    if (contains(tile.rect, x, y)) return { kind: "beside", node: tile.id, side: sideOf(tile.rect, x, y) ?? "right" };
  }

  for (const panel of scene.panels) {
    if (panel.floating || !contains(panel.rect, x, y)) continue;
    if (panel.windows.length === 1 && panel.windows[0] === dragged) return null;
    if (panel.tabbed && y < panel.rect.y + stripHeight) return { kind: "tab", panel: panel.id };
    const side = sideOf(panel.rect, x, y);
    return side ? { kind: "beside", node: panel.id, side } : { kind: "tab", panel: panel.id };
  }

  if (contains(scene.desktop, x, y) && find(root, "desktop")) {
    const d = scene.desktop;
    const reach = (length: number) => Math.min(deskEdge, length * edgeShare);
    const distances: [Side, number, number][] = [
      ["left", x - d.x, reach(d.width)],
      ["right", d.x + d.width - x, reach(d.width)],
      ["top", y - d.y, reach(d.height)],
      ["bottom", d.y + d.height - y, reach(d.height)],
    ];
    const edge = distances.filter(([, distance, limit]) => distance < limit).sort((a, b) => a[1] - b[1])[0];
    if (edge) return { kind: "beside", node: "desktop", side: edge[0] };
    return { kind: "float", x, y };
  }
  return null;
}

/** The edge of R whose outer share holds (X, Y), the nearest if several; null in the middle. */
function sideOf(r: Rect, x: number, y: number): Side | null {
  const shares: [Side, number][] = [
    ["left", (x - r.x) / r.width],
    ["right", (r.x + r.width - x) / r.width],
    ["top", (y - r.y) / r.height],
    ["bottom", (r.y + r.height - y) / r.height],
  ];
  const [side, share] = shares.reduce((best, entry) => (entry[1] < best[1] ? entry : best));
  return share < edgeShare ? side : null;
}

export const sameDrop = (a: Drop | null, b: Drop | null) => JSON.stringify(a) === JSON.stringify(b);
