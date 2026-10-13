# Shaders: the only decoration

**Status:** implemented. This document is for review.
[PROTOCOL.md](PROTOCOL.md#shaders) specifies the wire format, and
[GUIDE.md](GUIDE.md#shaders) covers the SDK.

## Why

Every look used to be fixed protocol. A rect had `color`, `colorEnd`,
`fillAngle`, four border properties and `blur`; a window had `dim`; a
background had `color` and four grid properties; an effect had `shader`,
`amount`, `margin`, `local`, `time`, `backdrop`, `pointer`, `area` and
`uniforms`. Each was a property in the schema, an item kind in the display
list, a GLSL program in the compositor and a writer in the SDK, and every new
look meant changing the protocol and both of its ends.

The first step, [paints](#history), made shadows a shader the director defines.
This step finishes the job. The protocol now has no decoration at all: a node
has its geometry and content, and everything else it shows comes from shaders
the director defines and uses, with uniforms that animate like any property.
Nothing in the compositor knows what a border, a shadow or a grid is.

The constraint was performance. Each built-in had been tuned: its quad was
exactly as large as it drew, it repainted only what it changed, an opaque fill
hid what lay beneath, and a transparent one cost nothing. A general system has
to keep every one of those properties, or it is slower than what it replaces.

## Three stages

A shader is GLSL ES 1.0 with a stage, which decides what it can read and what
it costs:

| Stage | Defines | Reads | Costs |
| --- | --- | --- | --- |
| **paint** | `vec4 paint(vec2 position)` | its uniforms; optionally the blurred backdrop | one draw, straight into the frame |
| **filter** | `vec4 filter(vec4 color, vec2 position)` | the node's content, one texel at a time | nothing: compiled into the content's own draw |
| **effect** | `vec4 effect(vec2 position)` | the node and its subtree as drawn, anywhere | the subtree drawn offscreen first |

What each old decoration became:

| Was | Now |
| --- | --- |
| rect `color`, `colorEnd`, `fillAngle`, border properties | `boxPaint`: one paint drawing fill and border, solid or gradient |
| window and web border (drawn outside the box) | `boxPaint` with `outset` |
| image border (drawn over the image) | `boxPaint` with `layer: "over"` |
| `shadow*` (already a paint) | `boxShadow` |
| `blur` | `backdropBlur`: a paint reading the backdrop, blurred |
| window `dim` | `dimFilter` |
| background `color`, `grid*` | `planePaint`, covering the background's plane |
| effect properties | an effect shader; `amount` and `margin` became the shader's own uniforms and extent |
| `rect` node type | a `group` with `width`, `height` and `radius` |

The standard shaders live in the SDK ([`shader.ts`](../sdk/src/shader.ts)),
and the SDK keeps the decoration props (`fill`, `border`, `shadow`, `blur`,
`dim`, `grid`) as shorthands for them. Worlds using only those are unchanged;
`effect` and `paints` became `shaders`.

## Defining a shader

A director defines a shader once by id, with a `shader` op. The SDK derives the
id from the definition, so equal definitions share one program, and sends the
op before the first commit that uses it.

```json
{"op":"shader","id":"s1x9k2","stage":"paint","source":"vec4 paint(vec2 position) { … }",
 "uniforms":{"fill":4,"fillEnd":4,"fillAngle":1,"border":1,"borderColor":4,
             "borderColorEnd":4,"borderAngle":1,"outset":1},
 "extent":{"uniforms":{"outset":1},"pixel":1},
 "opaque":{"inset":[{"uniforms":{"border":1,"outset":-1},"pixel":1},
                    {"uniforms":{"border":0.7,"outset":-0.7},"radius":0.3,"pixel":1}],
           "when":[{"uniform":"fill","component":3},{"uniform":"fillEnd","component":3}]},
 "hole":{"inset":[…the same…],"when":[…the same…]},
 "gate":[{"uniform":"fill","component":3},{"uniform":"fillEnd","component":3},
         {"uniform":"border"}]}
```

The definition is the shader's contract with the compositor. Besides the source
and its uniforms, it says what the shader reads and how its values bound what it
draws, so the compositor can keep every optimization of a built-in without
running or understanding the GLSL:

| Field | What the compositor does with it |
| --- | --- |
| `reads` | Declares `time`, `pointer`, `backdrop(p)` (a paint's blurred by a uniform) and, for an effect, `local`. The prelude declares only these; a running clock keeps frames coming, a pointer reader repaints as the pointer moves, a backdrop reader gets the backdrop copied and blurred and its area repaired whole. |
| `extent` | The quad: how far the shader draws beyond the box, per side. |
| `opaque` | Occlusion: the rectangle a paint covers opaquely, so what lies beneath is never drawn. For a filter, whether opaque content stays opaque. |
| `hole` | The ring: where a paint draws nothing, so it is drawn and damaged as the ring around it. |
| `gate` | The free case: unless one of these components is above zero, the shader shows nothing and is skipped. |

### Bounds

`extent`, `opaque` and `hole` are bounds: four distances (left, top, right,
bottom), linear in what the shader shows. A form sums `pad` local units,
`pixel` output pixels, `radius` times the node's corner radius, and each
uniform component's value, first raised to its `floor`, times its
coefficients. A bound is one form, or up to four whose largest applies, side by
side.

This is enough for every decoration, exactly, because their geometry is
piecewise linear in their parameters:

- A shadow reaches `1.5 × blur + spread` beyond the box, shifted by `x` and `y`,
  and at least a pixel and a half for a sharp edge: a floor on `blur`.
- A box with a border of `b` and corners of `r` has its fill (and, without a
  fill, its empty middle) inside an inset of `max(b, 0.7 b + 0.3 r)` plus a
  pixel: a rounded corner reaches at most `0.29 r` into the inscribed
  rectangle, so a maximum of two forms bounds it.

The compositor evaluates bounds every frame from the values on screen, so a
quad, a ring or an opaque rectangle follows a shader exactly while it animates.

Regions add a condition: `opaque` holds while every listed component is at
least 1 (the fill's alpha), `hole` while every one is at most 0 (no fill).

## Using a shader

A node's `shaders` lists up to 8 uses:

```json
"shaders":[{"id":"shadow","shader":"s7f2…","uniforms":{"color":[0,0,0,0.3],"blur":24,"y":8}},
           {"id":"box","shader":"s1x9k2","uniforms":{"fill":[1,1,1,1],"fillEnd":[1,1,1,1]},
            "transition":{"default":{"type":"spring"},"fill":{"type":"instant"}}}]
```

| Field | Meaning |
| --- | --- |
| `id` | The use's identity on its node, across declarations and hand-overs. |
| `uniforms` | Values; those left out are 0. |
| `layer` | A paint's: under the content or over it; always under the children. |
| `area` | A paint's or effect's: the node's box, or the whole output. |
| `time` | Whether its clock runs. |
| `transition` | A motion for its uniforms, or one per uniform. |

Uses keep the rules props have:

- **Kept:** a use that keeps its id keeps its displayed values and its clock,
  and moves on to the new values with its transition.
- **New:** on a new node it starts as declared, or from `initial`; on a node
  already shown, from zero.
- **Removed:** it moves to zero, then goes.
- **Animating:** `initial` and `exit` take `shaders: {<id>: {<uniform>: v}}`,
  keyframe tracks address `shaders.<id>.<uniform>`, and nodes handing over
  motion by identity hand over their uses' values too.

Zero is therefore "nothing" for every shader, which is also what makes the
gate useful: a shadow fading out reaches zero alpha and stops costing anything.

A node takes at most one filter and one effect. A background takes paints,
which cover its plane. The SDK orders a node's paints as CSS layers its
decorations: shadow, backdrop blur, the node's own paints under the content,
fill and border, the content, paints over it.

## Compositor

| Where | What |
| --- | --- |
| [`shader.c`](../src/shader.c) | The registry: decoding definitions, evaluating bounds, regions and gates. |
| [`scene.c`](../src/scene.c) | `struct shading`: a use's animated uniforms, motions per uniform, clock, area and layer; matching by id, fading in and out, `initial`/`exit`, hand-over, keyframe layers. |
| [`display.c`](../src/display.c) | Emitting paints (quad, ring or plane; backdrop area; opaque rectangle; ring damage), recording a node's filter on its content items, effects; signatures over the values shown; error reporting; repainting while a program builds. |
| [`render.c`](../src/render.c) | Programs: the prelude per stage, texture programs with a filter compiled in, the dual Kawase backdrop, ring and plane geometry, and a cache of every program's uniform values. |

The display list lost three item kinds (`RECT`, `BLUR` and `BACKGROUND`) and
the effects' side table. Three kinds draw shaders: a paint, a content item
carrying its filter, and an effect. The renderer lost the rect, background and
backdrop programs and the effect cache keyed by source text.

### How each built-in property survives

1. **Tight quads.** A paint draws its box grown by its `extent`, evaluated per
   frame. A plane paint covers only the buffer, cut at the horizon in
   perspective.
2. **Rings.** While its `hole` holds, a paint draws eight triangles joining the
   quad's corners to the hole's, every edge shared whole, so no pixel is drawn
   twice, and damages only the four strips around the hole. A spinning
   gradient border repaints its ring and nothing inside. What a later paint of
   the same node covers opaquely becomes a hole too: a shadow under an opaque
   fill is drawn, and damaged, only around the fill.
3. **Occlusion.** While its `opaque` region holds and the node is fully opaque,
   a paint is an occluder like a window's opaque region. A paint reading its
   backdrop never is, since what it reads lies beneath it, nor is one whose
   program has not built yet, nor a plane in perspective, which may leave sky.
4. **Free when invisible.** A closed gate skips the paint, the filter (the
   content draws through the plain program) or the effect (the node draws
   without the offscreen pass).
5. **Backdrop as an input.** The built-in blur survived as an input: a paint
   declaring `backdrop: {blur}` gets what is behind it, copied and blurred by
   the dual Kawase passes, as `backdrop(p)` at any local position. Frosted
   glass is a three-line paint; the examples' liquid glass, which refracts the
   frosted backdrop, went from an effect averaging 24 taps over an offscreen
   copy of the whole bar to a paint.
6. **Filters cost nothing.** A filter is compiled into the program drawing its
   node's textures, so dimming a window costs a multiply per pixel of a draw
   that happens anyway. Filters chain no further than one per node: chaining
   would mean renaming identifiers in director GLSL, which breaks swizzles.
7. **Few GL calls.** Every program caches its uniform values, built-ins and the
   director's alike, and is bound only when it changes.
8. **No per-frame strings.** A use names its shader by id: nothing is hashed or
   compared per frame but the values themselves.

## Performance

Measured against the build before this change (built-in decorations, protocol
1), headless at 1280 × 800, the same worlds through each build's SDK; medians
of 3 runs (CPU) and 5 (GPU). CPU is the compositor's, in milliseconds per
second of animation; GPU is from Mesa's `INTEL_MEASURE` batch timings, in a
separate pass because the instrumentation itself costs CPU.

| World | CPU before | CPU after | GPU before | GPU after |
| --- | --- | --- | --- | --- |
| 300 spinning, fading rects with labels | 441 | 338 (−23%) | — | — |
| 108 wobbling cards with shadows | 140 | 137 (−2%) | 168 | 151 (−10%) |
| 108 spinning gradient borders | 136 | 80 (−41%) | 36.9 | 33.4 (−9%) |
| 12 frosted, tinted panels drifting | 133 | 122 (−8%) | 173 | 168 (−3%) |
| dotted plane panning and zooming | 36 | 36 | 21.0 | 15.4 (−27%) |

The rects saturate the CPU under instrumentation, so their GPU time is not
comparable.

- **CPU** fell because items carry fewer, cheaper parameters, programs are
  bound only when they change, and every uniform is cached per program:
  frames of many similar items send almost no GL calls.
- **Borders** draw as rings instead of whole boxes, so the GPU skips the
  inside of every border.
- **Shadows** under an opaque fill are drawn as rings around it. The generic
  shadow costs a little more per pixel than the built-in did, which had its
  sigma, corner and premultiplied color precomputed, but it no longer shades
  the pixels its card hides.
- **The plane** interpolates its position instead of inverting the
  background's transform at every pixel.

**Pixels.** Against the old build, a world covering solid, translucent and
gradient fills, inside and outside borders with gradients, rotated and
perspective boxes, image borders, both backdrop blurs, the dot grid and a
shadow differs in 86 of 3.7 million channel values, by 1 (ring triangles
interpolate positions with other rounding than a quad). Eight shadows over a
range of parameters differ in 186, and windows with frames, dimming and
shadows over a scaled line grid in 315, all by 1.

**Damage.** Every example world, driven headless with frame checks, matches a
full redraw in every frame. **Idle:** a still desktop wakes nothing; the meta
world idles at one compositor wakeup in 20 seconds.

## Questions for review

- **One filter per node.** Directors combine filters in GLSL. Chaining would
  need a GLSL-aware renamer, or a pass per filter.
- **Fixed decoration ids.** The decoration props use the ids `box`, `shadow`,
  `blur`, `dim` and `plane`, which a node's own `shaders` may not reuse.
- **Paint order.** Own paints under the content go between the backdrop blur
  and the fill, as CSS backgrounds layer; a director wanting another order
  writes the standard shaders into `shaders` itself.
- **Bounds stay linear.** Products (a border's width only counting when its
  color is visible) are not expressible; such a shader is gated and bounded a
  little more loosely.
- **Registry lifetime.** Definitions live as long as the compositor. A hot
  reload that edits a shader adds a program; unused ones are not collected.

## History

Paints, the first step, made the shadow a shader: a `paints` property, a
`shader` op for paint shaders only, extents and a gate. They showed that a
generic shader could match a built-in's cost once its definition carried what
the compositor needs: shadows drew the same pixels as the built-in program and
cost within a few percent of it on a 108-card stress test.
