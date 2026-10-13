import { existsSync } from "node:fs";
import { join } from "node:path";
import { close, launch, Shortcut, useKeyboardGrab, warpPointer, type StageKeyEvent } from "proscenium";
import { terminal as fallbackTerminal } from "../lib/settings.js";
import { changeBrightness } from "../lib/system/brightness.js";
import { mediaCommand } from "../lib/system/media.js";
import { changeVolume, toggleMute } from "../lib/system/sound.js";
import { useNiri } from "./NiriProvider.js";
import { captureNow } from "./ScreenshotUI.js";
import type { NiriAction } from "./state.js";

function installed(command: string): boolean {
  return (process.env.PATH ?? "").split(":").some((directory) => existsSync(join(directory, command)));
}

/** niri opens alacritty; without it, the desktop's own terminal. */
export const terminal = installed("alacritty") ? "alacritty" : fallbackTerminal;

type Bind = [keys: string, run: () => void, repeat?: boolean];

/** Both spellings of KEYS with Mod: the arrow and its Vim letter. */
function both(arrow: string, letter: string, prefix: string, run: () => void): Bind[] {
  return [[`${prefix}${arrow}`, run], [`${prefix}${letter}`, run]];
}

/** niri's default bindings, Mod being Super. Every bind repeats while held unless marked otherwise. */
export function Keybindings() {
  const { act, focused, overview, setOverview, overlays, setOverlay, state, envRef } = useNiri();
  const run = (action: NiriAction) => () => act(action);
  // Focus moving to another output by keyboard brings the pointer to its middle, as in niri.
  const toMonitor = (action: Extract<NiriAction, { direction: -1 | 1 }>) => () => {
    const outputs = envRef.current.outputs;
    const target = outputs[outputs.findIndex((output) => output.name === state.activeOutput) + action.direction];
    act(action);
    if (target) warpPointer(target.name, target.width / 2, target.height / 2);
  };
  const closeFocused = () => focused !== null && close(focused);

  const binds: Bind[] = [
    ["Super+Shift+question", () => !overlays.hotkeys && setOverlay("hotkeys", true), false],
    ["Super+O", () => setOverview((open) => !open), false],
    ["Super+Q", closeFocused, false],
    ["Alt+F4", closeFocused, false],

    ...both("Left", "H", "Super+", run({ type: "focusColumn", to: "left" })),
    ...both("Right", "L", "Super+", run({ type: "focusColumn", to: "right" })),
    ...both("Down", "J", "Super+", run({ type: "focusWindow", direction: 1 })),
    ...both("Up", "K", "Super+", run({ type: "focusWindow", direction: -1 })),
    ...both("Left", "H", "Super+Ctrl+", run({ type: "moveColumn", to: "left" })),
    ...both("Right", "L", "Super+Ctrl+", run({ type: "moveColumn", to: "right" })),
    ...both("Down", "J", "Super+Ctrl+", run({ type: "moveWindow", direction: 1 })),
    ...both("Up", "K", "Super+Ctrl+", run({ type: "moveWindow", direction: -1 })),
    ["Super+Home", run({ type: "focusColumn", to: "first" })],
    ["Super+End", run({ type: "focusColumn", to: "last" })],
    ["Super+Ctrl+Home", run({ type: "moveColumn", to: "first" })],
    ["Super+Ctrl+End", run({ type: "moveColumn", to: "last" })],

    // Outputs form one row, so up and down have no neighbour.
    ...both("Left", "H", "Super+Shift+", toMonitor({ type: "focusMonitor", direction: -1 })),
    ...both("Right", "L", "Super+Shift+", toMonitor({ type: "focusMonitor", direction: 1 })),
    ...both("Left", "H", "Super+Shift+Ctrl+", toMonitor({ type: "moveColumnToMonitor", direction: -1 })),
    ...both("Right", "L", "Super+Shift+Ctrl+", toMonitor({ type: "moveColumnToMonitor", direction: 1 })),

    ...both("Next", "U", "Super+", run({ type: "focusWorkspaceRelative", direction: 1 })),
    ...both("Prior", "I", "Super+", run({ type: "focusWorkspaceRelative", direction: -1 })),
    ...both("Next", "U", "Super+Ctrl+", run({ type: "moveColumnToWorkspace", direction: 1 })),
    ...both("Prior", "I", "Super+Ctrl+", run({ type: "moveColumnToWorkspace", direction: -1 })),
    ...both("Next", "U", "Super+Shift+", run({ type: "moveWorkspace", direction: 1 })),
    ...both("Prior", "I", "Super+Shift+", run({ type: "moveWorkspace", direction: -1 })),
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((number): Bind[] => [
      [`Super+${number}`, run({ type: "focusWorkspace", index: number - 1 })],
      [`Super+Ctrl+${number}`, run({ type: "moveColumnToWorkspace", index: number - 1 })],
    ]),

    ["Super+bracketleft", run({ type: "consumeOrExpel", direction: -1 })],
    ["Super+bracketright", run({ type: "consumeOrExpel", direction: 1 })],
    ["Super+comma", run({ type: "consume" })],
    ["Super+period", run({ type: "expel" })],

    ["Super+R", run({ type: "presetWidth", direction: 1 })],
    ["Super+Shift+R", run({ type: "presetWidth", direction: -1 })],
    ["Super+Ctrl+Shift+R", run({ type: "presetHeight" })],
    ["Super+Ctrl+R", run({ type: "resetHeight" })],
    ["Super+F", run({ type: "maximizeColumn" })],
    ["Super+Shift+F", run({ type: "fullscreen" })],
    ["Super+M", run({ type: "maximizeToEdges" })],
    ["Super+Ctrl+F", run({ type: "expandColumn" })],
    ["Super+C", run({ type: "centerColumn" })],
    ["Super+Ctrl+C", run({ type: "centerVisible" })],
    ["Super+minus", run({ type: "adjustWidth", percent: -10 })],
    ["Super+equal", run({ type: "adjustWidth", percent: 10 })],
    // Shift turns minus and equal into underscore and plus.
    ["Super+Shift+underscore", run({ type: "adjustHeight", percent: -10 })],
    ["Super+Shift+plus", run({ type: "adjustHeight", percent: 10 })],
    ["Super+V", run({ type: "toggleFloating" })],
    ["Super+Shift+V", run({ type: "switchFocusFloating" })],
    ["Super+W", run({ type: "toggleTabbed" })],

    ["Print", () => setOverlay("screenshot", true), false],
    ["Ctrl+Print", () => state.activeOutput && captureNow({ output: state.activeOutput }), false],
    // Alt turns Print into Sys_Req on many layouts.
    ["Alt+Print", () => focused !== null && captureNow({ window: focused }), false],
    ["Alt+Sys_Req", () => focused !== null && captureNow({ window: focused }), false],
  ];

  // These still work while the screenshot UI has the keyboard, as in niri.
  const always: Bind[] = [
    ["Super+Shift+E", () => setOverlay("exit", true)],
    ["Ctrl+Alt+Delete", () => setOverlay("exit", true)],
    ["Super+T", () => launch(terminal)],
    ["XF86AudioRaiseVolume", () => changeVolume(0.1)],
    ["XF86AudioLowerVolume", () => changeVolume(-0.1)],
    ["XF86AudioMute", toggleMute],
    ["XF86AudioPlay", () => mediaCommand("PlayPause")],
    ["XF86AudioPause", () => mediaCommand("PlayPause")],
    ["XF86AudioStop", () => mediaCommand("Stop")],
    ["XF86AudioPrev", () => mediaCommand("Previous")],
    ["XF86AudioNext", () => mediaCommand("Next")],
    ["XF86MonBrightnessUp", () => changeBrightness(10)],
    ["XF86MonBrightnessDown", () => changeBrightness(-10)],
  ];

  // The overview holds the keyboard; plain keys move around it, and bindings still work.
  const overviewKeys = (event: StageKeyEvent) => {
    if (!event.pressed) return;
    if ((event.key === "Escape" || event.key === "Return") && !event.repeat) setOverview(false);
    else if (event.key === "Left") act({ type: "focusColumn", to: "left" });
    else if (event.key === "Right") act({ type: "focusColumn", to: "right" });
    else if (event.key === "Up") act({ type: "focusWindow", direction: -1, orWorkspace: true });
    else if (event.key === "Down") act({ type: "focusWindow", direction: 1, orWorkspace: true });
  };
  useKeyboardGrab(overview && !overlays.screenshot && !overlays.exit ? overviewKeys : null);

  // The exit dialog swallows every key but its own.
  if (overlays.exit) return null;
  const active = overlays.screenshot ? always : [...binds, ...always];
  return (
    <>
      {active.map(([keys, action, repeat = true]) => (
        <Shortcut key={keys} keys={keys} repeat={repeat} onPress={action} />
      ))}
    </>
  );
}
