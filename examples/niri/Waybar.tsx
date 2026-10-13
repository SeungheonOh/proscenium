import type { ReactNode } from "react";
import { Box, Reserve, Screen, Spacer, Text, useWindow, type OutputInfo } from "proscenium";
import { useBattery } from "../lib/system/battery.js";
import { useBrightness } from "../lib/system/brightness.js";
import { useTime } from "../lib/system/clock.js";
import { usePowerProfile } from "../lib/system/power.js";
import { useVolume } from "../lib/system/sound.js";
import { useNiri } from "./NiriProvider.js";

/** waybar's height with its default style: 13 px text, and its 3 px bottom border. */
const height = 26;
const border = 3;
const font = "Roboto, Helvetica, Arial, sans-serif";

function Module({ fill, color = "#ffffff", children }: { fill?: string; color?: string; children: ReactNode }) {
  return (
    <Box height={height} paddingX={10} alignItems="center" fill={fill}>
      <Text font={font} size={13} color={color}>{children}</Text>
    </Box>
  );
}

const profileColors: Record<string, [string, string]> = {
  performance: ["#f53c3c", "#ffffff"],
  balanced: ["#2980b9", "#ffffff"],
  "power-saver": ["#2ecc71", "#000000"],
};

/**
 * The bar niri starts, waybar, in its default style: a translucent slate strip
 * with colored status modules, here with niri's workspace and window modules.
 */
export function Waybar({ hidden }: { hidden: ReadonlySet<string> }) {
  const { outputs } = useNiri();
  return (
    <>
      <Reserve top={height + border} />
      {outputs.map((output) => <Strip key={output.name} output={output} hidden={hidden.has(output.name)} />)}
    </>
  );
}

function Strip({ output, hidden }: { output: OutputInfo; hidden: boolean }) {
  const { state, act, focused } = useNiri();
  const window = useWindow(focused ?? -1);
  const volume = useVolume();
  const brightness = useBrightness();
  const battery = useBattery();
  const profile = usePowerProfile();
  const time = useTime();
  const monitor = state.monitors[output.name];
  const clock = `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
  const [profileFill, profileColor] = profileColors[profile?.current ?? ""] ?? ["#2980b9", "#ffffff"];

  return (
    <Screen output={output.name}>
      <Box
        width={output.width}
        height={height + border}
        flexDirection="row"
        alignItems="flex-start"
        fill="#2b303b80"
        opacity={hidden ? 0 : 1}
        interactive={!hidden}
      >
        <Box position="absolute" x={0} y={height} width={output.width} height={border} fill="#64727d80" />
        <Box position="absolute" x={0} y={0} width={output.width} height={height} justifyContent="center"
             alignItems="center" interactive={false}>
          <Text font={font} size={13} color="#ffffff" maxLines={1} width={output.width / 3} align="center">
            {window?.title ?? ""}
          </Text>
        </Box>
        <Box flexDirection="row" marginX={4} height={height}>
          {monitor?.workspaces.map((workspace, index) => {
            const shown = index === monitor.active;
            // waybar lists niri's workspaces with windows, and the one shown.
            if (!shown && !workspace.columns.length && !workspace.floating.length) return null;
            return (
              <Box key={workspace.id} height={height} paddingX={5} alignItems="center" cursor="pointer"
                   fill={shown ? "#64727d" : undefined}
                   onPointerDown={() => {
                     act({ type: "focusOutput", output: output.name });
                     act({ type: "focusWorkspace", index, output: output.name });
                   }}>
                <Text font={font} size={13} color="#ffffff">{index + 1}</Text>
                {shown && <Box position="absolute" x={0} y={height - 3} width="100%" height={3} fill="#ffffff" />}
              </Box>
            );
          })}
        </Box>
        <Spacer />
        <Box flexDirection="row" height={height}>
          {profile && <Module fill={profileFill} color={profileColor}>{profile.current}</Module>}
          {volume && (volume.muted
            ? <Module fill="#90b1b1" color="#2a5c45">muted</Module>
            : <Module fill="#f1c40f" color="#000000">{`${Math.round(volume.volume * 100)}%`}</Module>)}
          {brightness && <Module fill="#90b1b1">{`${brightness.percent}%`}</Module>}
          {battery && (battery.charging || battery.pluggedIn
            ? <Module fill="#26a65b">{`${battery.percent}% charging`}</Module>
            : <Module fill="#ffffff" color="#000000">{`${battery.percent}%`}</Module>)}
          <Module fill="#64727d">{clock}</Module>
        </Box>
      </Box>
    </Screen>
  );
}
