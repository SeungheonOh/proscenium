import { useRef } from "react";
import {
  close,
  GestureBinding,
  launch,
  PointerBinding,
  Shortcut,
  WheelBinding,
} from "proscenium";
import { terminal } from "../lib/settings.js";
import { useCube } from "./CubeProvider.js";
import { faces } from "./state.js";

/** Fingers' travel, in pixels, that turns the cube a face. */
const swipeThreshold = 80;

/** Turning the cube, carrying windows round it, and the usual window keys. */
export function Keybindings() {
  const { front, focused, dispatch } = useCube();
  const swipe = useRef(0);

  function carry(step: number) {
    if (focused === null) return;
    dispatch({ type: "move", window: focused, face: (front + step + faces) % faces });
    dispatch({ type: "turn", step });
  }

  return (
    <>
      <PointerBinding button="left" modifiers="super" action="move" />
      <Shortcut keys="Super+Right" onPress={() => dispatch({ type: "turn", step: 1 })} />
      <Shortcut keys="Super+Left" onPress={() => dispatch({ type: "turn", step: -1 })} />
      <Shortcut keys="Super+Shift+Right" onPress={() => carry(1)} />
      <Shortcut keys="Super+Shift+Left" onPress={() => carry(-1)} />
      {Array.from({ length: faces }, (_, face) => [
        <Shortcut
          key={`show-${face}`}
          keys={`Super+${face + 1}`}
          onPress={() => dispatch({ type: "show", face })}
        />,
        <Shortcut
          key={`move-${face}`}
          keys={`Super+Shift+${face + 1}`}
          onPress={() => focused !== null && dispatch({ type: "move", window: focused, face })}
        />,
      ])}
      <WheelBinding
        modifiers="super"
        onWheel={({ delta }) => dispatch({ type: "turn", step: Math.sign(delta) })}
      />
      <GestureBinding
        gesture="swipe"
        fingers={3}
        onBegin={() => {
          swipe.current = 0;
        }}
        onUpdate={({ dx }) => {
          swipe.current += dx;
        }}
        onEnd={({ cancelled }) => {
          // The cube follows the fingers: a swipe left brings in the face to the right.
          if (!cancelled && Math.abs(swipe.current) >= swipeThreshold)
            dispatch({ type: "turn", step: -Math.sign(swipe.current) });
        }}
      />
      <Shortcut keys="Super+Return" onPress={() => launch(terminal)} />
      <Shortcut keys="Super+Q" onPress={() => focused !== null && close(focused)} />
    </>
  );
}
