import { Group, Rect, useCamera, type Rectangle, type Transition } from "proscenium";
import { bounds, type Pole } from "./magnetism.js";
import { groups, tint, type Grouping } from "./polarity.js";

/** The group outline's colour: neither pole's, so a mixed group reads as one. */
const bondColor = "#7c5cff";
/** Badge diameter and the outline's offset from the windows, on screen. */
const badge = 22;
const outlineGap = 7;

interface PolesProps {
  /** Where each window shows now. */
  places: ReadonlyMap<number, Rectangle>;
  poleOf: (window: number) => Pole;
  grouping: Grouping;
  motionOf: (window: number) => Transition;
  onFlip: (window: number) => void;
}

/**
 * With polarity on: each window's pole as a badge on its top-left corner,
 * red ⊕ or blue ⊖, which flips when clicked, and an outline around every
 * bonded group. Sizes are screen sizes at any zoom.
 */
export function Poles({ places, poleOf, grouping, motionOf, onFlip }: PolesProps) {
  const zoom = useCamera()?.zoom ?? 1;
  const unit = 1 / zoom;
  const size = badge * unit;
  const bar = { long: 10 * unit, thick: 2.4 * unit };
  return (
    <Group>
      {groups(grouping).map((ids) => {
        const rects = ids.flatMap((id) => places.get(id) ?? []);
        if (rects.length < 2) return null;
        const b = bounds(rects);
        const d = outlineGap * unit;
        return (
          <Rect
            key={ids.join("+")}
            x={b.x - d}
            y={b.y - d}
            width={b.width + 2 * d}
            height={b.height + 2 * d}
            radius={16 * unit}
            border={{ width: 3 * unit, color: bondColor }}
            interactive={false}
            transition={motionOf(ids[0]!)}
          />
        );
      })}
      {[...places].map(([id, r]) => {
        const pole = poleOf(id);
        return (
          <Group
            key={id}
            x={r.x - size / 2}
            y={r.y - size / 2}
            width={size}
            height={size}
            transition={motionOf(id)}
            cursor="pointer"
            onPointerDown={() => onFlip(id)}
          >
            <Rect
              width={size}
              height={size}
              radius={size / 2}
              fill={tint[pole]}
              border={{ width: 1.5 * unit, color: "#ffffff" }}
              shadow={{ color: "#00000040", blur: 6 * unit, y: 2 * unit }}
            />
            <Rect
              x={(size - bar.long) / 2}
              y={(size - bar.thick) / 2}
              width={bar.long}
              height={bar.thick}
              radius={bar.thick / 2}
              fill="#ffffff"
              interactive={false}
            />
            {pole === "plus" && (
              <Rect
                x={(size - bar.thick) / 2}
                y={(size - bar.long) / 2}
                width={bar.thick}
                height={bar.long}
                radius={bar.thick / 2}
                fill="#ffffff"
                interactive={false}
              />
            )}
          </Group>
        );
      })}
    </Group>
  );
}
