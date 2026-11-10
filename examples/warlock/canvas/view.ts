/**
 * The view of an output's canvas. Every output has a canvas of its own, a
 * stretch of the world far from the others', so no camera sees another
 * output's windows; what the world keeps (window rectangles, views) is free of
 * that offset, which is added and taken away here. A view is where the camera
 * is from home: the home page filling the screen at 100%.
 */

import { getCamera, moveCamera, type Motion, type OutputInfo, type Rectangle } from "proscenium";
import { pageAt } from "../geometry.js";
import type { Page, View } from "../state.js";

/** How far apart the canvases of two outputs lie in the world. */
export const canvasStride = 200000;
/** How far the canvas zooms out and in. */
export const zoomRange = { min: 0.1, max: 2 };

export const homeView: View = { x: 0, y: 0, zoom: 1 };

export interface Point {
  x: number;
  y: number;
}

/** A camera as the compositor has it: the world point at the middle of the screen, and the zoom. */
export interface WorldCamera extends Point {
  zoom: number;
}

/** Where the canvas of the output at INDEX begins in the world. */
export function canvasOffset(index: number): Point {
  return { x: 0, y: index * canvasStride };
}

/** A rectangle of the canvas at OFFSET, in the world. */
export function toWorld(rect: Rectangle, offset: Point): Rectangle {
  return offset.x === 0 && offset.y === 0
    ? rect
    : { ...rect, x: rect.x + offset.x, y: rect.y + offset.y };
}

/** A rectangle of the world, on the canvas at OFFSET. */
export function toCanvas(rect: Rectangle, offset: Point): Rectangle {
  return offset.x === 0 && offset.y === 0
    ? rect
    : { ...rect, x: rect.x - offset.x, y: rect.y - offset.y };
}

/** The camera that shows VIEW on the output at INDEX. */
export function cameraFor(output: OutputInfo, index: number, view: View): WorldCamera {
  const offset = canvasOffset(index);
  return {
    x: offset.x + output.width / 2 + view.x,
    y: offset.y + output.height / 2 + view.y,
    zoom: view.zoom,
  };
}

/** The view CAMERA gives the output at INDEX. */
export function viewFrom(output: OutputInfo, index: number, camera: WorldCamera): View {
  const offset = canvasOffset(index);
  return {
    x: camera.x - offset.x - output.width / 2,
    y: camera.y - offset.y - output.height / 2,
    zoom: camera.zoom,
  };
}

/** Cameras this world just moved, by output: the compositor reports them back a moment later. */
const sent = new Map<string, { camera: WorldCamera; at: number }>();
/** How long a camera this world moved stands in for the compositor's report of it, in milliseconds. */
const echoTime = 120;

/** Where the camera of the output at INDEX is headed. Read when an action runs: nothing here subscribes to it. */
export function viewOf(output: OutputInfo, index: number): View {
  const mine = sent.get(output.name);
  const camera =
    mine && performance.now() - mine.at < echoTime ? mine.camera : getCamera(output.name);
  return camera ? viewFrom(output, index, camera) : homeView;
}

/** Move the camera of the output at INDEX to VIEW, by the camera's own transition unless one is given. */
export function moveView(output: OutputInfo, index: number, view: View, transition?: Motion): void {
  const zoom = Math.min(Math.max(view.zoom, zoomRange.min), zoomRange.max);
  const camera = cameraFor(output, index, { ...view, zoom });
  sent.set(output.name, { camera, at: performance.now() });
  moveCamera(camera, transition ? { output: output.name, transition } : { output: output.name });
}

/** The part of the canvas VIEW shows on the whole screen. */
export function shownArea(output: OutputInfo, view: View): Rectangle {
  return shownPart(output, view, { x: 0, y: 0, width: output.width, height: output.height });
}

/** The part of the canvas VIEW shows in the work area, clear of the taskbar. */
export function shownWorkArea(output: OutputInfo, view: View): Rectangle {
  return shownPart(output, view, output.workArea);
}

function shownPart(output: OutputInfo, view: View, part: Rectangle): Rectangle {
  return {
    x: output.width / 2 + view.x + (part.x - output.width / 2) / view.zoom,
    y: output.height / 2 + view.y + (part.y - output.height / 2) / view.zoom,
    width: part.width / view.zoom,
    height: part.height / view.zoom,
  };
}

/** At 100%, near enough that a page fills the screen. */
export function atActualSize(view: View): boolean {
  return Math.abs(view.zoom - 1) < 0.02;
}

/** At home: the home page filling the screen, as the desktop starts. */
export function atHome(view: View): boolean {
  return atActualSize(view) && Math.abs(view.x) < 1 && Math.abs(view.y) < 1;
}

/** The page under the middle of the screen. */
export function pageInView(output: OutputInfo, view: View): Page {
  return pageAt(output, output.width / 2 + view.x, output.height / 2 + view.y);
}

/** The view with PAGE filling the screen. */
export function pageView(output: OutputInfo, [column, row]: Page): View {
  return { x: column * output.width, y: row * output.height, zoom: 1 };
}

/** The view with RECT in the middle of the work area at 100%. */
export function centredOn(output: OutputInfo, rect: Rectangle): View {
  return framing(output, rect, 1);
}

/** The view that shows all of RECT in the work area with a margin, no closer than 100%. */
export function fitting(output: OutputInfo, rect: Rectangle): View {
  const area = output.workArea;
  const fit =
    0.9 * Math.min(area.width / Math.max(rect.width, 1), area.height / Math.max(rect.height, 1));
  return framing(output, rect, Math.min(1, Math.max(zoomRange.min, fit)));
}

/** The view at ZOOM with the middle of RECT in the middle of the work area. */
function framing(output: OutputInfo, rect: Rectangle, zoom: number): View {
  const area = output.workArea;
  return {
    x:
      rect.x +
      rect.width / 2 -
      output.width / 2 -
      (area.x + area.width / 2 - output.width / 2) / zoom,
    y:
      rect.y +
      rect.height / 2 -
      output.height / 2 -
      (area.y + area.height / 2 - output.height / 2) / zoom,
    zoom,
  };
}

/** Whether all of INNER lies in OUTER. */
export function inside(outer: Rectangle, inner: Rectangle): boolean {
  return (
    inner.x >= outer.x - 0.5 &&
    inner.y >= outer.y - 0.5 &&
    inner.x + inner.width <= outer.x + outer.width + 0.5 &&
    inner.y + inner.height <= outer.y + outer.height + 0.5
  );
}

export function middle(rect: Rectangle): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}
