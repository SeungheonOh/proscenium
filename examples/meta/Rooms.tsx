import { memo, useRef, useState } from "react";
import {
  focus,
  Group,
  Rect,
  Text,
  useWindows,
  Window,
  type Color,
  type Rectangle,
  type StageDragEvent,
} from "proscenium";
import { TilingWindow, windowMotion } from "../components/TilingWindow.js";
import { bump } from "../lib/animations.js";
import { boxAt } from "../lib/geometry.js";
import { colors, font, motion } from "../lib/theme.js";
import { roomAt } from "./geometry.js";
import { useMeta } from "./MetaProvider.js";
import { roomWindows } from "./tiling.js";

/** A drag shorter than this, in canvas pixels, is a click. */
const clickDistance = 6;

/** Each room's own dusk, so rooms are told apart on the canvas. */
const roomFills: readonly [Color, Color][] = [
  ["#1e1e2e", "#313244"],
  ["#172636", "#2b4a5e"],
  ["#2a1d2e", "#4a3150"],
  ["#1a2b22", "#2f4a3a"],
  ["#2e241d", "#4e3a2c"],
  ["#1b2a2e", "#2c4650"],
  ["#2b1d24", "#4d2f3d"],
  ["#202029", "#3a3a4a"],
  ["#1d291d", "#38503a"],
];

function moved(from: { x: number; y: number }, to: { x: number; y: number }): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) >= clickDistance;
}

/** The short name of an application id: "org.gnome.Nautilus" reads "Nautilus". */
function shortName(appId: string): string {
  return appId.split(".").at(-1) || appId;
}

interface RoomProps {
  room: number;
  /** Its number, from the order rooms were made in. */
  number: number;
  /** Raises this room above the others while something of it is dragged, or lowers it with null. */
  onLift: (room: number | null) => void;
}

/**
 * A room: its backdrop, title and windows, in one group that moves with the
 * pointer in the same frame when dragged by its title. The backdrop lets the
 * pointer through, so dragging it pans the canvas. Windows take input wherever
 * they are; Super-drag one to another room, or onto empty canvas for a room of its
 * own. Inside a room, windows tile as in Hypr and focus follows the mouse.
 */
const Room = memo(function Room({ room, number, onLift }: RoomProps) {
  const meta = useMeta();
  const { state, dispatch, size, outputs, present, boxes, focused, bumped } = meta;
  const { rectOf, enteredRoom, enter, addRoom, reveal, setRoomDrag } = meta;
  const apps = useWindows();
  const [lifted, setLifted] = useState<number | null>(null);
  const dragStart = useRef({ x: 0, y: 0 });

  const rect = rectOf(room);
  const entered = outputs.some((output) => enteredRoom(output) === room);
  const isFloating = (id: number) => Boolean(state.floating[id]);
  // Bottom to top: tiled, floating, the focused one, a dragged one.
  const windows = roomWindows(state, room, present).sort(
    (a, b) =>
      Number(isFloating(a)) - Number(isFloating(b)) ||
      Number(a === focused) - Number(b === focused) ||
      Number(a === lifted) - Number(b === lifted),
  );
  const titleSize = Math.round(size.width * 0.036);
  const [from, to] = roomFills[(room - 1) % roomFills.length]!;
  const names = [...new Set(windows.map((id) => apps.find((app) => app.id === id)?.appId ?? ""))]
    .filter(Boolean)
    .map(shortName)
    .slice(0, 4);
  const removable = windows.length === 0 && !entered && state.rooms.length > 1;

  /** A click on the title or number enters the room; a drag puts it where it was dropped. */
  function dropRoom({ x, y }: StageDragEvent) {
    onLift(null);
    setRoomDrag(null);
    if (moved(rect, { x, y })) dispatch({ type: "placeRoom", room, x, y, size });
    else enter(room);
  }

  function dropWindow(id: number, box: Rectangle, { x, y }: StageDragEvent) {
    onLift(null);
    setLifted(null);
    if (!moved(dragStart.current, { x, y })) return;
    // A window lands in the room under its center, or founds one on empty canvas.
    const center = { x: rect.x + x + box.width / 2, y: rect.y + y + box.height / 2 };
    const target =
      roomAt(state.rooms, size, center.x, center.y)?.id ??
      addRoom(center.x - size.width / 2, center.y - size.height / 2);
    if (target !== room) {
      dispatch({ type: "move", window: id, room: target });
    } else if (isFloating(id)) {
      dispatch({ type: "float", window: id, box: { ...box, x, y } });
    } else {
      const tiles = new Map(
        windows
          .filter((other) => !isFloating(other) && boxes.has(other))
          .map((other) => [other, boxes.get(other)!]),
      );
      const other = boxAt(tiles, x + box.width / 2, y + box.height / 2, id);
      if (other !== null) dispatch({ type: "swap", first: id, second: other });
    }
  }

  const fullscreen = state.fullscreen;
  const showFullscreen =
    fullscreen !== null && present.has(fullscreen) && state.roomOf[fullscreen] === room;

  return (
    <Group
      x={rect.x}
      y={rect.y}
      transition={motion.slide}
      draggable={!entered}
      onDragStart={() => onLift(room)}
      onDrag={({ x, y }) => setRoomDrag({ room, x, y })}
      onDragEnd={dropRoom}
    >
      <Rect
        width={rect.width}
        height={rect.height}
        radius={entered ? 0 : 36}
        fill={{ from, to, angle: 120 }}
        shadow={{ color: entered ? "#00000000" : "#00000040", blur: 60, y: 24 }}
        interactive={false}
        transition={motion.slide}
      />
      {/* The title sits below the room, clear of the bar and out of sight inside it. */}
      <Text
        y={rect.height + titleSize * 0.4}
        font={font}
        size={titleSize}
        weight={700}
        color={colors.ink}
        cursor="pointer"
      >
        {String(number)}
        <Text weight={400} color={colors.muted}>
          {names.length > 0 ? `   ${names.join(" · ")}` : "   empty"}
        </Text>
      </Text>
      {windows.length === 0 && !entered && (
        <Text
          x={rect.width / 2 - titleSize}
          y={rect.height / 2 - titleSize * 1.5}
          width={titleSize * 2}
          align="center"
          font={font}
          size={titleSize * 2.4}
          weight={300}
          color="#ffffff55"
          cursor="pointer"
        >
          {String(number)}
        </Text>
      )}
      {removable && (
        <Text
          x={rect.width - titleSize * 1.6}
          y={titleSize * 0.4}
          font={font}
          size={titleSize}
          color="#ffffff88"
          cursor="pointer"
          onPointerDown={() => dispatch({ type: "removeRoom", room })}
        >
          ×
        </Text>
      )}

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
            // Focus follows the mouse inside a room; on the canvas a click picks.
            onPointerEnter={entered ? () => focus(id) : undefined}
            onDragStart={({ x, y }) => {
              dragStart.current = { x, y };
              setLifted(id);
              onLift(room);
            }}
            onDrop={(event) => dropWindow(id, box, event)}
            onResize={({ x, y, width, height }) =>
              dispatch({ type: "float", window: id, box: { x, y, width, height } })
            }
            onFullscreen={(value) => dispatch({ type: "fullscreen", window: value ? id : null })}
            onActivate={() => reveal(id)}
          />
        );
      })}

      {showFullscreen && (
        <Window
          window={fullscreen}
          width={rect.width}
          height={rect.height}
          fullscreen
          transition={windowMotion}
          onFullscreenRequest={({ value }) =>
            dispatch({ type: "fullscreen", window: value ? fullscreen : null })
          }
        />
      )}
    </Group>
  );
});

/**
 * Every room, the one being dragged drawn above the rest. A window moving to
 * another room is drawn anew there and carries on from where it was shown.
 */
export function Rooms() {
  const { state } = useMeta();
  const [lifted, setLifted] = useState<number | null>(null);
  const rooms = state.rooms
    .map((room, index) => ({ id: room.id, number: index + 1 }))
    .sort((a, b) => Number(a.id === lifted) - Number(b.id === lifted));
  return rooms.map(({ id, number }) => (
    <Room key={id} room={id} number={number} onLift={setLifted} />
  ));
}
