/**
 * The touchpad and the wheel while the camera is in a room, in place of the
 * canvas's pan and zoom, as in the metaworld:
 *
 *   Pinch out                       leave the room
 *   Three-finger swipe              niri: sideways the columns follow the fingers, up and down the
 *                                   workspaces do, and settle as niri's do; hypr: the next room that way
 *   Super+wheel                     niri: up and down the next workspace, sideways the next column;
 *                                   hypr: the next room
 */

import { useRef } from "react";
import { focus, GestureBinding, WheelBinding, type StageGestureEvent, type StageWheelEvent } from "proscenium";
import type { Direction } from "../lib/geometry.js";
import { roomOutput } from "../meta/worlds.js";
import { ViewGesture, WorkspaceGesture } from "../niri/interaction.js";
import type { Rooms } from "./useRooms.js";

/** A pinch that ends below this scale leaves the room. */
const pinchOut = 0.8;
/** How far a three-finger swipe must travel to change rooms. */
const swipeThreshold = 120;
/** Travel before a swipe's direction is decided. */
const decide = 16;
/** Smooth-scroll travel that counts as one wheel notch. */
const notch = 50;

export function RoomGestures({ rooms }: { rooms: Rooms }) {
  const swipe = useRef<{ x: number; y: number; view: ViewGesture | WorkspaceGesture | null; decided: boolean } | null>(null);
  const wheel = useRef(0);
  const entered = rooms.rooms.find((room) => room.id === rooms.entered);
  if (!entered) return null;
  const niri = entered.world.kind === "niri";

  function toward(direction: Direction) {
    const next = rooms.roomToward(direction);
    if (next !== null) rooms.enter(next);
  }

  function begin() {
    swipe.current = { x: 0, y: 0, view: null, decided: false };
  }

  function update(event: StageGestureEvent) {
    const now = swipe.current;
    if (!now) return;
    now.x += event.dx;
    now.y += event.dy;
    if (!now.decided) {
      if (now.x ** 2 + now.y ** 2 < decide ** 2) return;
      now.decided = true;
      // A niri room's swipes are niri's own: sideways its view follows the fingers, up and down its workspaces.
      // The distance that decided which is not applied.
      const host = niri ? rooms.gestureHost() : null;
      if (host) {
        const live = () => rooms.gestureHost() ?? host;
        now.view = Math.abs(now.x) > Math.abs(now.y)
          ? ViewGesture.begin(live, roomOutput, true)
          : WorkspaceGesture.begin(live, roomOutput, true);
      }
      return;
    }
    // Content follows the fingers.
    if (now.view instanceof ViewGesture) now.view.update(-event.dx);
    else now.view?.update(-event.dy);
  }

  function end(event: StageGestureEvent) {
    const now = swipe.current;
    swipe.current = null;
    if (!now) return;
    if (now.view) {
      now.view.end();
      return;
    }
    if (event.cancelled || Math.max(Math.abs(now.x), Math.abs(now.y)) < swipeThreshold) return;
    // A swipe left brings in the room to the right.
    toward(Math.abs(now.x) > Math.abs(now.y) ? [-Math.sign(now.x), 0] : [0, -Math.sign(now.y)]);
  }

  function onWheel(event: StageWheelEvent) {
    // Notches count one each; smooth scrolling, once it has gone a notch's way.
    const notched = event.source === "wheel" || event.source === "wheel-tilt";
    wheel.current += notched ? (event.discrete || Math.sign(event.delta)) * notch : event.delta;
    if (Math.abs(wheel.current) < notch) return;
    const step = Math.sign(wheel.current) as 1 | -1;
    wheel.current = 0;
    if (niri) {
      const focused = rooms.act(entered!.id, {
        kind: "niri",
        action: event.orientation === "vertical"
          ? { type: "focusWorkspaceRelative", direction: step, output: roomOutput }
          : { type: "focusColumn", to: step > 0 ? "right" : "left" },
      });
      if (focused !== null) focus(focused);
    } else {
      // Rooms in reading order.
      const order = [...rooms.rooms].sort((a, b) => a.y - b.y || a.x - b.x);
      const next = order[order.findIndex((room) => room.id === entered!.id) + step];
      if (next) rooms.enter(next.id);
    }
  }

  return (
    <>
      <GestureBinding gesture="pinch" fingers={2}
                      onEnd={({ scale, cancelled }) => !cancelled && (scale ?? 1) < pinchOut && rooms.leave()} />
      <GestureBinding gesture="swipe" fingers={3} onBegin={begin} onUpdate={update} onEnd={end} />
      <WheelBinding modifiers="super" onWheel={onWheel} />
    </>
  );
}
