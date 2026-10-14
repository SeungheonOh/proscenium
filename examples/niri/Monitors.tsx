import { memo, useEffect, useRef, useState } from "react";
import {
  boxPaint,
  Group,
  instant,
  Rect,
  scale,
  Screen,
  Window,
  type Motion,
  type OutputInfo,
  type Shading,
  type StagePointerEvent,
  type StageRequestEvent,
} from "proscenium";
import {
  backdropColor,
  draggedOpacity,
  focusRing,
  insertHintColor,
  motion,
  overview as overviewConfig,
  tabIndicator,
  workspaceColor,
  workspaceGap,
} from "./config.js";
import { drivenTarget, useLive } from "./live.js";
import {
  floaterBox, hintBox, placeTiles, type Env, type OutputEnv, type PlacedTile, type Workspace,
  workspaceFocus,
} from "./model.js";
import { dropAt, liveView, type WindowDrag } from "./interaction.js";
import { useNiri, type Drag } from "./NiriProvider.js";
import { locate } from "./state.js";

/** Rounds to OUTPUT's physical pixels, as niri places everything. */
function pixel(value: number, output: OutputInfo): number {
  return Math.round(value * output.scale) / output.scale;
}

/** How far the clip around a workspace reaches sideways: it crops only above and below. */
const reach = 1e5;

const unmoving = instant;

/**
 * The focus ring around a window, or the black behind a fullscreen one that is
 * too small for the output. niri fills the ring in behind the window; drawn as
 * an outline it cannot tint the window while it fades in or out.
 */
export function frame(color: string | null, fullscreen: boolean): Shading {
  const transparent = "#00000000";
  const ring = color ?? transparent;
  return {
    id: "frame", shader: boxPaint, transition: unmoving,
    uniforms: fullscreen
      ? { fill: "#000000", fillEnd: "#000000" }
      : { border: focusRing.width, outset: focusRing.width, borderColor: ring, borderColorEnd: ring },
  };
}

/** Windows seen at mount are the session's; any after that open with niri's animation. */
const seenAtStart = new Set<number>();
let started = false;

export function Monitors() {
  const { outputs, state, envRef } = useNiri();
  if (!started && outputs.length) {
    started = true;
    for (const id of Object.keys(envRef.current.windows)) seenAtStart.add(Number(id));
  }
  return (
    <>
      {outputs.map((output) => (
        state.monitors[output.name] && <MonitorView key={output.name} output={output} />
      ))}
    </>
  );
}

function MonitorView({ output }: { output: OutputInfo }) {
  const niri = useNiri();
  const { state, overview, zoom, stacks, act, envRef } = niri;
  const monitor = state.monitors[output.name]!;
  const height = output.height;
  const step = height * (1 + workspaceGap);
  const zoomDriven = useLive(zoom, "all");
  const [progress, zoomMotion] = zoomDriven
    ? drivenTarget(zoomDriven, motion.overview, -(1 - overviewConfig.zoom))
    : [overview ? 1 : 0, motion.overview];
  const factor = 1 - progress * (1 - overviewConfig.zoom);
  const stackDriven = useLive(stacks, output.name);
  const [index, stackMotion] = stackDriven
    ? drivenTarget(stackDriven, motion.workspaceSwitch, -step)
    : [monitor.active, motion.workspaceSwitch];
  const outputEnv = envRef.current.outputs.find((candidate) => candidate.name === output.name);
  if (!outputEnv) return null;
  const focusOutput = () => act({ type: "focusOutput", output: output.name });

  return (
    <Screen output={output.name}>
      <Rect width={output.width} height={height} fill={backdropColor} onPointerDown={focusOutput} />
      <Group
        width={output.width}
        height={height}
        transform={progress !== 0 ? [scale(factor)] : undefined}
        transition={zoomMotion}
      >
        <NewWorkspaceHint output={output} index={index} />
        {monitor.workspaces.map((workspace, position) => (
          <WorkspaceView
            key={workspace.id}
            workspace={workspace}
            output={output}
            outputEnv={outputEnv}
            y={pixel((position - index) * step, output)}
            motion={stackMotion}
            shown={position === monitor.active}
          />
        ))}
      </Group>
      <DragLayer output={output} factor={factor} />
    </Screen>
  );
}

interface WorkspaceViewProps {
  workspace: Workspace;
  output: OutputInfo;
  outputEnv: OutputEnv;
  y: number;
  motion: Motion;
  shown: boolean;
}

function WorkspaceView({ workspace, output, outputEnv, y, motion: stackMotion, shown }: WorkspaceViewProps) {
  const niri = useNiri();
  const { overview, act, setOverview, env, state, focused } = niri;
  const norm = output.height / 1080;
  const shadow = overviewConfig.shadow;
  const outputActive = state.activeOutput === output.name;
  const ringColor = outputActive ? focusRing.active : focusRing.inactive;
  const focus = workspaceFocus(workspace);
  // On the shown workspace of the focused output the ring marks the keyboard focus.
  const ringed = shown && outputActive ? focused : focus;

  function handleDown(event: StagePointerEvent) {
    if (!overview) {
      act({ type: "focusOutput", output: output.name });
      return;
    }
    if (event.button === 273) {
      // A right drag in the overview scrolls the workspace's columns.
      niri.pointer.spatial({ output: event.output, x: event.screenX, y: event.screenY }, workspace.id, true);
      return;
    }
    if (event.button === 272) {
      // A click on a workspace in the overview goes there and closes it.
      act({ type: "focusOutput", output: output.name });
      const index = state.monitors[output.name]!.workspaces.findIndex((other) => other.id === workspace.id);
      act({ type: "focusWorkspace", index, output: output.name });
      setOverview(false);
    }
  }

  return (
    <Group y={y} transition={stackMotion}>
      <Rect
        width={output.width}
        height={output.height}
        fill={workspaceColor}
        shadow={{
          blur: shadow.blur * norm, spread: shadow.spread * norm, y: shadow.y * norm,
          color: overview ? shadow.color : "#00000000",
        }}
        transition={motion.overview}
        onPointerDown={handleDown}
        onPointerMove={(event) => niri.pointer.move({ output: event.output, x: event.screenX, y: event.screenY })}
        onPointerUp={() => niri.pointer.release()}
      />
      <Group x={-reach} width={output.width + 2 * reach} height={output.height} clip>
        <Group x={reach}>
          <Strip workspace={workspace} output={output} outputEnv={outputEnv} env={env}
                 ringed={ringed} ringColor={ringColor} />
          {workspace.floating.map((floater) => (
            <FloatingView key={floater.window} window={floater.window} box={floaterBox(floater, env)}
                          sized={floater.width !== null} output={output}
                          ring={floater.window === ringed && workspace.floatingActive ? ringColor : null} />
          ))}
        </Group>
      </Group>
    </Group>
  );
}

interface StripProps {
  workspace: Workspace;
  output: OutputInfo;
  outputEnv: OutputEnv;
  env: Env;
  ringed: number | null;
  ringColor: string;
}

/** The scrolling strip of columns, with the view moving over it. */
function Strip({ workspace, output, outputEnv, env, ringed, ringColor }: StripProps) {
  const { views } = useNiri();
  const driven = useLive(views, workspace.id);
  const [view, viewMotion] = driven ? drivenTarget(driven, motion.view, -1) : [workspace.view, motion.view];
  const tiles = placeTiles(workspace, outputEnv, env);
  const active = workspace.columns[workspace.active];
  const activeWindow = active?.tiles[active.active]?.window;
  // niri draws the active column above the others, and its active tile on top.
  const order = [...tiles].sort((a, b) =>
    Number(a.column === workspace.active) - Number(b.column === workspace.active)
    || Number(a.window === activeWindow) - Number(b.window === activeWindow));
  const ringShown = !workspace.floatingActive || !workspace.floating.length;

  return (
    <Group x={-pixel(view, output)} transition={viewMotion}>
      {order.map((tile) => {
        const column = workspace.columns[tile.column]!;
        return (
          <TileView
            key={tile.window}
            tile={tile}
            output={output}
            fullscreen={column.sizing === "fullscreen"}
            maximized={column.sizing === "maximized"}
            tabbed={column.tabbed}
            ring={ringShown && tile.window === ringed && column.sizing === "normal" ? ringColor : null}
          />
        );
      })}
      {workspace.columns.map((column, index) => column.tabbed && column.sizing === "normal" && (
        <TabIndicator
          key={column.tiles[0]!.window}
          tiles={tiles.filter((tile) => tile.column === index)}
          activeRow={column.active}
          columnActive={index === workspace.active}
        />
      ))}
      <InsertHint workspace={workspace} outputEnv={outputEnv} env={env} output={output} />
    </Group>
  );
}

interface TileViewProps {
  tile: PlacedTile;
  output: OutputInfo;
  fullscreen: boolean;
  maximized: boolean;
  tabbed: boolean;
  ring: string | null;
}

/** True for a moment after a window first appears, while it plays niri's open animation. */
function useOpening(window: number): boolean {
  const [opening, setOpening] = useState(() => !seenAtStart.has(window));
  useEffect(() => {
    if (!opening) return;
    const timer = setTimeout(() => setOpening(false), 200);
    return () => clearTimeout(timer);
  }, []);
  return opening;
}

const opened = { opacity: 0, transform: [scale(0.5)] };
export const closed = {
  opacity: 0, transform: [scale(0.8)],
  shaders: { frame: { borderColor: "#00000000", borderColorEnd: "#00000000" } },
};

const TileView = memo(function TileView({ tile, output, fullscreen, maximized, tabbed, ring }: TileViewProps) {
  const niri = useNiri();
  const { act, drags, overview } = niri;
  const drag = useLive(drags, tile.window);
  const opening = useOpening(tile.window);
  const holding = drag && !drag.lifted;
  const fade = tabbed ? motion.windowMovement : opening ? motion.windowOpen : motion.windowClose;
  const place = holding ? instant : motion.windowMovement;

  return (
    <Window
      window={tile.window}
      x={pixel(tile.x + (holding ? drag.dx : 0), output)}
      y={pixel(tile.y + (holding ? drag.dy : 0), output)}
      width={tile.width}
      height={tile.height}
      fullscreen={fullscreen}
      maximized={maximized}
      opacity={tile.hidden ? 0 : 1}
      shaders={[frame(ring, fullscreen)]}
      initial={opening ? opened : undefined}
      exit={closed}
      transition={{ default: motion.windowResize, x: place, y: place, opacity: fade, transform: fade }}
      onActivateRequest={() => act({ type: "activate", window: tile.window })}
      onFullscreenRequest={(event) => act({ type: "fullscreen", window: tile.window, value: event.value })}
      onMaximizeRequest={(event) => act({ type: "maximizeToEdges", window: tile.window, value: event.value })}
      {...titleBarHandlers(niri, tile.window)}
    >
      {overview && <OverviewCatcher window={tile.window} width={tile.width} height={tile.height} />}
    </Window>
  );
});

interface FloatingViewProps {
  window: number;
  box: { x: number; y: number; width: number; height: number };
  sized: boolean;
  output: OutputInfo;
  ring: string | null;
}

function FloatingView({ window, box, sized, output, ring }: FloatingViewProps) {
  const niri = useNiri();
  const { act, overview } = niri;
  const opening = useOpening(window);
  const fade = opening ? motion.windowOpen : motion.windowClose;
  return (
    <Window
      window={window}
      x={pixel(box.x, output)}
      y={pixel(box.y, output)}
      width={sized ? box.width : undefined}
      height={sized ? box.height : undefined}
      shaders={[frame(ring, false)]}
      initial={opening ? opened : undefined}
      exit={closed}
      transition={{ default: motion.windowMovement, opacity: fade, transform: fade }}
      onActivateRequest={() => act({ type: "activate", window })}
      onFullscreenRequest={(event) => act({ type: "fullscreen", window, value: event.value })}
      {...titleBarHandlers(niri, window)}
    >
      {overview && <OverviewCatcher window={window} width={box.width} height={box.height} />}
    </Window>
  );
}

/** A client's own title bar and edges drag and resize its window as Mod+left and right drags do. */
function titleBarHandlers(niri: ReturnType<typeof useNiri>, window: number) {
  const at = (event: { output?: string; screenX?: number; screenY?: number }) =>
    ({ output: event.output!, x: event.screenX!, y: event.screenY! });
  return {
    onMoveRequest: (event: StageRequestEvent) => {
      if (event.output !== undefined) niri.pointer.drag(window, at(event), true);
    },
    onResizeRequest: (event: StageRequestEvent) => {
      if (event.output !== undefined) niri.pointer.resize(window, at(event), event.edges ?? 0);
    },
    onPointerMove: (event: StagePointerEvent) => niri.pointer.move(at(event)),
    onPointerUp: () => niri.pointer.release(),
  };
}

/** In the overview a window takes no input: a press picks it, a drag moves it. */
function OverviewCatcher({ window, width, height }: { window: number; width: number; height: number }) {
  const niri = useNiri();
  const drag = useRef<WindowDrag | null>(null);
  return (
    <Rect
      width={width}
      height={height}
      onPointerDown={(event) => {
        event.stopPropagation();
        const at = { output: event.output, x: event.screenX, y: event.screenY };
        if (event.button === 273) {
          const place = locate(niri.state, window);
          const id = place && niri.state.monitors[place.output]?.workspaces[place.workspace]?.id;
          niri.pointer.spatial(at, id ?? undefined, true);
          return;
        }
        if (event.button !== 272) return;
        drag.current = niri.pointer.drag(window, at, false);
      }}
      onPointerMove={(event) => niri.pointer.move({ output: event.output, x: event.screenX, y: event.screenY })}
      onPointerUp={() => {
        const pressed = drag.current;
        drag.current = null;
        if (!pressed) {
          niri.pointer.release();
          return;
        }
        if (pressed.dragging) {
          niri.pointer.release();
          return;
        }
        niri.pointer.current = null;
        // A click goes to the window, closing the overview onto its workspace.
        const place = locate(niri.state, window);
        if (place) niri.act({ type: "focusOutput", output: place.output });
        niri.act({ type: "activate", window });
        niri.setOverview(false);
      }}
    />
  );
}

interface TabIndicatorProps {
  tiles: PlacedTile[];
  activeRow: number;
  columnActive: boolean;
}

/** niri's tab indicator: a bar left of a tabbed column, a segment per tab. */
export function TabIndicator({ tiles, activeRow, columnActive }: TabIndicatorProps) {
  const first = tiles[0];
  if (!first) return null;
  const side = Math.max(...tiles.map((tile) => tile.height));
  const length = Math.round(side * tabIndicator.length);
  const count = tiles.length;
  const each = Math.floor(length / count);
  const top = first.y + Math.round((side - length) / 2);
  return (
    <Group x={first.x - tabIndicator.gap - tabIndicator.width} y={top} opacity={columnActive ? 1 : 0.5}
           initial={{ transform: [scale(1, 0)] }} transition={motion.windowMovement}>
      {tiles.map((tile, row) => (
        <Rect
          key={tile.window}
          y={row * each}
          width={tabIndicator.width}
          height={row === count - 1 ? length - row * each : each}
          fill={row === activeRow ? focusRing.active : focusRing.inactive}
        />
      ))}
    </Group>
  );
}

interface InsertHintProps {
  workspace: Workspace;
  outputEnv: OutputEnv;
  env: Env;
  output: OutputInfo;
}

/** Where a dragged window would drop, while one is dragged over this workspace. */
function InsertHint({ workspace, outputEnv, env, output }: InsertHintProps) {
  const niri = useNiri();
  const drag = useLive(niri.drags, "current");
  const drop = drag?.lifted && !drag.floating ? dropAt(niri, drag) : null;
  if (!drop || drop.workspace !== workspace.id || drop.target.kind === "floating") return null;
  const box = hintBox(liveView(niri, workspace), outputEnv, env, drop.target);
  return (
    <Rect x={pixel(box.x, output)} y={pixel(box.y, output)} width={box.width} height={box.height}
          fill={insertHintColor} />
  );
}

/** In the overview, a window dragged between workspaces makes a new one there. */
function NewWorkspaceHint({ output, index }: { output: OutputInfo; index: number }) {
  const niri = useNiri();
  const drag = useLive(niri.drags, "current");
  const drop = drag?.lifted && drag.output === output.name ? dropAt(niri, drag) : null;
  if (!drop || drop.newAt === undefined) return null;
  const height = output.height;
  const gap = height * workspaceGap;
  const top = (drop.newAt - index) * height * (1 + workspaceGap) - gap * 0.1 - gap * 0.8;
  return (
    <Rect x={output.width * 0.125} y={pixel(top, output)} width={output.width * 0.75} height={gap * 0.8}
          fill={insertHintColor} />
  );
}

/** The dragged window, out of the layout, under the pointer on its output. */
function DragLayer({ output, factor }: { output: OutputInfo; factor: number }) {
  const niri = useNiri();
  const drag = useLive(niri.drags, "current");
  if (!drag?.lifted || drag.output !== output.name) return null;
  return <DraggedWindow drag={drag} factor={factor} />;
}

function DraggedWindow({ drag, factor }: { drag: Drag; factor: number }) {
  return (
    <Group x={drag.x} y={drag.y} width={1} height={1} originX={0} originY={0}
           transform={factor !== 1 ? [scale(factor)] : undefined}>
      <Window
        window={drag.window}
        x={-drag.ratioX * drag.width}
        y={-drag.ratioY * drag.height}
        width={drag.width}
        height={drag.height}
        opacity={drag.floating ? 1 : draggedOpacity}
        shaders={[frame(focusRing.inactive, false)]}
        transition={{ default: instant, opacity: motion.windowMovement }}
      />
    </Group>
  );
}
