/**
 * What the niri world remembers and every change to it, as a pure reducer
 * following niri's own layout code. Actions carry the compositor's view of
 * outputs and windows (`env`), which widths and views are computed against.
 */

import { defaultWidth, floatingStep, gaps, presetHeights, presetWidths } from "./config.js";
import {
  centerView, type Column, columnWidth, type Env, type Floater, floaterBox, fitView, hasFixedHeight,
  isEmpty, type Monitor, type OutputEnv, resolveWidth, strip, type Tile, tileHeights, tileOrigin,
  visibleColumns, type Width, windowEnv, type Workspace, workspaceFocus,
} from "./model.js";

export interface NiriState {
  /** The compositor instance the window ids belong to. */
  instance: string | null;
  monitors: Record<string, Monitor>;
  activeOutput: string | null;
  nextId: number;
  /** Floating windows made fullscreen, to float again when they leave it. */
  refloat: number[];
  /** Where windows last floated, to float there again. */
  floated: Record<number, { x: number; y: number; width: number; height: number }>;
  /** A window lifted out of the layout by a drag, and its column's width to drop it with. */
  held: { window: number; width: Width; fullWidth: boolean } | null;
}

export const initialNiriState: NiriState = {
  instance: null, monitors: {}, activeOutput: null, nextId: 1, refloat: [], floated: {}, held: null,
};

export type Direction = -1 | 1;

/** Where a dragged window lands: a new column, or into one at a tile index. */
export type InsertTarget =
  | { kind: "column"; index: number }
  | { kind: "tile"; column: number; index: number }
  | { kind: "floating"; x: number; y: number };

export type NiriAction =
  | { type: "sync"; windows: readonly number[]; instance: string }
  /** Focus a window wherever it is, showing its workspace. */
  | { type: "activate"; window: number }
  | { type: "focusOutput"; output: string }
  | { type: "focusColumn"; to: "left" | "right" | "first" | "last" }
  | { type: "focusWindow"; direction: Direction; orWorkspace?: boolean }
  | { type: "moveColumn"; to: "left" | "right" | "first" | "last" }
  | { type: "moveWindow"; direction: Direction }
  | { type: "consumeOrExpel"; direction: Direction }
  | { type: "consume" }
  | { type: "expel" }
  | { type: "presetWidth"; direction: Direction }
  | { type: "presetHeight" }
  | { type: "resetHeight"; window?: number }
  | { type: "maximizeColumn"; window?: number }
  | { type: "fullscreen"; window?: number; value?: boolean }
  | { type: "maximizeToEdges"; window?: number; value?: boolean }
  | { type: "expandColumn" }
  | { type: "centerColumn" }
  | { type: "centerVisible" }
  | { type: "adjustWidth"; percent: number }
  | { type: "adjustHeight"; percent: number }
  | { type: "toggleFloating"; window?: number }
  | { type: "switchFocusFloating" }
  | { type: "toggleTabbed" }
  | { type: "focusWorkspace"; index: number; output?: string }
  | { type: "focusWorkspaceRelative"; direction: Direction; output?: string }
  | { type: "moveColumnToWorkspace"; index?: number; direction?: Direction }
  | { type: "moveWorkspace"; direction: Direction }
  | { type: "focusMonitor"; direction: Direction }
  | { type: "moveColumnToMonitor"; direction: Direction }
  /** Drop empty workspaces the output no longer shows, once its switch has played. */
  | { type: "cleanWorkspaces"; output: string }
  /** A view gesture ended: the view and the column it settled on. */
  | { type: "setView"; output: string; workspace: number; view: number; active: number }
  /** A workspace gesture ended on workspace INDEX. */
  | { type: "showWorkspace"; output: string; index: number }
  /** WIDTH from an interactive resize; dragging the left edge keeps the right one still on screen. */
  | { type: "resizeColumn"; window: number; width: number; fromLeft?: boolean }
  | { type: "resizeTile"; window: number; height: number }
  /** An interactive resize of WINDOW ended: the view fits its column again if it is the active one. */
  | { type: "fitActive"; window: number }
  | { type: "placeFloating"; window: number; x: number; y: number; width?: number; height?: number }
  /** A drag pulled WINDOW out of the layout. */
  | { type: "lift"; window: number }
  /** The held window was dropped on workspace WORKSPACE (an id) of OUTPUT, or a new one at index NEWAT. */
  | { type: "drop"; output: string; workspace: number | null; newAt?: number; target: InsertTarget };

export type EnvAction = NiriAction & { env: Env };

interface Place {
  output: string;
  workspace: number;
  /** The column and tile, or for a floating window its stack index in `floating`. */
  column: number;
  tile: number;
  floating: boolean;
}

export function locate(state: NiriState, window: number): Place | null {
  for (const [output, monitor] of Object.entries(state.monitors)) {
    for (const [index, workspace] of monitor.workspaces.entries()) {
      for (const [column, entry] of workspace.columns.entries()) {
        const tile = entry.tiles.findIndex((candidate) => candidate.window === window);
        if (tile >= 0) return { output, workspace: index, column, tile, floating: false };
      }
      const floating = workspace.floating.findIndex((floater) => floater.window === window);
      if (floating >= 0) return { output, workspace: index, column: -1, tile: floating, floating: true };
    }
  }
  return null;
}

export function activeMonitor(state: NiriState): Monitor | undefined {
  return state.activeOutput === null ? undefined : state.monitors[state.activeOutput];
}

export function activeWorkspace(state: NiriState): Workspace | undefined {
  const monitor = activeMonitor(state);
  return monitor?.workspaces[monitor.active];
}

/** The window niri would give the keyboard. */
export function focusedWindow(state: NiriState): number | null {
  const workspace = activeWorkspace(state);
  return workspace ? workspaceFocus(workspace) : null;
}

export function allWindows(state: NiriState): number[] {
  const placed = Object.values(state.monitors).flatMap((monitor) => monitor.workspaces.flatMap((workspace) => [
    ...workspace.columns.flatMap((column) => column.tiles.map((tile) => tile.window)),
    ...workspace.floating.map((floater) => floater.window),
  ]));
  return state.held ? [...placed, state.held.window] : placed;
}

function newWorkspace(state: NiriState, output: OutputEnv): Workspace {
  // The view starts where a first column's fit would put it, so it opens without a slide.
  return {
    id: state.nextId++, columns: [], active: 0, shift: 0, view: -gaps - output.workArea.x,
    restoreOnRemoval: null, restoreOnUnfullscreen: null, floating: [], floatingActive: false,
  };
}

export function newColumn(window: number, width: Width = { proportion: defaultWidth },
                          fullWidth = false): Column {
  const preset = "proportion" in width ? presetWidths.indexOf(width.proportion) : -1;
  return {
    tiles: [{ window, height: { auto: 1 } }], active: 0, width, preset: preset >= 0 ? preset : null,
    fullWidth, tabbed: false, sizing: "normal",
  };
}

/** Applies the reducer to a copy of the state, with everything it needs at hand. */
class Draft {
  readonly state: NiriState;

  constructor(state: NiriState, readonly env: Env) {
    this.state = structuredClone(state);
  }

  output(name: string): OutputEnv | undefined {
    return this.env.outputs.find((output) => output.name === name);
  }

  /** The active output, its monitor and its shown workspace. */
  current() {
    const name = this.state.activeOutput;
    const output = name === null ? undefined : this.output(name);
    const monitor = name === null ? undefined : this.state.monitors[name];
    if (!output || !monitor) return null;
    return { output, monitor, workspace: monitor.workspaces[monitor.active]! };
  }

  /** Where WINDOW is, with its output, monitor and workspace. */
  find(window: number | undefined) {
    const id = window ?? focusedWindow(this.state);
    if (id === null) return null;
    const place = locate(this.state, id);
    const output = place && this.output(place.output);
    if (!place || !output) return null;
    const monitor = this.state.monitors[place.output]!;
    return { ...place, window: id, output, monitor, workspaceIndex: place.workspace,
             workspace: monitor.workspaces[place.workspace]! };
  }

  // Columns and tiles, after niri's ScrollingSpace.

  activateColumn(workspace: Workspace, index: number, output: OutputEnv): void {
    if (index === workspace.active || !workspace.columns[index]) return;
    workspace.view = fitView(workspace, index, output, this.env);
    workspace.active = index;
    workspace.restoreOnRemoval = null;
    workspace.restoreOnUnfullscreen = null;
  }

  /** Column INDEX changed width from BEFORE: keep the active column in place, refitting it. */
  widthChanged(workspace: Workspace, index: number, before: number, output: OutputEnv): void {
    const column = workspace.columns[index];
    if (!column) return;
    const after = columnWidth(column, output, this.env);
    if (index < workspace.active) workspace.shift -= after - before;
    if (index === workspace.active) workspace.view = fitView(workspace, index, output, this.env);
  }

  addColumn(workspace: Workspace, index: number, column: Column, activate: boolean,
            output: OutputEnv): void {
    const wasEmpty = workspace.columns.length === 0;
    const at = wasEmpty ? 0 : index;
    workspace.columns.splice(at, 0, column);
    if (!wasEmpty && at <= workspace.active) {
      workspace.active += 1;
      workspace.shift -= columnWidth(column, output, this.env) + gaps;
    }
    if (!activate) return;
    if (wasEmpty) {
      // The first column fits from a zeroed view, without animating from wherever it was.
      workspace.view = fitView(workspace, 0, output, this.env, workspace.shift);
      workspace.active = 0;
    }
    const { xs } = strip(workspace, output, this.env);
    const previous = !wasEmpty && at === workspace.active + 1 ? workspace.view - xs[workspace.active]! : null;
    this.activateColumn(workspace, at, output);
    workspace.restoreOnRemoval = previous;
  }

  removeColumn(workspace: Workspace, index: number, output: OutputEnv): Column {
    const { widths } = strip(workspace, output, this.env);
    const removed = widths[index]! + gaps;
    const [column] = workspace.columns.splice(index, 1);
    if (index + 1 === workspace.active) workspace.restoreOnRemoval = null;
    if (index === workspace.active) workspace.restoreOnUnfullscreen = null;
    if (workspace.columns.length === 0) {
      // The next first column then opens where the view already is.
      workspace.active = 0;
      workspace.restoreOnRemoval = null;
      workspace.shift = workspace.view + gaps + output.workArea.x;
      if (workspace.floating.length) workspace.floatingActive = true;
      return column!;
    }
    if (index < workspace.active) {
      workspace.active -= 1;
      workspace.shift += removed;
      workspace.restoreOnRemoval = null;
    } else if (index === workspace.active && workspace.restoreOnRemoval !== null) {
      if (index > 0) {
        const offset = workspace.restoreOnRemoval;
        this.activateColumn(workspace, index - 1, output);
        workspace.view = strip(workspace, output, this.env).xs[workspace.active]! + offset;
        workspace.view = fitView(workspace, workspace.active, output, this.env);
      }
    } else {
      this.activateColumn(workspace, Math.min(workspace.active, workspace.columns.length - 1), output);
    }
    return column!;
  }

  /** Takes tile ROW out of column INDEX, and the column with it if it was the last. */
  removeTile(workspace: Workspace, index: number, row: number, output: OutputEnv) {
    const column = workspace.columns[index]!;
    if (column.tiles.length === 1) {
      const removed = this.removeColumn(workspace, index, output);
      return { tile: removed.tiles[0]!, width: removed.width, fullWidth: removed.fullWidth };
    }
    const before = columnWidth(column, output, this.env);
    const [tile] = column.tiles.splice(row, 1);
    if (column.tiles.length === 1 && "auto" in column.tiles[0]!.height) column.tiles[0]!.height = { auto: 1 };
    if (row < column.active) column.active -= 1;
    else if (row === column.active && row === column.tiles.length) column.active = row - 1;
    this.widthChanged(workspace, index, before, output);
    return { tile: tile!, width: column.width, fullWidth: column.fullWidth };
  }

  addTileToColumn(workspace: Workspace, index: number, tile: Tile, activate: boolean,
                  output: OutputEnv, row?: number): void {
    const column = workspace.columns[index]!;
    const before = columnWidth(column, output, this.env);
    const at = row ?? column.tiles.length;
    column.tiles.splice(at, 0, tile);
    if (at <= column.active && column.tiles.length > 1) column.active += 1;
    if (activate) {
      column.active = at;
      this.activateColumn(workspace, index, output);
    }
    this.widthChanged(workspace, index, before, output);
  }

  /** Makes sure the output's last workspace is an empty one. */
  keepEmptyLast(monitor: Monitor, output: OutputEnv): void {
    const last = monitor.workspaces[monitor.workspaces.length - 1];
    if (!last || !isEmpty(last)) monitor.workspaces.push(newWorkspace(this.state, output));
  }

  showWorkspace(monitor: Monitor, index: number): void {
    const target = Math.max(0, Math.min(index, monitor.workspaces.length - 1));
    if (target === monitor.active) return;
    monitor.previous = monitor.workspaces[monitor.active]?.id ?? null;
    monitor.active = target;
  }

  /** Drops an emptied workspace the output is not showing and that is not its last. */
  dropIfEmpty(monitor: Monitor, index: number): void {
    const workspace = monitor.workspaces[index];
    if (!workspace || !isEmpty(workspace) || index === monitor.active) return;
    if (index === monitor.workspaces.length - 1) return;
    monitor.workspaces.splice(index, 1);
    if (index < monitor.active) monitor.active -= 1;
  }

  // Windows coming and going.

  sync(windows: readonly number[], instance: string): void {
    const state = this.state;
    if (state.instance !== instance) {
      Object.assign(state, structuredClone(initialNiriState), { instance, nextId: state.nextId });
    }
    this.syncOutputs();
    const present = new Set(windows);
    const known = new Set(allWindows(state));
    for (const window of known) if (!present.has(window)) this.removeWindow(window);
    for (const window of windows) if (!known.has(window)) this.addWindow(window);
    for (const key of Object.keys(state.floated)) {
      if (!present.has(Number(key))) delete state.floated[Number(key)];
    }
  }

  syncOutputs(): void {
    const state = this.state;
    for (const output of this.env.outputs) {
      if (state.monitors[output.name]) continue;
      state.monitors[output.name] = { workspaces: [newWorkspace(state, output)], active: 0, previous: null };
    }
    const names = new Set(this.env.outputs.map((output) => output.name));
    if (state.activeOutput === null || !names.has(state.activeOutput)) {
      state.activeOutput = this.env.outputs[0]?.name ?? null;
    }
    // A disconnected output's windows move to the active output, before its empty workspace.
    const home = state.activeOutput === null ? undefined : state.monitors[state.activeOutput];
    for (const name of Object.keys(state.monitors)) {
      if (names.has(name)) continue;
      const kept = state.monitors[name]!.workspaces.filter((workspace) => !isEmpty(workspace));
      delete state.monitors[name];
      if (home) home.workspaces.splice(home.workspaces.length - 1, 0, ...kept);
    }
    for (const output of this.env.outputs) this.keepEmptyLast(state.monitors[output.name]!, output);
  }

  removeWindow(window: number): void {
    if (this.state.held?.window === window) this.state.held = null;
    const found = this.find(window);
    if (!found) return;
    const { workspace, monitor, output } = found;
    if (found.floating) {
      workspace.floating.splice(found.tile, 1);
      if (!workspace.floating.length) workspace.floatingActive = false;
    } else {
      this.removeTile(workspace, found.column, found.tile, output);
      if (!workspace.columns.length && workspace.floating.length) workspace.floatingActive = true;
    }
    this.state.refloat = this.state.refloat.filter((id) => id !== window);
    this.dropIfEmpty(monitor, found.workspaceIndex);
  }

  addWindow(window: number): void {
    const info = windowEnv(this.env, window);
    const parent = info.parent === null ? null : this.find(info.parent);
    const target = parent ?? this.current();
    if (!target) return;
    const { output, monitor, workspace } = target;
    const fullscreenActive = workspace.columns[workspace.active]?.sizing === "fullscreen";
    const floats = info.parent !== null || hasFixedHeight(info)
      || (/firefox$/.test(info.appId) && info.title === "Picture-in-Picture");
    if (floats) {
      const area = output.workArea;
      let x = area.x + Math.max(0, (area.width - info.width) / 2);
      let y = area.y + Math.max(0, (area.height - info.height) / 2);
      const over = parent && this.renderedBox(parent.window);
      if (over) {
        // Dialogs open centered over their parent, kept inside the work area.
        x = clampPreferStart(over.x + (over.width - info.width) / 2, area.x, area.width, info.width);
        y = clampPreferStart(over.y + (over.height - info.height) / 2, area.y, area.height, info.height);
      }
      const activate = parent ? workspaceFocus(workspace) === parent.window : !fullscreenActive;
      const floater: Floater = { window, x, y, width: null, height: null };
      const above = parent?.floating ? parent.tile + 1 : workspace.floating.length;
      workspace.floating.splice(activate ? workspace.floating.length : above, 0, floater);
      if (activate) workspace.floatingActive = true;
    } else {
      const activate = !fullscreenActive;
      const at = workspace.columns.length ? workspace.active + 1 : 0;
      this.addColumn(workspace, at, newColumn(window), activate, output);
      if (activate) workspace.floatingActive = false;
    }
    this.keepEmptyLast(monitor, output);
  }

  /** WINDOW's box on its output as its workspace shows it at rest. */
  renderedBox(window: number) {
    const found = this.find(window);
    if (!found) return null;
    const { workspace, output } = found;
    if (found.floating) return floaterBox(workspace.floating[found.tile]!, this.env);
    const column = workspace.columns[found.column]!;
    const { xs, widths } = strip(workspace, output, this.env);
    const heights = tileHeights(column, output, this.env);
    let y = tileOrigin(column, output);
    if (!column.tabbed) for (let row = 0; row < found.tile; row++) y += heights[row]! + gaps;
    return { x: xs[found.column]! - workspace.view, y, width: widths[found.column]!, height: heights[found.tile]! };
  }

  activate(window: number): void {
    const found = this.find(window);
    if (!found) return;
    const { monitor, workspace, output } = found;
    this.state.activeOutput = found.output.name;
    this.showWorkspace(monitor, found.workspaceIndex);
    if (found.floating) {
      const [floater] = workspace.floating.splice(found.tile, 1);
      workspace.floating.push(floater!);
      workspace.floatingActive = true;
    } else {
      workspace.columns[found.column]!.active = found.tile;
      this.activateColumn(workspace, found.column, output);
      workspace.floatingActive = false;
    }
  }

  // Floating windows.

  /** The nearest floating window from the active one along an axis, by centers. */
  floatingNeighbour(workspace: Workspace, axis: "x" | "y", direction: Direction): number | null {
    const boxes = workspace.floating.map((floater) => floaterBox(floater, this.env));
    const active = boxes[boxes.length - 1];
    if (!active) return null;
    const center = (box: typeof active) => axis === "x" ? box.x + box.width / 2 : box.y + box.height / 2;
    let best: number | null = null;
    let bestDistance = Infinity;
    boxes.slice(0, -1).forEach((box, index) => {
      const distance = (center(box) - center(active)) * direction;
      if (distance > 0 && distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    return best;
  }

  raiseFloating(workspace: Workspace, index: number): void {
    const [floater] = workspace.floating.splice(index, 1);
    workspace.floating.push(floater!);
  }

  moveFloating(workspace: Workspace, dx: number, dy: number): void {
    const floater = workspace.floating[workspace.floating.length - 1];
    if (!floater) return;
    floater.x += dx;
    floater.y += dy;
  }

  // Actions.

  focusColumn(to: "left" | "right" | "first" | "last"): void {
    const here = this.current();
    if (!here) return;
    const { workspace, output } = here;
    if (workspace.floatingActive && workspace.floating.length) {
      if (to === "left" || to === "right") {
        const index = this.floatingNeighbour(workspace, "x", to === "left" ? -1 : 1);
        if (index !== null) this.raiseFloating(workspace, index);
      }
      return;
    }
    const last = workspace.columns.length - 1;
    const index = { left: workspace.active - 1, right: workspace.active + 1, first: 0, last }[to];
    if (index >= 0 && index <= last) this.activateColumn(workspace, index, output);
  }

  focusWindow(direction: Direction, orWorkspace: boolean): void {
    const here = this.current();
    if (!here) return;
    const { workspace, monitor } = here;
    if (workspace.floatingActive && workspace.floating.length) {
      const index = this.floatingNeighbour(workspace, "y", direction);
      if (index !== null) this.raiseFloating(workspace, index);
      return;
    }
    const column = workspace.columns[workspace.active];
    const row = column ? column.active + direction : -1;
    if (column && row >= 0 && row < column.tiles.length) column.active = row;
    else if (orWorkspace) this.showWorkspace(monitor, monitor.active + direction);
  }

  moveColumnTo(workspace: Workspace, index: number, output: OutputEnv): void {
    const from = workspace.active;
    if (index === from || index < 0 || index >= workspace.columns.length) return;
    const [column] = workspace.columns.splice(from, 1);
    workspace.columns.splice(index, 0, column!);
    // The camera stays where it was while the column slides, then fits it.
    workspace.view = fitView(workspace, index, output, this.env);
    workspace.active = index;
    workspace.restoreOnRemoval = null;
    workspace.restoreOnUnfullscreen = null;
  }

  moveColumn(to: "left" | "right" | "first" | "last"): void {
    const here = this.current();
    if (!here) return;
    const { workspace, output } = here;
    if (workspace.floatingActive && workspace.floating.length) {
      if (to === "left" || to === "right") this.moveFloating(workspace, to === "left" ? -floatingStep : floatingStep, 0);
      return;
    }
    const last = workspace.columns.length - 1;
    const index = { left: workspace.active - 1, right: workspace.active + 1, first: 0, last }[to];
    this.moveColumnTo(workspace, index, output);
  }

  moveWindow(direction: Direction): void {
    const here = this.current();
    if (!here) return;
    const { workspace } = here;
    if (workspace.floatingActive && workspace.floating.length) {
      this.moveFloating(workspace, 0, direction * floatingStep);
      return;
    }
    const column = workspace.columns[workspace.active];
    if (!column) return;
    const row = column.active + direction;
    if (row < 0 || row >= column.tiles.length) return;
    [column.tiles[row], column.tiles[column.active]] = [column.tiles[column.active]!, column.tiles[row]!];
    column.active = row;
  }

  consumeOrExpel(direction: Direction, window?: number): void {
    const found = this.find(window);
    if (!found || found.floating) return;
    const { workspace, output } = found;
    const index = found.column;
    const column = workspace.columns[index]!;
    const wasActive = index === workspace.active && column.active === found.tile;
    if (column.tiles.length === 1) {
      if (direction < 0) {
        if (index === 0) return;
        if (wasActive && workspace.restoreOnRemoval === null) {
          // Keep the camera still as the column folds into its left neighbour.
          workspace.restoreOnRemoval = workspace.view - strip(workspace, output, this.env).xs[index - 1]!;
        }
        const { tile } = this.removeTile(workspace, index, 0, output);
        this.addTileToColumn(workspace, index - 1, tile, wasActive, output);
      } else {
        if (index + 1 === workspace.columns.length) return;
        if (wasActive) workspace.restoreOnRemoval = null;
        const { tile } = this.removeTile(workspace, index, 0, output);
        this.addTileToColumn(workspace, index, tile, wasActive, output);
      }
      return;
    }
    const { tile, width, fullWidth } = this.removeTile(workspace, index, found.tile, output);
    const created = { ...newColumn(tile.window, width, fullWidth), tiles: [{ ...tile, height: { auto: 1 } }] };
    this.addColumn(workspace, direction < 0 ? index : index + 1, created, wasActive, output);
    if (wasActive && direction < 0) workspace.restoreOnRemoval = null;
  }

  consume(): void {
    const here = this.current();
    if (!here) return;
    const { workspace, output } = here;
    if (workspace.active >= workspace.columns.length - 1) return;
    const { tile } = this.removeTile(workspace, workspace.active + 1, 0, output);
    this.addTileToColumn(workspace, workspace.active, { ...tile, height: { auto: 1 } }, false, output);
  }

  expel(): void {
    const here = this.current();
    if (!here) return;
    const { workspace, output } = here;
    const column = workspace.columns[workspace.active];
    if (!column || column.tiles.length === 1) return;
    const index = workspace.active;
    const { tile, width, fullWidth } = this.removeTile(workspace, index, column.tiles.length - 1, output);
    this.addColumn(workspace, index + 1, { ...newColumn(tile.window, width, fullWidth) }, false, output);
  }

  /** The active column of the focused workspace, unless its floating layer has focus. */
  activeColumn() {
    const here = this.current();
    if (!here || (here.workspace.floatingActive && here.workspace.floating.length)) return null;
    const column = here.workspace.columns[here.workspace.active];
    return column ? { ...here, column, index: here.workspace.active } : null;
  }

  activeFloater() {
    const here = this.current();
    if (!here || !here.workspace.floatingActive) return null;
    const floater = here.workspace.floating[here.workspace.floating.length - 1];
    return floater ? { ...here, floater } : null;
  }

  setWidth(found: NonNullable<ReturnType<Draft["activeColumn"]>>, width: Width, preset: number | null): void {
    const { column, workspace, index, output } = found;
    const before = columnWidth(column, output, this.env);
    column.width = width;
    column.preset = preset;
    column.fullWidth = false;
    if (column.sizing === "maximized") column.sizing = "normal";
    this.widthChanged(workspace, index, before, output);
  }

  presetWidth(direction: Direction): void {
    const floating = this.activeFloater();
    if (floating) {
      const { floater, output } = floating;
      const current = floaterBox(floater, this.env).width;
      const widths = presetWidths.map((preset) => output.workArea.width * preset);
      const next = nextPreset(widths, current, null, direction);
      floater.width = Math.round(widths[next]!);
      return;
    }
    const found = this.activeColumn();
    if (!found) return;
    const { column, output } = found;
    const current = column.fullWidth || column.sizing === "maximized" ? null : column.preset;
    const widths = presetWidths.map((preset) => resolveWidth({ proportion: preset }, output.workArea));
    const next = nextPreset(widths, columnWidth(column, output, this.env), current, direction);
    this.setWidth(found, { proportion: presetWidths[next]! }, next);
  }

  adjustWidth(percent: number): void {
    const floating = this.activeFloater();
    if (floating) {
      const { floater, output } = floating;
      const current = floaterBox(floater, this.env).width;
      floater.width = Math.max(1, Math.round(current + output.workArea.width * percent / 100));
      return;
    }
    const found = this.activeColumn();
    if (!found) return;
    const { column, output } = found;
    const area = output.workArea;
    const current: Width = column.fullWidth || column.sizing === "maximized" ? { proportion: 1 } : column.width;
    const proportion = "proportion" in current
      ? current.proportion
      : (resolveWidth(current, area) + gaps) / (area.width - gaps);
    this.setWidth(found, { proportion: Math.min(Math.max(proportion + percent / 100, 0), 10000) }, null);
  }

  /** Other tiles of COLUMN become auto, keeping the heights they show. */
  othersToAuto(column: Column, keep: number, output: OutputEnv): void {
    const heights = tileHeights(column, output, this.env);
    const sorted = [...heights].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 1;
    column.tiles.forEach((tile, row) => {
      if (row !== keep) tile.height = { auto: heights[row]! / median };
    });
  }

  presetHeight(): void {
    const found = this.activeColumn();
    if (!found) return;
    const { column, output } = found;
    const tile = column.tiles[column.active]!;
    const heights = presetHeights.map((preset) => (output.workArea.height - gaps) * preset - gaps);
    const current = "preset" in tile.height ? tile.height.preset : null;
    const next = nextPreset(heights, tileHeights(column, output, this.env)[column.active]!, current, 1);
    this.othersToAuto(column, column.active, output);
    tile.height = { preset: next };
  }

  adjustHeight(percent: number): void {
    const floating = this.activeFloater();
    if (floating) {
      const { floater, output } = floating;
      const current = floaterBox(floater, this.env).height;
      floater.height = Math.max(1, Math.round(current + output.workArea.height * percent / 100));
      return;
    }
    const found = this.activeColumn();
    if (!found) return;
    const { column, output } = found;
    const area = output.workArea;
    const current = tileHeights(column, output, this.env)[column.active]!;
    const proportion = (current + gaps) / (area.height - gaps);
    const height = (area.height - gaps) * (proportion + percent / 100) - gaps;
    this.othersToAuto(column, column.active, output);
    column.tiles[column.active]!.height = { fixed: Math.min(Math.max(Math.round(height), 1), 100000) };
    if (column.sizing === "maximized") column.sizing = "normal";
  }

  resetHeight(window?: number): void {
    const found = this.find(window);
    if (!found || found.floating) return;
    const column = found.workspace.columns[found.column]!;
    for (const [row, tile] of column.tiles.entries()) {
      if (column.tabbed || row === found.tile) tile.height = { auto: 1 };
    }
  }

  maximizeColumn(window?: number): void {
    const found = this.find(window);
    if (!found || found.floating) return;
    const { workspace, output } = found;
    const column = workspace.columns[found.column]!;
    const before = columnWidth(column, output, this.env);
    if (column.sizing === "maximized") {
      column.sizing = "normal";
      column.fullWidth = false;
    } else {
      column.fullWidth = !column.fullWidth;
    }
    column.preset = null;
    this.widthChanged(workspace, found.column, before, output);
  }

  /** Puts WINDOW's column into SIZING, or back to normal, expelling it from a shared column first. */
  setSizing(sizing: "fullscreen" | "maximized", window: number | undefined, value: boolean | undefined): void {
    let found = this.find(window);
    if (!found) return;
    const id = found.window;
    if (found.floating) {
      if (value === false) return;
      // A floating window goes fullscreen from the tiled layout and floats again after.
      this.toggleFloating(id);
      if (!this.state.refloat.includes(id)) this.state.refloat.push(id);
      found = this.find(id);
      if (!found) return;
    }
    let column = found.workspace.columns[found.column]!;
    const enter = value ?? column.sizing !== sizing;
    if (enter && column.sizing === sizing) return;
    if (!enter && column.sizing !== sizing) return;
    if (enter && column.tiles.length > 1 && !column.tabbed) {
      this.consumeOrExpel(1, id);
      found = this.find(id);
      if (!found) return;
      column = found.workspace.columns[found.column]!;
    }
    const { workspace, output } = found;
    const index = found.column;
    const before = columnWidth(column, output, this.env);
    if (enter) {
      if (index === workspace.active && sizing === "fullscreen" && column.sizing === "normal") {
        workspace.restoreOnUnfullscreen = workspace.view - strip(workspace, output, this.env).xs[index]!;
      }
      column.sizing = sizing;
      this.widthChanged(workspace, index, before, output);
      return;
    }
    column.sizing = "normal";
    const restore = workspace.restoreOnUnfullscreen;
    this.widthChanged(workspace, index, before, output);
    if (index === workspace.active && restore !== null) {
      workspace.view = strip(workspace, output, this.env).xs[index]! + restore;
      workspace.view = fitView(workspace, index, output, this.env);
      workspace.restoreOnUnfullscreen = null;
    }
    if (sizing === "fullscreen" && this.state.refloat.includes(id)) {
      this.state.refloat = this.state.refloat.filter((other) => other !== id);
      this.toggleFloating(id);
    }
  }

  expandColumn(): void {
    const found = this.activeColumn();
    if (!found) return;
    const { column, workspace, output, index } = found;
    if (column.sizing !== "normal" || column.fullWidth) return;
    const { indices, leftmost, taken } = visibleColumns(workspace, output, this.env);
    if (!indices.includes(index) || leftmost === null) return;
    const available = output.workArea.width - gaps - taken;
    if (available <= 0) return;
    if (indices.length === 1) {
      this.maximizeColumn();
      return;
    }
    const width = columnWidth(column, output, this.env) + available;
    this.setWidth(found, { fixed: width }, null);
    workspace.view = leftmost - gaps - output.workArea.x;
    workspace.view = fitView(workspace, index, output, this.env);
  }

  centerColumn(): void {
    const floating = this.activeFloater();
    if (floating) {
      const { floater, output } = floating;
      const box = floaterBox(floater, this.env);
      const area = output.workArea;
      floater.x = area.x + (area.width - box.width) / 2;
      floater.y = area.y + (area.height - box.height) / 2;
      return;
    }
    const found = this.activeColumn();
    if (found) found.workspace.view = centerView(found.workspace, found.index, found.output, this.env);
  }

  centerVisible(): void {
    const found = this.activeColumn();
    if (!found) return;
    const { workspace, output, index } = found;
    const { indices, leftmost, taken } = visibleColumns(workspace, output, this.env);
    if (!indices.includes(index) || leftmost === null) return;
    const free = output.workArea.width - taken + gaps;
    workspace.view = leftmost - free / 2 - output.workArea.x;
  }

  toggleFloating(window?: number): void {
    const found = this.find(window);
    if (!found) return;
    const { workspace, output } = found;
    const focused = workspaceFocus(workspace) === found.window;
    const area = output.workArea;
    if (found.floating) {
      const [floater] = workspace.floating.splice(found.tile, 1);
      const box = floaterBox(floater!, this.env);
      this.state.floated[found.window] = box;
      const at = workspace.columns.length ? workspace.active + 1 : 0;
      this.addColumn(workspace, at, newColumn(found.window, { fixed: box.width }), focused, output);
      if (focused || !workspace.floating.length) workspace.floatingActive = false;
      return;
    }
    const box = this.renderedBox(found.window)!;
    const remembered = this.state.floated[found.window];
    const width = remembered?.width ?? box.width;
    const height = remembered?.height ?? box.height;
    const x = remembered?.x ?? box.x + 50;
    const y = remembered?.y ?? box.y + 50;
    this.removeTile(workspace, found.column, found.tile, output);
    workspace.floating.push({
      window: found.window, width, height,
      x: Math.min(Math.max(x, area.x), area.x + area.width - Math.min(width, area.width) / 4),
      y: Math.min(Math.max(y, area.y), area.y + area.height - Math.min(height, area.height) / 4),
    });
    if (focused) workspace.floatingActive = true;
  }

  switchFocusFloating(): void {
    const here = this.current();
    if (!here) return;
    const { workspace } = here;
    if (workspace.floating.length && workspace.columns.length) workspace.floatingActive = !workspace.floatingActive;
  }

  toggleTabbed(): void {
    const found = this.activeColumn();
    if (!found) return;
    const { column } = found;
    column.tabbed = !column.tabbed;
    if (!column.tabbed && column.tiles.length > 1 && column.sizing !== "normal") column.sizing = "normal";
  }

  monitorFor(output?: string) {
    const name = output ?? this.state.activeOutput;
    const monitor = name === null ? undefined : this.state.monitors[name];
    const env = name === null ? undefined : this.output(name);
    return monitor && env ? { monitor, output: env } : null;
  }

  /** Moves the focused column, or floating window, to workspace INDEX of MONITOR. */
  moveColumnToWorkspace(monitor: Monitor, output: OutputEnv, target: number, focus = true): void {
    const source = monitor.workspaces[monitor.active]!;
    const destinationIndex = Math.max(0, Math.min(target, monitor.workspaces.length - 1));
    if (destinationIndex === monitor.active) return;
    const destination = monitor.workspaces[destinationIndex]!;
    if (source.floatingActive && source.floating.length) {
      const floater = source.floating.pop()!;
      if (!source.floating.length) source.floatingActive = false;
      destination.floating.push(floater);
      destination.floatingActive = true;
    } else {
      if (!source.columns.length) return;
      const column = this.removeColumn(source, source.active, output);
      const at = destination.columns.length ? destination.active + 1 : 0;
      this.addColumn(destination, at, column, true, output);
      destination.floatingActive = false;
    }
    if (focus) this.showWorkspace(monitor, destinationIndex);
    this.keepEmptyLast(monitor, output);
  }

  moveWorkspace(direction: Direction): void {
    const found = this.monitorFor();
    if (!found) return;
    const { monitor, output } = found;
    const to = monitor.active + direction;
    if (to < 0 || to >= monitor.workspaces.length) return;
    const list = monitor.workspaces;
    [list[to], list[monitor.active]] = [list[monitor.active]!, list[to]!];
    monitor.active = to;
    this.keepEmptyLast(monitor, output);
  }

  neighbourOutput(direction: Direction): OutputEnv | undefined {
    const index = this.env.outputs.findIndex((output) => output.name === this.state.activeOutput);
    return index < 0 ? undefined : this.env.outputs[index + direction];
  }

  moveColumnToMonitor(direction: Direction): void {
    const here = this.current();
    const target = this.neighbourOutput(direction);
    if (!here || !target) return;
    const destinationMonitor = this.state.monitors[target.name]!;
    const destination = destinationMonitor.workspaces[destinationMonitor.active]!;
    const { workspace, output, monitor } = here;
    if (workspace.floatingActive && workspace.floating.length) {
      const floater = workspace.floating.pop()!;
      if (!workspace.floating.length) workspace.floatingActive = false;
      floater.x += target.x - output.x;
      destination.floating.push(floater);
      destination.floatingActive = true;
    } else {
      if (!workspace.columns.length) return;
      const column = this.removeColumn(workspace, workspace.active, output);
      if (column.sizing === "maximized") column.sizing = "normal";
      const at = destination.columns.length ? destination.active + 1 : 0;
      this.addColumn(destination, at, column, true, target);
      destination.floatingActive = false;
    }
    this.dropIfEmpty(monitor, monitor.active);
    this.keepEmptyLast(destinationMonitor, target);
    this.state.activeOutput = target.name;
  }

  cleanWorkspaces(name: string): void {
    const monitor = this.state.monitors[name];
    if (!monitor) return;
    for (let index = monitor.workspaces.length - 2; index >= 0; index--) this.dropIfEmpty(monitor, index);
  }

  /** Lifts WINDOW out of the layout for a drag; `drop` puts it back. */
  lift(window: number): void {
    const found = this.find(window);
    if (!found || this.state.held) return;
    const { workspace, output, monitor } = found;
    // The view holds still while a window is dragged around, whatever its leaving does.
    const view = workspace.view;
    if (found.floating) {
      this.state.floated[window] = floaterBox(workspace.floating[found.tile]!, this.env);
      workspace.floating.splice(found.tile, 1);
      if (!workspace.floating.length) workspace.floatingActive = false;
      this.state.held = { window, width: { proportion: defaultWidth }, fullWidth: false };
    } else {
      const column = workspace.columns[found.column]!;
      if (column.sizing !== "normal") {
        const before = columnWidth(column, output, this.env);
        column.sizing = "normal";
        this.widthChanged(workspace, found.column, before, output);
      }
      const { width, fullWidth } = this.removeTile(workspace, found.column, found.tile, output);
      this.state.held = { window, width, fullWidth };
      if (!workspace.columns.length && workspace.floating.length) workspace.floatingActive = true;
      workspace.view = view;
      if (!workspace.columns.length) workspace.shift = view + gaps + output.workArea.x;
    }
    this.dropIfEmpty(monitor, found.workspaceIndex);
  }

  drop(action: Extract<NiriAction, { type: "drop" }>): void {
    const held = this.state.held;
    const output = this.output(action.output) ?? this.current()?.output;
    const monitor = output && this.state.monitors[output.name];
    if (!held || !output || !monitor) return;
    this.state.held = null;
    let index = monitor.workspaces.findIndex((workspace) => workspace.id === action.workspace);
    if (index < 0) {
      const last = monitor.workspaces.length - 1;
      index = Math.min(action.newAt ?? monitor.active, last);
      if (action.newAt !== undefined && index < last) {
        monitor.workspaces.splice(index, 0, newWorkspace(this.state, output));
        if (index <= monitor.active) monitor.active += 1;
      }
    }
    const workspace = monitor.workspaces[index]!;
    const { target } = action;
    const { window } = held;
    if (target.kind === "floating") {
      const remembered = this.state.floated[window];
      workspace.floating.push({ window, x: target.x, y: target.y, width: remembered?.width ?? null,
                                height: remembered?.height ?? null });
      workspace.floatingActive = true;
    } else if (target.kind === "column") {
      const column = newColumn(window, held.width, held.fullWidth);
      this.addColumn(workspace, Math.min(target.index, workspace.columns.length), column, true, output);
      workspace.floatingActive = false;
    } else {
      this.addTileToColumn(workspace, target.column, { window, height: { auto: 1 } }, true, output, target.index);
      workspace.floatingActive = false;
    }
    this.state.activeOutput = output.name;
    this.keepEmptyLast(monitor, output);
  }
}

/** Keeps a box of SIZE starting at START within AREA from OFFSET, preferring its start edge. */
function clampPreferStart(start: number, offset: number, area: number, size: number): number {
  return Math.max(offset, Math.min(start, offset + area - size));
}

/** The next preset from CURRENT's index, or from the size SIZE when it is none of them. */
function nextPreset(sizes: readonly number[], size: number, current: number | null, direction: Direction): number {
  const count = sizes.length;
  if (current !== null) return (current + direction + count) % count;
  if (direction > 0) {
    const index = sizes.findIndex((preset) => size + 1 < preset);
    return index < 0 ? 0 : index;
  }
  const index = sizes.findLastIndex((preset) => preset + 1 < size);
  return index < 0 ? count - 1 : index;
}

/** STATE as saved by any version of this world, with what it lacks filled in. */
export function normalizeState(state: NiriState | null | undefined): NiriState {
  return state && typeof state === "object" && state.monitors ? { ...initialNiriState, ...state } : initialNiriState;
}

export function niriReducer(state: NiriState, action: EnvAction): NiriState {
  const draft = new Draft(normalizeState(state), action.env);
  const run = () => {
    switch (action.type) {
      case "sync": return draft.sync(action.windows, action.instance);
      case "activate": return draft.activate(action.window);
      case "focusOutput":
        if (draft.state.monitors[action.output]) draft.state.activeOutput = action.output;
        return;
      case "focusColumn": return draft.focusColumn(action.to);
      case "focusWindow": return draft.focusWindow(action.direction, action.orWorkspace ?? false);
      case "moveColumn": return draft.moveColumn(action.to);
      case "moveWindow": return draft.moveWindow(action.direction);
      case "consumeOrExpel": return draft.consumeOrExpel(action.direction);
      case "consume": return draft.consume();
      case "expel": return draft.expel();
      case "presetWidth": return draft.presetWidth(action.direction);
      case "presetHeight": return draft.presetHeight();
      case "resetHeight": return draft.resetHeight(action.window);
      case "maximizeColumn": return draft.maximizeColumn(action.window);
      case "fullscreen": return draft.setSizing("fullscreen", action.window, action.value);
      case "maximizeToEdges": return draft.setSizing("maximized", action.window, action.value);
      case "expandColumn": return draft.expandColumn();
      case "centerColumn": return draft.centerColumn();
      case "centerVisible": return draft.centerVisible();
      case "adjustWidth": return draft.adjustWidth(action.percent);
      case "adjustHeight": return draft.adjustHeight(action.percent);
      case "toggleFloating": return draft.toggleFloating(action.window);
      case "switchFocusFloating": return draft.switchFocusFloating();
      case "toggleTabbed": return draft.toggleTabbed();
      case "focusWorkspace": {
        const found = draft.monitorFor(action.output);
        if (found) draft.showWorkspace(found.monitor, action.index);
        return;
      }
      case "focusWorkspaceRelative": {
        const found = draft.monitorFor(action.output);
        if (found) draft.showWorkspace(found.monitor, found.monitor.active + action.direction);
        return;
      }
      case "moveColumnToWorkspace": {
        const found = draft.monitorFor();
        if (!found) return;
        const target = action.index ?? found.monitor.active + (action.direction ?? 1);
        return draft.moveColumnToWorkspace(found.monitor, found.output, target);
      }
      case "moveWorkspace": return draft.moveWorkspace(action.direction);
      case "focusMonitor": {
        const target = draft.neighbourOutput(action.direction);
        if (target) draft.state.activeOutput = target.name;
        return;
      }
      case "moveColumnToMonitor": return draft.moveColumnToMonitor(action.direction);
      case "cleanWorkspaces": return draft.cleanWorkspaces(action.output);
      case "setView": {
        const monitor = draft.state.monitors[action.output];
        const workspace = monitor?.workspaces.find((candidate) => candidate.id === action.workspace);
        if (!workspace) return;
        if (action.active !== workspace.active) {
          workspace.restoreOnRemoval = null;
          workspace.restoreOnUnfullscreen = null;
        }
        workspace.view = action.view;
        workspace.active = Math.min(action.active, Math.max(0, workspace.columns.length - 1));
        return;
      }
      case "showWorkspace": {
        const monitor = draft.state.monitors[action.output];
        if (monitor) draft.showWorkspace(monitor, action.index);
        return;
      }
      case "resizeColumn": {
        const found = draft.find(action.window);
        if (!found || found.floating) return;
        const column = found.workspace.columns[found.column]!;
        const before = columnWidth(column, found.output, draft.env);
        column.width = { fixed: Math.max(1, Math.round(action.width)) };
        column.preset = null;
        column.fullWidth = false;
        const after = columnWidth(column, found.output, draft.env);
        if (found.column < found.workspace.active) found.workspace.shift -= after - before;
        if (found.column === found.workspace.active && action.fromLeft) found.workspace.view += after - before;
        return;
      }
      case "resizeTile": {
        const found = draft.find(action.window);
        if (!found || found.floating) return;
        const column = found.workspace.columns[found.column]!;
        draft.othersToAuto(column, found.tile, found.output);
        column.tiles[found.tile]!.height = { fixed: Math.max(1, Math.round(action.height)) };
        return;
      }
      case "fitActive": {
        const found = draft.find(action.window);
        if (!found || found.floating || found.column !== found.workspace.active) return;
        found.workspace.view = fitView(found.workspace, found.column, found.output, draft.env);
        return;
      }
      case "placeFloating": {
        const found = draft.find(action.window);
        if (!found?.floating) return;
        const floater = found.workspace.floating[found.tile]!;
        floater.x = action.x;
        floater.y = action.y;
        if (action.width !== undefined) floater.width = Math.max(1, Math.round(action.width));
        if (action.height !== undefined) floater.height = Math.max(1, Math.round(action.height));
        return;
      }
      case "lift": return draft.lift(action.window);
      case "drop": return draft.drop(action);
    }
  };
  run();
  return draft.state;
}
