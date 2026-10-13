import { type OutputInfo } from "proscenium";
import { useHypr } from "../hypr/HyprProvider.js";
import { workspaceWindows } from "../hypr/tiling.js";
import { useBattery, type BatteryInfo } from "../lib/system/battery.js";
import { useTime } from "../lib/system/clock.js";
import { useMedia } from "../lib/system/media.js";
import { Clock } from "./Clock.js";
import { usePersona } from "./PersonaProvider.js";
import { Player } from "./Player.js";
import { useSpectrum } from "./visualizer.js";
import { Wallpaper } from "./Wallpaper.js";

const levels = ["󰁺", "󰁻", "󰁼", "󰁽", "󰁾", "󰁿", "󰂀", "󰂁", "󰂂", "󰁹"];

/** The clock's battery: its icon and charge. */
function batteryText(battery: BatteryInfo | null): string {
  if (!battery) return "󰂑 0%";
  const icon = battery.charging || battery.full ? "󰂄" : levels[Math.min(Math.floor(battery.percent / 10), 9)];
  return `${icon} ${Math.round(battery.percent)}%`;
}

/**
 * What an output shows behind its windows: the wallpaper, the clock and the
 * music player, all drawn by the compositor. Nothing moves while a menu, a
 * fullscreen window or tiled windows cover them, which leave at most the gaps
 * between them to see.
 */
export function Backdrop({ output }: { output: OutputInfo }) {
  const { menu } = usePersona();
  const { state, present, workspaceOf } = useHypr();
  const workspace = workspaceOf(output);
  const fullscreen = state.fullscreen;
  const covered = menu?.output === output.name
    || (fullscreen !== null && present.has(fullscreen) && state.workspaces[fullscreen] === workspace)
    || workspaceWindows(state, workspace, present).some((window) => !state.floating[window]);
  const now = useTime();
  const battery = useBattery();
  const media = useMedia();
  const spectrum = useSpectrum(!covered && media?.playing === true);

  return (
    <>
      <Wallpaper output={output} moving={!covered} bars={spectrum} />
      <Clock right={output.width} now={now} battery={batteryText(battery)} rolling={!covered} />
      <Player bottom={output.height} media={media} moving={!covered} />
    </>
  );
}
