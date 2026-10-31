/**
 * An infinite canvas: windows float on a dotted plane under a spring camera.
 *
 *   Drag or scroll empty canvas, three-finger swipe   pan, with momentum
 *   Super+wheel, pinch                                zoom around the pointer
 *   Super+drag, or a client's title bar               move a window (Alt too: freely, and on its own)
 *   Super+drag empty canvas                           select the windows the box touches; Super+click clears
 *   Super+S                                           stack the selection; on a stacked window, spread it out
 *   Super+right-drag, or a client's edges             resize a window
 *   Super+G                                           alignment guides on or off
 *   Super+M / Super+Shift+M                           magnet mode on or off / Gentle, Medium, Firm
 *   Ctrl+Alt+arrows                                   the focused window to a half; again for ⅔, ⅓
 *   Ctrl+Alt+U I J K / D F G / E T                    a quarter / a third / two-thirds
 *   Ctrl+Alt+Return / Ctrl+Alt+C                      fill the screen / centre at its size
 *   Ctrl+Alt+2 / 3 / 4                                the windows on that screen in columns
 *   Ctrl+Alt+A                                        tidy: every window on one grid, framed
 *   Super+Shift+P                                     polarity on or off (magnet mode comes on with it)
 *   Super+F, or click a window's pole                 flip the focused window's pole, ⊕ or ⊖
 *   Super+U                                           ungroup the focused window's group
 *   Super+Shift+Z                                     put back what the last push, bond or placement moved
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
 * while they do, and it stays where it is let go: there is no grid. In magnet mode
 * the windows in the way are pushed aside along the shortest route, shoving
 * the ones behind them, and a window flung hard coasts a little further.
 *
 * With polarity (Sunlight's magnetic polarity, canvas/polarity.ts) every window
 * wears its pole on its corner, ⊕ to begin with. Like poles push; drag a window
 * near one of the opposite pole, faces lined up, and it is pulled in to the gap
 * and bonds: the group, outlined in violet, moves, coasts, tidies and undoes as
 * one. Alt-drag a member to pull it out, flip it to eject
 * it, or ungroup. A toast at the bottom says what each key just changed.
 *
 * Select windows by Super-dragging a box over empty canvas; a selected window
 * dragged takes the whole selection with it. Super+S piles the selection into a
 * stack behind the frontmost window, each edge peeking out, marked with its
 * count (canvas/stacks.ts); drag any of it and the stack goes as one. Super+S
 * on a stacked window spreads it out again, side by side where it now sits.
 *
 * The Ctrl+Alt keys are Sunlight's placement commands (canvas/usePlacement.ts).
 * At 100% a slot is a share of the screen in view; zoomed out it is a share of
 * the page the window is on, pages being screen-sized areas in a grid from
 * where the camera starts. A new window opens in the middle of the view if
 * that is clear, else in the nearest free spot beside the windows in the way.
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
  getCamera,
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
import { glyph, tint } from "./canvas/polarity.js";
import { Poles } from "./canvas/Poles.js";
import { Toast, useToast } from "./canvas/Toast.js";
import { usePolarity } from "./canvas/usePolarity.js";
import { Minimap } from "./canvas/Minimap.js";
import { PaperLayer, PaperProvider } from "./canvas/paper/Paper.js";
import { PaperToolbar } from "./canvas/paper/Toolbar.js";
import { useCameraActions } from "./canvas/useCameraActions.js";
import { Selection } from "./canvas/Selection.js";
import { closure } from "./canvas/stacks.js";
import { useArrange, useArrangeSettings, type Links } from "./canvas/useArrange.js";
import { arrangements, presetKeys, titles } from "./canvas/tiling.js";
import { useOpenings } from "./canvas/useOpenings.js";
import { useHistory, usePlacement } from "./canvas/usePlacement.js";
import { usePlaces } from "./canvas/usePlaces.js";
import { useSelection } from "./canvas/useSelection.js";
import { useStackingOrder } from "./canvas/useStackingOrder.js";
import { useStacks } from "./canvas/useStacks.js";
import { ZoomLabel } from "./canvas/ZoomLabel.js";
import type { ToastMessage } from "./canvas/Toast.js";
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
  const [places, , placeWindows] = usePlaces(output);
  const stacks = useStacks(places);
  const [stacked, raise] = useStackingOrder(windows, focused, stacks.of);
  const opening = useOpenings(windows);
  const { flyTo, toggleOverview } = useCameraActions(places, output, focused);
  const [settings, setArrangement] = useArrangeSettings();
  const [toast, say] = useToast();
  const polarity = usePolarity(places, settings.magnet && settings.polarity);
  const selection = useSelection(places, () => getCamera(output?.name)?.zoom ?? 1);
  // What moves with a window: its bonded group, its stack, and the selection it is in.
  const links: Links = {
    together: (window) =>
      closure(window, [polarity.groupOf, stacks.of, (id) => (selection.has(id) ? [...selection.ids] : [])]),
    leave: (window) => {
      if (polarity.groupOf(window).length > 1) polarity.release(window, places);
      stacks.leave(window);
      selection.remove(window);
    },
    snapshot: () => {
      const grouping = polarity.grouping;
      const all = stacks.all;
      return () => {
        polarity.restore(grouping);
        stacks.restore(all);
      };
    },
  };
  const history = useHistory(places, placeWindows);
  const arrange = useArrange(places, placeWindows, output, history, polarity, links, (event) =>
    say(event === "bonded" ? { label: "Bonded", detail: "they move as one", dot: bond } : { label: "Pulled out", detail: "it goes on alone", dot: "off" }),
  );
  const placement = usePlacement(places, placeWindows, output, focused ?? stacked.at(-1), history, polarity, stacks, links);
  // Windows being dragged or pushed show where they are now, on the canvas and the minimap.
  const shown = arrange.shown;

  const strengthName = (value: number) => strengths.find((x) => x.value === value)?.name ?? "";

  /** Change the settings and say what changed. */
  function toggle(change: (s: typeof settings) => typeof settings, message: (s: typeof settings) => ToastMessage) {
    const next = change(settings);
    setArrangement(next);
    say(message(next));
  }

  function flip(window: number) {
    if (!polarity.active) return;
    const was = polarity.groupOf(window).length > 1;
    polarity.flip(window, places);
    const pole = polarity.poleOf(window) === "plus" ? "minus" : "plus";
    say({
      label: `Pole ${glyph[pole]}`,
      detail: was ? "flipped, and out of its group" : pole === "minus" ? "sticks to ⊕ windows" : "sticks to ⊖ windows",
      dot: tint[pole],
    });
  }

  /** Super+S: spread out the focused window's stack, or pile the selection into one. */
  function stackOrSpread() {
    if (focused !== null && stacks.of(focused).length > 1) {
      const n = placement.expand(focused);
      say({ label: "Spread out", detail: `${n} windows`, dot: "off" });
      return;
    }
    // Bottom to top as they are now, the focused one on top if it is selected.
    const ids = stacked.filter((id) => selection.has(id) && id !== focused);
    if (focused !== null && selection.has(focused)) ids.push(focused);
    if (ids.length < 2) {
      say({ label: "Select windows to stack", detail: "Super+drag a box over empty canvas", dot: "off" });
      return;
    }
    placement.stack(ids);
    raise(ids);
    focus(ids.at(-1)!);
    selection.clear();
    say({ label: "Stacked", detail: `${ids.length} windows · Super+S spreads them out`, dot: "on" });
  }

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
        {polarity.active && (
          <Poles
            places={shown}
            poleOf={polarity.poleOf}
            grouping={polarity.grouping}
            motionOf={arrange.motionOf}
            onFlip={flip}
          />
        )}
        <Selection
          places={shown}
          selected={selection.ids}
          box={selection.box}
          stacks={stacks.all}
          motionOf={arrange.motionOf}
        />
        <Guides guides={arrange.guides} />

        {output && <Minimap output={output} places={shown} focused={focused} />}
        <Desktop barStart={ZoomLabel} />
        <PaperToolbar />
        <Launcher output={output} />
        <Toast message={toast} />

        {/* Super+drag picks a window up anywhere in it, with Alt too freely; on empty canvas it draws a selection box. */}
        {[["super"], ["super", "alt"]].map((modifiers) => (
          <PointerBinding
            key={modifiers.join("+")}
            button="left"
            modifiers={modifiers as ("super" | "alt")[]}
            onDown={(event) =>
              event.window != null ? arrange.startDrag(event.window, event) : selection.begin(event.worldX, event.worldY)
            }
            onMove={(event) => selection.move(event.worldX, event.worldY) || arrange.moveDrag(event)}
            onUp={(event) => selection.end() || arrange.endDrag(event)}
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
        <Shortcut
          keys="Super+G"
          onPress={() =>
            toggle(
              (s) => ({ ...s, snapping: !s.snapping }),
              (s) => ({ label: "Guides", detail: s.snapping ? "On · edges stick to neighbours" : "Off", dot: s.snapping ? "on" : "off" }),
            )
          }
        />
        <Shortcut keys="Super+S" onPress={stackOrSpread} />
        <Shortcut
          keys="Super+M"
          onPress={() =>
            toggle(
              (s) => ({ ...s, magnet: !s.magnet }),
              (s) => ({
                label: "Magnet",
                detail: s.magnet ? `On · ${strengthName(s.strength)}${s.polarity ? " · polarity" : ""}` : "Off",
                dot: s.magnet ? "on" : "off",
              }),
            )
          }
        />
        <Shortcut
          keys="Super+Shift+M"
          onPress={() =>
            toggle(
              (s) => ({ ...s, magnet: true, strength: cycle(strengths.map((x) => x.value), s.strength) }),
              (s) => ({ label: "Magnet", detail: strengthName(s.strength), dot: "on" }),
            )
          }
        />
        <Shortcut
          keys="Super+Shift+P"
          onPress={() =>
            toggle(
              // Poles act through the push: polarity on brings magnet mode on with it.
              (s) => (s.polarity && s.magnet ? { ...s, polarity: false } : { ...s, polarity: true, magnet: true }),
              (s) => ({
                label: "Polarity",
                detail: s.polarity ? "On · opposite poles stick" : "Off",
                dot: s.polarity ? bond : "off",
              }),
            )
          }
        />
        <Shortcut keys="Super+F" onPress={() => focused !== null && flip(focused)} />
        <Shortcut
          keys="Super+U"
          onPress={() => {
            if (focused === null || polarity.groupOf(focused).length < 2) return;
            const before = polarity.grouping;
            history.record([], false, () => polarity.restore(before));
            polarity.ungroup(focused);
            say({ label: "Ungrouped", detail: "every window goes free", dot: "off" });
          }}
        />
        <Shortcut
          keys="Super+Shift+Z"
          onPress={() => say(history.undo() ? { label: "Undone" } : { label: "Nothing to undo", dot: "off" })}
        />
        {presetKeys.map(([key, preset]) => (
          <Shortcut
            key={preset}
            keys={`Ctrl+Alt+${key}`}
            onPress={() => {
              const placed = placement.tile(preset);
              if (placed) say({ label: titles[placed] });
            }}
          />
        ))}
        {arrangements.map((columns) => (
          <Shortcut
            key={columns}
            keys={`Ctrl+Alt+${columns}`}
            onPress={() => {
              placement.arrange(columns);
              say({ label: "Arrange", detail: `${columns} columns` });
            }}
          />
        ))}
        <Shortcut
          keys="Ctrl+Alt+A"
          onPress={() => {
            placement.tidy();
            say({ label: "Tidy" });
          }}
        />
        {arrowKeys.map((key) => (
          <Shortcut key={key} keys={`Super+${key}`} onPress={() => focusToward(key)} />
        ))}
      </PaperProvider>
    </ScreenEffects>
  );
}

/** A bonded group's colour, as its outline. */
const bond = "#7c5cff";

/** The value after CURRENT in VALUES, round again after the last. */
function cycle<T>(values: readonly T[], current: T): T {
  return values[(values.indexOf(current) + 1) % values.length]!;
}
