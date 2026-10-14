import { memo, useState } from "react";
import { Group, Rect, Text, type Color, type Rectangle, type StageDragEvent } from "proscenium";
import { colors, font, motion } from "../lib/theme.js";
import { DeckRoom } from "./DeckRoom.js";
import { moved, roomAt, type Size } from "./geometry.js";
import { HyprRoom } from "./HyprRoom.js";
import { useMeta } from "./MetaProvider.js";
import { NiriRoom } from "./NiriRoom.js";

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

/** The short name of an application id: "org.gnome.Nautilus" reads "Nautilus". */
function shortName(appId: string): string {
  return appId.split(".").at(-1) || appId;
}

/** What a room's world draws in it, in the room's coordinates. */
export interface RoomViewProps<S> {
  room: number;
  /** The world's own state. */
  state: S;
  size: Size;
  /** Whether an output shows the room. */
  entered: boolean;
  /**
   * Takes WINDOW, let go at BOX in the room's coordinates, to the room under
   * its middle, or to a new room on empty canvas; false if that is this room.
   */
  carry: (window: number, box: Rectangle) => boolean;
  /** Raises this room above the others while something of it is dragged, or lowers it with null. */
  onLift: (room: number | null) => void;
}

interface RoomProps {
  room: number;
  /** Its number, from the order rooms were made in. */
  number: number;
  onLift: (room: number | null) => void;
}

/**
 * A room: its backdrop, title, and its world arranging its windows, in one
 * group that moves with the pointer in the same frame when dragged by its
 * title. The backdrop lets the pointer through, so dragging it pans the canvas.
 * Windows take input wherever they are; Super-drag one to another room, or onto
 * empty canvas for a room of its own, of the same kind.
 */
const Room = memo(function Room({ room, number, onLift }: RoomProps) {
  const meta = useMeta();
  const { state, dispatch, size, outputs, windows: infos } = meta;
  const { rectOf, enteredRoom, enter, addRoom, setRoomDrag, worldOf, windowsOf } = meta;

  const rect = rectOf(room);
  const entered = outputs.some((output) => enteredRoom(output) === room);
  const world = worldOf(room);
  const windows = windowsOf(room);
  const titleSize = Math.round(size.width * 0.036);
  const [from, to] = roomFills[(room - 1) % roomFills.length]!;
  const names = [...new Set(windows.map((id) => infos.get(id)?.appId ?? ""))]
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

  function carry(window: number, box: Rectangle): boolean {
    onLift(null);
    const center = { x: rect.x + box.x + box.width / 2, y: rect.y + box.y + box.height / 2 };
    const target =
      roomAt(state.rooms, size, center.x, center.y)?.id ??
      addRoom(center.x - size.width / 2, center.y - size.height / 2, world.kind);
    if (target === room) return false;
    dispatch({ type: "move", window, room: target });
    return true;
  }

  const view = { room, size, entered, carry, onLift };
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
        <Text weight={600} color={colors.accent}>{`  ${world.kind}`}</Text>
        <Text weight={400} color={colors.muted}>
          {names.length > 0 ? `   ${names.join(" · ")}` : "   empty"}
        </Text>
      </Text>

      {world.kind === "hypr" && <HyprRoom {...view} state={world.state} />}
      {world.kind === "niri" && <NiriRoom {...view} state={world.state} />}
      {world.kind === "deck" && <DeckRoom {...view} state={world.state} />}

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
