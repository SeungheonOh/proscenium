/**
 * A niri room's strip, moving as niri's does: the group of its tiled windows
 * scrolls with niri's view spring and slides between workspaces with its
 * workspace spring. Under a swipe it follows the fingers at once, and let go,
 * settles carrying their speed. Only these subscribe to what a swipe drives, so
 * the fingers move one group and nothing else renders.
 */

import type { ReactNode } from "react";
import { Group, instant, tween, type Transition } from "proscenium";
import { roomOutput } from "../meta/worlds.js";
import { easeOutCubic, motion as niriMotion } from "../niri/config.js";
import { drivenTarget, useLive } from "../niri/live.js";
import type { CanvasRoom, Rooms, Strip } from "./useRooms.js";

/**
 * A key or a click moving the strip to another column or workspace: a short ease-out that stops dead,
 * with no spring's long tail. Only a swipe let go settles on a spring, carrying the fingers' speed.
 */
export const stripSlide = tween(0.2, easeOutCubic);
export const stackSlide = tween(0.25, easeOutCubic);

/** How far a swipe has the strip from where its layout puts it, and how it gets there. */
function useDriven(rooms: Rooms, strip: Strip): { dx: number; dy: number; transition: Transition } {
  const view = useLive(rooms.views, strip.workspace);
  const stack = useLive(rooms.stacks, roomOutput);
  const stacked = strip.spread ? stack : undefined;
  if (rooms.dragging === strip.room.id) return { dx: 0, dy: 0, transition: instant };
  const [, x] = view ? drivenTarget(view, niriMotion.view, -1) : [0, stripSlide];
  const [, y] = stacked ? drivenTarget(stacked, niriMotion.workspaceSwitch, -rooms.step) : [0, stackSlide];
  return {
    dx: view ? strip.view - view.value : 0,
    dy: stacked ? (strip.active - stacked.value) * rooms.step : 0,
    transition: { default: stripSlide, x, y },
  };
}

/**
 * The strip's windows, in their group, cut off at the room's sides as niri's output cuts its strip:
 * only what is in the view shows, a column half in it half shown. From outside the room it is cut at
 * the room's top and bottom too, its other workspaces folded behind; in it, they stack up and down in
 * full. A window in hand is never cut, so it can be carried out.
 */
export function RoomStrip({ rooms, strip, children }: { rooms: Rooms; strip: Strip; children: ReactNode }) {
  const { dx, dy, transition } = useDriven(rooms, strip);
  const { room, spread } = strip;
  const carrying = rooms.held !== null && strip.windows.has(rooms.held);
  // Spread out, the cut reaches far enough up and down for any stack.
  const reach = spread ? 64 * rooms.step : 0;
  const top = room.y - reach;
  return (
    <Group x={room.x} y={top} width={rooms.size.width} height={rooms.size.height + 2 * reach} clip={!carrying}>
      <Group x={strip.x - room.x + dx} y={strip.y - top + dy} transition={transition}>{children}</Group>
    </Group>
  );
}

/** What goes with a niri room's stack as a swipe drives it up and down: its frame and header. */
export function RoomShift({ rooms, room, children }: { rooms: Rooms; room: CanvasRoom; children: ReactNode }) {
  const strip = rooms.stripOf(room);
  if (!strip) return <>{children}</>;
  return <StackShift rooms={rooms} strip={strip}>{children}</StackShift>;
}

function StackShift({ rooms, strip, children }: { rooms: Rooms; strip: Strip; children: ReactNode }) {
  const { dy, transition } = useDriven(rooms, strip);
  return <Group y={dy} transition={transition}>{children}</Group>;
}
