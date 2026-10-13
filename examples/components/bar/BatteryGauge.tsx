import { Group, Rect } from "proscenium";
import { colors, motion } from "../../lib/theme.js";

const outline = "#17171aa6";

interface BatteryGaugeProps {
  percent: number;
  charging: boolean;
}

/** A small battery drawn with rectangles; its fill springs to the charge. */
export function BatteryGauge({ percent, charging }: BatteryGaugeProps) {
  const fill = charging ? colors.accent : percent <= 15 ? colors.danger : colors.ink;
  return (
    <Group width={24} height={12}>
      <Rect width={21} height={12} radius={3.5} border={{ width: 1.2, color: outline }} />
      <Rect x={21.6} y={4} width={1.8} height={4} radius={0.9} fill={outline} />
      <Rect
        x={2.3}
        y={2.3}
        width={Math.max(1.5, (16.4 * percent) / 100)}
        height={7.4}
        radius={2}
        fill={fill}
        transition={motion.glide}
      />
    </Group>
  );
}
