import { useState } from "react";
import { Group, Text, type Color } from "proscenium";

interface MarqueeProps {
  text: string;
  x: number;
  y: number;
  /** Wider text scrolls; narrower text sits still. */
  maxWidth: number;
  font: string;
  size: number;
  color: Color;
  scrolling: boolean;
}

/** The original's marquee: text that scrolls by, two seconds' pause each round, when it does not fit. */
export function Marquee({ text, x, y, maxWidth, font, size, color, scrolling }: MarqueeProps) {
  const [measured, setMeasured] = useState({ width: 0, height: 0, gap: 0 });
  const wide = measured.width > maxWidth;
  // A round: the pause, then the width of the text and three spaces at 50 ms a pixel.
  const distance = measured.width + measured.gap;
  const duration = 2 + distance * 0.05;
  const line = (at: number, onMeasure?: (width: number, height: number) => void) => (
    <Text x={at} font={font} size={size} color={color} interactive={false}
          onMeasure={onMeasure && ((event) => onMeasure(event.width, event.height))}>{text}</Text>
  );
  return (
    <Group x={x} y={y} width={Math.min(maxWidth, measured.width)} height={measured.height} clip interactive={false}>
      <Group animate={wide && scrolling ? { x: [0, 0, -distance], offsets: [0, 2 / duration, 1], duration,
                                            ease: "linear", iterations: Infinity, key: `${text}` } : undefined}>
        {line(0, (width, height) => setMeasured((current) => ({ ...current, width, height })))}
        {wide && line(distance)}
      </Group>
      <Text x={-1000} font={font} size={size} interactive={false}
            onMeasure={(event) => setMeasured((current) => ({ ...current, gap: event.width }))}>{"   "}</Text>
    </Group>
  );
}
