import { arrangements, presetKeys } from "../canvas/tiling.js";
import { useEffect } from "react";
import { launch, Shortcut, useModifiers } from "proscenium";
import { terminal } from "../lib/settings.js";
import { launchEntry } from "./catalog.js";
import { groupContext, groupPrimary, useTaskbarGroups } from "./groups.js";
import { shortcutRoutes, shortcutsFile, useStored, type ShortcutRoute } from "./storage.js";
import { useWarlock, type Arrow, type PopupMode } from "./WarlockProvider.js";

/** A chord as Warlock writes it, `SUPER + ALT + SPACE`, as a Shortcut's keys. */
function keysOf(chord: string): string {
  const names: Record<string, string> = {
    SUPER: "Super",
    ALT: "Alt",
    CTRL: "Ctrl",
    SHIFT: "Shift",
    SPACE: "space",
    ESCAPE: "Escape",
  };
  return chord
    .split(" + ")
    .map((part) => names[part] ?? part)
    .join("+");
}

const routeModes: Record<ShortcutRoute, PopupMode> = {
  applications: { mode: "applications" },
  system: { mode: "system" },
  notifications: { mode: "notifications" },
};

const digits = [1, 2, 3, 4, 5, 6, 7, 8, 9];
/** The arrow keys, and the page each turns the view by. */
const arrows: readonly (readonly [Arrow, number, number])[] = [
  ["Left", -1, 0],
  ["Right", 1, 0],
  ["Up", 0, -1],
  ["Down", 0, 1],
];

/** Warlock's keys: the switcher, Task View, snapping, the window menu, the taskbar's buttons by number, the canvas. */
export function Keybindings() {
  const warlock = useWarlock();
  const {
    popup,
    focusedRoot,
    state,
    openPopup,
    stepSwitcher,
    commitSwitcher,
    snap,
    maximize,
    minimize,
    restoreSize,
    activeWorkspace,
    showWorkspace,
    canvas,
  } = warlock;
  const groups = useTaskbarGroups();
  const choices = useStored(shortcutsFile);

  // Letting go of Alt chooses the switcher's window, when Alt+Tab opened it.
  const holdingAlt = useModifiers().includes("alt");
  const chordSwitcher = popup?.mode === "switcher" && popup.chord;
  useEffect(() => {
    if (chordSwitcher && !holdingAlt) commitSwitcher();
  }, [chordSwitcher, holdingAlt]);

  /** Wraps an action on the focused window, doing nothing while none has focus. */
  const onFocused = (action: (window: number) => void) => () => {
    if (focusedRoot !== null) action(focusedRoot);
  };
  const placement = (window: number) => state.windows[window]?.placement;

  return (
    <>
      <Shortcut keys="Alt+Tab" repeat onPress={() => stepSwitcher(1, true)} />
      {/* Shift turns Tab into ISO_Left_Tab. */}
      <Shortcut keys="Alt+Shift+ISO_Left_Tab" repeat onPress={() => stepSwitcher(-1, true)} />
      <Shortcut keys="Super+Tab" onPress={() => openPopup({ mode: "overview" })} />

      <Shortcut keys="Super+Left" onPress={onFocused((window) => snap(window, "left"))} />
      <Shortcut keys="Super+Right" onPress={onFocused((window) => snap(window, "right"))} />
      <Shortcut keys="Super+Up" onPress={onFocused(maximize)} />
      <Shortcut
        keys="Super+Down"
        onPress={onFocused((window) => {
          if (placement(window) === "snapped" || placement(window) === "maximized")
            restoreSize(window);
          else minimize(window);
        })}
      />
      <Shortcut
        keys="Super+Z"
        onPress={onFocused((window) => {
          if (warlock.canSnap(window)) openPopup({ mode: "snap", window });
          else warlock.notify("Snap layouts are unavailable for this window.", 4);
        })}
      />
      <Shortcut
        keys="Alt+space"
        onPress={onFocused((window) => openPopup({ mode: "menu", window }))}
      />

      {shortcutRoutes.map(({ route, chord, alternate }) => {
        const choice = choices[route];
        if (choice === "keep") return null;
        return (
          <Shortcut
            key={route}
            keys={keysOf(choice === "alternate" ? alternate : chord)}
            onPress={() => openPopup(routeModes[route])}
          />
        );
      })}

      {digits.map((digit) => {
        const group = groups[digit - 1];
        return [
          <Shortcut
            key={`go-${digit}`}
            keys={`Super+${digit}`}
            onPress={() => group && groupPrimary(warlock, group)}
          />,
          <Shortcut
            key={`new-${digit}`}
            keys={`Super+Shift+${digit}`}
            onPress={() => group?.entry && launchEntry(group.entry)}
          />,
          <Shortcut
            key={`menu-${digit}`}
            keys={`Super+Alt+${digit}`}
            onPress={() => group && groupContext(warlock, group)}
          />,
        ];
      })}

      <Shortcut keys="Super+W" onPress={onFocused(warlock.closeWindow)} />
      <Shortcut
        keys="Super+F"
        onPress={onFocused((window) =>
          warlock.setFullscreen(window, !state.windows[window]?.fullscreen),
        )}
      />
      <Shortcut
        keys="Super+P"
        onPress={onFocused((window) => {
          const on = state.windows[window]?.onTop ?? false;
          if (on || warlock.canPin(window)) warlock.setOnTop(window, !on);
        })}
      />
      {/* The canvas: each output's desktop pans and zooms, and windows gather into stacks on it. */}
      <Shortcut keys="Super+O" onPress={canvas.toggleOverview} />
      <Shortcut keys="Super+C" onPress={canvas.centerFocused} />
      <Shortcut keys="Super+Home" onPress={canvas.flyHome} />
      {arrows.map(([arrow, columns, rows]) => [
        <Shortcut
          key={`focus-${arrow}`}
          keys={`Super+Shift+${arrow}`}
          onPress={() => canvas.focusToward(arrow)}
        />,
        <Shortcut
          key={`page-${arrow}`}
          keys={`Super+Alt+${arrow}`}
          repeat
          onPress={() => canvas.turnPage(columns, rows)}
        />,
      ])}
      <Shortcut keys="Super+S" onPress={canvas.stackOrSpread} />
      {/* Held, Super+` goes on through the stack; letting go of Super picks. */}
      <Shortcut keys="Super+grave" repeat onPress={() => canvas.fanStack(1)} />
      {/* Sunlight's placement keys, as the canvas world has them. */}
      {presetKeys.map(([key, preset]) => (
        <Shortcut
          key={`tile-${preset}`}
          keys={`Ctrl+Alt+${key}`}
          onPress={() => canvas.tile(preset)}
        />
      ))}
      {arrangements.map((columns) => (
        <Shortcut
          key={`arrange-${columns}`}
          keys={`Ctrl+Alt+${columns}`}
          onPress={() => canvas.arrangeColumns(columns)}
        />
      ))}
      <Shortcut keys="Ctrl+Alt+A" onPress={() => canvas.tidy()} />
      <Shortcut keys="Super+Shift+Z" onPress={() => canvas.undo()} />
      <Shortcut keys="Super+G" onPress={canvas.toggleGuides} />
      <Shortcut keys="Super+M" onPress={canvas.toggleMagnet} />
      <Shortcut keys="Super+Shift+M" onPress={canvas.cycleMagnetStrength} />

      <Shortcut
        keys="Super+Ctrl+Left"
        onPress={() => showWorkspace(Math.max(1, activeWorkspace - 1))}
      />
      <Shortcut
        keys="Super+Ctrl+Right"
        onPress={() => showWorkspace(Math.min(10, activeWorkspace + 1))}
      />
      <Shortcut keys="Super+Return" onPress={() => launch(terminal)} />
    </>
  );
}
