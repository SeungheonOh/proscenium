// The herdr world's UI scale. Everything the world draws on screen is laid out
// in UI units and drawn through one scale, so a 1.25 scale is a 125% zoom of
// the sidebar, header, tabs, notices and pages alike. Text rasterizes and
// pages render at the scale they are seen, so the zoom stays sharp, and a page
// lays itself out in fewer CSS pixels, as a browser's zoom does. Windows are
// placed in real pixels: `toScreen` turns a UI box into one.

import { createContext, useContext, type ReactNode } from "react";
import { Group, scale, Screen, type Rectangle, type Transition } from "proscenium";

export const scales = [0.75, 0.85, 1, 1.1, 1.25, 1.4, 1.6, 1.8, 2];

/** The next scale up or down from CURRENT, by one step. */
export function stepScale(current: number, by: 1 | -1): number {
  const at = scales.findIndex((candidate) => candidate >= current - 1e-6);
  const index = at < 0 ? scales.length - 1 : at;
  return scales[Math.max(0, Math.min(scales.length - 1, index + by))];
}

const UiScaleContext = createContext<{ scale: number; transition?: Transition }>({ scale: 1 });

export function UiScaleProvider({ value, transition, children }: {
  value: number;
  transition?: Transition;
  children: ReactNode;
}) {
  return <UiScaleContext.Provider value={{ scale: value, transition }}>{children}</UiScaleContext.Provider>;
}

export function useUiScale(): number {
  return useContext(UiScaleContext).scale;
}

/** A Screen whose children are in UI units. */
export function UiScreen({ output, children }: { output?: string; children?: ReactNode }) {
  const { scale: factor, transition } = useContext(UiScaleContext);
  return (
    <Screen output={output}>
      <Group originX={0} originY={0} transform={scale(factor)} transition={transition}>
        {children}
      </Group>
    </Screen>
  );
}

/** A box in UI units on an output at OFFSET, in real pixels. */
export function toScreen(box: Rectangle, factor: number, offset = 0): Rectangle {
  return { x: offset + box.x * factor, y: box.y * factor, width: box.width * factor, height: box.height * factor };
}
