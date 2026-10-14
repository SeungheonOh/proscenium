import { useMemo, useRef, useState } from "react";
import { focus, Window, type Rectangle, type StageDragEvent } from "proscenium";
import { TilingWindow, windowMotion } from "../components/TilingWindow.js";
import type { HyprAction, HyprState } from "../hypr/state.js";
import { placeWindows, workspaceWindows } from "../hypr/tiling.js";
import { bump } from "../lib/animations.js";
import { boxAt } from "../lib/geometry.js";
import { moved } from "./geometry.js";
import { useMeta } from "./MetaProvider.js";
import type { RoomViewProps } from "./Rooms.js";
import { hyprWorkspace } from "./worlds.js";

/**
 * A hypr room: windows tiled and floating as the hypr world places them on a
 * workspace, the focused one above, a dragged one above that. Inside the room
 * focus follows the mouse; on the canvas a click picks.
 */
export function HyprRoom({ room, state, size, entered, carry, onLift }: RoomViewProps<HyprState>) {
  const { env, present, focused, bumped, act, reveal } = useMeta();
  const [lifted, setLifted] = useState<number | null>(null);
  const dragStart = useRef({ x: 0, y: 0 });
  const boxes = useMemo(() => placeWindows(state, [env.room], present), [state, env, present]);
  const dispatch = (action: HyprAction) => act(room, { kind: "hypr", action });

  const isFloating = (id: number) => Boolean(state.floating[id]);
  // Bottom to top: tiled, floating, the focused one, a dragged one.
  const windows = workspaceWindows(state, hyprWorkspace, present).sort(
    (a, b) =>
      Number(isFloating(a)) - Number(isFloating(b)) ||
      Number(a === focused) - Number(b === focused) ||
      Number(a === lifted) - Number(b === lifted),
  );

  /** A floating window stays where it is dropped; a tiled one swaps with the tile under its center. */
  function drop(id: number, box: Rectangle, { x, y }: StageDragEvent) {
    onLift(null);
    setLifted(null);
    if (!moved(dragStart.current, { x, y }) || carry(id, { ...box, x, y })) return;
    if (isFloating(id)) {
      dispatch({ type: "float", window: id, box: { ...box, x, y } });
      return;
    }
    const tiles = new Map(
      windows.filter((other) => !isFloating(other) && boxes.has(other)).map((other) => [other, boxes.get(other)!]),
    );
    const other = boxAt(tiles, x + box.width / 2, y + box.height / 2, id);
    if (other !== null) dispatch({ type: "swap", first: id, second: other });
  }

  const fullscreen = state.fullscreen;
  return (
    <>
      {windows.map((id) => {
        const box = boxes.get(id) ?? { x: 0, y: 0, width: 960, height: 640 };
        return (
          <TilingWindow
            key={id}
            id={id}
            box={box}
            floating={isFloating(id)}
            focused={id === focused}
            animate={bumped?.window === id ? bump(bumped.direction, bumped.count) : null}
            onPointerEnter={entered ? () => focus(id) : undefined}
            onDragStart={({ x, y }) => {
              dragStart.current = { x, y };
              setLifted(id);
              onLift(room);
            }}
            onDrop={(event) => drop(id, box, event)}
            onResize={({ x, y, width, height }) =>
              dispatch({ type: "float", window: id, box: { x, y, width, height } })
            }
            onFullscreen={(value) => dispatch({ type: "fullscreen", window: value ? id : null })}
            onActivate={() => reveal(id)}
          />
        );
      })}
      {fullscreen !== null && present.has(fullscreen) && state.workspaces[fullscreen] === hyprWorkspace && (
        <Window
          window={fullscreen}
          width={size.width}
          height={size.height}
          fullscreen
          transition={windowMotion}
          onFullscreenRequest={({ value }) =>
            dispatch({ type: "fullscreen", window: value ? fullscreen : null })
          }
        />
      )}
    </>
  );
}
