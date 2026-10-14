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

## Decisions

### Pages that draw the canvas lie on it and move with their frames

The canvas world's paper is an Excalidraw page under the windows that has to show
the canvas where the camera looks, so its drawing stays with the windows as the
canvas moves. Ways tried first:

- **The page laid on the canvas, with pictures between**: laid again once the view
  settled elsewhere, a PNG of each drawing standing in while the camera moved or
  the page was laid again. The drawing drifted from the windows, flashed and
  dropped to the pictures' lower resolution.
- **A screen-fixed page told the camera**, by `useCamera` (where it is headed: a
  fling's coast, a Super+wheel glide and a spring flight report their destination
  as they start), by `followCamera` on the web node (the compositor posting the
  camera into the page each frame) or by a live camera report through the
  director. Each draws the page again in every frame of a pan, about 450 ms of CPU
  and 700 ms of GPU a second at 2256 × 1504, and the drawing trailed the windows
  and the grid by 12–23 px at 400 px/s, two to three frames, since Chromium draws
  on its own 60 Hz clock.

What stands: the page lies on the canvas over the view and a margin, at rest. The
compositor moves it with the canvas as it does a window, so a pan draws nothing in
the page and the drawing cannot drift: a line drawn beside a window kept the same
42–43 px through a pan, a fling and the page being laid again. It is laid again
only when the view nears its edge or the zoom has changed by an eighth: short of
the 15% at which the compositor would raster the page again at the scale it is
seen at, which draws the whole page again and can bring one frame laid out at the
new scale but the old size, the drawing briefly a fifth too small or large. That
move is where it could jump, since the node would move at once and the page draw
for the new place a frame or two later. So the move waits for the frame:

- The node's `frameTag` names the frame it is placed for.
- The page, once it draws for the new place, marks its frames with that number
  (`tagFrames` in the page runtime: two 2 × 2 px cells at its top left).
- The helper reads the cells as it copies a frame, blanks them and hands the
  number on with the frame.
- The compositor remembers where the node was for each of its last four numbers,
  within the canvas so it still pans, and shows each frame where it was drawn for:
  until a frame with the node's latest number comes, the node stays where the frame
  shown belongs, then the frame and the place change together. Moves that overlap,
  as in a fast zoom, place the page again before its last frame reached the screen;
  with only the last good place kept, such a frame showed for a few frames at the
  place before it. A frame with a number it does not remember, or one waited for
  over a second, shows where the node is.

Panning with the paper out costs what it does with the paper put away: 77–82 ms of
CPU and 172 ms of GPU a second, against 67–78 and 150.
