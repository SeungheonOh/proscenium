// Tiling layouts: pure functions from an ordered list of keys (usually window
// ids) and an area to one box per key. Worlds decide what to tile and when;
// these only do the arithmetic, so they compose with any animation or state.

export interface Area {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Placement<K> extends Area {
  key: K;
}

export interface GapOptions {
  /** Space between neighbouring boxes. */
  gap?: number;
  /** Space between the boxes and the area's edges. */
  outer?: number;
}

/** AREA shrunk by AMOUNT on every side. */
export function inset(area: Area, amount: number): Area {
  return {
    x: area.x + amount, y: area.y + amount,
    width: Math.max(0, area.width - 2 * amount), height: Math.max(0, area.height - 2 * amount),
  };
}

/** Split AREA along an axis at RATIO, leaving GAP between the two parts. */
function split(area: Area, ratio: number, gap: number, vertical: boolean): [Area, Area] {
  if (vertical) {
    const first = Math.max(0, (area.height - gap) * ratio);
    return [{ ...area, height: first },
            { ...area, y: area.y + first + gap, height: Math.max(0, area.height - first - gap) }];
  }
  const first = Math.max(0, (area.width - gap) * ratio);
  return [{ ...area, width: first },
          { ...area, x: area.x + first + gap, width: Math.max(0, area.width - first - gap) }];
}

/** Stack KEYS in AREA in equal slices along one axis, GAP apart. */
function slices<K>(keys: readonly K[], area: Area, gap: number, vertical: boolean): Placement<K>[] {
  const length = vertical ? area.height : area.width;
  const size = Math.max(0, (length - gap * (keys.length - 1)) / keys.length);
  return keys.map((key, index) => {
    const offset = index * (size + gap);
    return vertical
      ? { key, ...area, y: area.y + offset, height: size }
      : { key, ...area, x: area.x + offset, width: size };
  });
}

/**
 * Hyprland's dwindle: every window takes RATIO of the space left by the
 * previous one, split along that space's longer side.
 */
export function dwindle<K>(keys: readonly K[], area: Area,
                           { gap = 0, outer = 0, ratio = 0.5 }: GapOptions & { ratio?: number } = {}):
    Placement<K>[] {
  const placements: Placement<K>[] = [];
  let rest = inset(area, outer);
  keys.forEach((key, index) => {
    if (index === keys.length - 1) {
      placements.push({ key, ...rest });
      return;
    }
    const [first, remaining] = split(rest, ratio, gap, rest.height > rest.width);
    placements.push({ key, ...first });
    rest = remaining;
  });
  return placements;
}

export interface MasterOptions extends GapOptions {
  /** Share of the area the masters take. */
  ratio?: number;
  /** Number of master windows. */
  masters?: number;
  /** Side the masters sit on. */
  side?: "left" | "right" | "top" | "bottom";
}

/** The first MASTERS windows share one side; the rest stack on the other. */
export function masterStack<K>(keys: readonly K[], area: Area,
                               { gap = 0, outer = 0, ratio = 0.55, masters = 1, side = "left" }:
                                 MasterOptions = {}): Placement<K>[] {
  const inner = inset(area, outer);
  const count = Math.min(Math.max(masters, 0), keys.length);
  const vertical = side === "top" || side === "bottom";
  if (count === 0 || count === keys.length) return slices(keys, inner, gap, !vertical);
  const leading = side === "left" || side === "top";
  const [first, second] = split(inner, leading ? ratio : 1 - ratio, gap, vertical);
  const [masterArea, stackArea] = leading ? [first, second] : [second, first];
  return [...slices(keys.slice(0, count), masterArea, gap, !vertical),
          ...slices(keys.slice(count), stackArea, gap, !vertical)];
}

export interface ColumnOptions extends GapOptions {
  /** Column width: a fraction of the area when at most 1, else pixels. */
  width?: number;
  /** Horizontal scroll offset from the previous layout. */
  scroll?: number;
}

/**
 * niri-style scrolling columns: full-height columns side by side, scrolled as
 * little as needed to keep FOCUSED in view. Returns the boxes and the scroll.
 */
export function columns<Key>(keys: readonly Key[], area: Area,
                             { gap = 0, outer = 0, width = 0.5, scroll = 0, focused }:
                               ColumnOptions & {
                                 /** Key that must end up fully in view. */
                                 focused?: Key;
                               } = {}):
    { placements: Placement<Key>[]; scroll: number } {
  const inner = inset(area, outer);
  const columnWidth = width <= 1 ? (inner.width - gap) * width : width;
  const index = focused === undefined ? -1 : keys.indexOf(focused);
  if (index >= 0) {
    const left = index * (columnWidth + gap);
    scroll = Math.min(Math.max(scroll, left + columnWidth - inner.width), left);
  }
  scroll = Math.max(0, scroll);
  return {
    scroll,
    placements: keys.map((key, column) => ({
      key, x: inner.x + column * (columnWidth + gap) - scroll, y: inner.y,
      width: columnWidth, height: inner.height,
    })),
  };
}

/** An even grid, as square as AREA allows; handy for overviews. */
export function grid<K>(keys: readonly K[], area: Area, { gap = 0, outer = 0 }: GapOptions = {}):
    Placement<K>[] {
  const inner = inset(area, outer);
  const count = keys.length;
  if (count === 0) return [];
  const columnCount = Math.max(1, Math.round(Math.sqrt(count * inner.width / Math.max(1, inner.height))));
  const rowCount = Math.ceil(count / Math.min(columnCount, count));
  const width = (inner.width - gap * (Math.min(columnCount, count) - 1)) / Math.min(columnCount, count);
  const height = (inner.height - gap * (rowCount - 1)) / rowCount;
  return keys.map((key, index) => ({
    key,
    x: inner.x + (index % columnCount) * (width + gap),
    y: inner.y + Math.floor(index / columnCount) * (height + gap),
    width, height,
  }));
}
