import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  focus,
  Group,
  Window,
  type Rectangle,
  type StageDragEvent,
  type StageResizeEvent,
} from "proscenium";
import { focusRing, motion, workspaceGap } from "../niri/config.js";
import { SwipeBinding, WheelBinds } from "../niri/Input.js";
import type { GestureHost } from "../niri/interaction.js";
import { drivenTarget, LiveMap, useLive, type Driven } from "../niri/live.js";
import {
  dropTarget,
  floaterBox,
  placeTiles,
  workspaceFocus,
  type PlacedTile,
  type Workspace,
} from "../niri/model.js";
import { closed, frame, TabIndicator } from "../niri/Monitors.js";
import { useWorkspaceCleanup } from "../niri/NiriProvider.js";
import {
  allWindows,
  focusedWindow,
  niriReducer,
  type NiriAction,
  type NiriState,
} from "../niri/state.js";
import { moved } from "./geometry.js";
import { useMeta } from "./MetaProvider.js";
import type { RoomViewProps } from "./Rooms.js";
import { roomOutput } from "./worlds.js";

/**
 * A niri room: the room is niri's output, with its stack of workspaces, each a
 * strip of columns as niri lays them out, cut off at the room's edges, with
 * niri's focus ring and tab indicators. The room's world picks the focus while
 * the room has the keyboard, and a click on one of its windows picks for it.
 * In the room, three-finger swipes and Super+wheel are niri's: sideways along
 * the columns, up and down the workspaces.
 */
export function NiriRoom({ room, state, size, carry, onLift }: RoomViewProps<NiriState>) {
  const { env, focused, keyRoom, activeRoom, act, reveal } = useMeta();
  const [lifted, setLifted] = useState<number | null>(null);
  const dragStart = useRef({ x: 0, y: 0 });
  const [live] = useState(() => ({ views: new LiveMap<Driven>(), stacks: new LiveMap<Driven>() }));
  const run = (action: NiriAction) => act(room, { kind: "niri", action });
  const engaged = keyRoom === room;
  const desired = focusedWindow(state);
  const placed = useMemo(() => new Set(allWindows(state)), [state]);

  // What niri's gestures read and change: this room's world, as it is when they do.
  const host = useRef<GestureHost | null>(null);
  host.current = { state, envRef: { current: env }, act: run, overview: false, ...live };
  const gestures = useCallback(() => host.current!, []);

  useWorkspaceCleanup(state, run);
  useEffect(() => {
    if (engaged && desired !== null && desired !== focused) focus(desired);
  }, [desired]);
  useEffect(() => {
    if (focused !== null && placed.has(focused) && focused !== desired) {
      run({ type: "activate", window: focused });
    }
  }, [focused]);

  const monitor = state.monitors[roomOutput];
  const step = size.height * (1 + workspaceGap);
  const stackDriven = useLive(live.stacks, roomOutput);
  const [index, stackMotion] = stackDriven
    ? drivenTarget(stackDriven, motion.workspaceSwitch, -step)
    : [monitor?.active ?? 0, motion.workspaceSwitch];
  if (!monitor) return null;
  const ring = engaged ? focusRing.active : focusRing.inactive;

  function lift(window: number, { x, y }: StageDragEvent) {
    dragStart.current = { x, y };
    setLifted(window);
    onLift(room);
  }

  /** Dropped in the room, a tiled window joins the layout where its middle is, as niri's drag does. */
  function dropTile(workspace: Workspace, tile: PlacedTile, { x, y }: StageDragEvent) {
    onLift(null);
    setLifted(null);
    const box = { x: x - workspace.view, y, width: tile.width, height: tile.height };
    if (!moved(dragStart.current, { x, y }) || carry(tile.window, box)) return;
    const held = niriReducer(state, { type: "lift", window: tile.window, env });
    const target = held.monitors[roomOutput]?.workspaces.find((other) => other.id === workspace.id);
    if (!target) return;
    const at = dropTarget(target, env.room, env, box.x + box.width / 2, box.y + box.height / 2);
    run({ type: "lift", window: tile.window });
    run({ type: "drop", output: roomOutput, workspace: target.id, target: at });
  }

  function dropFloating(window: number, box: Rectangle, { x, y }: StageDragEvent) {
    onLift(null);
    setLifted(null);
    if (!moved(dragStart.current, { x, y }) || carry(window, { ...box, x, y })) return;
    run({ type: "placeFloating", window, x, y });
  }

  /** Super+right drag sizes a tiled window's column and its share of it. */
  function resizeTile(tile: PlacedTile, { width, height }: StageResizeEvent) {
    if (Math.round(width) !== tile.width) run({ type: "resizeColumn", window: tile.window, width });
    if (Math.round(height) !== tile.height) run({ type: "resizeTile", window: tile.window, height });
  }

  const requests = (window: number) => ({
    onActivate: () => reveal(window),
    onFullscreen: (value: boolean) => run({ type: "fullscreen", window, value }),
    onMaximize: (value: boolean) => run({ type: "maximizeToEdges", window, value }),
  });

  function renderWorkspace(workspace: Workspace, position: number) {
    const tiles = placeTiles(workspace, env.room, env);
    const active = workspace.columns[workspace.active];
    const activeWindow = active?.tiles[active.active]?.window;
    // niri draws the active column above the others, its active tile on top, and a dragged window above all.
    const order = [...tiles].sort(
      (a, b) =>
        Number(a.window === lifted) - Number(b.window === lifted) ||
        Number(a.column === workspace.active) - Number(b.column === workspace.active) ||
        Number(a.window === activeWindow) - Number(b.window === activeWindow),
    );
    const ringed = workspaceFocus(workspace);
    const ringShown = !workspace.floatingActive || !workspace.floating.length;
    return (
      <Group key={workspace.id} y={(position - index) * step} transition={stackMotion}>
        <Strip workspace={workspace} views={live.views}>
          {order.map((tile) => {
            const column = workspace.columns[tile.column]!;
            const ringOn = ringShown && tile.window === ringed && column.sizing === "normal";
            return (
              <Tile
                key={tile.window}
                window={tile.window}
                box={tile}
                fullscreen={column.sizing === "fullscreen"}
                maximized={column.sizing === "maximized"}
                hidden={tile.hidden}
                tabbed={column.tabbed}
                ring={ringOn ? ring : null}
                onDragStart={(event) => lift(tile.window, event)}
                onDrop={(event) => dropTile(workspace, tile, event)}
                onResize={(event) => resizeTile(tile, event)}
                {...requests(tile.window)}
              />
            );
          })}
          {workspace.columns.map(
            (column, index) =>
              column.tabbed &&
              column.sizing === "normal" && (
                <TabIndicator
                  key={column.tiles[0]!.window}
                  tiles={tiles.filter((tile) => tile.column === index)}
                  activeRow={column.active}
                  columnActive={index === workspace.active}
                />
              ),
          )}
        </Strip>
        {workspace.floating.map((floater) => {
          const box = floaterBox(floater, env);
          const ringOn = workspace.floatingActive && floater.window === ringed;
          return (
            <Tile
              key={floater.window}
              window={floater.window}
              box={box}
              sized={floater.width !== null}
              ring={ringOn ? ring : null}
              onDragStart={(event) => lift(floater.window, event)}
              onDrop={(event) => dropFloating(floater.window, box, event)}
              onResize={({ x, y, width, height }) =>
                run({ type: "placeFloating", window: floater.window, x, y, width, height })
              }
              {...requests(floater.window)}
            />
          );
        })}
      </Group>
    );
  }

  return (
    <>
      {/* Past the room's edges, columns and workspaces are cut off, unless a window is carried out. */}
      <Group width={size.width} height={size.height} clip={lifted === null}>
        {monitor.workspaces.map(
          (workspace, position) =>
            (lifted === null || position === monitor.active) && renderWorkspace(workspace, position),
        )}
      </Group>
      {activeRoom === room && (
        <>
          <SwipeBinding niri={gestures} output={roomOutput} />
          <WheelBinds act={run} />
        </>
      )}
    </>
  );
}

/** A workspace's columns under its view: the workspace's own, or a swipe's while one drives it. */
function Strip({ workspace, views, children }: { workspace: Workspace; views: LiveMap<Driven>; children: ReactNode }) {
  const driven = useLive(views, workspace.id);
  const [view, viewMotion] = driven ? drivenTarget(driven, motion.view, -1) : [workspace.view, motion.view];
  return (
    <Group x={-view} transition={viewMotion}>
      {children}
    </Group>
  );
}

interface TileProps {
  window: number;
  box: Rectangle;
  /** Whether the window is given the box's size; a floating one keeps its own until it is sized. */
  sized?: boolean;
  fullscreen?: boolean;
  maximized?: boolean;
  /** A background tab. */
  hidden?: boolean;
  tabbed?: boolean;
  ring: string | null;
  onDragStart: (event: StageDragEvent) => void;
  onDrop: (event: StageDragEvent) => void;
  onResize: (event: StageResizeEvent) => void;
  onActivate: () => void;
  onFullscreen: (value: boolean) => void;
  onMaximize: (value: boolean) => void;
}

/** A window as niri shows it: placed by its springs, with its focus ring. */
function Tile({ window, box, sized = true, fullscreen = false, maximized = false, hidden = false,
                tabbed = false, ring, onDragStart, onDrop, onResize, onActivate, onFullscreen,
                onMaximize }: TileProps) {
  const fade = tabbed ? motion.windowMovement : motion.windowClose;
  return (
    <Window
      window={window}
      x={box.x}
      y={box.y}
      width={sized ? box.width : undefined}
      height={sized ? box.height : undefined}
      fullscreen={fullscreen}
      maximized={maximized}
      opacity={hidden ? 0 : 1}
      movable
      resizable
      shaders={[frame(ring, fullscreen)]}
      exit={closed}
      transition={{ default: motion.windowResize, x: motion.windowMovement, y: motion.windowMovement,
                    opacity: fade, transform: fade }}
      onDragStart={onDragStart}
      onDragEnd={onDrop}
      onResizeEnd={onResize}
      onActivateRequest={onActivate}
      onFullscreenRequest={(event) => onFullscreen(Boolean(event.value))}
      onMaximizeRequest={(event) => onMaximize(Boolean(event.value))}
    />
  );
}
