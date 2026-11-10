/**
 * The desktop under the taskbar: the wallpaper, fixed to the screen, and over
 * it an infinite canvas for every output, on which each window lies in a frame
 * the shell draws (see canvas/CanvasOutput.tsx). With the view at home the
 * canvas is the desktop Warlock has always had; dragging or scrolling the
 * empty desktop pans it, and a faint grid of dots shows it move.
 */

import { useEffect, useRef, useState } from "react";
import {
  Background,
  GestureBinding,
  Image,
  instant,
  PointerBinding,
  Rect,
  Screen,
  WheelBinding,
  Window,
  type ModifierName,
  type OutputInfo,
} from "proscenium";
import wallpaperDawn from "./assets/wallpaper/wallpaper-dawn.svg";
import wallpaperNight from "./assets/wallpaper/wallpaper-night.svg";
import { CanvasOutput, type PortalState } from "./canvas/CanvasOutput.js";
import type { Placed } from "./geometry.js";
import { portalCloseSeconds, portalOpenSeconds } from "./portal.js";
import { alpha, useWarlockTheme } from "./theme.js";
import { useWarlock, type CanvasHandle } from "./WarlockProvider.js";

function Wallpaper({ output }: { output: OutputInfo }) {
  const theme = useWarlockTheme();
  if (theme.theme === "high-contrast")
    return <Rect width={output.width} height={output.height} fill={theme.palette.canvas} />;
  return (
    <>
      <Rect
        width={output.width}
        height={output.height}
        fill={theme.theme === "dawn" ? "#f6f1ea" : "#0b0909"}
      />
      <Image
        src={theme.theme === "dawn" ? wallpaperDawn : wallpaperNight}
        width={output.width}
        height={output.height}
        fit="cover"
      />
    </>
  );
}

/** What a press with a modifier held does, by button and modifiers. */
const bindings: readonly {
  button: "left" | "right";
  modifiers: ModifierName[];
  what: Parameters<CanvasHandle["press"]>[1];
}[] = [
  { button: "left", modifiers: ["alt"], what: "move" },
  { button: "left", modifiers: ["super"], what: "select" },
  { button: "left", modifiers: ["super", "alt"], what: "move" },
  { button: "right", modifiers: ["alt"], what: "resize" },
  { button: "right", modifiers: ["super"], what: "resize" },
];

/** The canvas of every output, the wallpaper under them, and the portals windows open and close through. */
export function Desktop() {
  const { outputs, placed, windows, state, rootOf, motion, canvasOn } = useWarlock();
  const theme = useWarlockTheme();

  // Portals: one window opening or closing at a time, at most one a second.
  const seen = useRef<Set<number> | null>(null);
  const before = useRef<ReadonlyMap<number, Placed>>(placed);
  const checked = useRef<unknown>(null);
  const lastPortal = useRef(-Infinity);
  const portal = useRef<PortalState | null>(null);
  const [, redraw] = useState(0);
  if (checked.current !== placed) {
    // Found while rendering, so a window and the cover it opens under appear in the same frame.
    checked.current = placed;
    const known = seen.current;
    const recorded = [...windows.keys()].filter(
      (id) => state.windows[id] !== undefined && rootOf(id) === id,
    );
    if (known) {
      const opened = [...placed.keys()].filter((id) => !known.has(id));
      const closed = [...before.current.keys()].filter((id) => !windows.has(id));
      const now = performance.now();
      const allowed =
        theme.effects === "full" &&
        motion === "full" &&
        portal.current === null &&
        now - lastPortal.current >= 1000;
      if (allowed && opened.length + closed.length === 1) {
        const window = opened[0] ?? closed[0]!;
        const entry = opened.length === 1 ? placed.get(window)! : before.current.get(window)!;
        if (!entry.record.fullscreen) {
          portal.current = {
            key: now,
            kind: opened.length === 1 ? "open" : "close",
            window,
            rect: entry.rect,
            output: entry.output.name,
          };
          lastPortal.current = now;
        }
      }
    }
    seen.current = new Set([...(known ?? []), ...recorded].filter((id) => windows.has(id)));
    before.current = placed;
  }
  const portalKey = portal.current?.key;
  useEffect(() => {
    if (portalKey === undefined) return;
    const seconds = portal.current?.kind === "open" ? portalOpenSeconds : portalCloseSeconds;
    const timer = setTimeout(
      () => {
        portal.current = null;
        redraw((count) => count + 1);
      },
      seconds * 1000 + 100,
    );
    return () => clearTimeout(timer);
  }, [portalKey]);
  // An opening portal goes with its window.
  if (portal.current?.kind === "open" && !placed.has(portal.current.window)) portal.current = null;

  // A press with a modifier belongs to the canvas of the output it landed on until it is let go.
  const pressedOn = useRef<string | null>(null);
  const contrast = theme.theme === "high-contrast";

  return (
    <>
      {outputs.map((output) => (
        <Screen key={output.name} output={output.name}>
          <Wallpaper output={output} />
        </Screen>
      ))}
      {/* The canvas itself: clear, so the wallpaper shows, with dots that pan and zoom with the windows. */}
      <Background
        fill="transparent"
        grid={{
          kind: "dots",
          color: alpha(theme.palette.text, contrast ? 0.5 : 0.13),
          spacing: 32,
          size: 1,
        }}
        pan
      />
      {outputs.map((output, index) => (
        <CanvasOutput key={output.name} output={output} index={index} portal={portal.current} />
      ))}

      {bindings.map(({ button, modifiers, what }) => (
        <PointerBinding
          key={`${modifiers.join("+")}-${button}`}
          button={button}
          modifiers={modifiers}
          onDown={(event) => {
            pressedOn.current = event.output;
            canvasOn(event.output)?.press(event, what);
          }}
          onMove={(event) => {
            if (pressedOn.current !== null) canvasOn(pressedOn.current)?.drag(event);
          }}
          onUp={(event) => {
            if (pressedOn.current !== null) canvasOn(pressedOn.current)?.release(event);
            pressedOn.current = null;
          }}
        />
      ))}
      <PointerBinding button="middle" action="pan" />
      <WheelBinding modifiers="super" action="zoom" />
      <GestureBinding gesture="pinch" fingers={2} action="zoom" />
      <GestureBinding gesture="swipe" fingers={3} action="pan" />
    </>
  );
}

/** Fullscreen windows, which cover the taskbar: render after it. */
export function FullscreenWindows() {
  const { outputs, placed, stack, windows, setFullscreen } = useWarlock();
  return (
    <>
      {outputs.map((output) => {
        const ids = stack.filter((id) => {
          const entry = placed.get(id);
          return entry && entry.output === output && entry.record.fullscreen && windows.has(id);
        });
        if (ids.length === 0) return null;
        return (
          <Screen key={output.name} output={output.name}>
            <Rect width={output.width} height={output.height} fill="#000000" />
            {ids.map((id) => (
              <Window
                key={id}
                window={id}
                x={0}
                y={0}
                width={output.width}
                height={output.height}
                fullscreen
                transition={instant}
                onFullscreenRequest={({ value }) => setFullscreen(id, Boolean(value))}
              />
            ))}
          </Screen>
        );
      })}
    </>
  );
}
