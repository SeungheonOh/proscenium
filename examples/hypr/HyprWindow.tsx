import { focus, type Rectangle, type StageDragEvent, type StageResizeEvent } from "proscenium";
import { TilingWindow } from "../components/TilingWindow.js";
import { bump } from "../lib/animations.js";
import { useHypr } from "./HyprProvider.js";

interface HyprWindowProps {
  id: number;
  box: Rectangle;
  floating: boolean;
  /** Where a native drag left the window, in its workspace's coordinates. */
  onDrop?: (event: StageDragEvent) => void;
  onResize?: (event: StageResizeEvent) => void;
}

/** A tiled or floating window; focus follows the mouse. */
export function HyprWindow({ id, box, floating, onDrop, onResize }: HyprWindowProps) {
  const { focused, dispatch, bumped, reveal } = useHypr();

  return (
    <TilingWindow
      id={id}
      box={box}
      floating={floating}
      focused={id === focused}
      animate={bumped?.window === id ? bump(bumped.direction, bumped.count) : null}
      onPointerEnter={() => focus(id)}
      onDrop={onDrop}
      onResize={onResize}
      onFullscreen={(value) => dispatch({ type: "fullscreen", window: value ? id : null })}
      // A client asking to be shown, e.g. for a link it opened, brings its workspace along.
      onActivate={() => reveal(id)}
    />
  );
}
