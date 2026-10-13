import { useEffect, useRef } from "react";
import {
  Background,
  Camera,
  getCamera,
  moveCamera,
  spring,
  type CameraInfo,
  type OutputInfo,
  type StagePointerEvent,
} from "proscenium";
import { colors } from "../lib/theme.js";
import { overviewCamera, roomCamera } from "./geometry.js";
import { useMeta } from "./MetaProvider.js";

const flight = spring({ duration: 0.55, bounce: 0.05 });
/** Two presses this close in time and place are a double click. */
const doubleClick = { milliseconds: 350, pixels: 8 };

/** A camera nothing has moved yet shows world pixels as output pixels. */
function isUnplaced(camera: CameraInfo, output: OutputInfo): boolean {
  return camera.zoom === 1 && camera.x === output.width / 2 && camera.y === output.height / 2;
}

/**
 * An output's camera. Entering a room flies to it at 100%; leaving returns to where
 * the canvas was left. On the canvas it pans and zooms freely.
 */
function OutputCamera({ output }: { output: OutputInfo }) {
  const { state, size, enteredRoom, rectOf } = useMeta();
  const room = enteredRoom(output);
  const rect = room === null ? null : rectOf(room);
  const previous = useRef<number | null | undefined>(undefined);

  useEffect(() => {
    const before = previous.current;
    previous.current = room;
    const options = { output: output.name };
    if (rect) {
      moveCamera(roomCamera(rect, output), options);
    } else if (before === undefined) {
      // A fresh compositor starts over every room; a reloaded director leaves the view be.
      const camera = getCamera(output.name);
      if (!camera || isUnplaced(camera, output)) {
        moveCamera(overviewCamera(state.rooms, size, output), options);
      }
    } else if (before !== null) {
      const back = state.canvasView[output.name] ?? overviewCamera(state.rooms, size, output);
      moveCamera(back, options);
    }
  }, [room, rect?.x, rect?.y, size, output.width, output.height]);

  return <Camera output={output.name} minZoom={0.05} maxZoom={4} transition={flight} />;
}

/**
 * The cameras and the canvas under the rooms: dragging it pans with momentum, and
 * a double click on it makes a room there.
 */
export function MetaCamera() {
  const { size, outputs, enteredRoom, addRoom } = useMeta();
  const lastPress = useRef({ time: 0, x: 0, y: 0 });
  const onCanvas = outputs.filter((output) => enteredRoom(output) === null);

  function press({ screenX, screenY, worldX, worldY }: StagePointerEvent) {
    const last = lastPress.current;
    const quick = Date.now() - last.time < doubleClick.milliseconds;
    const still = Math.hypot(screenX - last.x, screenY - last.y) < doubleClick.pixels;
    lastPress.current = { time: Date.now(), x: screenX, y: screenY };
    if (quick && still) addRoom(worldX - size.width / 2, worldY - size.height / 2);
  }

  return (
    <>
      {outputs.map((output) => (
        <OutputCamera key={output.name} output={output} />
      ))}
      <Background
        fill={colors.paper}
        grid={{ kind: "dots", color: "#00000030", spacing: 48, size: 2 }}
        pan={onCanvas.length > 0}
        cursor={onCanvas.length > 0 ? "grab" : undefined}
        onPointerDown={onCanvas.length > 0 ? press : undefined}
      />
    </>
  );
}
