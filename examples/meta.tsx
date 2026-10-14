/**
 * Metaworld on Stage: an infinite canvas of rooms, each running another world's
 * window management: Hyprland-style tiling, niri's scrolling columns, or the
 * deck's hand of cards. A room keeps that world's own state, lays its windows
 * out with that world's own code, and takes that world's keys.
 *
 * On the canvas:
 *   Drag or scroll empty canvas, three-finger swipe   pan, with momentum
 *   Super+wheel, pinch                                zoom around the pointer
 *   Double-click empty canvas, Super+G                make a room there
 *   Click a room's title                              fly into the room
 *   Drag a room's title                               put the room anywhere
 *   Use a window                                      it takes input right on the canvas
 *   Super+drag a window, or its title bar             move it into another room, or onto empty
 *                                                     canvas for a new room of the same kind
 *   × on an empty room                                remove it
 *
 * Anywhere:
 *   Super+1..9 / Super+Shift+1..9    enter a room / send the focused window to one
 *   Super+E / Super+Escape           enter or leave a room / back to the canvas
 *   Super+Shift+T                    make the room hypr, niri or deck, in turn
 *   Super+arrows or H/J/K/L          focus the neighbour; past a room's edge, the next room that way
 *   Super+Shift+arrows or H/J/K/L    swap with the neighbour in hypr; past the edge, carry the window along
 *   Super+Return / Super+Q / Super+D terminal (in the current room) / close / launcher
 *
 * The room's world, in the room or on the canvas for the focused window's room:
 *   hypr   Super+V / Super+F / Super+T      floating / fullscreen / dwindle-master layout
 *   niri   niri's layout and workspace keys: Super+Ctrl+arrows, Super+[ ] , . R F M C V W - =,
 *          Super+U/I; Super+drag in the room puts a window where it is let go in the strip
 *   deck   Super+Tab, Super+Shift+Tab       deal the switcher out; let go of Super to play
 *
 * Rooms are the size of the screen, so a room entered at 100% shows its windows
 * pixel for pixel, and leaving returns to where the canvas was. In a hypr room
 * focus follows the mouse. In a room, Super+wheel and three-finger swipes move
 * between rooms, and pinching out leaves; a niri room keeps the swipes and the
 * wheel for itself, as niri uses them: sideways along its columns, up and down
 * its workspaces.
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
