import { useRef, useState } from "react";
import { Box, Group, instant, rotate, scale, Text, translate, tween, type StagePointerEvent } from "proscenium";
import { motion, palette } from "./config.js";

/** How far a blade is pulled to the right to act. */
const pull = 50;
const folded = [translate(0, 0), rotate(0)];
/** Blades go with the ball, which rolls away at once. */
const vanish = tween(0.15, "ease-out");

interface BladeProps {
  index: number;
  icon: string;
  label: string;
  x: number;
  y: number;
  onHover: () => void;
  onPull: () => void;
}

/**
 * One of the drawer's blades, fanned out by 20° each about its left end. Pulled
 * more than 50 pixels to the right, it acts; let go sooner, it springs back.
 */
export function Blade({ index, icon, label, x, y, onHover, onPull }: BladeProps) {
  const [hovered, setHovered] = useState(false);
  const [dragged, setDragged] = useState(0);
  const start = useRef<number | null>(null);

  function release(event: StagePointerEvent) {
    if (start.current !== null && event.screenX - start.current > pull) onPull();
    start.current = null;
    setDragged(0);
  }

  return (
    <Group
      x={x + dragged}
      y={y}
      width={120}
      height={40}
      originX={0}
      originY={0.5}
      transform={[translate(15, 0), rotate((index - 1) * 20)]}
      initial={{ transform: folded }}
      exit={{ transform: folded, opacity: 0 }}
      transition={{ x: motion.bladeDrag, transform: motion.blade, opacity: vanish }}
    >
      <Box
        width={120}
        height={40}
        radius={10}
        fill={palette.color3}
        border={{ width: hovered ? 2 : 1, color: hovered ? palette.foreground : palette.color1 }}
        flexDirection="row"
        justifyContent="center"
        alignItems="center"
        gap={8}
        transform={scale(hovered ? 1.15 : 1)}
        transition={{ default: instant, transform: motion.bladeHover }}
        cursor="grab"
        onPointerEnter={() => {
          setHovered(true);
          onHover();
        }}
        onPointerLeave={() => setHovered(false)}
        onPointerDown={(event) => {
          start.current = event.screenX;
        }}
        onPointerMove={(event) => {
          if (start.current !== null) setDragged(Math.max(0, event.screenX - start.current));
        }}
        onPointerUp={release}
      >
        <Text size={14} color={palette.foreground}>{icon}</Text>
        <Text size={13} weight="bold" color={palette.foreground}>{label}</Text>
      </Box>
    </Group>
  );
}
