# Trellis

A fractal desktop for Proscenium, after [**TrellisUI**](https://trellisui.com)
([source](https://github.com/DanFessler/trellis)) by
[**Dan Fessler**](https://github.com/DanFessler) and
[TrellisWM](https://trelliswm.app). Panels nest inside panels as deep as you
like, the view zooms to whichever part you need, and windows take the size they
get there. This world rebuilds that idea as a window manager in React on
Proscenium.

## Running

```sh
build/meson/proscenium --script examples/trellis.tsx  # or scripts/run-session examples/trellis.tsx
```

The keys are listed at the top of [`trellis.tsx`](../trellis.tsx).

## Thanks

Thank you to **Dan Fessler** for TrellisUI. The logic here comes from its code
and documentation: the arrangement as a tree of weighted splits with tabbed
panels for leaves, how drops dock, split, join and stack, framing any space or
run of neighbours, and the timings the layout moves with. See his
[2-minute video](https://www.youtube.com/watch?v=Kd9AbKawwhg) for the idea that
started it.

## License

Since its logic comes from TrellisUI, this world (`trellis.tsx` and this
directory) is for non-commercial use only, under TrellisUI's
[license](https://github.com/DanFessler/trellis/blob/main/LICENSE.md), not
Proscenium's BSD 3-Clause License. Commercial use needs a license from Dan
Fessler, through [GitHub Sponsors](https://github.com/sponsors/danfessler).
