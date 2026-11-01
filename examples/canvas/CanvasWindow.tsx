import { memo } from "react";
import {
  Rect,
  type Rectangle,
  rotate,
  scale,
  type StagePointerEvent,
  type StageRequestEvent,
  type StageResizeEvent,
  type Transition,
  Window,
} from "proscenium";
import { colors } from "../lib/theme.js";
import type { FanPose } from "./stacks.js";
import { cloak } from "./camoEffect.js";

const cloaking = cloak(104);
/** How a window looks before it shows and once it has closed: cloaked away where it is. */
const cloaked = { shaders: cloaking.cloaked };

interface CanvasWindowProps {
  id: number;
  /** Where it shows: its place, or where a drag or a push has it now. */
  box: Rectangle;
  /** How it moves there. */
  transition: Transition;
  focused: boolean;
  /** Pressed on: it hears the pointer until it is let go. */
  grabbed: boolean;
  /** In hand: drawn with a deeper shadow. */
  lifted: boolean;
  /** Fanned out of its stack: tilted and shrunk about its middle. */
  tilt?: FanPose | undefined;
  /** Fanned out: a press on it (to pick it or drag it along the fan), which reaches no client. */
  onPress?: ((window: number, event: StagePointerEvent) => void) | undefined;
  /** Fanned out: the pointer moved over it, or with it in hand. */
  onHover?: ((window: number, event: StagePointerEvent) => void) | undefined;
  /** Fanned out: let go of it. */
  onRelease?: (() => void) | undefined;
  onPickUp: (window: number, event: StagePointerEvent) => void;
  onCarry: (event: StagePointerEvent) => void;
  onLetGo: (event: StagePointerEvent) => void;
  onResizeStart: (window: number) => void;
  onResize: (window: number, event: StageResizeEvent) => void;
  onResizeEnd: (window: number, event: StageResizeEvent) => void;
  /** Just opened: it uncloaks into view. A window already there when the world (re)loads just shows. */
  opening: boolean;
}

/** A move request that says where the pointer is, so it can become a drag. */
function isFromPointer(event: StageRequestEvent): event is StagePointerEvent {
  const { screenX, screenY, worldX, worldY } = event;
  return screenX !== undefined && screenY !== undefined && worldX !== undefined && worldY !== undefined;
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
  lifted,
  tilt,
  onPress,
  onHover,
  onRelease,
  onPickUp,
  onCarry,
  onLetGo,
  onResizeStart,
  onResize,
  onResizeEnd,
  opening,
}: CanvasWindowProps) {
  // Lifted shows in the shadow alone: grown, its edges would miss the guides they line up with.
  const transform = [rotate(tilt?.angle ?? 0), scale(tilt?.scale ?? 1)];

  return (
    <>
      <Window
        window={id}
        {...box}
        radius={10}
        tiled
        resizable
        transform={transform}
        border={{ width: focused ? 2 : 1, color: focused ? colors.accent : "#00000022" }}
        shadow={{
          color: focused ? "#0000004d" : "#00000026",
          blur: lifted ? 64 : 36,
          y: lifted ? 26 : 12,
        }}
        // It uncloaks as it opens and cloaks away as it closes.
        shaders={[cloaking.use]}
        initial={opening ? cloaked : undefined}
        exit={cloaked}
        transition={transition}
        onMoveRequest={(event) => {
          if (isFromPointer(event)) onPickUp(id, event);
        }}
        // Only a window pressed on hears the pointer move; hovering costs nothing.
        onPointerMove={grabbed ? onCarry : undefined}
        onPointerUp={onLetGo}
        onResizeStart={() => onResizeStart(id)}
        onResize={(event) => onResize(id, event)}
        onResizeEnd={(event) => onResizeEnd(id, event)}
      />
      {onPress && (
        <Rect
          {...(tilt?.reach ?? box)}
          transform={transform}
          transition={transition}
          cursor="pointer"
          onPointerDown={(event) => onPress(id, event)}
          // Only a move counts: a card shifting under a still pointer leaves the pick to the keys.
          onPointerMove={onHover ? (event) => onHover(id, event) : undefined}
          onPointerUp={onRelease}
        />
      )}
    </>
  );
});
