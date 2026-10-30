/**
 * An infinite canvas: windows float on a dotted plane under a spring camera.
 *
 *   Drag or scroll empty canvas, three-finger swipe   pan, with momentum
 *   Super+wheel, pinch                                zoom around the pointer
 *   Super+drag, or a client's title bar               move a window (Alt too: freely)
 *   Super+right-drag, or a client's edges             resize a window
 *   Super+G / Super+Shift+G                           snapping on or off / grid 20, 40 or 80
 *   Super+M / Super+Shift+M                           magnet mode on or off / Gentle, Medium, Firm
 *   Super+Shift+Z                                     put back what the last push moved
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
 * move the canvas, and the drawing moves with it. Put away, the drawing
 * stays, as pictures that cost nothing to pan and zoom over (see
 * canvas/paper/Paper.tsx).
 *
 * Windows are arranged as on Sunlight's canvas (canvas/useArrange.ts): a
 * dragged window's edges and centre stick to its neighbours', with a pink guide
 * while they do, and it settles onto the grid when let go, except along an axis
 * a guide holds; a resize's moved edges settle onto the grid. In magnet mode
 * the windows in the way are pushed aside along the shortest route, shoving
 * the ones behind them, and a window flung hard coasts a little further.
 *
 * Pans, zooms and resizes run inside the compositor in the same frame as the
 * input; a window in hand is placed by this world on every move, so a guide can
 * hold it. Edit this file while it runs: the runtime reloads it and every
 * window glides to its new place.
 */

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
import { CanvasWindow } from "./canvas/CanvasWindow.js";
import { Guides } from "./canvas/Guides.js";
import { strengths } from "./canvas/magnetism.js";
import { Minimap } from "./canvas/Minimap.js";
import { PaperLayer, PaperProvider } from "./canvas/paper/Paper.js";
import { PaperToolbar } from "./canvas/paper/Toolbar.js";
import { useCameraActions } from "./canvas/useCameraActions.js";
import { gridSizes } from "./canvas/snapping.js";
import { useArrange, useArrangeSettings } from "./canvas/useArrange.js";
import { useOpenings } from "./canvas/useOpenings.js";
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
  const [places, , placeWindows] = usePlaces();
  const stacked = useStackingOrder(windows, focused);
  const opening = useOpenings(windows);
  const { flyTo, toggleOverview } = useCameraActions(places, output, focused);
  const arrange = useArrange(places, placeWindows, output);
  const [, setArrangement] = useArrangeSettings();
  // Windows being dragged or pushed show where they are now, on the canvas and the minimap.
  const shown = arrange.shown;

  function focusToward(key: (typeof arrowKeys)[number]) {
    const next = focused === null ? windows[0] : neighbour(places, focused, directions[key]!);
    if (next == null) return;
    focus(next);
    flyTo(next);
  }

  return (
    <ScreenEffects>
      <PaperProvider output={output}>
        {/* Excalidraw, which draws the paper, zooms out no further than 10%. */}
        <Camera minZoom={0.1} maxZoom={4} transition={cameraMotion} />
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
            box={shown.get(id)!}
            transition={arrange.motionOf(id)}
            focused={id === focused}
            grabbed={arrange.grabbed === id}
            held={arrange.held === id}
            opening={opening.has(id) ? output : undefined}
            onPickUp={arrange.startDrag}
            onCarry={arrange.moveDrag}
            onLetGo={arrange.endDrag}
            onResizeStart={arrange.startResize}
            onResize={arrange.resize}
            onResizeEnd={arrange.endResize}
          />
        ))}
        <Guides guides={arrange.guides} />

        {output && <Minimap output={output} places={shown} focused={focused} />}
        <Desktop barStart={ZoomLabel} />
        <PaperToolbar />
        <Launcher output={output} />

        {/* Super+drag picks a window up anywhere in it; with Alt too, it goes freely. */}
        {[["super"], ["super", "alt"]].map((modifiers) => (
          <PointerBinding
            key={modifiers.join("+")}
            button="left"
            modifiers={modifiers as ("super" | "alt")[]}
            onDown={(event) => event.window != null && arrange.startDrag(event.window, event)}
            onMove={arrange.moveDrag}
            onUp={arrange.endDrag}
          />
        ))}
        <PointerBinding button="right" modifiers="super" action="resize" />
        <PointerBinding button="middle" action="pan" />
        <WheelBinding modifiers="super" action="zoom" />
        <GestureBinding gesture="pinch" fingers={2} action="zoom" />
        <GestureBinding gesture="swipe" fingers={3} action="pan" />

        <Shortcut keys="Super+Return" onPress={() => launch(terminal)} />
        <Shortcut keys="Super+Q" onPress={() => focused !== null && close(focused)} />
        <Shortcut keys="Super+O" onPress={toggleOverview} />
        <Shortcut keys="Super+C" onPress={() => focused !== null && flyTo(focused, 1)} />
        <Shortcut keys="Super+G" onPress={() => setArrangement((s) => ({ ...s, snapping: !s.snapping }))} />
        <Shortcut
          keys="Super+Shift+G"
          onPress={() => setArrangement((s) => ({ ...s, gridSize: cycle(gridSizes, s.gridSize) }))}
        />
        <Shortcut keys="Super+M" onPress={() => setArrangement((s) => ({ ...s, magnet: !s.magnet }))} />
        <Shortcut
          keys="Super+Shift+M"
          onPress={() =>
            setArrangement((s) => ({ ...s, strength: cycle(strengths.map((x) => x.value), s.strength) }))
          }
        />
        <Shortcut keys="Super+Shift+Z" onPress={arrange.undoPush} />
        {arrowKeys.map((key) => (
          <Shortcut key={key} keys={`Super+${key}`} onPress={() => focusToward(key)} />
        ))}
      </PaperProvider>
    </ScreenEffects>
  );
}

/** The value after CURRENT in VALUES, round again after the last. */
function cycle<T>(values: readonly T[], current: T): T {
  return values[(values.indexOf(current) + 1) % values.length]!;
}
