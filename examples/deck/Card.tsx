import type { ReactNode } from "react";
import {
  Rect,
  rotate,
  scale,
  spring,
  Text,
  translate,
  Window,
  type Animation,
  type Rectangle,
  type StageDragEvent,
  type StagePointerEvent,
} from "proscenium";
import { font } from "../lib/theme.js";
import { placement, type Hover, type Pose, type Size } from "./layout.js";
import { cardFoil } from "./shaders.js";

const glow = spring({ duration: 0.3 });
const stock = "#f4efe3";

/** A pop and a wobble, as a card gives when picked up. */
function pop(key: string): Animation {
  return {
    transform: [
      [rotate(0), scale(1)],
      [rotate(-5), scale(1.1)],
      [rotate(3.5), scale(1.04)],
      [rotate(-1.5), scale(1.01)],
      [rotate(0), scale(1)],
    ],
    composite: "add",
    duration: 0.45,
    ease: "ease-out",
    key,
  };
}

/** Floating gently, each card at its own pace. */
function sway(index: number, lift: number): Animation {
  return {
    transform: [
      [translate(0, 0), rotate(-1.4)],
      [translate(0, -lift), rotate(1.4)],
    ],
    composite: "add",
    duration: 1.7 + (index % 4) * 0.23,
    ease: "ease-in-out",
    direction: "alternate",
    iterations: Infinity,
    key: "sway",
  };
}

interface CardProps {
  id: number;
  index: number;
  table: Rectangle;
  /** The window's size: the table's, or the nearest its client accepts. */
  size: Size;
  pose: Pose;
  /** In play the window is itself: it fills the table and takes input. */
  played: boolean;
  /** Darkened under a dialog of its own. */
  shaded: boolean;
  /** The pointer on this card, if it is there. */
  hover: Hover | null;
  /** What the card holds, shown above it while TITLED. */
  title: string;
  titled: boolean;
  /** Seconds this card waits while the deck is dealt. */
  delay: number;
  swaying: boolean;
  /** Changes each time the card should pop. */
  popKey: string | null;
  onHover: (hover: Hover | null) => void;
  onPick: () => void;
  /** The client asked to be shown, or to fill the screen. */
  onActivate: () => void;
  onFullscreen: (value: boolean) => void;
  /** Given, Super+drag moves the card: where its window was let go. */
  onDrop?: (event: StageDragEvent) => void;
  /** Dialogs riding on the card, drawn over its window. */
  children?: ReactNode;
}

/**
 * A window as a playing card: scaled down, turned and leaning toward the pointer,
 * framed in card stock. Its client keeps one size, so nothing reflows as it comes
 * in and out of play.
 */
export function Card({
  id,
  index,
  table,
  size,
  pose,
  played,
  shaded,
  hover,
  title,
  titled,
  delay,
  swaying,
  popKey,
  onHover,
  onPick,
  onActivate,
  onFullscreen,
  onDrop,
  children,
}: CardProps) {
  // Sizes in the window's own units, which the card's scale shrinks.
  const unit = 1 / pose.scale;
  const motion = spring({ duration: 0.45, bounce: 0.22, delay });
  const animations = [
    ...(popKey ? [pop(popKey)] : []),
    ...(swaying ? [sway(index, 6 * unit)] : []),
  ];

  function lean({ localX, localY }: StagePointerEvent) {
    onHover({ window: id, x: localX / size.width - 0.5, y: localY / size.height - 0.5 });
  }

  return (
    <Window
      window={id}
      {...placement(pose, size)}
      width={size.width}
      height={size.height}
      tiled
      focusable={played}
      movable={Boolean(onDrop)}
      dim={shaded ? 0.4 : 0}
      radius={played ? 14 : 9 * unit}
      border={{ width: played ? 2 : 5 * unit, color: stock }}
      shadow={{ color: "#0000006b", blur: (played ? 30 : 6) * unit, y: (played ? 10 : 7) * unit }}
      shaders={[{
        id: "foil",
        shader: cardFoil,
        uniforms: { amount: hover ? 1 : 0, light: [hover?.x ?? 0, hover?.y ?? 0], burn: 0, margin: 40 * unit },
        transition: glow,
      }]}
      initial={{
        y: table.y + table.height * 1.6,
        transform: placement({ ...pose, scale: 0.12, rotation: -14 }, size).transform,
      }}
      exit={{ shaders: { foil: { amount: 1, burn: 1 } } }}
      transition={motion}
      animate={animations}
      onActivateRequest={onActivate}
      onFullscreenRequest={({ value }) => onFullscreen(Boolean(value))}
      onDragEnd={onDrop}
    >
      {!played && (
        <Rect
          width={size.width}
          height={size.height}
          cursor="pointer"
          onPointerMove={lean}
          onPointerLeave={() => onHover(null)}
          onPointerDown={onPick}
        />
      )}
      {!played && (
        <Text
          x={0}
          y={-30 * unit}
          width={size.width}
          align="center"
          font={font}
          size={15 * unit}
          weight={700}
          color={stock}
          opacity={titled ? 1 : 0}
        >
          {title}
        </Text>
      )}
      {children}
    </Window>
  );
}
