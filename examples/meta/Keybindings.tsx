import { useRef } from "react";
import {
  close,
  focus,
  GestureBinding,
  getCamera,
  launch,
  PointerBinding,
  Shortcut,
  WheelBinding,
  type Rectangle,
} from "proscenium";
import { directions, neighbour, type Direction } from "../lib/geometry.js";
import { terminal } from "../lib/settings.js";
import { roomAt, roomGap } from "./geometry.js";
import { useMeta } from "./MetaProvider.js";

/** How far a three-finger swipe must travel to change rooms. */
const swipeThreshold = 120;
/** A pinch that ends below this scale leaves the room. */
const pinchOut = 0.8;
const roomKeys = [1, 2, 3, 4, 5, 6, 7, 8, 9];

/** Window management keys, and mouse and touchpad bindings for the canvas and rooms. */
export function Keybindings() {
  const meta = useMeta();
  const { state, dispatch, size, boxes, focused, activeRoom } = meta;
  const { rectOf, enter, addRoom, bump } = meta;
  const swipe = useRef({ dx: 0, dy: 0 });
  const inRoom = activeRoom !== null;

  /** Wraps an action on the focused window, doing nothing while none has focus. */
  const onFocused = (action: (window: number) => void) => () => {
    if (focused !== null) action(focused);
  };

  /** Every room's box on the canvas. */
  const roomRects = () => new Map(state.rooms.map((room) => [room.id, rectOf(room.id)]));

  /** Boxes of a room's windows, in its coordinates. */
  function roomBoxes(room: number): Map<number, Rectangle> {
    return new Map([...boxes].filter(([id]) => state.roomOf[id] === room));
  }

  /** Every window's box on the canvas. */
  function canvasBoxes(): Map<number, Rectangle> {
    return new Map(
      [...boxes].map(([id, box]) => {
        const room = rectOf(state.roomOf[id]!);
        return [id, { ...box, x: box.x + room.x, y: box.y + room.y }];
      }),
    );
  }

  /** The room `number` (1–9) in the order rooms were made. */
  const numbered = (number: number) => state.rooms[number - 1]?.id;

  /** The nearest room that way, by where rooms sit on the canvas. */
  const roomToward = (room: number, direction: Direction) =>
    neighbour(roomRects(), room, direction);

  function focusToward(direction: Direction) {
    if (!inRoom) {
      const all = canvasBoxes();
      const next = focused === null ? all.keys().next().value : neighbour(all, focused, direction);
      if (next != null) focus(next);
      return;
    }
    const here = roomBoxes(activeRoom);
    const start = focused !== null && here.has(focused) ? focused : null;
    const next = start === null ? here.keys().next().value : neighbour(here, start, direction);
    if (next != null) {
      focus(next);
      return;
    }
    // Past the room's edge lies the next room that way.
    const room = roomToward(activeRoom, direction);
    if (room !== null) enter(room);
    else if (focused !== null) bump(focused, direction);
  }

  /** Swaps with the neighbour in the room, or carries the window into the next room that way. */
  function moveToward(window: number, direction: Direction) {
    const room = state.roomOf[window];
    if (room === undefined) return;
    const next = inRoom ? neighbour(roomBoxes(room), window, direction) : null;
    if (next !== null) {
      dispatch({ type: "swap", first: window, second: next });
      return;
    }
    const target = roomToward(room, direction);
    if (target === null) {
      bump(window, direction);
      return;
    }
    dispatch({ type: "move", window, room: target });
    if (inRoom) {
      enter(target);
      focus(window);
    }
  }

  function toggleFloating(window: number) {
    const box = boxes.get(window);
    dispatch({ type: "float", window, box: state.floating[window] || !box ? null : box });
  }

  function toggleFullscreen(window: number) {
    dispatch({ type: "fullscreen", window: state.fullscreen === window ? null : window });
  }

  /** Leaves the room, or enters the focused window's room, else the one in view. */
  function toggleRoom() {
    if (inRoom) {
      enter(null);
      return;
    }
    const camera = getCamera();
    const inView = camera ? roomAt(state.rooms, size, camera.x, camera.y)?.id : undefined;
    enter((focused !== null ? state.roomOf[focused] : undefined) ?? inView ?? state.current);
  }

  /** A new room: beside this one and entered, or on the canvas where the view is. */
  function newRoom() {
    if (inRoom) {
      const here = rectOf(activeRoom);
      enter(addRoom(here.x + here.width + roomGap(size), here.y));
      return;
    }
    const camera = getCamera();
    if (camera) addRoom(camera.x - size.width / 2, camera.y - size.height / 2);
  }

  const layoutRoom = activeRoom ?? (focused !== null ? state.roomOf[focused] : undefined);
  const orderOf = (room: number) => state.rooms.findIndex((candidate) => candidate.id === room);

  return (
    <>
      <PointerBinding button="left" modifiers="super" action="move" />
      <PointerBinding button="right" modifiers="super" action="resize" />

      {inRoom ? (
        <>
          <WheelBinding
            modifiers="super"
            onWheel={({ delta }) => {
              const next = state.rooms[orderOf(activeRoom) + Math.sign(delta)];
              if (next) enter(next.id);
            }}
          />
          <GestureBinding
            gesture="pinch"
            fingers={2}
            onEnd={({ scale, cancelled }) => !cancelled && scale < pinchOut && enter(null)}
          />
          <GestureBinding
            gesture="swipe"
            fingers={3}
            onBegin={() => {
              swipe.current = { dx: 0, dy: 0 };
            }}
            onUpdate={({ dx, dy }) => {
              swipe.current.dx += dx;
              swipe.current.dy += dy;
            }}
            onEnd={({ cancelled }) => {
              const { dx, dy } = swipe.current;
              if (cancelled || Math.max(Math.abs(dx), Math.abs(dy)) < swipeThreshold) return;
              // Content follows the fingers, so a swipe left brings in the room to the right.
              const direction: Direction =
                Math.abs(dx) > Math.abs(dy) ? [-Math.sign(dx), 0] : [0, -Math.sign(dy)];
              const room = roomToward(activeRoom, direction);
              if (room !== null) enter(room);
            }}
          />
        </>
      ) : (
        <>
          <WheelBinding modifiers="super" action="zoom" />
          <GestureBinding gesture="pinch" fingers={2} action="zoom" />
          <GestureBinding gesture="swipe" fingers={3} action="pan" />
          <PointerBinding button="middle" action="pan" />
        </>
      )}

      <Shortcut keys="Super+Return" onPress={() => launch(terminal)} />
      <Shortcut keys="Super+Q" onPress={onFocused(close)} />
      <Shortcut keys="Super+F" onPress={onFocused(toggleFullscreen)} />
      <Shortcut keys="Super+V" onPress={onFocused(toggleFloating)} />
      <Shortcut
        keys="Super+T"
        onPress={() =>
          layoutRoom !== undefined && dispatch({ type: "toggleLayout", room: layoutRoom })
        }
      />
      <Shortcut keys="Super+E" onPress={toggleRoom} />
      <Shortcut keys="Super+Escape" onPress={() => enter(null)} />
      <Shortcut keys="Super+G" onPress={newRoom} />

      {roomKeys.map((number) => [
        <Shortcut
          key={`enter-${number}`}
          keys={`Super+${number}`}
          onPress={() => {
            const room = numbered(number);
            if (room !== undefined) enter(room);
          }}
        />,
        <Shortcut
          key={`move-${number}`}
          keys={`Super+Shift+${number}`}
          onPress={onFocused((window) => {
            const room = numbered(number);
            if (room !== undefined) dispatch({ type: "move", window, room });
          })}
        />,
      ])}

      {Object.entries(directions).map(([key, direction]) => [
        <Shortcut
          key={`focus-${key}`}
          keys={`Super+${key}`}
          onPress={() => focusToward(direction)}
        />,
        <Shortcut
          key={`move-${key}`}
          keys={`Super+Shift+${key}`}
          onPress={onFocused((window) => moveToward(window, direction))}
        />,
      ])}
    </>
  );
}
