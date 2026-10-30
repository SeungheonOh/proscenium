import { memo, useMemo } from "react";
import {
  getCamera,
  instant,
  type OutputInfo,
  scale,
  type StagePointerEvent,
  type StageResizeEvent,
  type Transition,
  Window,
  type Rectangle,
} from "proscenium";
import { burn } from "../lib/effects.js";
import { colors } from "../lib/theme.js";
import { isotopy, isotopyUniforms, seeded } from "./isotopyEffect.js";

const burning = burn(104);

interface CanvasWindowProps {
  id: number;
  /** Where it shows: its place, or where a drag or a push has it now. */
  box: Rectangle;
  /** How it moves there. */
  transition: Transition;
  focused: boolean;
  /** Pressed on: it hears the pointer until it is let go. */
  grabbed: boolean;
  /** In hand: lifted. */
  held: boolean;
  onPickUp: (window: number, event: StagePointerEvent) => void;
  onCarry: (event: StagePointerEvent) => void;
  onLetGo: (event: StagePointerEvent) => void;
  onResizeStart: (window: number) => void;
  onResize: (window: number, event: StageResizeEvent) => void;
  onResizeEnd: (window: number, event: StageResizeEvent) => void;
  /** While the window is opening, the output it opens on. */
  opening?: OutputInfo | undefined;
}

/**
 * The Isotopy opening for a window at BOX on OUTPUT: its beam leaves the screen
 * edge facing where the camera shows the window as it opens, and stays there.
 */
function openingUse(id: number, box: Rectangle, output: OutputInfo) {
  const camera = getCamera(output.name) ?? { x: 0, y: 0, zoom: 1 };
  const rect = {
    x: (box.x - camera.x) * camera.zoom + output.width / 2,
    y: (box.y - camera.y) * camera.zoom + output.height / 2,
    width: box.width * camera.zoom,
    height: box.height * camera.zoom,
  };
  const uniforms = isotopyUniforms(rect, output.width, output.height, seeded(id));
  return { id: "isotopy", shader: isotopy, uniforms, transition: instant };
}

/**
 * A window on the canvas; it lifts while dragged. Its title bar picks it up: the
 * request becomes a pointer capture on it, so the world places it on every move
 * (see useArrange). Resizes stay native.
 */
export const CanvasWindow = memo(function CanvasWindow({
  id,
  box,
  transition,
  focused,
  grabbed,
  held: lifted,
  onPickUp,
  onCarry,
  onLetGo,
  onResizeStart,
  onResize,
  onResizeEnd,
  opening,
}: CanvasWindowProps) {
  // Aimed once, as the window opens.
  const openingShader = useMemo(() => opening && openingUse(id, box, opening), [opening !== undefined]);

  return (
    <Window
      window={id}
      {...box}
      radius={10}
      tiled
      resizable
      transform={scale(lifted ? 1.012 : 1)}
      border={{ width: focused ? 2 : 1, color: focused ? colors.accent : "#00000022" }}
      shadow={{
        color: focused ? "#0000004d" : "#00000026",
        blur: lifted ? 64 : 36,
        y: lifted ? 26 : 12,
      }}
      // A window opens through the Isotopy beam; it burns away as it closes.
      shaders={[openingShader || burning.use]}
      initial={opening ? undefined : { transform: scale(0.94), shaders: burning.burnt }}
      exit={{ transform: scale(0.94), shaders: burning.burnt }}
      transition={transition}
      onMoveRequest={(event) => {
        const { screenX, screenY, worldX, worldY } = event;
        if (screenX !== undefined && screenY !== undefined && worldX !== undefined && worldY !== undefined)
          onPickUp(id, event as StagePointerEvent);
      }}
      // Only a window pressed on hears the pointer move; hovering costs nothing.
      onPointerMove={grabbed ? onCarry : undefined}
      onPointerUp={onLetGo}
      onResizeStart={() => onResizeStart(id)}
      onResize={(event) => onResize(id, event)}
      onResizeEnd={(event) => onResizeEnd(id, event)}
    />
  );
});
