import { Box, Screen, Text, useInput } from "proscenium";
import { escapeMarkup } from "./markup.js";
import { useNiri } from "./NiriProvider.js";
import { terminal } from "./Keybindings.js";

/** niri's "Important Hotkeys" rows for its default binds, in its order. */
const rows: [key: string, label: string][] = [
  ["Super + Shift + /", "Show Important Hotkeys"],
  ["Super + Shift + E", "Exit niri"],
  ["Super + Q", "Close Focused Window"],
  ["Super + Left", "Focus Column to the Left"],
  ["Super + Right", "Focus Column to the Right"],
  ["Super + Ctrl + Left", "Move Column Left"],
  ["Super + Ctrl + Right", "Move Column Right"],
  ["Super + Page Down", "Switch Workspace Down"],
  ["Super + Page Up", "Switch Workspace Up"],
  ["Super + Ctrl + Page Down", "Move Column to Workspace Down"],
  ["Super + Ctrl + Page Up", "Move Column to Workspace Up"],
  ["Super + R", "Switch Preset Column Widths"],
  ["Super + F", "Maximize Column"],
  ["Super + [", "Consume or Expel Window Left"],
  ["Super + ]", "Consume or Expel Window Right"],
  ["Super + V", "Move Window Between Floating and Tiling"],
  ["Super + Shift + V", "Switch Focus Between Floating and Tiling"],
  ["Super + O", "Open the Overview"],
  ["PrtSc", "Take a Screenshot"],
  ["Super + T", `Open a Terminal: ${terminal}`],
  ["Super + D", "Run an Application"],
];

const font = "sans";
const size = 14;
const rowHeight = 19;
const padding = 8;

/** A key as niri writes it: monospace on a dark key cap. */
export function keyCap(key: string, background = "#2f2f2f"): string {
  return `<span font_family="monospace" bgcolor="${background}"> ${escapeMarkup(key)} </span>`;
}

/**
 * The overlay niri shows at startup and on Mod+Shift+/: a plain panel with no
 * animation, centered on every output, gone with the next input of any kind,
 * which still does what it does.
 */
export function HotkeyOverlay() {
  const { outputs, overlays, setOverlay } = useNiri();
  useInput(overlays.hotkeys ? () => setOverlay("hotkeys", false) : null);
  if (!overlays.hotkeys) return null;
  return (
    <>
      {outputs.map((output) => (
        <Screen key={output.name} output={output.name}>
          <Box
            width={output.width}
            height={output.height}
            justifyContent="center"
            alignItems="center"
            interactive={false}
          >
            <Box
              fill="#1a1a1a"
              border={{ width: 2, color: "#80ccff" }}
              opacity={0.9}
              padding={padding}
              flexDirection="column"
              gap={padding}
            >
              <Text font={font} size={size} weight="bold" color="#ffffff" alignSelf="center">
                Important Hotkeys
              </Text>
              <Box flexDirection="row" gap={padding}>
                <Box flexDirection="column" gap={2} alignItems="flex-start">
                  {rows.map(([key]) => (
                    <Box key={key} height={rowHeight} justifyContent="center">
                      <Text markup font={font} size={size} color="#ffffff">{keyCap(key)}</Text>
                    </Box>
                  ))}
                </Box>
                <Box flexDirection="column" gap={2} alignItems="flex-start">
                  {rows.map(([key, label]) => (
                    <Box key={key} height={rowHeight} justifyContent="center">
                      <Text font={font} size={size} color="#ffffff">{label}</Text>
                    </Box>
                  ))}
                </Box>
              </Box>
            </Box>
          </Box>
        </Screen>
      ))}
    </>
  );
}
