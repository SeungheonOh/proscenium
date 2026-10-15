import { useRef } from "react";
import {
  close,
  GestureBinding,
  getCamera,
  launch,
  moveCamera,
  PointerBinding,
  Shortcut,
  useFocusedWindow,
  WheelBinding,
} from "proscenium";
import { terminal } from "../lib/settings.js";
import { layoutMotion } from "./Arrangement.js";
import {
  frameWindow,
  moveAlong,
  settleCamera,
  showEverything,
  stepInto,
  stepOutOf,
} from "./navigation.js";
import { useTrellis } from "./TrellisProvider.js";

/** How long after the wheel stops a Super+wheel zoom settles. */
const wheelSettle = 180;
const digits = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

/**
 * TrellisWM's keys, on Ctrl+Alt as its ⌃⌥, with the desktop's usual Super keys;
 * a pinch, or Super+wheel, zooms the real desktop and settles on the space that
 * fits best; a three-finger swipe pans it, and settles the same way.
 */
export function Keybindings() {
  const { state, act, scene, output, startDrag, moveDrag, endDrag } = useTrellis();
  const focused = useFocusedWindow();
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ state, scene, output });
  latest.current = { state, scene, output };

  /** After a zoom or pan the compositor ran: frame the best fit, and bring the camera home with it. */
  function settle() {
    const { state, scene, output } = latest.current;
    const camera = output && getCamera(output.name);
    if (!camera || !scene || !output) return;
    act(settleCamera(state, scene, camera, output));
    moveCamera({ x: output.width / 2, y: output.height / 2, zoom: 1 }, { output: output.name, transition: layoutMotion });
  }

  // Stepping in heads for the focused window, or the middle of the screen.
  const toward = () => {
    const view = focused === null ? undefined : scene?.windows.get(focused);
    const r = view?.rect ?? scene?.screen;
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : { x: 0, y: 0 };
  };
  const stepIn = () => {
    const { x, y } = toward();
    if (scene) act(stepInto(state, scene, x, y));
  };
  const along = (by: number) => {
    const action = moveAlong(state, by);
    if (action) act(action);
  };

  return (
    <>
      <Shortcut keys="Ctrl+Alt+space" onPress={() => act(showEverything(state))} />
      <Shortcut keys="Ctrl+Alt+Up" onPress={() => act(stepOutOf(state))} />
      <Shortcut keys="Ctrl+Alt+Down" onPress={stepIn} />
      <Shortcut keys="Ctrl+Alt+Return" onPress={() => {
        const action = frameWindow(state, focused);
        if (action) act(action);
      }} />
      <Shortcut keys="Ctrl+Alt+Left" onPress={() => along(-1)} />
      <Shortcut keys="Ctrl+Alt+Right" onPress={() => along(1)} />
      <Shortcut keys="Ctrl+Alt+bracketleft" onPress={() => act({ type: "back" })} />
      <Shortcut keys="Ctrl+Alt+bracketright" onPress={() => act({ type: "forward" })} />
      {digits.map((digit) => (
        <Shortcut key={`save${digit}`} keys={`Ctrl+Alt+Shift+${digit}`} onPress={() => act({ type: "save", slot: Number(digit) })} />
      ))}
      {digits.map((digit) => (
        <Shortcut key={`recall${digit}`} keys={`Ctrl+Alt+${digit}`} onPress={() => act({ type: "recall", slot: Number(digit) })} />
      ))}

      <Shortcut keys="Super+Return" onPress={() => launch(terminal)} />
      <Shortcut keys="Super+Q" onPress={() => focused !== null && close(focused)} />
      <Shortcut keys="Super+M" onPress={() => focused !== null && act({ type: "minimize", window: focused })} />
      {/* Super+drag picks a window up anywhere in it. */}
      <PointerBinding
        button="left"
        modifiers="super"
        onDown={({ window, screenX, screenY }) => {
          const view = window === null || window === undefined ? undefined : scene?.windows.get(window);
          if (view) startDrag(view.id, false, view, screenX, screenY);
        }}
        onMove={({ screenX, screenY }) => moveDrag(screenX, screenY)}
        onUp={endDrag}
      />

      <GestureBinding gesture="pinch" fingers={2} action="zoom" onEnd={settle} />
      {/* The camera reports where a fling will land, so a flick settles as far as it would coast. */}
      <GestureBinding gesture="swipe" fingers={3} action="pan" onEnd={settle} />
      <WheelBinding
        modifiers="super"
        action="zoom"
        onWheel={() => {
          if (wheelTimer.current) clearTimeout(wheelTimer.current);
          wheelTimer.current = setTimeout(settle, wheelSettle);
        }}
      />
    </>
  );
}
