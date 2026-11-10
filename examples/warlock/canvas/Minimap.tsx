/**
 * A map of an output's canvas in its bottom right corner, in Warlock's look:
 * every window the output shows and an outline of what is in view. It shows
 * only while it is of use: the view is away from home, or a window lies beyond it.
 */

import { instant, Rect, Screen, tween, type OutputInfo, type Rectangle } from "proscenium";
import { union } from "../../lib/geometry.js";
import { alpha, standardEasing, useWarlockTheme } from "../theme.js";
import { useFeedCamera, type CameraFeed } from "./CameraFeed.js";
import { atHome, middle, viewFrom } from "./view.js";

/** The map's size, its distance from the corner and the margin round what it shows, in screen pixels. */
const size = { width: 200, height: 128 };
const inset = 16;
const padding = 8;
const fade = tween(0.16, [...standardEasing]);

export interface MinimapProps {
  output: OutputInfo;
  /** Which of the outputs this is: its canvas lies that far along the world. */
  index: number;
  feed: CameraFeed;
  /** Where each window shows now, in the world. */
  places: ReadonlyMap<number, Rectangle>;
  focused: number | null;
  /** It fades in and out, and its marks follow what they show. */
  animated: boolean;
}

export function Minimap({ output, index, feed, places, focused, animated }: MinimapProps) {
  const theme = useWarlockTheme();
  const camera = useFeedCamera(feed);
  if (!camera) return null;

  const view = {
    x: camera.x - output.width / 2 / camera.zoom,
    y: camera.y - output.height / 2 / camera.zoom,
    width: output.width / camera.zoom,
    height: output.height / camera.zoom,
  };
  const beyond = (rect: Rectangle) => {
    const { x, y } = middle(rect);
    return x < view.x || y < view.y || x > view.x + view.width || y > view.y + view.height;
  };
  if (atHome(viewFrom(output, index, camera)) && ![...places.values()].some(beyond)) return null;

  const all = union([...places.values(), view])!;
  const scale = Math.min(
    (size.width - 2 * padding) / all.width,
    (size.height - 2 * padding) / all.height,
  );
  // What it shows sits in the middle of the map.
  const left = (size.width - all.width * scale) / 2;
  const top = (size.height - all.height * scale) / 2;
  const toMap = (box: Rectangle) => ({
    x: left + (box.x - all.x) * scale,
    y: top + (box.y - all.y) * scale,
    width: Math.max(2, box.width * scale),
    height: Math.max(2, box.height * scale),
  });
  const { palette, skin } = theme;
  const track = animated ? fade : instant;

  return (
    <Screen
      output={output.name}
      x={output.width - size.width - inset}
      y={output.height - size.height - inset}
      initial={animated ? { opacity: 0 } : undefined}
      exit={animated ? { opacity: 0 } : undefined}
      transition={fade}
    >
      <Rect
        {...size}
        radius={10}
        fill={skin.glassStrong}
        blur={theme.glass ? 18 : undefined}
        border={{ width: 1, color: skin.hairline }}
        shadow={theme.shadows.raised}
        interactive={false}
      />
      {[...places].map(([id, box]) => (
        <Rect
          key={id}
          {...toMap(box)}
          radius={1.5}
          fill={id === focused ? palette.brandText : alpha(palette.textSecondary, 0.55)}
          transition={track}
          interactive={false}
        />
      ))}
      <Rect
        {...toMap(view)}
        radius={2}
        border={{ width: 1.5, color: palette.text }}
        transition={track}
        interactive={false}
      />
    </Screen>
  );
}
