/**
 * Trellis: a fractal desktop after TrellisWM (trelliswm.app) and TrellisUI
 * (trellisui.com). Windows open floating on the Desktop. Drag one to the
 * screen's edge to dock it beside everything you see, onto another window's
 * edge to dock beside it, onto a gap to join that row, or onto its middle to
 * stack them under one strip of tabs. Spaces nest inside spaces as deep as you
 * like; the view frames any of them, and windows take the size they get there.
 * Zoomed out, a window too small to use shows its app's colour and icon, and a
 * group too small to see becomes one tile, lined with its splits. It arranges
 * the first display.
 *
 * Keys (TrellisWM's ⌃⌥ is Ctrl+Alt here):
 *   Ctrl+Alt+Space               everything, and back
 *   Ctrl+Alt+Up / Down           step out a level / in toward the focused window
 *   Ctrl+Alt+Return              frame the focused window on its own, and back
 *   Ctrl+Alt+Left / Right        the neighbouring space
 *   three-finger swipe           pan; letting go settles the same way
 *   Super+Shift+drag             draw a rectangle; letting go frames what fits it best
 *   Ctrl+Alt+[ / ]               back / forward
 *   Ctrl+Alt+Shift+1..9 / 1..9   save the view / go back to it
 *   pinch, Super+wheel           zoom; letting go settles on the space that fits
 *   double-click                 the Desktop, a title bar, an icon or a tile: frame it
 *   drag a seam                  resize both sides; double-click evens them
 *   Super+Return / Q / M / D     terminal / close / minimize / launcher
 */

import { Camera } from "proscenium";
import { Launcher } from "./components/Launcher.js";
import { ShareChooser } from "./components/ShareChooser.js";
import { Arrangement, layoutMotion } from "./trellis/Arrangement.js";
import { Keybindings } from "./trellis/Keybindings.js";
import { Marquee } from "./trellis/Marquee.js";
import { MenuBar } from "./trellis/MenuBar.js";
import { TrellisProvider, useTrellis } from "./trellis/TrellisProvider.js";

export default function Trellis() {
  return (
    <TrellisProvider>
      <Desktop />
    </TrellisProvider>
  );
}

function Desktop() {
  const { output } = useTrellis();
  return (
    <>
      {output && (
        <Camera
          x={output.width / 2}
          y={output.height / 2}
          zoom={1}
          minZoom={0.3}
          maxZoom={6}
          transition={layoutMotion}
        />
      )}
      <Arrangement />
      <MenuBar />
      <Keybindings />
      <Marquee />
      <Launcher output={output} />
      <ShareChooser />
    </>
  );
}
