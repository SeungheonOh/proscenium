import type { ReactNode } from "react";
import {
  scale,
  spring,
  tween,
  Window,
  type Animation,
  type Rectangle,
  type StageDragEvent,
  type StageResizeEvent,
} from "proscenium";
import { burn } from "../lib/effects.js";

export const windowMotion = spring({ duration: 0.38, bounce: 0.12 });

// The focused border turns once as focus arrives; a forever loop would keep the display awake.
const borderTurn = tween(1.2, "ease-out");
// Windows burn in as they open and away as they close; at rest the effect is skipped.
const burning = burn(64);
const activeBorder = { from: "#33ccff", to: "#00ff99", angle: 360 };
const inactiveBorder = "#59595988";

interface TilingWindowProps {
  id: number;
  box: Rectangle;
  floating: boolean;
  focused: boolean;
  /** Played once, e.g. a nudge when a move has nowhere to go. */
  animate?: Animation | null;
  onPointerEnter?: () => void;
  onDragStart?: (event: StageDragEvent) => void;
  /** Where a native drag left the window, in its parent's coordinates. */
  onDrop?: (event: StageDragEvent) => void;
  onResize?: (event: StageResizeEvent) => void;
  onFullscreen?: (fullscreen: boolean) => void;
  /** The client asked to be shown, e.g. for a link it opened. */
  onActivate?: () => void;
  /** Drawn over the content; one taking the pointer keeps it from the client. */
  children?: ReactNode;
}

/** A tiled or floating window with a gradient border that turns as focus arrives. */
export function TilingWindow({
  id,
  box,
  floating,
  focused,
  animate,
  onPointerEnter,
  onDragStart,
  onDrop,
  onResize,
  onFullscreen,
  onActivate,
  children,
}: TilingWindowProps) {
  return (
    <Window
      window={id}
      {...box}
      radius={10}
      tiled={!floating}
      movable
      resizable={floating}
      dim={focused ? 0 : 0.12}
      border={{ width: 2, color: focused ? activeBorder : inactiveBorder }}
      shadow={{ color: floating ? "#000000aa" : "#00000055", blur: floating ? 36 : 18, y: 6 }}
      shaders={[burning.use]}
      initial={{ transform: scale(0.94), border: { color: { angle: 0 } }, shaders: burning.burnt }}
      exit={{ transform: scale(0.94), shaders: burning.burnt }}
      transition={{ default: windowMotion, borderAngle: borderTurn }}
      animate={animate ?? null}
      onPointerEnter={onPointerEnter}
      onDragStart={onDragStart}
      onDragEnd={onDrop}
      onResizeEnd={onResize}
      onFullscreenRequest={onFullscreen && (({ value }) => onFullscreen(Boolean(value)))}
      onActivateRequest={onActivate}
    >
      {children}
    </Window>
  );
}
