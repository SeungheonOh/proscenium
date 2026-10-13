import { useState } from "react";
import {
  Box,
  Rect,
  Screen,
  Shortcut,
  Text,
  useOutputs,
  type Rectangle,
  type StagePointerEvent,
} from "proscenium";
import { colors, font, motion } from "../lib/theme.js";

/** A box in an output's logical pixels. */
export type OutputArea = Rectangle & { output: string };

interface AreaSelectionProps {
  prompt: string;
  /** Called with the chosen area, or null after Escape or a click without a drag. */
  onDone: (area: OutputArea | null) => void;
}

const minimumSize = 8;

/** Drag out an area on any output. */
export function AreaSelection({ prompt, onDone }: AreaSelectionProps) {
  const outputs = useOutputs();
  const [start, setStart] = useState<{ output: string; x: number; y: number } | null>(null);
  const [area, setArea] = useState<OutputArea | null>(null);

  // Computed from each event, not from state, which can be one event behind.
  function areaTo(event: StagePointerEvent): OutputArea | null {
    if (!start) return null;
    return {
      output: start.output,
      x: Math.min(start.x, event.screenX),
      y: Math.min(start.y, event.screenY),
      width: Math.abs(event.screenX - start.x),
      height: Math.abs(event.screenY - start.y),
    };
  }

  function handlePointerUp(event: StagePointerEvent) {
    const chosen = areaTo(event);
    setStart(null);
    const bigEnough = chosen && chosen.width >= minimumSize && chosen.height >= minimumSize;
    onDone(bigEnough ? chosen : null);
  }

  return (
    <>
      {outputs.map((output) => (
        <Screen key={output.name} output={output.name}>
          <Box
            width={output.width}
            height={output.height}
            justifyContent="center"
            alignItems="center"
            fill="#00000059"
            cursor="crosshair"
            initial={{ opacity: 0 }}
            transition={motion.pop}
            onPointerDown={(event) =>
              setStart({ output: output.name, x: event.screenX, y: event.screenY })
            }
            // Motion reaches the director only while dragging.
            onPointerMove={start ? (event) => setArea(areaTo(event)) : undefined}
            onPointerUp={handlePointerUp}
          >
            {area?.output === output.name ? (
              <Rect
                position="absolute"
                x={area.x}
                y={area.y}
                width={area.width}
                height={area.height}
                radius={6}
                fill="#2f6fed14"
                border={{ width: 2, color: colors.accent }}
              />
            ) : (
              <Text
                size={15}
                weight={600}
                color="#ffffff"
                font={font}
                initial={{ opacity: 0 }}
                transition={motion.pop}
              >
                {prompt}
              </Text>
            )}
          </Box>
        </Screen>
      ))}
      <Shortcut keys="Escape" onPress={() => onDone(null)} />
    </>
  );
}
