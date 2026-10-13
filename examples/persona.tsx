/**
 * A Persona 3 Reload shell after Yujon Pradhananga's Persona-Quickshell
 * (github.com/Yujonpradhananga/Persona-Quickshell), over the hypr world's
 * tiling. Its art, video and fonts come from scripts/fetch-persona.
 *
 *   the wallpaper                   a train carriage by the sea: rain, a passing train, the
 *                                   music's spectrum as hills, depth that follows the pointer
 *   top right / bottom left         the clock and moon / the music player
 *   left edge                       a ball rolls out; click it for the blades, and pull a blade
 *                                   right for the calendar, stats, screen shaders or power
 *   Super+R                         application search
 *   volume and brightness keys      a level pill near the top
 *   Super+Return / Q / F / V / T    terminal / close / fullscreen / float / layout, as in hypr
 *   Super+1..9, Super+arrows        workspaces and focus, as in hypr
 *
 * The desktop (wallpaper, clock, player) is drawn and animated by the
 * compositor, and rests while windows cover it. The menus, the search and the
 * level pill are Chromium pages, which cost nothing while hidden.
 */

import { MediaKeys } from "./components/MediaKeys.js";
import { Screenshots } from "./components/Screenshots.js";
import { ShareChooser } from "./components/ShareChooser.js";
import { HyprProvider } from "./hypr/HyprProvider.js";
import { Keybindings } from "./hypr/Keybindings.js";
import { Scratchpad } from "./hypr/Scratchpad.js";
import { Workspaces } from "./hypr/Workspaces.js";
import { assetsReady } from "./persona/assets.js";
import { Backdrop } from "./persona/Backdrop.js";
import { Drawer } from "./persona/Drawer.js";
import { Menus } from "./persona/Menus.js";
import { MissingAssets } from "./persona/MissingAssets.js";
import { Osd } from "./persona/Osd.js";
import { PersonaProvider } from "./persona/PersonaProvider.js";
import { ScreenFilters } from "./persona/ScreenFilters.js";
import { Search } from "./persona/Search.js";

function Shell() {
  return (
    <>
      <Drawer />
      <Menus />
      <Search />
      <Osd />
      <MediaKeys indicator={null} />
    </>
  );
}

export default function Persona() {
  return (
    <PersonaProvider>
      <ScreenFilters>
        <HyprProvider>
          <Workspaces background={assetsReady ? (output) => <Backdrop output={output} /> : undefined} />
          <Scratchpad />
          {assetsReady ? <Shell /> : <MissingAssets />}
          <ShareChooser />
          <Screenshots />
          <Keybindings />
        </HyprProvider>
      </ScreenFilters>
    </PersonaProvider>
  );
}
