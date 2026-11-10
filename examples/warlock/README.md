# Warlock

A desktop shell after [Warlock](https://github.com/CharlesHoskinson/Warlock) by
Charles Hoskinson: a Windows-style taskbar, window controls, a launcher, an
Alt-Tab switcher, Task View, snap layouts, notifications, Files, a system menu
and Settings, in its black-and-red design language, with windows that open and
close through a portal of red embers.

Warlock is a shell for Hyprland: an Elm interface in web views, a host, and a
plugin inside the compositor that carries out what the interface asks and
reports back what happened. Here there is no plugin and nothing to wait for.
The world is the window manager: a click on a taskbar button minimizes the
window in the same commit, a preview is the live window drawn once more, and
the portal is two shaders the compositor animates.

```sh
build/meson/proscenium --script examples/warlock.tsx
```

Its keys are listed at the top of [`warlock.tsx`](../warlock.tsx).

## What comes from Warlock

Looks and behaviour follow Warlock's own sources: its design tokens and the
skin its desktop is drawn with, the Elm shell's controls, order and wording,
and the simulated desktop of its test drive for how windows are placed.

| Part | Here | After |
| --- | --- | --- |
| Colours, type, shape, shadows: Night, Dawn and high contrast; text at 100–200% | [`theme.ts`](theme.ts) | `tokens.css`, `shell-skin.css` |
| The taskbar: pinned and running applications, their state marks, the utilities, the status chip | [`Taskbar.tsx`](Taskbar.tsx), [`groups.ts`](groups.ts) | `Taskbar.elm`, taskbar skin |
| Window frames: edge, title bar, − □ ⋮ ×, the active application's line | [`WindowFrame.tsx`](WindowFrame.tsx) | the test drive's stage |
| Tiled columns, halves and quarters, maximize, drops at the screen's edges | [`geometry.ts`](geometry.ts), [`state.ts`](state.ts) | the test drive's host |
| The portal: 520 ms opening, 360 ms closing | [`portal.tsx`](portal.tsx) | `effects.css` |
| The popup, its controls and keyboard focus | [`kit.tsx`](kit.tsx) | `controls.css`, `Surface.elm` |
| Applications, application actions and recent files, pins | [`panels/Applications.tsx`](panels/Applications.tsx), [`panels/Jump.tsx`](panels/Jump.tsx), [`catalog.ts`](catalog.ts), [`recent.ts`](recent.ts) | `Catalog.elm`, `JumpList.elm`, `Pins.elm` |
| The window switcher, Task View and moving a window to a workspace | [`panels/Switcher.tsx`](panels/Switcher.tsx), [`panels/TaskView.tsx`](panels/TaskView.tsx) | `Switcher.elm`, `TaskView.elm`, `Transfer.elm` |
| The window picker, snap chooser and window menu | [`panels/Picker.tsx`](panels/Picker.tsx), [`panels/Snap.tsx`](panels/Snap.tsx), [`panels/WindowMenu.tsx`](panels/WindowMenu.tsx) | `Snap.elm`, `Menu.elm` |
| Notifications, served on `org.freedesktop.Notifications` | [`panels/Notifications.tsx`](panels/Notifications.tsx), [`notifications.ts`](notifications.ts), [`notification-service.py`](notification-service.py) | `Notifications.elm`, `notification_service.py` |
| System: volume, network, session and power, with a confirmation | [`panels/System.tsx`](panels/System.tsx), [`system.ts`](system.ts) | `SystemMenu.elm`, `system_menu.py` |
| Files: collections and a folder path | [`panels/Files.tsx`](panels/Files.tsx), [`files.ts`](files.ts) | `Files.elm` |
| Settings: appearance, motion, shortcut choices, each saved on its own | [`panels/Settings.tsx`](panels/Settings.tsx), [`storage.ts`](storage.ts) | `Settings.elm`, `ShortcutPreferences.elm` |

The shell draws every window's frame, so it asks windows to leave out their
own title bars (`useServerDecorations`); a window that draws its own anyway, as
GTK 4 applications do, gets the frame's edge without a second title bar.

Settings, pins and shortcut choices are kept where Warlock keeps them, in
`$XDG_STATE_HOME/warlock`, in its file formats.

Where Warlock's sources disagree, the test drive and the skin win for looks and
the Elm shell for wording. What Warlock shows while it waits for Hyprland
(pending, refused, not confirmed) has no counterpart here, since nothing is
asked of anyone; every control it lists is there, and a Refresh reads the real
state again. As in Warlock, a notification whose sender has left the bus goes
straight to history, there are no toasts, and volume is set in five steps.

## What only Proscenium adds

- **The desktop is a canvas** ([`canvas/`](canvas)). At home it is Warlock's
  desktop; from there it pans and zooms, with screen-sized pages all around.
  New windows tile on the page in view, snapping and maximizing fill a page,
  and each workspace keeps its own view. Activating a window flies to it;
  `Super+O` shows every window of the workspace, and a map in the corner shows
  while the view is away from home.
- **Grouping.** `Super`-drag a box over windows to select them and move them as
  one; `Super+S` piles them into a stack with a count, which fans out like a
  hand of cards to pick from. Dragged windows line up with their neighbours
  along guides, and magnet mode pushes the ones in the way aside. These are the
  canvas world's hooks ([`../canvas`](../canvas)) over Warlock's windows.
- **Motion.** Windows glide to their places on a spring and fly to and from
  their taskbar button when minimized and restored, as Warlock's earlier
  prototype did; with Reduced motion everything is instant, as in Warlock now.
- **Live previews.** The window picker and the switcher's cards show the
  windows themselves.

## Assets

The glyphs, wallpapers and brand marks under [`assets`](assets) are Warlock's,
under the Apache License 2.0. Its typefaces are Inter, Space Grotesk and
JetBrains Mono, under the SIL Open Font License (the licences are beside the
files in [`assets/fonts`](assets/fonts)); any the system lacks is copied into
`~/.local/share/fonts/proscenium-warlock` when the world first loads, and shows
from the compositor's next start.

## Limits

- The taskbar's controls are not reached by the keyboard; its chords and
  `Super+1..9` are.
- A drag does not carry a window to another output.
