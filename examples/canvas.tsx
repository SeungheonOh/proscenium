/**
 * An infinite canvas: windows float on a dotted plane under a spring camera.
 *
 *   Drag or scroll empty canvas, three-finger swipe   pan, with momentum
 *   Super+wheel, pinch                                zoom around the pointer
 *   Super+drag, or a client's title bar               move a window (Alt too: freely, and on its own)
 *   Super+drag empty canvas                           select the windows the box touches; Super+click clears
 *   Super+S                                           stack the selection; on a stacked window, spread it out
 *   Alt+Tab / Alt+Shift+Tab                           fan the focused window's stack out; let go of Alt to pick
 *   Click a stack's pill                              fan it out; point at a window, click it (or Return) to pick
 *   Drag a window along a fan                         give it a new place in the stack
 *   Drag a window onto a stack / Alt-drag one off     add it / take it out (a plain drag moves the stack)
 *   Drag a stack onto a stack                         merge them
 *   Alt-drag a window onto a lone window              the two start a stack
 *   Super+right-drag, or a client's edges             resize a window
 *   Super+G                                           alignment guides on or off
 *   Super+M / Super+Shift+M                           magnet mode on or off / Gentle, Medium, Firm
 *   Ctrl+Alt+arrows                                   the focused window to a half; again for ⅔, ⅓
 *   Ctrl+Alt+U I J K / D F G / E T                    a quarter / a third / two-thirds
 *   Ctrl+Alt+Return / Ctrl+Alt+C                      fill the screen / centre at its size
 *   Ctrl+Alt+2 / 3 / 4                                the windows on that screen in columns
 *   Ctrl+Alt+A                                        tidy: every window on one grid, framed
 *   Super+Shift+Z                                     put back what the last push, drop or placement moved
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
 * the ones behind them, and a window flung hard coasts a little further. Held
 * near a screen edge, a dragged window pans the canvas that way, faster the
 * nearer the edge. A toast at the bottom says what each key just changed.
 *
 * Select windows by Super-dragging a box over empty canvas; a selected window
 * dragged takes the whole selection with it. Super+S piles the selection into a
 * stack behind the frontmost window, each edge peeking out, marked with its
 * count (canvas/stacks.ts). Drag any window in it, or the pill, and the stack
 * goes as one; Alt-drag a window and it comes out, the rest closing up behind
 * it; drop a window, or a whole stack, on a stack and the stack makes room at
 * its front for it, or Alt-drop a window on a lone window and the two start
 * one. Alt+Tab fans the stack out like a hand of cards to pick a window from,
 * or to drag one along to a new place in the stack (canvas/useFan.ts); a quick
 * tap just shuffles it, the front window slipping out and tucking in behind
 * (canvas/useShuffle.ts). Super+S on a stacked window spreads it out again,
 * side by side where it now sits.
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
  instant,
  launch,
  type ModifierName,
  PointerBinding,
  Shortcut,
  spring,
  type StagePointerEvent,
  type Transition,
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
import { Selection } from "./canvas/Selection.js";
import { closure } from "./canvas/stacks.js";
import { arrangements, presetKeys, titles, type Preset } from "./canvas/tiling.js";
import { Toast, useToast, type ToastMessage } from "proscenium/ui";
import { useArrange, useArrangeSettings, type ArrangeEvent, type ArrangeSettings, type Links } from "./canvas/useArrange.js";
import { useCameraActions } from "./canvas/useCameraActions.js";
import { useFan } from "./canvas/useFan.js";
import { useOpenings } from "./canvas/useOpenings.js";
import { useHistory, usePlacement } from "./canvas/usePlacement.js";
import { usePlaces } from "./canvas/usePlaces.js";
import { useSelection } from "./canvas/useSelection.js";
import { useShuffle } from "./canvas/useShuffle.js";
import { useStackingOrder } from "./canvas/useStackingOrder.js";
import { useStacks } from "./canvas/useStacks.js";
import { ZoomLabel } from "./canvas/ZoomLabel.js";
import { Desktop } from "./components/Desktop.js";
import { Launcher } from "./components/Launcher.js";
import { ScreenEffects } from "./components/ScreenEffects.js";
import { directions, neighbour } from "./lib/geometry.js";
import { terminal } from "./lib/settings.js";
import { colors, motion } from "./lib/theme.js";

const cameraMotion = spring({ duration: 0.45, bounce: 0.08 });
const arrowKeys = ["Left", "Right", "Up", "Down"] as const;
const dragModifiers: ModifierName[][] = [["super"], ["super", "alt"]];
const joinedLabels = { added: "Added to stack", started: "New stack", merged: "Stacks merged" };

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
  const selection = useSelection(places, () => getCamera(output?.name)?.zoom ?? 1);
  const selected = (id: number) => (selection.has(id) ? [...selection.ids] : []);
  // What moves with a window: its stack, and the selection it is in.
  const links: Links = {
    together: (window) => closure(window, [stacks.of, selected]),
    release: (window) => {
      const inSelection = selection.has(window);
      selection.remove(window);
      return inSelection;
    },
    leave: (window) => {
      links.release(window);
      stacks.leave(window);
    },
    snapshot: () => {
      const all = stacks.all;
      return () => stacks.restore(all);
    },
  };
  const history = useHistory(places, placeWindows);
  const arrange = useArrange(places, placeWindows, output, history, links, stacks, onArranged);
  const placement = usePlacement(places, placeWindows, output, focused ?? stacked.at(-1), history, stacks, links);
  // Windows being dragged or pushed show where they are now, on the canvas and the minimap.
  const shown = arrange.shown;
  // Alt+Tab fans the focused window's stack out to pick from; a quick tap shuffles it.
  const { swing, shuffle } = useShuffle(raise, focus);
  const fan = useFan(shown, bringToFront, reorder);
  const poses = fan.poses;
  const boxes = new Map(shown);
  if (swing) boxes.set(swing.window, swing.rect);
  for (const [id, pose] of poses ?? []) boxes.set(id, pose.rect);
  const picked = fan.fan?.order[fan.fan.at];
  // A fan lies over everything. Folding back, the cards already layer as they land, so none jumps over another as it settles.
  const layers = fan.layers;
  const drawn = layers ? [...stacked.filter((id) => !layers.includes(id)), ...layers] : stacked;
  // A fanned stack shows no pill.
  const withPills = poses ? stacks.all.filter((ids) => !poses.has(ids[0]!)) : stacks.all;

  /** Change the arrangement settings and say what they are now. */
  function changeSettings(change: (s: ArrangeSettings) => ArrangeSettings, describe: (s: ArrangeSettings) => ToastMessage) {
    const next = change(settings);
    setArrangement(next);
    say(describe(next));
  }

  function toggleGuides() {
    changeSettings(
      (s) => ({ ...s, snapping: !s.snapping }),
      (s) => ({ label: "Guides", detail: s.snapping ? "On · edges stick to neighbours" : "Off", dot: s.snapping ? "on" : "off" }),
    );
  }

  function toggleMagnet() {
    changeSettings(
      (s) => ({ ...s, magnet: !s.magnet }),
      (s) => ({
        label: "Magnet",
        detail: s.magnet ? `On · ${strengthName(s.strength)}` : "Off",
        dot: s.magnet ? "on" : "off",
      }),
    );
  }

  function cycleMagnetStrength() {
    changeSettings(
      (s) => ({ ...s, magnet: true, strength: cycle(strengths.map((x) => x.value), s.strength) }),
      (s) => ({ label: "Magnet", detail: strengthName(s.strength), dot: "on" }),
    );
  }

  function undo() {
    say(history.undo() ? { label: "Undone" } : { label: "Nothing to undo", dot: "off" });
  }

  /** Say what the hand just did; a window dropped into a stack goes on top of it. */
  function onArranged(event: ArrangeEvent) {
    switch (event.type) {
      case "pulledOut":
        say({ label: "Pulled out", detail: "out of the selection", dot: "off" });
        break;
      case "joined":
        raise(event.stack);
        say({
          label: joinedLabels[event.how],
          detail: `${event.stack.length} windows · Alt+Tab goes through them`,
          dot: "on",
        });
        break;
      case "left":
        say({ label: "Out of the stack", dot: "off" });
        break;
    }
  }

  /** Alt+Tab: the focused window's stack fans out, the next window picked; again, the one after. */
  function fanStack(step: 1 | -1) {
    if (fan.fan) {
      fan.step(step);
      return;
    }
    const ids = focused === null ? [] : stacks.of(focused);
    if (ids.length < 2) {
      say({ label: "Alt+Tab goes through a stack", detail: "focus a stacked window first", dot: "off" });
      return;
    }
    // Left to right from the front window, as Alt+Tab goes through them; it starts on the next one.
    const order = [...ids].reverse();
    fan.open(order, step === 1 ? 1 : order.length - 1, "keys");
  }

  /** WINDOW to the front of its stack: picked from the fan, or with QUICK (a tap of Alt+Tab) shuffled there. */
  function bringToFront(window: number, quick: boolean) {
    const ids = stacks.of(window);
    const turned = placement.bringToFront(window);
    if (!turned) return;
    const swinging = swingingOut(ids, window);
    if (quick && swinging !== null) {
      const front = places.get(ids.at(-1)!)!;
      shuffle(turned, swinging, { ...places.get(swinging)!, x: front.x + 64, y: front.y + 16 });
      return;
    }
    raise(turned);
    focus(window);
  }

  /** A card dragged along the fan: the stack takes the fan's ORDER, left to right, the leftmost in front. */
  function reorder(order: readonly number[]) {
    const turned = [...order].reverse();
    placement.restack(turned);
    raise(turned);
    focus(turned.at(-1)!);
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

  function tile(preset: Preset) {
    const placed = placement.tile(preset);
    if (placed) say({ label: titles[placed] });
  }

  function arrangeColumns(columns: number) {
    placement.arrange(columns);
    say({ label: "Arrange", detail: `${columns} columns` });
  }

  function tidy() {
    placement.tidy();
    say({ label: "Tidy" });
  }

  function closeFocused() {
    if (focused !== null) close(focused);
  }

  function centerFocused() {
    if (focused !== null) flyTo(focused, 1);
  }

  function focusToward(key: (typeof arrowKeys)[number]) {
    const next = focused === null ? windows[0] : neighbour(places, focused, directions[key]!);
    if (next == null) return;
    focus(next);
    flyTo(next);
  }

  /** The pill clicked: the stack whose top window is TOP fans out, left to right from the front. */
  function openStack(top: number) {
    fan.open([...stacks.of(top)].reverse(), 0, "pill");
  }

  /** How window ID moves to its box. */
  function transitionOf(id: number): Transition {
    // A card dragged along a fan sticks to the pointer.
    if (fan.dragging === id) return instant;
    if (poses?.has(id)) return motion.glide;
    if (swing?.window === id) return motion.pop;
    return arrange.motionOf(id);
  }

  /** Window ID is in hand: being dragged, shuffled, or the one a fan would pick. */
  function isLifted(id: number) {
    return arrange.held === id || swing?.window === id || (poses !== null && id === picked);
  }

  /** Super+drag on a window picks it up; on empty canvas it starts a selection box. */
  function pressWithSuper(event: StagePointerEvent) {
    if (event.window != null) arrange.startDrag(event.window, event);
    else selection.begin(event.worldX, event.worldY);
  }

  function dragWithSuper(event: StagePointerEvent) {
    if (!selection.move(event.worldX, event.worldY)) arrange.moveDrag(event);
  }

  function releaseWithSuper(event: StagePointerEvent) {
    if (!selection.end()) arrange.endDrag(event);
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

        {drawn.map((id) => {
          const fanned = poses?.has(id) ?? false;
          return (
            <CanvasWindow
              key={id}
              id={id}
              box={boxes.get(id)!}
              tilt={poses?.get(id)}
              transition={transitionOf(id)}
              // In a fan the window that would be picked wears the focus ring.
              focused={poses ? id === picked : id === focused}
              grabbed={arrange.grabbed === id}
              lifted={isLifted(id)}
              onPress={fanned ? fan.press : undefined}
              onHover={fanned ? fan.hover : undefined}
              onRelease={fanned ? fan.release : undefined}
              opening={opening.has(id)}
              onPickUp={arrange.startDrag}
              onCarry={arrange.moveDrag}
              onLetGo={arrange.endDrag}
              onResizeStart={arrange.startResize}
              onResize={arrange.resize}
              onResizeEnd={arrange.endResize}
            />
          );
        })}
        <Selection
          places={shown}
          selected={selection.ids}
          box={selection.box}
          stacks={withPills}
          dropTarget={arrange.dropTarget}
          dropping={arrange.dropping}
          leaving={arrange.leaving}
          motionOf={arrange.motionOf}
          onPickUpStack={arrange.startDrag}
          onOpenStack={openStack}
          onCarry={arrange.moveDrag}
          onLetGo={arrange.endDrag}
        />
        <Guides guides={arrange.guides} />

        {output && <Minimap output={output} places={boxes} focused={focused} />}
        <Desktop barStart={ZoomLabel} />
        <PaperToolbar />
        <Launcher output={output} />
        <Toast message={toast} />

        {/* Super+drag picks a window up anywhere in it, with Alt too freely; on empty canvas it draws a selection box. */}
        {dragModifiers.map((modifiers) => (
          <PointerBinding
            key={modifiers.join("+")}
            button="left"
            modifiers={modifiers}
            onDown={pressWithSuper}
            onMove={dragWithSuper}
            onUp={releaseWithSuper}
          />
        ))}
        <PointerBinding button="right" modifiers="super" action="resize" />
        <PointerBinding button="middle" action="pan" />
        <WheelBinding modifiers="super" action="zoom" />
        <GestureBinding gesture="pinch" fingers={2} action="zoom" />
        <GestureBinding gesture="swipe" fingers={3} action="pan" />

        <Shortcut keys="Super+Return" onPress={() => launch(terminal)} />
        <Shortcut keys="Super+Q" onPress={closeFocused} />
        <Shortcut keys="Super+O" onPress={toggleOverview} />
        <Shortcut keys="Super+C" onPress={centerFocused} />
        <Shortcut keys="Super+G" onPress={toggleGuides} />
        <Shortcut keys="Super+S" onPress={stackOrSpread} />
        <Shortcut keys="Alt+Tab" repeat onPress={() => fanStack(1)} />
        {/* Shift turns Tab into ISO_Left_Tab. */}
        <Shortcut keys="Alt+Shift+ISO_Left_Tab" repeat onPress={() => fanStack(-1)} />
        <Shortcut keys="Super+M" onPress={toggleMagnet} />
        <Shortcut keys="Super+Shift+M" onPress={cycleMagnetStrength} />
        <Shortcut keys="Super+Shift+Z" onPress={undo} />
        <Shortcut keys="Ctrl+Alt+A" onPress={tidy} />
        {presetKeys.map(([key, preset]) => (
          <Shortcut key={preset} keys={`Ctrl+Alt+${key}`} onPress={() => tile(preset)} />
        ))}
        {arrangements.map((columns) => (
          <Shortcut key={columns} keys={`Ctrl+Alt+${columns}`} onPress={() => arrangeColumns(columns)} />
        ))}
        {arrowKeys.map((key) => (
          <Shortcut key={key} keys={`Super+${key}`} onPress={() => focusToward(key)} />
        ))}
      </PaperProvider>
    </ScreenEffects>
  );
}

function strengthName(value: number): string {
  return strengths.find((x) => x.value === value)?.name ?? "";
}

/**
 * The window of the stack IDS (bottom first) that slips a little out from the front slot as WINDOW comes to the front:
 * the front one going to the back when WINDOW is next behind it, or WINDOW itself coming from the back; else none.
 */
function swingingOut(ids: readonly number[], window: number): number | null {
  if (window === ids.at(-2)) return ids.at(-1)!;
  if (window === ids[0]) return window;
  return null;
}

/** The value after CURRENT in VALUES, round again after the last. */
function cycle<T>(values: readonly T[], current: T): T {
  return values[(values.indexOf(current) + 1) % values.length]!;
}
