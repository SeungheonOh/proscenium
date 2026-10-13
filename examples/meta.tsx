/**
 * Metaworld on Stage: an infinite canvas of rooms, each a Hyprland-style tiler.
 *
 * On the canvas:
 *   Drag or scroll empty canvas, three-finger swipe   pan, with momentum
 *   Super+wheel, pinch                                zoom around the pointer
 *   Double-click empty canvas, Super+G                make a room there
 *   Click a room's title                              fly into the room
 *   Drag a room's title                               put the room anywhere
 *   Use a window                                      it takes input right on the canvas
 *   Super+drag a window, or its title bar             move it into another room, or onto
 *                                                     empty canvas for a room of its own
 *   × on an empty room                                remove it
 *
 * Anywhere:
 *   Super+1..9 / Super+Shift+1..9    enter a room / send the focused window to one
 *   Super+E / Super+Escape           enter or leave a room / back to the canvas
 *   Super+arrows or H/J/K/L          focus the neighbour; past a room's edge, the next room that way
 *   Super+Shift+arrows or H/J/K/L    swap with the neighbour; past the edge, carry the window along
 *   Super+V / Super+F / Super+T      toggle floating / fullscreen / dwindle-master layout
 *   Super+Return / Super+Q / Super+D terminal (in the current room) / close / launcher
 *
 * Rooms are the size of the screen, so a room entered at 100% shows its windows
 * pixel for pixel, and leaving returns to where the canvas was. In a room, focus
 * follows the mouse, Super+wheel and three-finger swipes move between rooms, and
 * pinching out leaves.
 */

import { Desktop } from "./components/Desktop.js";
import { Launcher } from "./components/Launcher.js";
import { ScreenEffects } from "./components/ScreenEffects.js";
import { Keybindings } from "./meta/Keybindings.js";
import { MetaCamera } from "./meta/MetaCamera.js";
import { MetaMinimap } from "./meta/MetaMinimap.js";
import { MetaProvider, useMeta } from "./meta/MetaProvider.js";
import { RoomPills } from "./meta/RoomPills.js";
import { Rooms } from "./meta/Rooms.js";

function MetaLauncher() {
  const { focusOutput } = useMeta();
  return <Launcher output={focusOutput} />;
}

export default function Meta() {
  return (
    <ScreenEffects>
      <MetaProvider>
        <MetaCamera />
        <Rooms />
        <MetaMinimap />
        <Desktop barStart={RoomPills} />
        <MetaLauncher />
        <Keybindings />
      </MetaProvider>
    </ScreenEffects>
  );
}
