import type { ReactNode } from "react";
import { Group, scale, useCamera, type Transition } from "proscenium";

/** One screen pixel in canvas units, so lines and rings on the canvas keep their width at any zoom. */
export function useScreenPixel(): number {
  return 1 / (useCamera()?.zoom ?? 1);
}

interface ScreenSizedProps {
  /** The canvas point the children's origin sits on. */
  x: number;
  y: number;
  transition?: Transition;
  children: ReactNode;
}

/**
 * Children pinned to a canvas point but drawn at screen size: a badge or a
 * label laid out in plain pixels that stays the same size as the canvas zooms.
 */
export function ScreenSized({ x, y, transition, children }: ScreenSizedProps) {
  const pixel = useScreenPixel();
  return (
    <Group x={x} y={y} originX={0} originY={0} transform={scale(pixel)} transition={transition}>
      {children}
    </Group>
  );
}
