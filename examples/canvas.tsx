/**
 * An infinite canvas: windows float on a dotted plane under a spring camera.
 *
 *   Drag or scroll empty canvas, three-finger swipe   pan, with momentum
 *   Super+wheel, pinch                                zoom around the pointer
 *   Super+drag, or a client's title bar               move a window
 *   Super+right-drag, or a client's edges             resize a window
 *   Super+arrows                                      focus the nearest window that way and fly to it
 *   Super+O                                           overview of every window; click one to dive in
 *   Super+C                                           center the focused window at 100%
 *   Super+Return / Super+Q / Super+D                  terminal / close the focused window / launcher
 *   Super+N / Super+R / Super+Z                       night light / retro CRT / magnifying lens
 *   Super+P                                           take out the paper, or put it away
 *
 * The paper is an Excalidraw drawing that lies on the canvas under the windows.
 * While it is out, empty canvas draws, a toolbar along the bottom picks tools
 * and colors, and Excalidraw's keys work; the wheel, pinches and swipes still
 * move the canvas. Put away, the drawing stays, as pictures that cost nothing
 * to pan and zoom over (see canvas/paper/Paper.tsx).
 *
 * Pans, zooms, moves and resizes run inside the compositor in the same frame as
 * the input; this file only stores where things ended up. Edit it while it runs:
 * the runtime reloads it and every window glides to its new place.
 */

import { useCallback, useState } from "react";
import {
  Background,
  Camera,
  close,
  focus,
  GestureBinding,
  launch,
  PointerBinding,
  Shortcut,
  spring,
  useFocusedWindow,
  useOutputs,
  useWindowIds,
  WheelBinding,
} from "proscenium";
import { CanvasWindow, type MoveWindow } from "./canvas/CanvasWindow.js";
import { Minimap } from "./canvas/Minimap.js";
import { PaperLayer, PaperProvider } from "./canvas/paper/Paper.js";
import { PaperToolbar } from "./canvas/paper/Toolbar.js";
import { useCameraActions } from "./canvas/useCameraActions.js";
import { usePlaces } from "./canvas/usePlaces.js";
import { useStackingOrder } from "./canvas/useStackingOrder.js";
import { ZoomLabel } from "./canvas/ZoomLabel.js";
import { Desktop } from "./components/Desktop.js";
import { Launcher } from "./components/Launcher.js";
import { ScreenEffects } from "./components/ScreenEffects.js";
import { directions, neighbour } from "./lib/geometry.js";
import { terminal } from "./lib/settings.js";
import { colors } from "./lib/theme.js";

const cameraMotion = spring({ duration: 0.45, bounce: 0.08 });
const arrowKeys = ["Left", "Right", "Up", "Down"] as const;

export default function Canvas() {
  const windows = useWindowIds();
  const output = useOutputs()[0];
  const focused = useFocusedWindow();
  const [places, place] = usePlaces();
  const stacked = useStackingOrder(windows, focused);
  const { flyTo, toggleOverview } = useCameraActions(places, output, focused);
  // A window being dragged shows on the minimap where it is, not where it was.
  const [moving, setMoving] = useState<{ window: number; x: number; y: number } | null>(null);
  const onMove = useCallback<MoveWindow>((window, at) => setMoving(at && { window, ...at }), []);
  const from = moving && places.get(moving.window);
  const shown =
    moving && from
      ? new Map(places).set(moving.window, { ...from, x: moving.x, y: moving.y })
      : places;

  function focusToward(key: (typeof arrowKeys)[number]) {
    const next = focused === null ? windows[0] : neighbour(places, focused, directions[key]!);
    if (next == null) return;
    focus(next);
    flyTo(next);
  }

  return (
    <ScreenEffects>
      <PaperProvider output={output}>
        <Camera minZoom={0.08} maxZoom={4} transition={cameraMotion} />
        <Background
          fill={colors.paper}
          grid={{ kind: "dots", color: "#00000033", spacing: 28, size: 1.1 }}
          pan
          cursor="grab"
        />
        <PaperLayer />

        {stacked.map((id) => (
          <CanvasWindow
            key={id}
            id={id}
            box={places.get(id)!}
            focused={id === focused}
            onPlace={place}
            onMove={onMove}
          />
        ))}

        {output && <Minimap output={output} places={shown} focused={focused} />}
        <Desktop barStart={ZoomLabel} />
        <PaperToolbar />
        <Launcher output={output} />

        <PointerBinding button="left" modifiers="super" action="move" />
        <PointerBinding button="right" modifiers="super" action="resize" />
        <PointerBinding button="middle" action="pan" />
        <WheelBinding modifiers="super" action="zoom" />
        <GestureBinding gesture="pinch" fingers={2} action="zoom" />
        <GestureBinding gesture="swipe" fingers={3} action="pan" />

        <Shortcut keys="Super+Return" onPress={() => launch(terminal)} />
        <Shortcut keys="Super+Q" onPress={() => focused !== null && close(focused)} />
        <Shortcut keys="Super+O" onPress={toggleOverview} />
        <Shortcut keys="Super+C" onPress={() => focused !== null && flyTo(focused, 1)} />
        {arrowKeys.map((key) => (
          <Shortcut key={key} keys={`Super+${key}`} onPress={() => focusToward(key)} />
        ))}
      </PaperProvider>
    </ScreenEffects>
  );
}
