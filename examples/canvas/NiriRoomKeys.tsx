/**
 * niri's own keys, every one of its layout and workspace binds (niri/Keybindings.tsx),
 * for the niri room the camera is in or whose window has focus. They are declared
 * after the canvas's, and later shortcuts win, so in a niri room Super+H/J/K/L,
 * Super+R, Super+F, Super+C and the rest are niri's, as on niri itself. After each
 * one the window niri focuses gets the keyboard.
 */

import { focus, Shortcut } from "proscenium";
import { layoutBinds, workspaceBinds } from "../niri/Keybindings.js";
import type { NiriAction } from "../niri/state.js";
import type { CanvasRoom, Rooms } from "./useRooms.js";

export function NiriRoomKeys({ rooms, room }: { rooms: Rooms; room: CanvasRoom }) {
  const run = (action: NiriAction) => () => {
    const next = rooms.act(room.id, { kind: "niri", action });
    if (next !== null) focus(next);
  };
  return [...layoutBinds(run), ...workspaceBinds(run)].map(([keys, onPress, repeat = true]) => (
    <Shortcut key={keys} keys={keys} repeat={repeat} onPress={onPress} />
  ));
}
