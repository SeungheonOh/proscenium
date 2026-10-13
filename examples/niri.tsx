/**
 * A niri world: windows in columns on an endless horizontal strip per
 * workspace, workspaces stacked vertically per output, with niri's defaults
 * throughout — its layout rules, springs, focus ring, overview, gestures,
 * hotkey overlay, exit dialog, screenshot UI and default bindings.
 *
 *   Super+T / Super+D / Super+Q        terminal / launcher / close the focused window
 *   Super+arrows or H/J/K/L            focus a column or a window in its column
 *   Super+Ctrl+arrows or H/J/K/L       move the column, or the window in its column
 *   Super+Page Up/Down, U/I, 1..9      switch workspace; with Ctrl, take the column along
 *   Super+[ / ] / , / .                consume or expel windows into neighbouring columns
 *   Super+R / F / Shift+F / M / C      preset widths / maximize column / fullscreen / maximize / center
 *   Super+- / =                        narrow or widen the column by 10%
 *   Super+V / Shift+V / W              float / focus floating or tiled / tabbed column
 *   Super+O or the top left corner     the overview, also a four-finger swipe
 *   three-finger swipe                 scroll the columns, or switch workspace
 *   Super+drag / right / middle drag   move / resize / scroll the view
 *   Print / Ctrl+Print / Alt+Print     screenshot UI / output / window
 *   Alt+Tab or Super+Tab               recently used windows
 *   Super+Shift+/ / Super+Shift+E      important hotkeys / exit
 */

import { Launcher } from "./components/Launcher.js";
import { ShareChooser } from "./components/ShareChooser.js";
import { ExitDialog } from "./niri/ExitDialog.js";
import { HotkeyOverlay } from "./niri/HotkeyOverlay.js";
import { Input } from "./niri/Input.js";
import { Keybindings } from "./niri/Keybindings.js";
import { Monitors } from "./niri/Monitors.js";
import { NiriProvider, useNiri } from "./niri/NiriProvider.js";
import { RecentWindows } from "./niri/RecentWindows.js";
import { ScreenshotUI } from "./niri/ScreenshotUI.js";
import { Waybar } from "./niri/Waybar.js";

/** Outputs whose shown workspace is a still fullscreen window, which covers the bar. */
function useFullscreenOutputs(): ReadonlySet<string> {
  const { state, overview } = useNiri();
  const outputs = new Set<string>();
  if (overview) return outputs;
  for (const [name, monitor] of Object.entries(state.monitors)) {
    const workspace = monitor.workspaces[monitor.active];
    const column = workspace?.columns[workspace.active];
    if (column?.sizing === "fullscreen" && !workspace!.floatingActive) outputs.add(name);
  }
  return outputs;
}

function Desktop() {
  const { outputs, state } = useNiri();
  const fullscreen = useFullscreenOutputs();
  return (
    <>
      <Monitors />
      <Waybar hidden={fullscreen} />
      <Launcher output={outputs.find((output) => output.name === state.activeOutput)} />
      <ShareChooser />
      <RecentWindows />
      <ScreenshotUI />
      <HotkeyOverlay />
      <ExitDialog />
      <Keybindings />
      <Input fullscreen={fullscreen} />
    </>
  );
}

export default function Niri() {
  return (
    <NiriProvider>
      <Desktop />
    </NiriProvider>
  );
}
