# UI refinement and a web output: research

Research only; nothing here is implemented. Written on branch `ui-refinement`
(off `webremote` at `ea35068`), from reading the renderer, SDK and UI kit, and
from a survey of GPUI, gpui-component, React Strict DOM, Yoga, Flutter web,
Greenfield, Selkies and the Material/Fluent/Apple motion guidance.

One limit up front: I could not get a headless session to draw in my shell
(EGL would not initialise), so the diagnosis below comes from the code, not
from looking at pixels. Section 6 asks for the examples that would confirm it.

## 1. Summary

- **The renderer's base is already at GPUI's level.** Boxes are analytic SDFs,
  shadows are Evan Wallace's closed-form Gaussian (what Zed shipped until
  recently), glyphs come from an atlas with 4×4 subpixel phases, blur is dual
  Kawase, and damage tracking is better than GPUI's (GPUI has none).
- **What is missing sits one layer up**, in four places: text blending,
  the vocabulary of a box, interaction that round-trips through the director,
  and device-pixel snapping. These are what GPUI, and every toolkit that feels
  finished, spend their effort on.
- **The examples already vote with their feet**: the bar's menus, launcher,
  finder, share picker and code viewer are React DOM pages in CEF, not nodes.
  A good test of "mature" is being able to move those back.
- **Web output is feasible and fits the existing design**, because the wire
  protocol is already a retained tree of declarative targets. Recommended
  shape: Proscenium primitives are the source of truth and the DOM is a second
  render target (the React Native → web direction), not web elements
  translated into nodes (the uncommitted `html.ts` direction).
- **One rule ties both goals together**: every primitive and every
  interaction feature added from here on must have a direct CSS equivalent.
  Flutter removed its DOM renderer because its paint model had none.

## 2. Why it reads as unrefined

Ranked by how much I expect each to matter.

### 2.1 Interaction goes through React

`Pressable` (`sdk/src/ui/Pressable.tsx`) holds hover and press in `useState`.
Every hover is: compositor pick → socket → Node → React render → commit →
socket → next frame. With the render thread a frame can already be up to a
refresh late, so hover feedback lands one to three frames after the pointer.
`ScrollView` is the same: each wheel or finger event becomes a `setOffset` in
the director, with no momentum, no overscroll, and a thumb driven by a timer.

GPUI's answer is structural. Hover, active and focus styles are data on the
element (`hover`, `active`, `group_hover`, `focus_visible`), and the hit test
runs between prepaint and paint, so the frame that moves the pointer also
shows the hover. Proscenium already applies this principle to drags, pans and
resizes ("direct manipulation never waits for the director"); controls are
the part that has not received it.

Also absent: keyboard focus traversal, a focus-visible ring, and IME for
world-drawn text fields (`TextField` builds its caret and selection from a
keyboard grab).

### 2.2 Text is blended without gamma or contrast correction

`glyph_fragment` in `src/render.c` multiplies atlas coverage by the colour
and blends premultiplied in gamma space. Nothing else is done. The usual
result is dark-on-light text that looks thin and light-on-dark text that looks
heavy, which is likely why the theme's body weight is 500 rather than 400.

Zed ports Windows Terminal's approach: a contrast boost
`a·(k+1)/(a·k+1)` scaled by text brightness, then an alpha correction indexed
by gamma (default 1.8). FreeType's own guidance says the same: coverage needs
linear-space blending or a correction standing in for it. This is a
fragment-shader change of a few lines.

Other text gaps, from `PROP_SPECS` and `TextProps`: no letter spacing, no font
features (tabular figures for clocks and counters), end-ellipsis only, no
underline or strike primitive. GPUI also rounds line heights to whole device
pixels and snaps glyph origins to quarter pixels in x and whole pixels in y;
here the y phase is also subpixel, which softens horizontal stems.

### 2.3 A box can say too little

| Property | Proscenium today | GPUI / CSS |
| --- | --- | --- |
| Corner radius | one value | per corner |
| Border | one width, one paint | per side, dashed |
| Shadow | one, outer | a list, inset too |
| Gradient | two stops, linear | multi-stop, Oklab, dithered |
| Clip | axis-aligned rectangle | rounded |
| Group opacity | multiplied into each child | composited as a layer |
| Vector shapes | none (images only) | paths, tinted SVG sprites |

Each line is a visible tell. One shadow means no "ambient plus key" pair,
which is most of what makes a card look lifted. Rectangle-only clipping means
scrolled content and images cut square at a rounded card's corners. Per-child
opacity means overlapping children show through each other while a panel
fades. Two-stop gradients band without dithering.

### 2.4 Layout snaps to logical pixels, not device pixels

`layout.ts` sets Yoga's point scale factor to 1. At a fractional output scale,
edges land between device pixels and hairlines blur or double. GPUI turns the
layout engine's rounding off and snaps itself in device pixels in two passes:
authored lengths before layout, absolute outer edges after, so shared edges
close and a 1 px line stays 1 device pixel at 150%. If the laptop panel runs
at a fractional scale this alone may be a large part of the impression.

### 2.5 Tokens

Smaller, and partly taste. Compared with gpui-component (shadcn-style roles):
its shadows use negative spread (`0 4 8 -2`, `0 12 24 -4`) to stay tight under
the surface; its scrollbars fade after a 2 s hold and widen on hover; motion
splits into slightly underdamped springs for position and size and critically
damped ones for colour and opacity (Material 3 tokens say the same). The kit's
`pop` and `glide` springs apply bounce to fills as well as geometry.

## 3. What to take from other frameworks

| Source | Take | Leave |
| --- | --- | --- |
| GPUI | State styles as data; same-frame hit test; text contrast and gamma; two-phase device-pixel snapping; richer quad; Raph Levien's blurred rounded rect (no sampling loop, supports inset) | Its frame model (rebuilds per frame, no damage); Taffy; its web target, which is one canvas, not DOM |
| gpui-component | Token scale and control metrics as a reference; scrollbar behaviour; reduce-motion | — |
| React Native / RSD | Primitives first, web as a backend; inline style objects; RSD's finding that hover/active need renderer support | RSD's direction (web as spec, native as subset): pre-1.0, and it is the path that grows into an HTML engine |
| Flutter web | The warning: no primitive without a CSS equivalent | Canvas rendering on the web |
| Greenfield, Selkies | Per-surface H.264 over WebSocket with WebCodecs; DOM chrome over video; answer frame callbacks locally | Greenfield's alpha-as-second-stream, unless windows need translucency |
| Skia, Vello, Slint, Qt Quick | Nothing wholesale. Adopting a renderer means giving up the damage, occlusion and shader model already built, for gains obtainable with a few shaders | |

## 4. Web output

### 4.1 Direction

Keep the SDK's nodes (`Box`, `Text`, `Image`, `Window`, …) as the one thing
authors write, and add a second consumer of the commit stream that builds DOM.
The mapping is nearly one to one:

| Node feature | DOM |
| --- | --- |
| `Box`/`Rect` with fill, radius, border, shadow | `div` with `background`, `border-radius`, `border`, `box-shadow` |
| `blur` | `backdrop-filter: blur()` (close, not identical, to dual Kawase) |
| `Text` | `span` with the same font files served as webfonts |
| `Image` | `img` |
| `transform`, `opacity`, `clip` | `transform`, `opacity`, `overflow: hidden` |
| `Window`, `Mirror` | `canvas` fed by that window's H.264 stream |
| `Web` | `iframe` (the `remote-hybrid-attempt` branch already does this) |
| State styles (§5) | `:hover`, `:active`, `:focus-visible` |
| Scroll container (§5) | native `overflow: auto` |

The uncommitted `html.ts` goes the other way (`<div style>` → nodes). It can
stay as authoring sugar, but I would not build on it: it caps the native side
at what the subset can express, and each request to widen the subset pulls
toward the HTML engine you ruled out.

### 4.2 Architecture

- **A remote viewer is an output.** Give each browser a virtual output sized
  to its viewport; the world draws a `<Screen>` for it like any other. Layout
  stays with the director and nothing is scaled.
- **The host stays the layout authority.** The director already resolves Yoga
  to absolute boxes and Pango measures text. Send those boxes, and the DOM
  positions absolutely. This sidesteps every Yoga-versus-browser flexbox
  difference (automatic minimum sizes, shrink defaults) rather than chasing
  them.
- **Text needs two guards**: serve the exact font files, and send Pango's
  line breaks so the browser never re-wraps. Advances will still differ by
  fractions of a pixel; boxes sized by the host absorb that.
- **Motion runs in the client.** A small JS integrator mirroring `motion.c`
  (same stiffness/damping/mass, retarget from displayed value and velocity),
  writing `transform` and `opacity`. CSS `linear()` can play a pre-sampled
  spring but has a fixed duration and cannot carry velocity through a
  retarget, which is the property the compositor's motion is built on.
- **Windows are per-surface streams.** The screencast path already captures a
  window from its own surfaces. Browsers cap decoders (the limit is
  implementation-defined; Chrome also reclaims decoders idle for a minute), so
  budget a handful and fall back to one composited stream for the rest.
- **Custom shaders** are GLSL ES 1.0, which WebGL 1 runs nearly as written, so
  a paint can draw into a small canvas. Shaders that read the backdrop (liquid
  glass) cannot see the video and DOM beneath; they need a declared fallback
  such as `backdrop-filter`.

### 4.3 Risks

- Hover and press over a network are unusable unless the client resolves them
  locally. This is the same feature as §2.1, which is why it comes first.
- Per-window streams multiply encoder load on the host; hardware encoders also
  cap sessions.
- Visual parity will be close, not exact: blur kernel, text antialiasing and
  shadow falloff all differ slightly from the browser's.

## 5. Proposed order

1. **Make it measurable.** A gallery world of every control in both themes at
   scale 1, 1.5 and 2, with a screenshot harness, next to the same gallery in
   a browser. Refinement becomes a diff rather than a feeling.
2. **Renderer polish**: text contrast and gamma, whole-pixel baselines,
   device-pixel layout snapping; then the box vocabulary (per-corner radii,
   per-side borders, shadow lists with inset, rounded clip, layer opacity,
   multi-stop dithered gradients, letter spacing and font features).
3. **Interaction in the compositor**: state styles (`hover`, `pressed`,
   `focused`, `disabled`, and a group form) resolved at pick time with the
   node's transitions; a scroll container whose offset the compositor owns,
   with momentum and a fading scrollbar; focus traversal and a focus ring.
4. **Rebuild `proscenium/ui` on those**, retune tokens, and port the bar menu
   and launcher off CEF as the acceptance test.
5. **DOM backend and per-window streams**, reusing the viewer, layer sync and
   iframe hosting from `remote-hybrid-attempt`.

Steps 2 and 3 are designed against the CSS-equivalent rule from the start, so
step 5 is a mapping exercise rather than a redesign.

## 6. Questions

1. Which two or three things feel most off to you: text, hover and scroll
   response, or the look of surfaces? It decides whether step 2 or 3 goes
   first.
2. What scale does your panel run at? If fractional, §2.4 moves to the top.
3. Is per-window video required for the first web version, or is one video of
   the windows under a DOM layer acceptable to start? The second is much
   cheaper but only allows UI above windows.
4. Should `html.ts` be kept as sugar, or dropped?

## 7. Not verified

- No pixels were inspected (see top). §2.2 and §2.4 are predictions from code.
- Whether GPUI blends in linear or gamma space was only partly confirmed.
- No primary source was found for Quickshell, AGS/Astal, Makepad, Iced, Vello,
  Clay, Tamagui, NativeWind or Unistyles, so they are not cited.
- Numeric decoder limits for Firefox and Safari are undocumented.
- React Strict DOM's native polyfill details came from search snippets; its
  "how native works" page returned 404.

## Sources

- Zed, "Leveraging Rust and the GPU to render user interfaces at 120 FPS": https://zed.dev/blog/videogame
- GPUI source (`crates/gpui`, `gpui_wgpu`, `gpui_web`): https://github.com/zed-industries/zed
- gpui-component: https://github.com/longbridge/gpui-component
- Raph Levien, blurred rounded rectangles: https://raphlinus.github.io/graphics/2020/04/21/blurred-rounded-rects.html
- Evan Wallace, fast rounded rectangle shadows: https://madebyevan.com/shaders/fast-rounded-rectangle-shadows/
- FreeType on text rendering: https://freetype.org/freetype2/docs/hinting/text-rendering-general.html
- React Strict DOM: https://facebook.github.io/react-strict-dom/api/css and https://nicolasgallagher.com/one-react-for-web-and-native/
- Yoga defaults: https://www.yogalayout.dev/docs/styling
- Flutter HTML renderer removal: https://groups.google.com/g/flutter-announce/c/JqkMe7cPkQo
- CSS `linear()`: https://developer.chrome.com/docs/css-ui/css-linear-easing-function
- Greenfield, FOSDEM 2024: https://fosdem.org/schedule/event/fosdem-2024-3219-greenfield-wayland-in-the-browser-an-update
- Selkies: https://docs.linuxserver.io/selkies/components/selkies/
- WebCodecs: https://www.w3.org/TR/webcodecs/
- Material motion tokens: https://github.com/material-components/material-components-android/blob/master/docs/theming/Motion.md
- Fluent tokens: https://github.com/microsoft/fluentui/tree/master/packages/tokens/src/global
