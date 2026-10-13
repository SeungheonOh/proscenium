/**
 * A Hyprland-style tiling world.
 *
 *   Super+Return / Super+Q          open a terminal / close the focused window
 *   Super+D                         application launcher
 *   Super+1..9, Super+wheel         switch workspace; a three-finger swipe slides between them
 *   Super+Shift+1..9                move the focused window to a workspace
 *   Super+arrows or H/J/K/L         focus the neighbour in that direction
 *   Super+Shift+arrows or H/J/K/L   swap with that neighbour
 *   Super+V / Super+F / Super+T     toggle floating / fullscreen / dwindle-master layout
 *   Super+S / Super+Shift+S         show the scratchpad / move a window to or from it
 *   Super+drag / Super+right-drag   move (tiled windows swap) / resize floating windows
 *   Print / Shift+Print             screenshot the screen / an area
 *   Super+N / Super+R / Super+Z     night light / retro CRT / magnifying lens
 *
 * Focus follows the mouse, and the focused window's gradient border turns once.
 * Windows burn in and out through a shader, and nudge when a move has nowhere to go.
 * The bar shows each output's workspaces; clicking one switches to it.
 */

import { Desktop } from "./components/Desktop.js";
import { Launcher } from "./components/Launcher.js";
import { ScreenEffects } from "./components/ScreenEffects.js";
import { HyprProvider, useHypr } from "./hypr/HyprProvider.js";
import { Keybindings } from "./hypr/Keybindings.js";
import { Scratchpad } from "./hypr/Scratchpad.js";
import { WorkspacePills } from "./hypr/WorkspacePills.js";
import { Workspaces } from "./hypr/Workspaces.js";

function HyprLauncher() {
  const { focusOutput } = useHypr();
  return <Launcher output={focusOutput} />;
}

export default function Hypr() {
  return (
    <ScreenEffects>
      <HyprProvider>
        <Workspaces />
        <Scratchpad />
        <Desktop barStart={WorkspacePills} />
        <HyprLauncher />
        <Keybindings />
      </HyprProvider>
    </ScreenEffects>
  );
}
