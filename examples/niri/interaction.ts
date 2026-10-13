/**
 * Input that moves the layout continuously, as niri's grabs and gestures do:
 * swiping or dragging the view, swiping between workspaces and into the
 * overview, and dragging windows around. Each follows its input exactly and
 * settles with niri's snapping and the input's own velocity.
 */

import { warpPointer } from "proscenium";
import { dragThreshold, gaps, overview as overviewConfig, pullOutDistance, workspaceGap } from "./config.js";
import { rubberBand, rubberBandSlope, SwipeTracker, type Driven, type LiveMap } from "./live.js";
import {
  dropTarget, floaterBox, placeTiles, snapView, strip, type Env, type OutputEnv, type Workspace,
} from "./model.js";
import type { Drag, NiriContextValue } from "./NiriProvider.js";
import { locate, type InsertTarget } from "./state.js";

export type Niri = () => NiriContextValue;

/** Shows DRAG for WINDOW, to its own tile and to whatever draws the drag under the pointer. */
function putDrag(niri: NiriContextValue, window: number, drag: Drag | undefined): void {
  niri.drags.set(window, drag);
  niri.drags.set("current", drag);
}

/**
 * Lets go of a driven value: LIVE shows TARGET once with the input's VELOCITY,
 * as APPLY makes it the layout's own, then lets the layout show it.
 */
function release(live: LiveMap<Driven>, key: string | number, target: number, velocity: number,
                 apply: () => void): void {
  live.set(key, { value: target, velocity });
  apply();
  // Without the velocity the same target moves on as it was.
  setTimeout(() => live.set(key, undefined), 0);
}

function outputOf(env: Env, name: string): OutputEnv | undefined {
  return env.outputs.find((output) => output.name === name);
}

/** Touchpad travel that scrolls one work area width, as in niri. */
const touchpadViewTravel = 1200;
/** Touchpad travel that switches one workspace, or opens the overview. */
const touchpadWorkspaceTravel = 300;

/** Scrolling one workspace's columns by touchpad or by dragging. */
export class ViewGesture {
  private readonly tracker = new SwipeTracker();

  private constructor(private readonly niri: Niri, readonly output: string, readonly workspace: number,
                      private readonly start: number, private readonly norm: number) {}

  /** On OUTPUT's shown workspace, or the one with id WORKSPACE; none without columns. */
  static begin(niri: Niri, output: string, touchpad: boolean, workspace?: number): ViewGesture | null {
    const { state, envRef, views, overview } = niri();
    const monitor = state.monitors[output];
    const target = workspace === undefined
      ? monitor?.workspaces[monitor.active]
      : monitor?.workspaces.find((candidate) => candidate.id === workspace);
    const area = outputOf(envRef.current, output)?.workArea;
    if (!target || !area || !target.columns.length) return null;
    const start = views.get(target.id)?.value ?? target.view;
    // In the overview, input moves the zoomed-out workspace as far as it shows.
    const zoom = overview ? overviewConfig.zoom : 1;
    return new ViewGesture(niri, output, target.id, start,
                           (touchpad ? area.width / touchpadViewTravel : 1) / zoom);
  }

  /** DELTA moves the view right; content follows the fingers, so swipes pass it negated. */
  update(delta: number): void {
    this.tracker.push(delta);
    this.niri().views.set(this.workspace, { value: this.start + this.tracker.position * this.norm });
  }

  end(): void {
    const { velocity, end } = this.tracker.release();
    const { state, envRef, views, act } = this.niri();
    const workspace = state.monitors[this.output]?.workspaces.find((candidate) => candidate.id === this.workspace);
    const output = outputOf(envRef.current, this.output);
    const current = this.start + this.tracker.position * this.norm;
    if (!workspace || !output) {
      views.set(this.workspace, undefined);
      return;
    }
    const snap = snapView(workspace, output, envRef.current, current, this.start + end * this.norm);
    release(views, this.workspace, snap.view, velocity * this.norm,
            () => act({ type: "setView", output: this.output, workspace: this.workspace, ...snap }));
  }
}

/** Swiping between an output's workspaces, which slide as one stack. */
export class WorkspaceGesture {
  private readonly tracker = new SwipeTracker();

  private constructor(private readonly niri: Niri, readonly output: string, private readonly start: number,
                      private readonly total: number, private readonly scale: number,
                      private readonly min: number, private readonly max: number,
                      private readonly zoom: number) {}

  static begin(niri: Niri, output: string, touchpad: boolean): WorkspaceGesture | null {
    const { state, envRef, stacks, overview } = niri();
    const monitor = state.monitors[output];
    const height = outputOf(envRef.current, output)?.height;
    if (!monitor || !height) return null;
    const zoom = overview ? overviewConfig.zoom : 1;
    const start = stacks.get(output)?.value ?? monitor.active;
    const last = monitor.workspaces.length - 1;
    // Outside the overview a swipe reaches only the neighbours of where it began.
    const min = overview ? 0 : Math.max(monitor.active - 1, 0);
    const max = overview ? last : Math.min(monitor.active + 1, last);
    const total = touchpad ? touchpadWorkspaceTravel : height * (1 + workspaceGap);
    const scale = touchpad ? (zoom - 1) / 2.5 + 1 : zoom;
    return new WorkspaceGesture(niri, output, start, total, scale, min, max, zoom);
  }

  private index(): number {
    return rubberBand(this.start + this.tracker.position / this.total, this.min, this.max, 0.5,
                      0.05 / this.zoom);
  }

  /** DELTA goes down the stack. */
  update(delta: number): void {
    this.tracker.push(delta / this.scale);
    this.niri().stacks.set(this.output, { value: this.index() });
  }

  end(): void {
    const { velocity, end } = this.tracker.release();
    const { stacks, act } = this.niri();
    const position = this.start + this.tracker.position / this.total;
    const target = Math.round(Math.min(Math.max(this.start + end / this.total, this.min), this.max));
    const speed = velocity / this.total * rubberBandSlope(position, this.min, this.max, 0.5, 0.05 / this.zoom);
    release(stacks, this.output, target, speed,
            () => act({ type: "showWorkspace", output: this.output, index: target }));
  }
}

/** Swiping the overview open or closed with four fingers. */
export class OverviewGesture {
  private readonly tracker = new SwipeTracker();

  private constructor(private readonly niri: Niri, private readonly start: number) {}

  static begin(niri: Niri): OverviewGesture {
    const { zoom, overview, setOverview } = niri();
    const start = zoom.get("all")?.value ?? (overview ? 1 : 0);
    setOverview(true);
    return new OverviewGesture(niri, start);
  }

  private progress(): number {
    return rubberBand(this.start + this.tracker.position / touchpadWorkspaceTravel, 0, 1, 0.5, 0.05);
  }

  /** DELTA opens: fingers moving up. */
  update(delta: number): void {
    this.tracker.push(delta);
    this.niri().zoom.set("all", { value: this.progress() });
  }

  end(): void {
    const { velocity, end } = this.tracker.release();
    const { zoom, setOverview } = this.niri();
    const position = this.start + this.tracker.position / touchpadWorkspaceTravel;
    const open = Math.round(Math.min(Math.max(this.start + end / touchpadWorkspaceTravel, 0), 1)) === 1;
    const speed = velocity / touchpadWorkspaceTravel * rubberBandSlope(position, 0, 1, 0.5, 0.05);
    release(zoom, "all", open ? 1 : 0, speed, () => setOverview(open));
  }
}

/** A point on the row of outputs: an output and a position in its logical pixels. */
export interface PointerAt {
  output: string;
  x: number;
  y: number;
}

/** Where on OUTPUT's stack the point (X, Y) falls: a workspace row, or a gap before workspace NEWAT. */
export function workspaceAt(niri: NiriContextValue, output: OutputEnv, x: number, y: number):
  { workspace: Workspace; index: number; localX: number; localY: number } | { newAt: number } | null {
  const monitor = niri.state.monitors[output.name];
  if (!monitor) return null;
  const zoom = niri.overview ? overviewConfig.zoom : 1;
  const height = output.height;
  const step = height * (1 + workspaceGap);
  // Workspaces are stacked unzoomed around the shown one, then zoomed about the output's center.
  const unzoomedX = output.width / 2 + (x - output.width / 2) / zoom;
  const unzoomedY = height / 2 + (y - height / 2) / zoom;
  const offset = unzoomedY + monitor.active * step;
  const index = Math.floor(offset / step);
  const within = offset - index * step;
  if (!niri.overview) {
    const workspace = monitor.workspaces[monitor.active]!;
    return { workspace, index: monitor.active, localX: unzoomedX, localY: unzoomedY };
  }
  if (index < 0) return { newAt: 0 };
  if (index >= monitor.workspaces.length) return { newAt: monitor.workspaces.length };
  if (within > height) return { newAt: index + 1 };
  return { workspace: monitor.workspaces[index]!, index, localX: unzoomedX, localY: within };
}

type DragPhase = "pressed" | "view" | "starting" | "moving";

/**
 * Dragging a window: niri's move grab. A press becomes a drag after 8 pixels;
 * a tiled window then resists until pulled 256 pixels, leaves the layout at
 * three-quarter opacity and follows the pointer, and drops into the nearest gap.
 */
export class WindowDrag {
  private phase: DragPhase = "pressed";
  private view: ViewGesture | null = null;
  private readonly startX: number;
  private readonly startY: number;
  private last: PointerAt;
  private readonly edge: EdgeScroll;

  constructor(private readonly niri: Niri, readonly window: number, at: PointerAt,
              /** A title bar drag: sideways on a tiled window scrolls the view instead. */
              private readonly viewOffset: boolean) {
    this.edge = new EdgeScroll(niri);
    const origin = this.global(at);
    this.startX = origin.x;
    this.startY = origin.y;
    this.last = at;
  }

  private global(at: PointerAt): { x: number; y: number } {
    const output = outputOf(this.niri().envRef.current, at.output);
    return { x: (output?.x ?? 0) + at.x, y: at.y };
  }

  /** Whether the press turned into a drag. */
  get dragging(): boolean {
    return this.phase !== "pressed";
  }

  move(at: PointerAt): void {
    const niri = this.niri();
    const point = this.global(at);
    const lastPoint = this.global(this.last);
    this.last = at;
    const dx = point.x - this.startX;
    const dy = point.y - this.startY;
    if (this.phase === "pressed") {
      if (Math.hypot(dx, dy) < dragThreshold) return;
      const place = locate(niri.state, this.window);
      if (!place) return;
      if (this.viewOffset && !place.floating && Math.abs(dx) > Math.abs(dy)) {
        this.view = ViewGesture.begin(this.niri, place.output, false,
                                      niri.state.monitors[place.output]!.workspaces[place.workspace]!.id);
        this.phase = this.view ? "view" : "starting";
        this.view?.update(-dx);
        return;
      }
      this.phase = place.floating ? "moving" : "starting";
      if (place.floating) this.lift(at);
    }
    if (this.phase === "view") {
      this.view?.update(-(point.x - lastPoint.x));
      return;
    }
    const zoom = niri.overview ? overviewConfig.zoom : 1;
    if (this.phase === "starting") {
      // The window holds on, ever more loosely, until pulled far enough.
      const distance = (dx * dx + dy * dy) / (zoom * zoom);
      const stretch = distance / pullOutDistance ** 2;
      const factor = stretch / (2 * stretch + 1);
      if (distance < pullOutDistance ** 2) {
        putDrag(niri, this.window, { ...this.dragAt(at), lifted: false, dx: dx * factor, dy: dy * factor });
        return;
      }
      this.phase = "moving";
      this.lift(at);
      return;
    }
    const current = niri.drags.get(this.window);
    if (current) putDrag(niri, this.window, { ...current, output: at.output, x: at.x, y: at.y });
    if (current && !current.floating) this.edge.follow(at);
  }

  private dragAt(at: PointerAt) {
    const niri = this.niri();
    const env = niri.envRef.current;
    const place = locate(niri.state, this.window);
    const window = env.windows[this.window];
    let box = { x: 0, y: 0, width: window?.width ?? 1, height: window?.height ?? 1 };
    if (place) {
      const output = outputOf(env, place.output)!;
      const workspace = niri.state.monitors[place.output]!.workspaces[place.workspace]!;
      if (place.floating) box = floaterBox(workspace.floating[place.tile]!, env);
      else {
        const tile = placeTiles(workspace, output, env).find((placed) => placed.window === this.window)!;
        box = { x: tile.x - workspace.view, y: tile.y, width: tile.width, height: tile.height };
      }
    }
    const start = workspaceAt(niri, outputOf(env, at.output)!, at.x, at.y);
    const localX = start && "localX" in start ? start.localX : at.x;
    const localY = start && "localY" in start ? start.localY : at.y;
    return {
      window: this.window, output: at.output, x: at.x, y: at.y,
      ratioX: Math.min(Math.max((localX - box.x) / box.width, 0), 1),
      ratioY: Math.min(Math.max((localY - box.y) / box.height, 0), 1),
      width: box.width, height: box.height, floating: place?.floating ?? false,
    };
  }

  private lift(at: PointerAt): void {
    const niri = this.niri();
    const base = niri.drags.get(this.window) ?? { ...this.dragAt(at), dx: 0, dy: 0 };
    putDrag(niri, this.window, { ...base, output: at.output, x: at.x, y: at.y, lifted: true });
    niri.act({ type: "lift", window: this.window });
  }

  /** Where the window would land if dropped now. */
  target(): { output: string; workspace: number | null; newAt?: number; target: InsertTarget } | null {
    const niri = this.niri();
    const drag = niri.drags.get(this.window);
    if (!drag?.lifted) return null;
    return dropAt(niri, drag);
  }

  release(): void {
    const niri = this.niri();
    if (this.phase === "view") {
      this.view?.end();
      return;
    }
    this.edge.stop();
    const drop = this.target();
    putDrag(niri, this.window, undefined);
    if (this.phase === "moving" && drop) niri.act({ type: "drop", ...drop });
  }
}

/** Where WORKSPACE's view is shown now: a gesture's, else its own. */
export function liveView(niri: NiriContextValue, workspace: Workspace): Workspace {
  const driven = niri.views.get(workspace.id);
  return driven ? { ...workspace, view: driven.value } : workspace;
}

/**
 * niri's edge scrolling while a window is dragged: within 30 pixels of the
 * work area's side, after 100 ms there, the view scrolls toward that side, up
 * to 1500 pixels a second at the very edge.
 */
class EdgeScroll {
  private timer: NodeJS.Timeout | null = null;
  private since = 0;
  private last = 0;
  private speed = 0;
  private target: { output: string; workspace: number } | null = null;

  constructor(private readonly niri: Niri) {}

  follow(at: PointerAt): void {
    const niri = this.niri();
    const output = outputOf(niri.envRef.current, at.output);
    const under = output && workspaceAt(niri, output, at.x, at.y);
    if (!output || !under || !("workspace" in under)) return this.pause();
    const area = output.workArea;
    const zoom = niri.overview ? overviewConfig.zoom : 1;
    const x = at.x - area.x;
    const trigger = Math.min(30, area.width / 2);
    const depth = x < trigger ? -(trigger - x) : area.width - x < trigger ? trigger - (area.width - x) : 0;
    if (!depth) return this.pause();
    this.speed = depth / trigger / zoom * 1500;
    this.target = { output: output.name, workspace: under.workspace.id };
    if (this.timer) return;
    this.since = this.last = performance.now();
    this.timer = setInterval(() => this.tick(), 16);
  }

  private tick(): void {
    const now = performance.now();
    const elapsed = (now - this.last) / 1000;
    this.last = now;
    if (now - this.since < 100 || !this.target) return;
    const niri = this.niri();
    const env = niri.envRef.current;
    const output = outputOf(env, this.target.output);
    const workspace = niri.state.monitors[this.target.output]?.workspaces
      .find((candidate) => candidate.id === this.target!.workspace);
    if (!output || !workspace) return;
    const { xs } = strip(workspace, output, env);
    const view = liveView(niri, workspace).view + this.speed * elapsed;
    // Scrolling reaches a screen of empty space past either end, to drop there.
    const least = xs[0]! - output.workArea.width;
    const most = Math.max(least, xs[xs.length - 1]! - gaps - output.workArea.x);
    niri.views.set(workspace.id, { value: Math.min(Math.max(view, least), most) });
  }

  private pause(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Ends scrolling, keeping the view where it went. */
  stop(): void {
    this.pause();
    const target = this.target;
    this.target = null;
    if (!target) return;
    const niri = this.niri();
    const driven = niri.views.get(target.workspace);
    const workspace = niri.state.monitors[target.output]?.workspaces.find((candidate) => candidate.id === target.workspace);
    if (!driven || !workspace) return;
    niri.act({ type: "setView", output: target.output, workspace: target.workspace, view: driven.value,
               active: workspace.active });
    niri.views.set(target.workspace, undefined);
  }
}

/** Where the dragged window DRAG drops: the gap or floating spot under the pointer. */
export function dropAt(niri: NiriContextValue, drag: Drag) {
  const env = niri.envRef.current;
  const output = outputOf(env, drag.output) ?? env.outputs[0];
  if (!output) return null;
  const at = workspaceAt(niri, output, drag.x, drag.y);
  if (!at) return null;
  if ("newAt" in at) {
    return { output: output.name, workspace: null, newAt: at.newAt,
             target: { kind: "column", index: 0 } as InsertTarget };
  }
  if (drag.floating) {
    const x = at.localX - drag.ratioX * drag.width;
    const y = at.localY - drag.ratioY * drag.height;
    return { output: output.name, workspace: at.workspace.id, target: { kind: "floating", x, y } as InsertTarget };
  }
  const target = dropTarget(liveView(niri, at.workspace), output, env, at.localX, at.localY);
  return { output: output.name, workspace: at.workspace.id, target: target as InsertTarget };
}

const edgeTop = 1;
const edgeBottom = 2;
const edgeLeft = 4;
const edgeRight = 8;

/** A window's box on its output as the layout shows it at rest. */
export function shownBox(niri: NiriContextValue, window: number) {
  const env = niri.envRef.current;
  const place = locate(niri.state, window);
  if (!place) return null;
  const output = outputOf(env, place.output);
  const workspace = niri.state.monitors[place.output]?.workspaces[place.workspace];
  if (!output || !workspace) return null;
  if (place.floating) return { ...floaterBox(workspace.floating[place.tile]!, env), output, place };
  const tile = placeTiles(workspace, output, env).find((placed) => placed.window === window)!;
  return { x: tile.x - workspace.view, y: tile.y, width: tile.width, height: tile.height, output, place };
}

/** Edges a press at (X, Y) on BOX resizes: the outer thirds, none in the middle. */
export function edgesAt(box: { x: number; y: number; width: number; height: number }, x: number, y: number): number {
  const across = (x - box.x) / box.width;
  const down = (y - box.y) / box.height;
  return (across < 1 / 3 ? edgeLeft : across > 2 / 3 ? edgeRight : 0)
    | (down < 1 / 3 ? edgeTop : down > 2 / 3 ? edgeBottom : 0);
}

/** Resizing a window by an edge or corner: niri's resize grab, unanimated. */
export class WindowResize {
  private readonly startX: number;
  private readonly startY: number;
  private readonly original: { x: number; y: number; width: number; height: number; floating: boolean };
  private readonly workspace: number | null;

  constructor(private readonly niri: Niri, readonly window: number, at: PointerAt, readonly edges: number) {
    const current = niri();
    const box = shownBox(current, window);
    this.startX = at.x;
    this.startY = at.y;
    this.original = box ? { ...box, floating: box.place.floating } : { x: 0, y: 0, width: 1, height: 1, floating: false };
    this.workspace = box ? current.state.monitors[box.place.output]!.workspaces[box.place.workspace]!.id : null;
    if (this.workspace !== null) current.resizing.set(this.workspace, true);
  }

  move(at: PointerAt): void {
    const { act } = this.niri();
    const dx = at.x - this.startX;
    const dy = at.y - this.startY;
    const { original, edges, window } = this;
    const width = original.width + (edges & edgeLeft ? -dx : edges & edgeRight ? dx : 0);
    const height = original.height + (edges & edgeTop ? -dy : edges & edgeBottom ? dy : 0);
    if (original.floating) {
      act({
        type: "placeFloating", window,
        x: edges & edgeLeft ? original.x + original.width - width : original.x,
        y: edges & edgeTop ? original.y + original.height - height : original.y,
        width: edges & (edgeLeft | edgeRight) ? width : undefined,
        height: edges & (edgeTop | edgeBottom) ? height : undefined,
      });
      return;
    }
    if (edges & (edgeLeft | edgeRight)) act({ type: "resizeColumn", window, width, fromLeft: Boolean(edges & edgeLeft) });
    if (edges & (edgeTop | edgeBottom)) act({ type: "resizeTile", window, height });
  }

  release(): void {
    const { resizing, act } = this.niri();
    if (this.workspace !== null) resizing.set(this.workspace, undefined);
    act({ type: "fitActive", window: this.window });
  }
}

/** Mod+middle drag: the view sideways, or the workspaces up and down, once the drag shows which. */
export class SpatialDrag {
  private gesture: ViewGesture | WorkspaceGesture | null = null;
  private recognized = false;
  private last: PointerAt;

  constructor(private readonly niri: Niri, private readonly start: PointerAt,
              /** The workspace to scroll, by id; else the output's shown one. */
              private readonly workspace?: number,
              /** Scroll the view at once, as a right drag in the overview does. */
              viewOnly = false) {
    this.last = start;
    if (viewOnly) {
      this.recognized = true;
      this.gesture = ViewGesture.begin(niri, start.output, false, workspace);
    }
  }

  move(at: PointerAt): void {
    const dx = at.x - this.start.x;
    const dy = at.y - this.start.y;
    if (!this.recognized) {
      if (Math.hypot(dx, dy) < dragThreshold) return;
      this.recognized = true;
      this.gesture = Math.abs(dx) > Math.abs(dy)
        ? ViewGesture.begin(this.niri, this.start.output, false, this.workspace)
        : WorkspaceGesture.begin(this.niri, this.start.output, false);
      if (this.gesture instanceof ViewGesture) this.gesture.update(-dx);
      else this.gesture?.update(-dy);
      this.last = at;
      return;
    }
    const stepX = at.x - this.last.x;
    const stepY = at.y - this.last.y;
    this.last = at;
    if (this.gesture instanceof ViewGesture) this.gesture.update(-stepX);
    else this.gesture?.update(-stepY);
    this.wrap(at);
  }

  /** At the output's edge along the drag, the pointer comes back in from the other side. */
  private wrap(at: PointerAt): void {
    const output = outputOf(this.niri().envRef.current, at.output);
    if (!output || !this.gesture) return;
    const sideways = this.gesture instanceof ViewGesture;
    const position = sideways ? at.x : at.y;
    const size = sideways ? output.width : output.height;
    if (position > 0 && position < size - 1) return;
    const across = position <= 0 ? size - 2 : 1;
    this.last = sideways ? { ...at, x: across } : { ...at, y: across };
    warpPointer(at.output, this.last.x, this.last.y);
  }

  release(): void {
    this.gesture?.end();
  }
}

interface PointerSession {
  move(at: PointerAt): void;
  release(): void;
}

/** The one pointer grab at a time: a drag, a resize or a spatial drag, fed by whoever captured the pointer. */
export class Pointer {
  current: PointerSession | null = null;
  private lastResize: { window: number; edges: number; time: number } | null = null;

  constructor(private readonly niri: Niri) {}

  drag(window: number, at: PointerAt, viewOffset: boolean): WindowDrag {
    const drag = new WindowDrag(this.niri, window, at, viewOffset);
    this.current = drag;
    return drag;
  }

  /** Starts a resize, or on a quick second one over the same edges resets the size instead. */
  resize(window: number, at: PointerAt, edges: number): void {
    const now = performance.now();
    const last = this.lastResize;
    this.lastResize = { window, edges, time: now };
    const box = shownBox(this.niri(), window);
    if (last && last.window === window && now - last.time < 400 && (last.edges & edges) && box && !box.place.floating) {
      this.lastResize = null;
      const shared = last.edges & edges;
      const { act } = this.niri();
      if (shared & (edgeLeft | edgeRight)) {
        act({ type: "activate", window });
        act({ type: "maximizeColumn", window });
      }
      if (shared & (edgeTop | edgeBottom)) act({ type: "resetHeight", window });
      return;
    }
    if (!edges) return;
    this.current = new WindowResize(this.niri, window, at, edges);
  }

  spatial(at: PointerAt, workspace?: number, viewOnly = false): void {
    this.current = new SpatialDrag(this.niri, at, workspace, viewOnly);
  }

  move(at: PointerAt): void {
    this.current?.move(at);
  }

  release(): void {
    const current = this.current;
    this.current = null;
    current?.release();
  }
}
