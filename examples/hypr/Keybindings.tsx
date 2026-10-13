import { close, focus, launch, PointerBinding, Shortcut, WheelBinding } from "proscenium";
import { directions, neighbour, type Direction } from "../lib/geometry.js";
import { terminal } from "../lib/settings.js";
import { useHypr } from "./HyprProvider.js";
import { onDesktop, workspaceNumbers } from "./tiling.js";

/** Window management keys and mouse bindings. */
export function Keybindings() {
  const { state, dispatch, boxes, focused, currentWorkspace, switchTo, bump } = useHypr();

  /** Wraps an action on the focused window, doing nothing while none has focus. */
  const onFocused = (action: (window: number) => void) => () => {
    if (focused !== null) action(focused);
  };

  function toggleFloating(window: number) {
    const box = boxes.get(window);
    dispatch({ type: "float", window, box: state.floating[window] || !box ? null : box });
  }

  function toggleFullscreen(window: number) {
    dispatch({ type: "fullscreen", window: state.fullscreen === window ? null : window });
  }

  function focusToward(direction: Direction) {
    const next =
      focused === null
        ? boxes.keys().next().value
        : neighbour(onDesktop(boxes), focused, direction);
    if (next != null) focus(next);
    else if (focused !== null) bump(focused, direction);
  }

  function swapToward(window: number, direction: Direction) {
    const next = neighbour(onDesktop(boxes), window, direction);
    if (next !== null) dispatch({ type: "swap", first: window, second: next });
    else bump(window, direction);
  }

  return (
    <>
      <PointerBinding button="left" modifiers="super" action="move" />
      <PointerBinding button="right" modifiers="super" action="resize" />
      <WheelBinding
        modifiers="super"
        onWheel={({ delta }) => switchTo(currentWorkspace + Math.sign(delta))}
      />

      <Shortcut keys="Super+Return" onPress={() => launch(terminal)} />
      <Shortcut keys="Super+Q" onPress={onFocused(close)} />
      <Shortcut keys="Super+F" onPress={onFocused(toggleFullscreen)} />
      <Shortcut keys="Super+V" onPress={onFocused(toggleFloating)} />
      <Shortcut
        keys="Super+T"
        onPress={() => dispatch({ type: "toggleLayout", workspace: currentWorkspace })}
      />

      {workspaceNumbers.map((number) => [
        <Shortcut
          key={`show-${number}`}
          keys={`Super+${number}`}
          onPress={() => switchTo(number)}
        />,
        <Shortcut
          key={`move-${number}`}
          keys={`Super+Shift+${number}`}
          onPress={onFocused((window) => dispatch({ type: "move", window, workspace: number }))}
        />,
      ])}

      {Object.entries(directions).map(([key, direction]) => [
        <Shortcut
          key={`focus-${key}`}
          keys={`Super+${key}`}
          onPress={() => focusToward(direction)}
        />,
        <Shortcut
          key={`swap-${key}`}
          keys={`Super+Shift+${key}`}
          onPress={onFocused((window) => swapToward(window, direction))}
        />,
      ])}
    </>
  );
}
