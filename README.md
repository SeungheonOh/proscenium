# Proscenium

A Wayland compositor whose scene is a React program. A TSX "world" declares
windows, text, images, web pages, shaders, cameras and input bindings; the
compositor animates and renders them itself and routes input to them, so
motion stays smooth whatever the director is doing. It grew from the Stage idea
of [Ataxia](../ataxia/docs/STAGE-WORLD.md), built directly in C on wlroots 0.20
with nothing between the Wayland objects and the scene. Everything a node shows
beyond its content, from fills and shadows to whole-screen effects, is a shader
the world defines.

```tsx
import { Background, Window, useWindows } from "proscenium";

export default function World() {
  const windows = useWindows();
  return (
    <>
      <Background fill="#1f2328" grid={{ kind: "dots" }} pan />
      {windows.map((window, index) => (
        <Window key={window.id} window={window.id} x={80 + index * 40} y={80 + index * 40}
                movable resizable />
      ))}
    </>
  );
}
```

## Build

wlroots 0.20 with Xwayland and the GLES2 renderer, plus pixman, xkbcommon,
libinput, Pango/Cairo, gdk-pixbuf, PipeWire and GLib. `scripts/fetch-deps`
unpacks development headers a system lacks under `build/deps` without
installing anything.

```sh
meson setup build/meson          # PKG_CONFIG_PATH must find wlroots-0.20
ninja -C build/meson
(cd sdk && npm ci && npm run build)
```

Web nodes need the Chromium helper, built with CMake against CEF:
`scripts/fetch-cef` downloads the pinned distribution, `meson configure
build/meson -Dweb=enabled` builds the helper with the compositor, and
`sudo scripts/install-web-sandbox` lets Chromium sandbox its renderers on
Ubuntu (without it the helper cannot start its sandbox).

## Run

```sh
build/meson/proscenium --script examples/deck.tsx             # nested in a session, or on a tty
build/meson/proscenium --headless --size 1280x720 --script examples/hypr.tsx
scripts/run-session examples/meta.tsx                         # as the desktop, a systemd user unit
```

The compositor starts the director (`node sdk/bin/proscenium.mjs WORLD.tsx`),
which reloads the world whenever its sources change; a crashing or missing
director leaves windows in a fallback cascade rather than hiding them. Options:
`--socket PATH`, `--no-xwayland`, `--no-screen-sharing`, `--run-for SECONDS`,
`--once` (no hot reload), `--dev` (React's development build and DevTools),
`--damage-debug`. On a seat it owns, the compositor points the desktop portals at
itself (`scripts/setup-desktop-session`), so screen sharing reaches the world's
share picker.

Examples: `hypr` (tiling workspaces), `niri` (niri's scrollable tiling),
`deck` (windows as playing cards), `shelf` (windows as books), `cube`
(workspaces on a turning cube), `meta` (rooms on an infinite canvas, each
tiling as hypr, niri or the deck does), `canvas` (a zoomable canvas with a
minimap), `persona` (a Persona 3 Reload shell after Persona-Quickshell;
`scripts/fetch-persona` fetches its art first).

## Documentation

- [docs/GUIDE.md](docs/GUIDE.md): writing worlds, the SDK, animation, shaders,
  input, web pages, rendering and energy.
- [docs/PROTOCOL.md](docs/PROTOCOL.md): the director protocol.
- [docs/SHADERS.md](docs/SHADERS.md): shaders as the only decoration (design under review).
- [docs/DESIGN.md](docs/DESIGN.md): threads, modules, style and performance rules.

## Testing

`(cd sdk && npm test)` runs the SDK's tests; `meson test -C build/meson` the
renderer's and media worker's. Whole sessions run headless: with `--headless`
the compositor offers virtual pointers and keyboards, and
`build/meson/proscenium-drive` plays scripted input through them (see
`tests/drive.c`), so a session can be driven like a desktop. With
`PROSCENIUM_CHECK=1` every frame is compared with a full redraw, which damage
tracking must reproduce pixel for pixel; mismatches are logged.
`tests/headless.sh examples/hypr.tsx tests/hypr.drive` runs such a session on a
private bus and scratch directories and reports the check.
