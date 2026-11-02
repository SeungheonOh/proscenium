import { memo, useMemo, useState } from "react";
import { getCamera, instant, type OutputInfo, scale, spring, Window, type Rectangle } from "proscenium";
import { burn } from "../lib/effects.js";
import { colors } from "../lib/theme.js";
import { isotopy, isotopyUniforms, seeded } from "./isotopyEffect.js";
import type { PlaceWindow } from "./usePlaces.js";

/** Reports where a window being dragged is now, or null once it is dropped. */
export type MoveWindow = (window: number, at: { x: number; y: number } | null) => void;

const settle = spring({ duration: 0.3 });
const burning = burn(104);

interface CanvasWindowProps {
  id: number;
  box: Rectangle;
  focused: boolean;
  onPlace: PlaceWindow;
  onMove: MoveWindow;
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

/** A window on the canvas; it lifts while dragged and remembers where it was left. */
export const CanvasWindow = memo(function CanvasWindow({
  id,
  box,
  focused,
  onPlace,
  onMove,
  opening,
}: CanvasWindowProps) {
  const [lifted, setLifted] = useState(false);
  // Aimed once, as the window opens.
  const openingShader = useMemo(() => opening && openingUse(id, box, opening), [opening !== undefined]);

  return (
    <Window
      window={id}
      {...box}
      radius={10}
      tiled
      movable
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
      transition={settle}
      onDragStart={() => setLifted(true)}
      onDrag={({ x, y }) => onMove(id, { x, y })}
      onDragEnd={({ x, y }) => {
        setLifted(false);
        onMove(id, null);
        onPlace(id, { x, y });
      }}
      onResizeEnd={(next) => onPlace(id, next)}
    />
  );
});
