import { useState } from "react";
import {
  Background,
  focus,
  Group,
  perspective,
  Rect,
  rotateY,
  spring,
  Text,
  translateZ,
  type Animation,
  type Paint,
} from "proscenium";
import { TilingWindow } from "../components/TilingWindow.js";
import { font } from "../lib/theme.js";
import { useCube } from "./CubeProvider.js";
import { faces } from "./state.js";

/** Each face's wallpaper, as its own colour of glass. */
const wallpapers: Paint[] = [
  { from: "#13254a", to: "#0a7a99", angle: 135 },
  { from: "#2c1446", to: "#a4508b", angle: 135 },
  { from: "#3d1c12", to: "#c9702b", angle: 135 },
  { from: "#0f3324", to: "#2b9c6e", angle: 135 },
];

const turnMotion = spring({ duration: 0.6, bounce: 0.12 });

/** The cube steps back as it turns and comes forward again, as Compiz's did. */
function stepBack(turn: number, depth: number): Animation {
  return {
    transform: [[translateZ(0)], [translateZ(-depth)], [translateZ(0)]],
    composite: "add",
    duration: 0.6,
    ease: "ease-in-out",
    key: `turn-${turn}`,
  };
}

/**
 * Four workspaces on the sides of a cube. Every face covers the work area and
 * sits half the cube's depth from its centre, so the face in front lies flat on
 * the screen, pixel for pixel. Faces turned away are not drawn at all, so a
 * cube at rest costs what a flat desktop does.
 */
export function Cube() {
  const { state, area, front, focused, boxes } = useCube();
  const { width, height } = area;
  const depth = width / 2;
  // Every turn steps back, but not the cube coming up as the session starts.
  const [startTurn] = useState(state.turn);
  const [turned, setTurned] = useState(false);
  if (!turned && state.turn !== startTurn) setTurned(true);

  return (
    <>
      <Background fill="#070a12" />
      <Group
        x={area.x}
        y={area.y}
        width={width}
        height={height}
        transform={[perspective(width * 1.3)]}
      >
        <Group
          width={width}
          height={height}
          animate={turned ? stepBack(state.turn, depth * 0.9) : null}
        >
          <Group
            width={width}
            height={height}
            transform={[translateZ(-depth), rotateY(-90 * state.turn)]}
            transition={turnMotion}
          >
            {Array.from({ length: faces }, (_, face) => (
              <Group
                key={face}
                width={width}
                height={height}
                backface="hidden"
                transform={[rotateY(90 * face), translateZ(depth)]}
              >
                <Rect
                  width={width}
                  height={height}
                  fill={wallpapers[face]}
                  border={{ width: 2, color: "#ffffff26" }}
                />
                <Text
                  y={height * 0.22}
                  width={width}
                  align="center"
                  font={font}
                  size={height * 0.42}
                  weight={800}
                  color="#ffffff12"
                >
                  {String(face + 1)}
                </Text>
                {state.order
                  .filter((id) => state.faceOf[id] === face && boxes.has(id))
                  .map((id) => (
                    <TilingWindow
                      key={id}
                      id={id}
                      box={boxes.get(id)!}
                      floating={false}
                      focused={id === focused}
                      // Only the face in front: one turning away passes under a
                      // still pointer, and focusing it would turn the cube back.
                      onPointerEnter={face === front ? () => focus(id) : undefined}
                    />
                  ))}
                {/* Faces darken as they turn away from the light. */}
                <Rect
                  width={width}
                  height={height}
                  fill="#000000"
                  opacity={face === front ? 0 : 0.6}
                  transition={turnMotion}
                />
              </Group>
            ))}
          </Group>
        </Group>
      </Group>
    </>
  );
}
