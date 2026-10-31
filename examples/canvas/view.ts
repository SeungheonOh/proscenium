import { getCamera, type CameraMove, type OutputInfo, type Rectangle } from "proscenium";
import { barLayout } from "../components/bar/layout.js";

/** Below the bar: the part of OUTPUT windows are laid out in, in its own pixels. */
function usable(output: OutputInfo): Rectangle {
  return { x: 0, y: barLayout.reserve, width: output.width, height: output.height - barLayout.reserve };
}

/** The part of the canvas in view below the bar, from the camera as it is now. */
export function visibleArea(output: OutputInfo): Rectangle {
  const camera = getCamera(output.name) ?? { x: 0, y: 0, zoom: 1 };
  const u = usable(output);
  return {
    x: camera.x + (u.x - output.width / 2) / camera.zoom,
    y: camera.y + (u.y - output.height / 2) / camera.zoom,
    width: u.width / camera.zoom,
    height: u.height / camera.zoom,
  };
}

/** The same where the camera starts, the canvas lined up with the screen at 100%: page 0. */
export function homeArea(output: OutputInfo): Rectangle {
  return usable(output);
}

/** At 100%, near enough that the screen in view is a screen's worth of canvas. */
export function atActualSize(output: OutputInfo): boolean {
  return Math.abs((getCamera(output.name)?.zoom ?? 1) - 1) < 0.01;
}

/**
 * The camera that shows RECT whole below the bar, with a margin, no closer than
 * 100%: Sunlight's framing.
 */
export function framing(rect: Rectangle, output: OutputInfo, minZoom = 0.1): CameraMove {
  const padX = rect.width * 0.08 + 40;
  const padY = rect.height * 0.08 + 60;
  const padded = { x: rect.x - padX, y: rect.y - padY, width: rect.width + 2 * padX, height: rect.height + 2 * padY };
  const u = usable(output);
  const zoom = Math.max(minZoom, Math.min(1, u.width / padded.width, u.height / padded.height));
  // The camera centres on the whole output: shift so RECT lands in the middle of what's below the bar.
  const shift = (u.y + u.height / 2 - output.height / 2) / zoom;
  return { x: padded.x + padded.width / 2, y: padded.y + padded.height / 2 - shift, zoom };
}
