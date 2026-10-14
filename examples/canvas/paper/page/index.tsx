/**
 * The canvas's paper, drawn with Excalidraw. While the paper is out, this page
 * lies on the canvas under the windows, over the view and a margin around it,
 * and draws the part of the canvas its placement covers; the compositor moves
 * it with the camera. When the world places it elsewhere, it draws there and
 * marks that frame with the placement's number, which its node waits for, so the
 * move and the drawing for it show together. Moving the view is the camera's
 * alone: wheel turns over the page, and the zooms of Excalidraw's own keys, go
 * to it.
 *
 * Changes go to the world, which keeps the document. When the paper is put
 * away, each element changed since is drawn on its own, for the world to show
 * as a picture; nothing is drawn so while the user draws.
 */

import "./fonts.js";
import "../../../node_modules/@excalidraw/excalidraw/dist/prod/index.css";
import "./paper.css";
import {
  CaptureUpdateAction,
  Excalidraw,
  exportToBlob,
  getCommonBounds,
  isInvisiblySmallElement,
  newElementWith,
  restoreElements,
} from "@excalidraw/excalidraw";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { send, tagFrames } from "proscenium/page";
import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  bytesToBase64,
  fromBase64,
  Outbox,
  tools,
  type Loaded,
  type PaperMessage,
  type PaperProps,
  type Placement,
  type SceneElement,
  type Tool,
} from "../wire.js";

/** How long after the last change the page sends what changed. */
const settleChanges = 160;
/** Pixels per canvas unit in an element's render: twice the screen's, sharp to 200%. */
const renderScale = () => Math.max(2, 2 * devicePixelRatio);
/** The largest render, in pixels a side and in all; the compositor decodes up to 4096 a side. */
const renderSide = 4096;
const renderPixels = 8e6;

type ExcalidrawElement = Parameters<typeof isInvisiblySmallElement>[0];

/** Only the drawing: the world has the toolbar, and keeps the document. */
const uiOptions = {
  canvasActions: {
    changeViewBackgroundColor: false,
    clearCanvas: false,
    export: false,
    loadScene: false,
    saveToActiveFile: false,
    toggleTheme: false,
    saveAsImage: false,
  },
  tools: { image: false },
} as const;

function tell(message: PaperMessage): void {
  send(message.name, "value" in message ? message.value : null);
}

/**
 * Excalidraw's laser trails look for collaborators' pointers on every animation
 * frame for as long as it is mounted, which keeps Chromium making frames with
 * nothing to draw. Nobody collaborates on the paper, so that loop stops; the
 * laser's own trail still starts and stops as it is used. The trails live on
 * Excalidraw's App component, reached through the fiber of its root element.
 */
function stopCollaboratorTrails(root: Element | null): void {
  const key = root && Object.keys(root).find((name) => name.startsWith("__reactFiber$"));
  type Fiber = { return: Fiber | null; stateNode: { laserTrails?: { stop(): void } } | null };
  for (let fiber = key ? ((root as never)[key] as Fiber) : null; fiber; fiber = fiber.return) {
    const trails = fiber.stateNode?.laserTrails;
    if (trails) return trails.stop();
  }
}

/** The page renders once before its first props arrive. */
export default function Page(props: Partial<PaperProps>) {
  return props.session ? <Paper {...(props as PaperProps)} /> : null;
}

/** Excalidraw's view showing CAMERA's world point at the middle of the page. */
function viewOf(placement: Placement) {
  return { scrollX: -placement.x, scrollY: -placement.y, zoom: { value: placement.zoom as never } };
}

function Paper({ session, placement, load, received, tool, style, flush }: PaperProps) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  // The document as the world last had it, and the session it came with.
  const [loaded, setLoaded] = useState<{ session: string; document: Loaded } | null>(null);
  const live = useRef({
    session: "",
    parts: [] as string[],
    /** Whether the scene holds a document yet. */
    filled: false,
    /** The version of each element the world has, and of each render. */
    known: new Map<string, number>(),
    rendered: new Map<string, number>(),
    /** Where the page last drew. */
    placement,
    /** Whether the page has said it is ready; before, view changes are Excalidraw settling in. */
    ready: false,
    tool: null as Tool | null,
    timer: null as ReturnType<typeof setTimeout> | null,
    rendering: null as Promise<void> | null,
  }).current;
  const [outbox] = useState(() => new Outbox((chunk) => tell({ name: "chunk", value: chunk })));

  // Each new world starts the conversation over.
  useEffect(() => {
    if (session === live.session) return;
    live.session = session;
    live.parts = [];
    outbox.reset();
    tell({ name: "hello", value: { fresh: !live.filled } });
  }, [session]);

  useEffect(() => {
    if (!load || load.part !== live.parts.length) return;
    live.parts.push(load.data);
    tell({ name: "loaded", value: load.part });
    if (live.parts.length < load.parts) return;
    const document = JSON.parse(fromBase64(live.parts.join(""))) as Loaded;
    live.parts = [];
    setLoaded({ session, document });
  }, [load?.part, load?.parts]);

  useEffect(() => outbox.confirm(received), [received]);

  // After Excalidraw's own mount, which started the trails.
  useEffect(() => {
    if (api) stopCollaboratorTrails(document.querySelector(".excalidraw-container"));
  }, [api]);

  /** Sends the elements that differ from what the world has. */
  function sync(api: ExcalidrawImperativeAPI): void {
    if (live.timer) clearTimeout(live.timer);
    live.timer = null;
    const put: SceneElement[] = [];
    const drop: string[] = [];
    const present = new Set<string>();
    for (const element of api.getSceneElementsIncludingDeleted()) {
      if (element.isDeleted) continue;
      present.add(element.id);
      if (live.known.get(element.id) === element.version) continue;
      put.push(element as unknown as SceneElement);
      live.known.set(element.id, element.version);
    }
    for (const id of live.known.keys()) {
      if (present.has(id)) continue;
      drop.push(id);
      live.known.delete(id);
      live.rendered.delete(id);
    }
    if (put.length || drop.length) outbox.push({ type: "elements", put, drop });
  }

  /**
   * Renders every element whose render the world lacks. A render holds up the
   * page for some 50 ms, so this waits for the paper to be put away rather than
   * coming between strokes.
   */
  function renderOwed(api: ExcalidrawImperativeAPI): Promise<void> {
    if (live.rendering) return live.rendering.then(() => renderOwed(api));
    live.rendering = (async () => {
      for (;;) {
        const element = api.getSceneElements().find((each) => live.rendered.get(each.id) !== each.version);
        if (!element) return;
        try {
          outbox.push({ type: "render", ...(await draw(element, api)) });
        } catch (error) {
          // An element Excalidraw cannot export keeps the picture it had.
          console.error(`paper: cannot render ${element.id}:`, error);
        }
        live.rendered.set(element.id, element.version);
      }
    })().finally(() => (live.rendering = null));
    return live.rendering;
  }

  // The document arrived: a page without one takes it; one with its own sends what differs.
  useEffect(() => {
    if (!api || !loaded || loaded.session !== live.session) return;
    const { elements, rendered } = loaded.document;
    live.known = new Map(elements.map((element) => [element.id, element.version]));
    live.rendered = new Map(Object.entries(rendered));
    if (!live.filled) {
      api.updateScene({
        elements: restoreElements(elements as never, null),
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      api.history.clear();
      live.filled = true;
    }
    sync(api);
  }, [api, loaded]);

  // The page draws where it is placed, once the document is in and at each new place, in one
  // frame with the place's number, so its node moves the moment that frame comes. Not in the
  // middle of a stroke or a word: the old place stays until the user lets go.
  const [placed, setPlaced] = useState(false);
  useEffect(() => {
    if (!api || !loaded) return;
    // Outside React's own work, so that flushSync can draw at once.
    let timer = setTimeout(function place() {
      const state = api.getAppState();
      if (state.cursorButton === "down" || state.editingTextElement || state.newElement) {
        timer = setTimeout(place, 100);
        return;
      }
      live.placement = placement;
      // Excalidraw draws the new view before the number goes on, both in this one task.
      flushSync(() => api.updateScene({ appState: viewOf(placement), captureUpdate: CaptureUpdateAction.NEVER }));
      tagFrames(placement.tag);
      tell({ name: "placed", value: placement.tag });
      setPlaced(true);
    });
    return () => clearTimeout(timer);
  }, [api, loaded, placement.tag, placement.x, placement.y, placement.zoom]);

  // Once the document is in and drawn where the page is placed, the page can show.
  useEffect(() => {
    if (!api || !loaded || !placed) return;
    let frames = 3;
    let request = requestAnimationFrame(function wait() {
      if (--frames > 0) request = requestAnimationFrame(wait);
      else {
        live.ready = true;
        tell({ name: "ready" });
      }
    });
    return () => cancelAnimationFrame(request);
  }, [api, loaded, placed]);

  // Excalidraw settles its tool once the scene is in, so the first pick waits for that.
  useEffect(() => {
    if (!api || !loaded) return;
    live.tool = tool.type;
    api.setActiveTool({ type: tool.type });
  }, [api, !loaded, tool.serial]);

  // The style is new elements', and with a new serial the selection's too.
  const styled = useRef(style.serial);
  useEffect(() => {
    if (!api) return;
    const state = api.getAppState();
    const restyle = styled.current !== style.serial;
    styled.current = style.serial;
    const changes = { strokeColor: style.stroke, backgroundColor: style.background, strokeWidth: style.width };
    const selected = state.selectedElementIds;
    api.updateScene({
      appState: {
        currentItemStrokeColor: style.stroke,
        currentItemBackgroundColor: style.background,
        currentItemStrokeWidth: style.width,
      },
      elements: restyle
        ? api.getSceneElementsIncludingDeleted().map((element) =>
            selected[element.id] ? newElementWith(element, changes as never) : element)
        : undefined,
      captureUpdate: restyle ? CaptureUpdateAction.IMMEDIATELY : CaptureUpdateAction.NEVER,
    });
  }, [api, style.serial]);

  // Before the paper is put away or moved, everything owed goes out; a page that started
  // since the world asked answers once it has the document.
  useEffect(() => {
    if (!api || !loaded || flush === 0) return;
    sync(api);
    void renderOwed(api)
      .then(() => outbox.drained())
      .then(() => tell({ name: "flushed", value: flush }));
  }, [api, !loaded, flush]);

  // Excalidraw's own panning, by its hand tool or by dragging with Space held, would follow
  // the pointer across a page that the camera moves under it; the canvas pans by itself.
  useEffect(() => {
    function key(event: KeyboardEvent) {
      const typing = event.target instanceof HTMLElement && event.target.closest("textarea, input");
      if (typing || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.code === "Space" || (event.key.toLowerCase() === "h" && !event.shiftKey)) event.stopPropagation();
    }
    addEventListener("keydown", key, { capture: true });
    return () => removeEventListener("keydown", key, { capture: true });
  }, []);

  // The wheel moves the canvas camera, not Excalidraw's view.
  useEffect(() => {
    function wheel(event: WheelEvent) {
      event.preventDefault();
      event.stopPropagation();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1;
      let dx = event.deltaX * unit;
      let dy = event.deltaY * unit;
      if (event.shiftKey && dx === 0) [dx, dy] = [dy, 0];
      const zoom = event.ctrlKey || event.metaKey;
      // The pointer on the canvas, as the page draws it now.
      const { x, y, zoom: scale } = live.placement;
      const point = { x: x + event.clientX / scale, y: y + event.clientY / scale };
      tell({
        name: "wheel",
        value: zoom ? { dx: 0, dy: 0, factor: Math.exp(-dy / 300), ...point } : { dx, dy, factor: 1, ...point },
      });
    }
    addEventListener("wheel", wheel, { capture: true, passive: false });
    return () => removeEventListener("wheel", wheel, { capture: true });
  }, []);

  function changed(_elements: unknown, state: AppState) {
    // Excalidraw's own tool changes, by its keys or after a shape is drawn, show on the toolbar.
    const type = state.activeTool.type as Tool;
    if (live.filled && type !== live.tool && tools.includes(type)) {
      live.tool = type;
      tell({ name: "tool", value: type });
    }
    if (!api || !live.filled) return;
    if (live.timer) clearTimeout(live.timer);
    live.timer = setTimeout(() => sync(api), settleChanges);
  }

  /** Excalidraw moved its view by itself: the camera goes there, and the page stays put. */
  function scrolled(scrollX: number, scrollY: number, zoom: { value: number }) {
    if (!api) return;
    const view = viewOf(live.placement);
    if (Math.abs(scrollX - view.scrollX) < 0.5 && Math.abs(scrollY - view.scrollY) < 0.5 &&
        Math.abs(zoom.value - live.placement.zoom) < 1e-4) {
      return;
    }
    // Excalidraw sets its view as it starts, after the page placed it: the placement stands.
    if (!live.ready) {
      api.updateScene({ appState: view, captureUpdate: CaptureUpdateAction.NEVER });
      return;
    }
    tell({
      name: "look",
      value: { x: innerWidth / 2 / zoom.value - scrollX, y: innerHeight / 2 / zoom.value - scrollY, zoom: zoom.value },
    });
    api.updateScene({ appState: view, captureUpdate: CaptureUpdateAction.NEVER });
  }

  // Excalidraw renders all of itself again whenever a prop is new, so its props stay the same
  // objects while the world's props come and go.
  const [initialData] = useState(() => ({
    appState: {
      ...viewOf(placement),
      viewBackgroundColor: "transparent",
      currentItemStrokeColor: style.stroke,
      currentItemBackgroundColor: style.background,
      currentItemStrokeWidth: style.width,
    },
    scrollToContent: false,
  }));
  const handlers = useRef({ changed, scrolled });
  handlers.current = { changed, scrolled };
  const onChange = useCallback((elements: unknown, state: AppState) => handlers.current.changed(elements, state), []);
  const onScrollChange = useCallback(
    (x: number, y: number, zoom: { value: number }) => handlers.current.scrolled(x, y, zoom),
    [],
  );

  return (
    <div className="paper">
      <Excalidraw
        excalidrawAPI={setApi}
        initialData={initialData}
        onChange={onChange}
        onScrollChange={onScrollChange}
        UIOptions={uiOptions}
        autoFocus
      />
    </div>
  );
}

/** ELEMENT drawn alone over its bounds and a margin for its stroke, as Excalidraw exports it. */
async function draw(element: ExcalidrawElement, api: ExcalidrawImperativeAPI) {
  const id = element.id;
  const version = element.version;
  if (isInvisiblySmallElement(element)) return { id, version, x: 0, y: 0, width: 0, height: 0, png: null };
  const [minX, minY, maxX, maxY] = getCommonBounds([element]);
  const padding = 6 + 2 * element.strokeWidth;
  const width = maxX - minX + 2 * padding;
  const height = maxY - minY + 2 * padding;
  const scale = Math.min(renderScale(), renderSide / Math.max(width, height), Math.sqrt(renderPixels / (width * height)));
  const blob = await exportToBlob({
    elements: [element],
    appState: { exportBackground: false, exportScale: scale, viewBackgroundColor: "transparent" },
    files: api.getFiles(),
    exportPadding: padding,
    mimeType: "image/png",
  });
  const png = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  return { id, version, x: minX - padding, y: minY - padding, width, height, png };
}
