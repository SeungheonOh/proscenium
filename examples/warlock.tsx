/**
 * Warlock: a desktop shell after Charles Hoskinson's Warlock
 * (github.com/CharlesHoskinson/Warlock), which puts a Windows-style taskbar and
 * window controls on Hyprland. Here nothing is a plugin: the world is the window
 * manager, so every window action simply happens, and previews are the live windows.
 *
 *   the taskbar                     pinned and running applications, Applications, Task View,
 *                                   Switch windows, Notifications, Files, System, Settings
 *   a window's title bar            minimize, maximize (hover it for the snap layouts), its menu,
 *                                   close; drag it to move, to an edge to snap, double-click to maximize
 *   Alt+Tab, Alt+Shift+Tab          switch windows, most recently used first; let go of Alt to choose
 *   Super+Tab                       Task View: windows by workspace, and moving them between workspaces
 *   Super+Left/Right/Up/Down        snap to a half, maximize, restore or minimize
 *   Super+Z / Alt+Space             the snap chooser / the focused window's menu
 *   Super+Alt+Space, Super+Escape   Applications / System; Super+Shift+Alt+, opens Notifications
 *   Super+1..9                      the taskbar's nth application; with Shift a new instance, with Alt its actions
 *   Alt-drag or Super-drag          move a window (with Alt, on its own and past the guides); with the right button, resize it
 *   Super+W / F / P                 close / fullscreen / always on top
 *   Super+Ctrl+Left/Right           the previous / next workspace
 *   Super+Return                    a terminal
 *
 * The desktop of every output is an infinite canvas (warlock/canvas): at home it is the desktop
 * above, and from there it pans and zooms, pages lying a screen apart all around.
 *
 *   drag or scroll empty desktop    pan, with momentum; middle-drag and a three-finger swipe too
 *   Super+wheel, pinch              zoom around the pointer
 *   Super+O                         overview: every window of the workspace; click one to dive in, again to go back
 *   Super+C / Super+Home            centre the focused window at 100% / fly home
 *   Super+Shift+arrows              focus the nearest window that way and fly to it
 *   Super+Alt+arrows                move the view by a page
 *   Super+drag empty desktop        select the windows the box touches; Super+click clears
 *   Super+S                         stack the selection; on a stacked window, spread its stack out
 *   Super+`                         fan the focused window's stack out; let go of Super to pick
 *   click a stack's pill            fan it out; click a window (or Return) to pick it
 *   drag onto a stack / Alt-drag    add a window to it / take one out (a plain drag moves the stack)
 *   Super+G                         alignment guides on or off
 *   Super+M / Super+Shift+M         magnet mode on or off / Gentle, Medium, Firm
 *   Ctrl+Alt+arrows                 the focused window to a half of the screen in view; again, ⅔ and ⅓
 *   Ctrl+Alt+U I J K / D F G / E T  a quarter / a third / two-thirds; Ctrl+Alt+Return fills, C centres
 *   Ctrl+Alt+2 / 3 / 4, Ctrl+Alt+A  the windows in view in columns / tidy every window onto one grid
 *   Super+Shift+Z                   put back what the last placement, drop or push moved
 *   Super+D                         take out the paper, an Excalidraw drawing under the windows, or put it away
 *   Super+N / Super+R / Super+X     night light / an old CRT / a magnifying lens under the pointer
 *
 * A new window opens tiled on the page in view, and snapping and maximizing fill the page in view
 * at 100%, else the page the window is on. Activating a window that is not all in view flies to it;
 * each workspace remembers where its view was. Windows glide to their places, and a selected window
 * dragged takes the selection with it. A map in the corner shows while the view is away from home.
 *
 * Windows open and close through Warlock's portal, a ring of red embers.
 * See warlock/README.md for what comes from where.
 */

import { useMemo, type ReactNode } from "react";
import { useOutputs } from "proscenium";
import { PaperProvider } from "./canvas/paper/Paper.js";
import { PaperToolbar, type ToolbarLook } from "./canvas/paper/Toolbar.js";
import { MediaKeys } from "./components/MediaKeys.js";
import { ScreenEffects } from "./components/ScreenEffects.js";
import { Screenshots } from "./components/Screenshots.js";
import { ShareChooser } from "./components/ShareChooser.js";
import { Desktop, FullscreenWindows } from "./warlock/Desktop.js";
import { installFonts } from "./warlock/fonts.js";
import { Keybindings } from "./warlock/Keybindings.js";
import { PopupLayer } from "./warlock/Popup.js";
import { Taskbar } from "./warlock/Taskbar.js";
import { alpha, useWarlockTheme } from "./warlock/theme.js";
import { WarlockProvider } from "./warlock/WarlockProvider.js";

installFonts();

/** Warlock's own colours to draw with on its dark canvas: text, its red, green, blue and amber. */
const paperStrokes = ["#f6efe8", "#fca399", "#6ee0b8", "#8ec8ff", "#f2c172"];

/** The paper lies on the first output's canvas. */
function Paper({ children }: { children: ReactNode }) {
  const output = useOutputs()[0];
  return (
    <PaperProvider
      output={output}
      name="warlock.paper"
      folder="warlock-paper"
      initialStroke={{ stroke: paperStrokes[0]!, width: 2 }}
    >
      {children}
    </PaperProvider>
  );
}

/** The paper's tools in Warlock's colours: a dark card, its red for what is picked. */
function WarlockPaperToolbar() {
  const { palette, skin } = useWarlockTheme();
  const look = useMemo<ToolbarLook>(
    () => ({
      card: alpha(palette.surface, 0.94),
      edge: skin.hairline,
      shadow: "#0000009e",
      ink: palette.text,
      icons: palette.text,
      hover: skin.hover,
      active: skin.selected,
      activeEdge: alpha(palette.brandText, 0.55),
      ring: palette.brandText,
      divider: skin.hairline,
    }),
    [palette, skin],
  );
  return <PaperToolbar keys="Super+D" strokeColors={paperStrokes} look={look} />;
}

export default function Warlock() {
  return (
    <ScreenEffects keys={{ lens: "Super+X" }}>
      <WarlockProvider>
        <Paper>
          <Desktop />
          <Taskbar />
          <WarlockPaperToolbar />
          <FullscreenWindows />
          <PopupLayer />
          <Keybindings />
          <ShareChooser />
          <Screenshots />
          <MediaKeys indicator={null} />
        </Paper>
      </WarlockProvider>
    </ScreenEffects>
  );
}
