/**
 * Rooms drawn on the canvas: a soft frame where each room is, under its
 * windows, and above it a header: a handle with its world's mark and name, and
 * round icon buttons to switch its world, ungroup it, and enter or leave it;
 * and over a selection, the menu that makes a room of it.
 */

import { useState } from "react";
import { Box, Group, instant, Rect, scale, type Rectangle, type Transition } from "proscenium";
import { Button, Icon, IconButton, Label, Surface, StyleSheet } from "proscenium/ui";
import closeIcon from "./icons/close.svg";
import enterIcon from "./icons/enter.svg";
import gripIcon from "./icons/grip.svg";
import hyprIcon from "./icons/hypr.svg";
import leaveIcon from "./icons/leave.svg";
import niriIcon from "./icons/niri.svg";
import swapIcon from "./icons/swap.svg";
import ungroupIcon from "./icons/ungroup.svg";
import { union } from "../lib/geometry.js";
import { colors, motion } from "../lib/theme.js";
import { RoomShift, stackSlide, stripSlide } from "./RoomStrip.js";
import { ScreenSized, useScreenPixel } from "./ScreenSized.js";
import { kindNames, roomKinds, type CanvasRoom, type RoomKind, type Rooms } from "./useRooms.js";

const barHeight = 36;
/** The header's round buttons. */
const buttonSize = 28;
const kindIcons: Record<RoomKind, string> = { hypr: hyprIcon, niri: niriIcon };
/** Screen pixels between a bar and what it sits above. */
const barGap = 10;

const styles = StyleSheet.create({
  // A pill of words and buttons in screen pixels, placed by its own x and y above the point it is pinned to.
  // Nothing in it shrinks: it is as wide as what it holds, whatever the zoom.
  grip: { flexDirection: "row", alignItems: "center", gap: 6, height: barHeight, paddingLeft: 6, paddingRight: 4,
          flexShrink: 0 },
  bar: { flexDirection: "row", alignItems: "center", gap: 2, paddingLeft: 4, paddingRight: 4, height: barHeight,
         radius: barHeight / 2 },
  // How many windows the room holds, in a small round chip after its name.
  count: { height: 18, minWidth: 18, paddingX: 5, radius: 9, alignItems: "center", justifyContent: "center",
           fill: colors.accentSoft },
  rule: { width: 1, height: 18, fill: colors.line, marginX: 4 },
  round: { radius: buttonSize / 2 },
  // Enter: the room's main action, a solid accent circle.
  primary: { radius: buttonSize / 2, fill: colors.accent },

});

const kindTitles: Record<RoomKind, string> = { hypr: "Hyprland", niri: "niri" };

/** A room's frame on the canvas: the room, or for niri the whole stack of its workspaces as one box. */
function frameOf(rooms: Rooms, room: CanvasRoom): { rect: Rectangle; moving: boolean } {
  const slots = rooms.slotsOf(room);
  return { rect: union(slots.map((slot) => slot.rect)) ?? rooms.rectOf(room), moving: slots.some((slot) => slot.moving) };
}

/**
 * How a room's frame and header move: as briskly as a niri room's strip, in one; on a spring that
 * never overshoots in any other. Nothing bounces.
 */
function chromeMotion(room: CanvasRoom): Transition {
  return room.world.kind === "niri" ? { default: stripSlide, y: stackSlide, height: stackSlide } : motion.layout;
}

/** Out from a frame's edges, in screen pixels. */
const framePadding = 12;

/**
 * Where each room is, under the windows: lit while the camera is in it. A niri
 * room's frame holds its whole stack of workspaces, growing and sliding with it
 * as the shown one changes.
 */
export function RoomFrames({ rooms }: { rooms: Rooms }) {
  const pixel = useScreenPixel();
  const gap = framePadding * pixel;
  return (
    <Group>
      {rooms.rooms.map((room) => {
        const inside = rooms.entered === room.id;
        const { rect, moving } = frameOf(rooms, room);
        const transition = rooms.dragging === room.id || moving ? { default: motion.pop, x: instant, y: instant }
          : chromeMotion(room);
        return (
          // Up and down with a niri room's stack as a swipe drives it.
          <RoomShift key={room.id} rooms={rooms} room={room}>
            <Rect x={rect.x - gap} y={rect.y - gap} width={rect.width + 2 * gap}
                  height={rect.height + 2 * gap} radius={24 * pixel}
                  fill={`${colors.accent}${inside ? "0d" : "14"}`}
                  border={{ width: 2 * pixel, color: `${colors.accent}${inside ? "40" : "80"}` }}
                  transition={transition}
                  initial={{ opacity: 0 }} exit={{ opacity: 0 }} />
          </RoomShift>
        );
      })}
    </Group>
  );
}

/** Over each room, its world's name and what can be done with it; and where a window in hand would go. */
export function RoomHeaders({ rooms }: { rooms: Rooms }) {
  const pixel = useScreenPixel();
  const hint = rooms.hint;
  return (
    <Group>
      {hint && (
        <Rect x={hint.x} y={hint.y} width={hint.width} height={hint.height} radius={14 * pixel}
              fill={`${colors.accent}2e`} border={{ width: 3 * pixel, color: colors.accent }}
              transition={hint.niri ? stripSlide : motion.layout}
              initial={{ opacity: 0 }} exit={{ opacity: 0 }} interactive={false} />
      )}
      {rooms.rooms.map((room) => (
        <RoomShift key={room.id} rooms={rooms} room={room}>
          <RoomHeader room={room} rooms={rooms} />
        </RoomShift>
      ))}
    </Group>
  );
}

function RoomHeader({ room, rooms }: { room: CanvasRoom; rooms: Rooms }) {
  const pixel = useScreenPixel();
  // Over the top of its frame: for niri, the topmost of its workspaces.
  const { rect, moving } = frameOf(rooms, room);
  const kind = room.world.kind as RoomKind;
  const other = roomKinds.find((k) => k !== kind)!;
  const inside = rooms.entered === room.id;
  return (
    <ScreenSized x={rect.x} y={rect.y - framePadding * pixel}
                 transition={rooms.dragging === room.id || moving ? { default: motion.pop, x: instant, y: instant }
                   : chromeMotion(room)}>
      <Surface variant="glass" style={styles.bar} x={0} y={-barHeight - barGap}
               initial={{ opacity: 0, transform: scale(0.9) }} transition={motion.pop}>
          {/* The room's handle: drag its mark and name to move the room whole. */}
          <Box style={styles.grip} cursor="grab"
               onPointerDown={(event) => rooms.grabRoom(room.id, event.worldX, event.worldY)}
               onPointerMove={(event) => rooms.carry(event.worldX, event.worldY)}
               onPointerUp={(event) => rooms.letGo(event.worldX, event.worldY)}>
            <Icon src={gripIcon} size={14} tone="faint" />
            <Icon src={kindIcons[kind]} size={16} tone="accent" />
            <Label variant="strong">{kindNames[kind]}</Label>
            <Box style={styles.count}>
              <Label variant="caption" tone="accent">{`${room.members.length}`}</Label>
            </Box>
          </Box>
          <Box style={styles.rule} />
          {/* Lay it out as the other world does instead. */}
          <IconButton icon={swapIcon} size={buttonSize} iconSize={15} style={styles.round}
                      onPress={() => rooms.switchKind(room.id, other)} />
          <IconButton icon={ungroupIcon} size={buttonSize} iconSize={15} style={styles.round}
                      onPress={() => rooms.ungroup(room.id)} />
          {inside ? (
            <IconButton icon={leaveIcon} size={buttonSize} iconSize={15} style={styles.round} onPress={rooms.leave} />
          ) : (
            <IconButton icon={enterIcon} size={buttonSize} iconSize={15} iconTint={colors.onAccent}
                        style={({ hovered, pressed }) => [styles.primary, { opacity: pressed ? 0.8 : hovered ? 0.92 : 1 }]}
                        onPress={() => rooms.enter(room.id)} />
          )}
      </Surface>
    </ScreenSized>
  );
}

interface SelectionMenuProps {
  /** The selected windows, and where they lie together. */
  windows: readonly number[];
  bounds: Rectangle;
  onPick: (kind: RoomKind) => void;
  onDismiss: () => void;
}

/** Over a selection: make a room of it, run by one world or the other. */
export function SelectionMenu({ windows, bounds, onPick, onDismiss }: SelectionMenuProps) {
  // Centred over the selection once its width is known; until then it waits unseen.
  const [width, setWidth] = useState<number | null>(null);
  return (
    <ScreenSized x={bounds.x + bounds.width / 2} y={bounds.y}>
      <Surface variant="glass" style={styles.bar} x={-Math.round((width ?? 0) / 2)} y={-barHeight - barGap}
               opacity={width === null ? 0 : 1} onLayout={(layout) => setWidth(layout.width)}
               initial={{ opacity: 0, transform: scale(0.9) }} exit={{ opacity: 0 }} transition={motion.pop}>
          <Box style={styles.grip}>
            <Label variant="strong">Room</Label>
            <Box style={styles.count}>
              <Label variant="caption" tone="accent">{`${windows.length}`}</Label>
            </Box>
          </Box>
          <Box style={styles.rule} />
          {roomKinds.map((kind) => (
            <Button key={kind} size="small" variant="tinted" icon={kindIcons[kind]} label={kindTitles[kind]}
                    style={styles.round} onPress={() => onPick(kind)} />
          ))}
          <IconButton icon={closeIcon} size={buttonSize} iconSize={14} style={styles.round} onPress={onDismiss} />
      </Surface>
    </ScreenSized>
  );
}
