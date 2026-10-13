# Proscenium design

Proscenium is a Wayland compositor whose scene is directed by a React program.
It grew from the Stage idea of [Ataxia](../../ataxia/docs/STAGE-WORLD.md),
built directly in C on wlroots: there is no kernel, world or Lisp layer between
the Wayland objects and the scene the director declares. The TypeScript director
(`sdk/`, `examples/`) speaks the director protocol (`docs/PROTOCOL.md`) over a
Unix socket; the compositor keeps the scene graph, animates it on its own frame clock,
renders it with GLES and routes input.

## Process and threads

- **Compositor** (one process): the Wayland event loop on the main thread owns
  every wlroots object, the scene, GL and the director link. Nothing on it waits
  for the network, disk, a child process or the director.
- **Media worker** thread: decodes images and rasterizes text with Pango/Cairo,
  returning results through an eventfd the event loop watches.
- **Screencast** thread: the desktop portal's ScreenCast backend over D-Bus and
  the PipeWire streams; it never touches GL or the scene.
- **Director** (`node`, child process): React, user code and hot reload.
- **Web helper** (child process): Chromium (CEF) rendering pages offscreen and
  handing frames over as dma-bufs.

## Modules (`src/`)

| File | Responsibility |
| --- | --- |
| `main.c` | Options, startup, the director and session-setup processes. |
| `server.h` | The `struct server` every module shares, windows, outputs and hits. |
| `util.c` | Allocation, growable arrays and strings, an integer map, time. |
| `json.c` | Bounded JSON parser and encoder for the protocol. |
| `geometry.c` | Boxes, projective plane maps, 4x4 matrices. |
| `motion.c` | Springs, tweens, curves, decay; keyframe tracks. |
| `props.c` | Node kinds, the property schema, decoding wire values, transform lists. |
| `scene.c` | Nodes, commits, transitions, identity hand-over, exits, shader uses and their clocks. |
| `shader.c` | Shaders the director defines: stages, uniforms, reads, bounds, regions, gates (see [SHADERS.md](SHADERS.md)). |
| `stage.c` | Indexes rebuilt after each commit, the fallback layout, motion on the frame clock. |
| `link.c` | The director socket, framing, messages, coalescing. |
| `output.c` | Outputs, the row layout, frame scheduling and pacing, GPU timing, work areas. |
| `window.c` | Windows: ids, metadata, configure, focus, snapshots. |
| `xdg.c`, `xwayland.c` | xdg-shell and X11 clients as windows; popups, decorations, override-redirect children. |
| `display.c` | Per-output display lists, damage, repair passes, occlusion, effects, hits, captures. |
| `render.c`, `gl.c` | GLES programs: textures, blur, and the shaders' paint, filter and effect programs; render targets. |
| `content.c` | Text and image nodes on top of `media.c`. |
| `media.c` | Pango text layout and rasters, image decoding, the worker. |
| `webnode.c`, `web.c` | Web nodes: pages on the CEF helper (`web/`), their frames and input. |
| `input.c` | Keyboards, pointer, gestures; shortcuts, bindings, picking, events, cursors, drags. |
| `manip.c` | Native moves, resizes, pans and zooms. |
| `camera.c` | Per-output cameras. |
| `clipboard.c` | Selections: clipboard text to and from the director. |
| `capture.c` | Screenshots for the director. |
| `share.c`, `screencast.c` | Screen sharing: requests, sources, PipeWire. |

## Style

- C17 with GNU extensions, built by meson. Four-space indentation, braces on the
  same line, lines up to 100 columns: `clang-format -i` with the repository's
  `.clang-format` keeps it so.
- `snake_case` everywhere. Structs are named, never typedef'd, as in wlroots.
  Public functions carry their module's prefix (`render_`, `media_`, `scene_`).
- Headers say what a function does and anything surprising about it, in a
  sentence or two. Comments inside functions explain why, not what.
- Allocation goes through `xmalloc`/`xcalloc`/`xstrdup` (`util.h`), which abort
  on exhaustion. Errors a client or the director can cause are reported and
  survived; they never abort.
- Logging uses `wlr_log`.
- No module polls. Work happens in response to an event, a frame, or a timer
  armed for a known deadline; when nothing changes, nothing runs.

## Energy and performance rules

- Settled scenes schedule no frames and arm no timers.
- Every frame repaints only the damage since its buffer was last drawn, and a
  frame that changes no pixels and owes no client a callback is not committed.
- The cursor uses a hardware plane where the output has one, so pointer motion
  over a still scene costs no frame.
- Allocation per frame is bounded and reused; display lists keep their storage.
- Commands reach the GPU early (`glFlush` every millisecond of recording), and
  frames start as late as still meets the vblank.
- Screen shares capture only while a consumer streams and the source changed.
- Children the director starts stop with it: a director exiting unmounts its
  world first, so effects clean up.
