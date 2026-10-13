# Persona

A Persona 3 Reload shell for Proscenium, after
[**Persona-Quickshell**](https://github.com/Yujonpradhananga/Persona-Quickshell)
by **Yujon Pradhananga**, a Quickshell (QML) configuration for Hyprland. Its
look, layout, timings and art are his. This world rebuilds it in React on
Proscenium, over the [hypr](../hypr.tsx) example's tiling.

## Running

The art, video and fonts are not part of this repository. Fetch them once:

```sh
scripts/fetch-persona                                 # about 40 MB into examples/persona/assets
build/meson/proscenium --script examples/persona.tsx  # or scripts/run-session examples/persona.tsx
```

`scripts/fetch-persona` needs Python 3, network access, and ffmpeg or VLC
(`cvlc`), and preferably Pillow or ffmpeg for the wallpaper's smaller copies. It
downloads Persona-Quickshell at a pinned commit and converts its H.264 videos to
VP9, which Chromium as CEF builds it can play. It also installs the stand-in
fonts into `~/.local/share/fonts/proscenium-persona` for the compositor's own
text. Without the assets, the world still tiles windows and says how to fetch
them.

| Keys | |
| --- | --- |
| left edge, middle | a ball rolls out; click it for the blades, and pull a blade to the right for the calendar, stats, screen shaders or power menu |
| Super+R | application search |
| volume and brightness keys | a level pill near the top |
| Super+Return / Q / F / V / T, Super+1..9, Super+arrows | as in the hypr world |

## What is where

| Original | Here | Drawn by |
| --- | --- | --- |
| `WallpaperEngine`: the train carriage, the sea, rain, the passing train, the cava hills, parallax | `Wallpaper.tsx`, `Rain.tsx`, `paints.ts` | the compositor |
| `Clock` and its moon | `Clock.tsx`, `Moon.tsx` | the compositor |
| `Capsule`, the music player | `Player.tsx`, `Marquee.tsx`, `art.ts` | the compositor |
| `AppDrawer`, the ball and blades | `Drawer.tsx`, `Blade.tsx`, with Qt's `SpringAnimation` constants as springs (`config.ts`) | the compositor |
| `Calendar`, `Resume`, `Options`, `P3rpause` and the three `P3rTransition`s | `pages/menus` | Chromium, while open |
| `Searchapp` | `pages/search`, `Search.tsx`, `icons.ts` | Chromium, while open |
| `VolumeOsd`, `BrightnessOsd` | `pages/osd`, `Osd.tsx` | Chromium, while shown |
| the screen shaders set through `hyprctl` | `filters.ts`, `ScreenFilters.tsx` | the compositor |
| `SysInfo`, `NetInfo`, `BluetoothInfo` | `system.ts` | |

Anything that moves while nobody touches it is drawn by the compositor. It runs
the keyframes itself and repaints only what moves, and the desktop rests while
windows cover it. Menus and the search are web pages: they need text input,
scrolling lists, rich layout and video, and they cost nothing while hidden. At
2256 × 1504 on an Iris Xe laptop, the moving desktop takes about 40 ms of CPU a
second and 2 ms of GPU a frame. The first version drew it in a WebGL page, which
took 730 ms of CPU a second: a page that changes every frame pays for a whole
Chromium frame each time, whatever its size.

## Differences from the original

- **Window management.** Persona-Quickshell is a shell over Hyprland; here the
  hypr example tiles the windows.
- **Parallax.** The original's DepthFlow ray march moves near and far parts of
  the wallpaper within 8% of each other, so two layers stand in for it. The
  sea's ripple, which drifts too slowly to see, is left out.
- **Fonts.** Free stand-ins replace the ones that are not free, unless the
  originals are installed: Selawik for Microsoft YaHei, Barlow Condensed for
  Bahnschrift Condensed, Libertinus Sans for Linux Biolinum, Nerd Font symbols
  for Material Symbols, and ProggyClean for proggyfonts.
- **Videos** play at 1920 × 1080 and 30 frames a second at most, since Chromium
  decodes them in software.
- **Logout** stops the compositor; shutdown and restart use `loginctl`, as in
  the original.
- **The search** opens on the focused output, not on every one.
- **The spectrum hills** need [cava](https://github.com/karlstav/cava), as the
  original's plugin does.

## Credits

- **Persona-Quickshell** by Yujon Pradhananga:
  <https://github.com/Yujonpradhananga/Persona-Quickshell>. Its design,
  animations and shaders are the basis of this world, and its art and videos are
  what `scripts/fetch-persona` downloads. Its README states the MIT License.
- **Persona 3 Reload** characters, menus and videos are © ATLUS and SEGA. None of
  it is in this repository.
- **The wallpaper** comes from Steam Workshop item
  [3151551777](https://steamcommunity.com/sharedfiles/filedetails/?id=3151551777),
  as the original credits it.
- **The greyscale screen shader** is the reading mode of
  [snes19xx's surface-dots](https://github.com/snes19xx/surface-dots/blob/main/.config/hypr/shaders/reading_mode.glsl),
  which the original uses.
- **The record's grooves** follow the original's album cover mask by Squirrel
  Modeller. The original credits its album art to
  [Rexcrazy804's Zaphkiel](https://github.com/Rexcrazy804/Zaphkiel), and thanks
  [blairxu13's persona3-website](https://github.com/blairxu13/persona3-website).
- **Fonts:**
  - Montserrat, Bebas Neue, Barlow Condensed and JetBrains Mono, from Google
    Fonts (SIL OFL);
  - Selawik, by Microsoft (SIL OFL);
  - Libertinus Sans (SIL OFL);
  - the Symbols Nerd Font and ProggyClean, from [Nerd Fonts](https://www.nerdfonts.com)
    (MIT, with each icon set under its own license).
