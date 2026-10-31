import { Group, Rect, Text, useCamera, type Rectangle, type Transition } from "proscenium";
import { colors, font } from "../lib/theme.js";

interface SelectionProps {
  /** Where each window shows now. */
  places: ReadonlyMap<number, Rectangle>;
  selected: ReadonlySet<number>;
  /** The box being drawn, or null. */
  box: Rectangle | null;
  /** Each stack, bottom first: its top window wears the count. */
  stacks: readonly (readonly number[])[];
  motionOf: (window: number) => Transition;
}

/**
 * The selection on the canvas: the box being drawn, an outline around each
 * selected window, and over each stack's top window a pill with how many
 * windows it holds. Sizes are screen sizes at any zoom.
 */
export function Selection({ places, selected, box, stacks, motionOf }: SelectionProps) {
  const zoom = useCamera()?.zoom ?? 1;
  const unit = 1 / zoom;
  const ring = 4 * unit;
  const pill = { width: 78 * unit, height: 24 * unit };
  return (
    <Group interactive={false}>
      {[...selected].map((id) => {
        const r = places.get(id);
        if (!r) return null;
        return (
          <Rect
            key={`selected-${id}`}
            x={r.x - ring}
            y={r.y - ring}
            width={r.width + 2 * ring}
            height={r.height + 2 * ring}
            radius={14 * unit}
            fill={`${colors.accent}14`}
            border={{ width: 2.5 * unit, color: colors.accent }}
            interactive={false}
            transition={motionOf(id)}
          />
        );
      })}
      {stacks.map((ids) => {
        const top = ids.at(-1)!;
        const r = places.get(top);
        if (!r) return null;
        return (
          <Group
            key={`stack-${ids.join("+")}`}
            x={r.x + r.width - pill.width}
            y={r.y - pill.height - 8 * unit}
            transition={motionOf(top)}
            interactive={false}
          >
            <Rect
              width={pill.width}
              height={pill.height}
              radius={pill.height / 2}
              fill={colors.ink}
              shadow={{ color: "#00000040", blur: 8 * unit, y: 2 * unit }}
              interactive={false}
            />
            <Text
              y={4 * unit}
              width={pill.width}
              align="center"
              font={font}
              size={12 * unit}
              weight={650}
              color="#ffffff"
              interactive={false}
            >
              {`Stack · ${ids.length}`}
            </Text>
          </Group>
        );
      })}
      {box && (
        <Rect
          {...box}
          fill={`${colors.accent}1f`}
          border={{ width: 1.5 * unit, color: colors.accent }}
          radius={3 * unit}
          interactive={false}
        />
      )}
    </Group>
  );
}
