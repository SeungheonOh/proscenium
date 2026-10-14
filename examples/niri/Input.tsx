import { useRef } from "react";
import {
  GestureBinding,
  PointerBinding,
  Rect,
  Screen,
  WheelBinding,
  type StageGestureEvent,
  type StagePointerEvent,
  type StageWheelEvent,
} from "proscenium";
import {
  edgesAt, OverviewGesture, shownBox, ViewGesture, workspaceAt, WorkspaceGesture, type GestureHost,
  type PointerAt,
} from "./interaction.js";
import { useNiri, type NiriContextValue } from "./NiriProvider.js";
import type { NiriAction } from "./state.js";

const at = (event: StagePointerEvent): PointerAt => ({ output: event.output, x: event.screenX, y: event.screenY });

/**
 * Turns wheel motion into whole notches, 120 units each as libinput reports
 * them, starting over when the direction changes; a cooldown drops notches
 * that come too soon after one acted, as niri's bind cooldown does.
 */
function useNotches(cooldown = 0) {
  const state = useRef({ total: 0, until: 0 });
  return (event: StageWheelEvent, act: (direction: 1 | -1) => void) => {
    if (event.source === "finger" || event.source === "continuous") return;
    const units = event.discrete || Math.sign(event.delta) * 120;
    const memory = state.current;
    if (Math.sign(units) !== Math.sign(memory.total)) memory.total = 0;
    memory.total += units;
    const notches = Math.trunc(memory.total / 120);
    memory.total %= 120;
    for (let notch = 0; notch < Math.abs(notches); notch++) {
      const now = performance.now();
      if (now < memory.until) continue;
      memory.until = now + cooldown;
      act(notches > 0 ? 1 : -1);
    }
  };
}

/** niri's mouse and touchpad bindings, and the hot corner. */
export function Input({ fullscreen }: { fullscreen: ReadonlySet<string> }) {
  const niri = useNiri();
  const { act, pointer, overview, overlays, outputs } = niri;
  const overviewWorkspaces = useNotches(50);
  const overviewColumns = useNotches(50);
  const overviewHorizontal = useNotches();
  const scroll = useTouchpadScroll(niri);
  const fourFinger = useRef<OverviewGesture | null>(null);
  const column = (direction: 1 | -1) => act({ type: "focusColumn", to: direction > 0 ? "right" : "left" });

  // The screenshot UI and the exit dialog have the pointer to themselves.
  if (overlays.screenshot || overlays.exit) return null;
  return (
    <>
      <PointerBinding
        button="left"
        modifiers="super"
        onDown={(event) => {
          if (event.window == null) return;
          if (!overview) act({ type: "activate", window: event.window });
          pointer.drag(event.window, at(event), false);
        }}
        onMove={(event) => pointer.move(at(event))}
        onUp={() => pointer.release()}
      />
      <PointerBinding
        button="right"
        modifiers="super"
        onDown={(event) => {
          if (event.window == null || overview) return;
          act({ type: "activate", window: event.window });
          const box = shownBox(niri, event.window);
          if (box) pointer.resize(event.window, at(event), edgesAt(box, event.screenX, event.screenY));
        }}
        onMove={(event) => pointer.move(at(event))}
        onUp={() => pointer.release()}
      />
      <PointerBinding
        button="middle"
        modifiers="super"
        onDown={(event) => {
          const output = niri.envRef.current.outputs.find((candidate) => candidate.name === event.output);
          const under = overview && output ? workspaceAt(niri, output, event.screenX, event.screenY) : null;
          pointer.spatial(at(event), under && "workspace" in under ? under.workspace.id : undefined);
        }}
        onMove={(event) => pointer.move(at(event))}
        onUp={() => pointer.release()}
      />

      <WheelBinds act={act} />
      {overview && (
        <>
          <WheelBinding onWheel={(event) => {
              if (scroll(event)) return;
            const output = event.output;
            if (event.orientation === "vertical") {
              overviewWorkspaces(event, (direction) =>
                act({ type: "focusWorkspaceRelative", direction, output }));
            } else {
              overviewHorizontal(event, column);
            }
          }} />
          <WheelBinding modifiers="shift" onWheel={(event) => {
            if (event.orientation === "vertical") overviewColumns(event, column);
          }} />
        </>
      )}

      <SwipeBinding niri={niri.handle} />
      <GestureBinding
        gesture="swipe"
        fingers={4}
        onBegin={() => { fourFinger.current = OverviewGesture.begin(niri.handle); }}
        onUpdate={(event) => fourFinger.current?.update(-event.dy)}
        onEnd={() => {
          fourFinger.current?.end();
          fourFinger.current = null;
        }}
      />

      {/* The top left corner of each output toggles the overview, above everything. */}
      {outputs.map((output) => !fullscreen.has(output.name) && (
        <Screen key={output.name} output={output.name}>
          <Rect width={1} height={1} onPointerEnter={() => niri.setOverview((open) => !open)} />
        </Screen>
      ))}
    </>
  );
}

/**
 * niri's Mod+wheel bindings: up and down switch workspaces and sideways focuses
 * columns; with Ctrl they take the column along, and Shift turns up and down
 * sideways.
 */
export function WheelBinds({ act }: { act: (action: NiriAction) => void }) {
  const workspaces = useNotches(150);
  const moves = useNotches(150);
  const columns = useNotches();
  const columnMoves = useNotches();
  const shiftColumns = useNotches();
  const shiftMoves = useNotches();

  const both = (vertical: (direction: 1 | -1) => void, horizontal: (direction: 1 | -1) => void,
                verticalNotches: ReturnType<typeof useNotches>, horizontalNotches: ReturnType<typeof useNotches>) =>
    (event: StageWheelEvent) => {
      if (event.orientation === "vertical") verticalNotches(event, vertical);
      else horizontalNotches(event, horizontal);
    };
  const run = (make: (direction: 1 | -1) => NiriAction) => (direction: 1 | -1) => act(make(direction));
  const column = (direction: 1 | -1) => act({ type: "focusColumn", to: direction > 0 ? "right" : "left" });
  const moveColumn = (direction: 1 | -1) => act({ type: "moveColumn", to: direction > 0 ? "right" : "left" });

  return (
    <>
      <WheelBinding modifiers="super" onWheel={both(
        run((direction) => ({ type: "focusWorkspaceRelative", direction })), column, workspaces, columns)} />
      <WheelBinding modifiers={["super", "ctrl"]} onWheel={both(
        run((direction) => ({ type: "moveColumnToWorkspace", direction })), moveColumn, moves, columnMoves)} />
      <WheelBinding modifiers={["super", "shift"]} onWheel={both(column, column, shiftColumns, columns)} />
      <WheelBinding modifiers={["super", "ctrl", "shift"]} onWheel={both(moveColumn, moveColumn, shiftMoves, columnMoves)} />
    </>
  );
}

/**
 * Three-finger swipes: sideways scrolls the columns, up and down switches
 * workspaces, decided once the fingers have moved 16 pixels. Content follows
 * the fingers. They act on the output they are on, or on OUTPUT when given.
 */
export function SwipeBinding({ niri, output }: { niri: () => GestureHost; output?: string }) {
  const state = useRef<{ x: number; y: number; output: string;
                         gesture: ViewGesture | WorkspaceGesture | null } | null>(null);

  function begin(event: StageGestureEvent) {
    const on = output ?? event.output ?? niri().state.activeOutput ?? "";
    state.current = { x: 0, y: 0, output: on, gesture: null };
  }

  function update(event: StageGestureEvent) {
    const swipe = state.current;
    if (!swipe) return;
    if (!swipe.gesture) {
      swipe.x += event.dx;
      swipe.y += event.dy;
      if (swipe.x ** 2 + swipe.y ** 2 < 16 ** 2) return;
      if (Math.abs(swipe.x) > Math.abs(swipe.y)) {
        let workspace: number | undefined;
        const host = niri();
        const shown = host.envRef.current.outputs.find((candidate) => candidate.name === swipe.output);
        if (host.overview && shown && event.screenX !== undefined && event.screenY !== undefined) {
          const under = workspaceAt(host, shown, event.screenX, event.screenY);
          if (under && "workspace" in under) workspace = under.workspace.id;
        }
        swipe.gesture = ViewGesture.begin(niri, swipe.output, true, workspace);
      } else {
        swipe.gesture = WorkspaceGesture.begin(niri, swipe.output, true);
      }
      // The distance that decided the direction is not applied.
      return;
    }
    if (swipe.gesture instanceof ViewGesture) swipe.gesture.update(-event.dx);
    else swipe.gesture.update(-event.dy);
  }

  function end() {
    state.current?.gesture?.end();
    state.current = null;
  }

  return <GestureBinding gesture="swipe" fingers={3} onBegin={begin} onUpdate={update} onEnd={end} />;
}

/**
 * In the overview, two-finger scrolling stands in for three-finger swipes:
 * its first motion picks the direction and lifting the fingers ends it.
 */
function useTouchpadScroll(niri: NiriContextValue) {
  const gesture = useRef<ViewGesture | WorkspaceGesture | null>(null);
  return (event: StageWheelEvent): boolean => {
    if (event.source !== "finger") return false;
    if (event.delta === 0) {
      gesture.current?.end();
      gesture.current = null;
      return true;
    }
    if (!gesture.current) {
      const output = niri.envRef.current.outputs.find((candidate) => candidate.name === event.output);
      if (event.orientation === "vertical") {
        gesture.current = WorkspaceGesture.begin(niri.handle, event.output, true);
      } else if (output) {
        const under = workspaceAt(niri.handle(), output, event.screenX, event.screenY);
        gesture.current = ViewGesture.begin(niri.handle, event.output, true,
                                            under && "workspace" in under ? under.workspace.id : undefined);
      }
    }
    if (gesture.current instanceof ViewGesture) {
      if (event.orientation === "horizontal") gesture.current.update(event.delta);
    } else if (event.orientation === "vertical") {
      gesture.current?.update(event.delta);
    }
    return true;
  };
}
