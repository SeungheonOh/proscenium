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
import { SwitcherKeys } from "../components/SwitcherKeys.js";
import type { HyprAction, HyprState } from "../hypr/state.js";
import { directions, neighbour, type Direction } from "../lib/geometry.js";
import type { HandState } from "../lib/hand.js";
import { terminal } from "../lib/settings.js";
import { layoutBinds, workspaceBinds } from "../niri/Keybindings.js";
import { focusedWindow, niriReducer, type EnvAction, type NiriAction, type NiriState } from "../niri/state.js";
import { roomAt, roomGap } from "./geometry.js";
import { useMeta } from "./MetaProvider.js";
import { hyprWorkspace, nextKind } from "./worlds.js";

/** How far a three-finger swipe must travel to change rooms. */
const swipeThreshold = 120;
/** A pinch that ends below this scale leaves the room. */
const pinchOut = 0.8;
const roomKeys = [1, 2, 3, 4, 5, 6, 7, 8, 9];

/**
 * Keys for rooms and the canvas, and mouse and touchpad bindings; then the keys
 * of the world of the room with the keyboard, which win where they overlap.
 */
export function Keybindings() {
  const meta = useMeta();
  const { state, dispatch, size, boxes, focused, activeRoom, keyRoom } = meta;
  const { rectOf, enter, addRoom, bump, worldOf, act, focusOutput } = meta;
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

  /** Into the next room that way, if there is one. */
  function crossToward(direction: Direction) {
    const room = activeRoom === null ? null : roomToward(activeRoom, direction);
    if (room !== null) enter(room);
    else if (focused !== null) bump(focused, direction);
  }

  /** On the canvas, the nearest window that way; in a hypr room, the neighbour, then the next room. */
  function focusToward(direction: Direction) {
    if (!inRoom) {
      const all = canvasBoxes();
      const next = focused === null ? all.keys().next().value : neighbour(all, focused, direction);
      if (next != null) focus(next);
      return;
    }
    if (worldOf(activeRoom).kind === "hypr") {
      const here = roomBoxes(activeRoom);
      const start = focused !== null && here.has(focused) ? focused : null;
      const next = start === null ? here.keys().next().value : neighbour(here, start, direction);
      if (next != null) {
        focus(next);
        return;
      }
    }
    crossToward(direction);
  }

  /** Swaps with the neighbour in a hypr room, or carries the window into the next room that way. */
  function moveToward(window: number, direction: Direction) {
    const room = state.roomOf[window];
    if (room === undefined) return;
    const tiled = inRoom && worldOf(room).kind === "hypr";
    const next = tiled ? neighbour(roomBoxes(room), window, direction) : null;
    if (next !== null) {
      act(room, { kind: "hypr", action: { type: "swap", first: window, second: next } });
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

  /** The room in view on the canvas: the one at the middle of the focused output. */
  function roomInView(): number | undefined {
    const camera = getCamera(focusOutput?.name);
    return camera ? roomAt(state.rooms, size, camera.x, camera.y)?.id : undefined;
  }

  /** Leaves the room, or enters the focused window's room, else the one in view. */
  function toggleRoom() {
    if (inRoom) {
      enter(null);
      return;
    }
    enter((focused !== null ? state.roomOf[focused] : undefined) ?? roomInView() ?? state.current);
  }

  /** A new room: beside this one and entered, or on the canvas where the view is. */
  function newRoom() {
    if (inRoom) {
      const here = rectOf(activeRoom);
      enter(addRoom(here.x + here.width + roomGap(size), here.y));
      return;
    }
    const camera = getCamera(focusOutput?.name);
    if (camera) addRoom(camera.x - size.width / 2, camera.y - size.height / 2);
  }

  /** The room with the keyboard, or the one in view, becomes the next kind. */
  function changeKind() {
    const room = keyRoom ?? roomInView();
    if (room !== undefined) dispatch({ type: "setKind", room, kind: nextKind(worldOf(room).kind), focused });
  }

  const orderOf = (room: number) => state.rooms.findIndex((candidate) => candidate.id === room);
  const keyWorld = keyRoom !== null ? worldOf(keyRoom) : null;

  return (
    <>
      <PointerBinding button="left" modifiers="super" action="move" />
      <PointerBinding button="right" modifiers="super" action="resize" />

      {inRoom ? (
        <>
          <GestureBinding
            gesture="pinch"
            fingers={2}
            onEnd={({ scale, cancelled }) => !cancelled && scale < pinchOut && enter(null)}
          />
          {/* A niri room swipes and scrolls as niri does; it binds them itself (NiriRoom). */}
          {worldOf(activeRoom).kind !== "niri" && (
            <>
              <WheelBinding
                modifiers="super"
                onWheel={({ delta }) => {
                  const next = state.rooms[orderOf(activeRoom) + Math.sign(delta)];
                  if (next) enter(next.id);
                }}
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
          )}
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
      <Shortcut keys="Super+E" onPress={toggleRoom} />
      <Shortcut keys="Super+Escape" onPress={() => enter(null)} />
      <Shortcut keys="Super+G" onPress={newRoom} />
      <Shortcut keys="Super+Shift+T" onPress={changeKind} />

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

      {keyRoom !== null && keyWorld?.kind === "hypr" && <HyprKeys room={keyRoom} state={keyWorld.state} />}
      {keyRoom !== null && keyWorld?.kind === "niri" && (
        <NiriKeys room={keyRoom} state={keyWorld.state} focusToward={focusToward} crossToward={crossToward} />
      )}
      {keyRoom !== null && keyWorld?.kind === "deck" && <DeckKeys room={keyRoom} state={keyWorld.state} />}
    </>
  );
}

/** The hypr world's keys for a room's focused window, and its layout. */
function HyprKeys({ room, state }: { room: number; state: HyprState }) {
  const { act, boxes, focused } = useMeta();
  const dispatch = (action: HyprAction) => act(room, { kind: "hypr", action });
  const onFocused = (action: (window: number) => void) => () => {
    if (focused !== null && state.workspaces[focused] === hyprWorkspace) action(focused);
  };

  function toggleFloating(window: number) {
    const box = boxes.get(window);
    dispatch({ type: "float", window, box: state.floating[window] || !box ? null : box });
  }

  function toggleFullscreen(window: number) {
    dispatch({ type: "fullscreen", window: state.fullscreen === window ? null : window });
  }

  return (
    <>
      <Shortcut keys="Super+F" onPress={onFocused(toggleFullscreen)} />
      <Shortcut keys="Super+V" onPress={onFocused(toggleFloating)} />
      <Shortcut
        keys="Super+T"
        onPress={() => dispatch({ type: "toggleLayout", workspace: hyprWorkspace })}
      />
    </>
  );
}

interface NiriKeysProps {
  room: number;
  state: NiriState;
  /** Meta's own focus by direction, for the canvas. */
  focusToward: (direction: Direction) => void;
  crossToward: (direction: Direction) => void;
}

/** Where a focus action of niri's goes, if it goes by direction. */
function directionOf(action: NiriAction): Direction | null {
  if (action.type === "focusColumn" && action.to === "left") return [-1, 0];
  if (action.type === "focusColumn" && action.to === "right") return [1, 0];
  if (action.type === "focusWindow") return [0, action.direction];
  return null;
}

/**
 * niri's keys for the room's workspaces. Focus that has nowhere further to go
 * in the room goes on into the next room that way; on the canvas, focus by
 * direction is the canvas's.
 */
function NiriKeys({ room, state, focusToward, crossToward }: NiriKeysProps) {
  const { act, activeRoom, env } = useMeta();
  const run = (action: NiriAction) => () => {
    const direction = directionOf(action);
    if (direction && activeRoom !== room) {
      focusToward(direction);
      return;
    }
    if (direction) {
      const after = niriReducer(state, { ...action, env } as EnvAction);
      if (focusedWindow(after) === focusedWindow(state)) {
        crossToward(direction);
        return;
      }
    }
    act(room, { kind: "niri", action });
  };
  return [...layoutBinds(run), ...workspaceBinds(run)].map(([keys, onPress, repeat = true]) => (
    <Shortcut key={keys} keys={keys} repeat={repeat} onPress={onPress} />
  ));
}

/** The deck's switcher on Super+Tab over the room's cards. */
function DeckKeys({ room, state }: { room: number; state: HandState }) {
  const { act } = useMeta();
  return (
    <SwitcherKeys
      open={state.selected !== null}
      played={state.played}
      dispatch={(action) => act(room, { kind: "deck", action })}
    />
  );
}
