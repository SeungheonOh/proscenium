/**
 * Paper on the canvas: drawings, made with Excalidraw, that lie on the canvas
 * under the windows and move with it.
 *
 * Put away, the paper is pictures only: a PNG of each element, placed where the
 * element is, so pans and zooms cost the drawings nothing and no browser runs.
 * Out (Super+P), an Excalidraw page lies on the canvas under the windows, over
 * the view and a small margin around it. While the camera moves, the page is
 * parked off the screen, where Chromium does not draw it, and the pictures show
 * every element, so a pan costs what it costs with the paper away; a picture
 * not yet up to date keeps the page out for that pan instead. Once the view
 * settles past the margin, or at another zoom, the page is laid again where the
 * view is, and the pictures stand in for it until it has drawn there.
 */

import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  getCamera,
  Group,
  Image,
  instant,
  moveCamera,
  scale,
  useCamera,
  usePersistentState,
  Web,
  type CameraInfo,
  type OutputInfo,
  type Rectangle,
} from "proscenium";
import { PaperDocument, type Drawing } from "./document.js";
import paperPage from "./page/index.tsx?url";
import { Inbox, type PaperMessage, type PaperProps, type Placement, type Style, type Tool } from "./wire.js";

/**
 * The page's margin around the view, a share of it on each side. Each frame the
 * page makes while the user draws costs Chromium its whole area; pans show the
 * pictures, and laying the page again costs one frame, so the margin need only
 * spare the smallest nudges that.
 */
const pageMargin = 0.05;
/** The page's pixels a side, at most; the browser helper's frames go to 4096. */
const pageSide = 4000;
/** Far enough off any view that the compositor neither draws the page nor sends it input. */
const parking = 1e7;
/** How long the camera stays put before the page is laid again. */
const settleDelay = 150;
/** The zoom change, as a ratio, that has the page drawn again at the new one. */
const rezoom = 1.15;
/** Excalidraw zooms no further out; the page covers more canvas instead. */
const pageMinZoom = 0.1;
/** How long the page has to hand over, and the pictures to load, before the paper goes ahead anyway. */
const handOverPatience = 2000;

/** Placements count on from the time, so a world started again never repeats one. */
let frames = Date.now();

interface PaperContextValue {
  output: OutputInfo | undefined;
  document: PaperDocument;
  /** Whether the paper is out, or wanted out. */
  out: boolean;
  setOut: (out: boolean) => void;
  tool: PaperProps["tool"];
  pickTool: (type: Tool) => void;
  style: PaperProps["style"];
  pickStyle: (style: Partial<Style>) => void;
  /** The page changed tools by its own keys. */
  toolChanged: (type: Tool) => void;
}

const PaperContext = createContext<PaperContextValue | null>(null);

export function usePaper(): PaperContextValue {
  const paper = useContext(PaperContext);
  if (!paper) throw new Error("usePaper needs a PaperProvider");
  return paper;
}

export function PaperProvider({ output, children }: { output: OutputInfo | undefined; children: ReactNode }) {
  const [document] = useState(() => new PaperDocument());
  const [out, setOut] = usePersistentState("canvas.paper.out", false);
  const [tool, setTool] = usePersistentState<PaperProps["tool"]>("canvas.paper.tool", {
    type: "freedraw",
    serial: 0,
  });
  const [style, setStyle] = usePersistentState<PaperProps["style"]>("canvas.paper.style", {
    stroke: "#1e1e1e",
    background: "transparent",
    width: 2,
    serial: 0,
  });
  useEffect(() => () => document.close(), [document]);

  // The same value until something in it changes, so the world's own renders, a window's drag
  // for one, leave the paper alone.
  const value = useMemo<PaperContextValue>(() => ({
    output,
    document,
    out,
    setOut,
    tool,
    pickTool: (type) => setTool((current) => ({ type, serial: current.serial + 1 })),
    style,
    pickStyle: (next) => setStyle((current) => ({ ...current, ...next, serial: current.serial + 1 })),
    toolChanged: (type) => setTool((current) => (current.type === type ? current : { ...current, type })),
  }), [output, document, out, setOut, tool, setTool, style, setStyle]);
  return <PaperContext.Provider value={value}>{children}</PaperContext.Provider>;
}

/** The page's size in its own pixels: the output's with the margin, as far as its frames allow. */
function pageSize(output: OutputInfo): { width: number; height: number } {
  const margin = Math.min(pageMargin, Math.max(0, (pageSide / (output.width * output.scale) - 1) / 2));
  return { width: Math.round(output.width * (1 + 2 * margin)), height: Math.round(output.height * (1 + 2 * margin)) };
}

/** Where the page lies for CAMERA: centered on it, at its zoom. */
function placementFor(camera: CameraInfo, size: { width: number; height: number }): Placement {
  const zoom = Math.max(camera.zoom, pageMinZoom);
  return {
    x: camera.x - size.width / 2 / zoom,
    y: camera.y - size.height / 2 / zoom,
    zoom,
    frame: ++frames,
  };
}

/** The canvas the page covers. */
function coverage(placement: Placement, size: { width: number; height: number }): Rectangle {
  return { x: placement.x, y: placement.y, width: size.width / placement.zoom, height: size.height / placement.zoom };
}

const within = (inner: Rectangle, outer: Rectangle) =>
  inner.x >= outer.x && inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

/** Whether LAID still does for CAMERA: the view within what the page covers, near the zoom it was laid at. */
function covers(laid: Laid, camera: CameraInfo, output: OutputInfo, size: { width: number; height: number }) {
  const view = {
    x: camera.x - output.width / 2 / camera.zoom,
    y: camera.y - output.height / 2 / camera.zoom,
    width: output.width / camera.zoom,
    height: output.height / camera.zoom,
  };
  const ratio = camera.zoom / laid.cameraZoom;
  return within(view, coverage(laid.placement, size)) && ratio < rezoom && ratio > 1 / rezoom;
}

/** A placement, and the camera zoom it was laid for. */
interface Laid {
  placement: Placement;
  cameraZoom: number;
}

/** The paper's pictures, and the page while the paper is out, on the canvas under the windows. */
export function PaperLayer() {
  const { output, document, out, setOut, tool, style, toolChanged } = usePaper();
  const drawings = useSyncExternalStore(document.subscribe, document.getDrawings);
  const fresh = useSyncExternalStore(document.subscribe, document.isFresh);
  const [session] = useState(() => Math.random().toString(36).slice(2));
  const [laid, setLaid] = useState<Laid | null>(null);
  const [framed, setFramed] = useState(-1);
  const [load, setLoad] = useState<PaperProps["load"]>(null);
  const [received, setReceived] = useState(0);
  const [flush, setFlush] = useState(0);
  const [flushed, setFlushed] = useState(0);
  // What waits for the page to hand over what it shows: laying it again, or taking it away.
  const [awaiting, setAwaiting] = useState<"relay" | "away" | null>(null);
  // The pictures the compositor has loaded; a count renders again as more come.
  const loadedPictures = useRef(new Set<string>()).current;
  const [, pictureCame] = useReducer((count: number) => count + 1, 0);
  const [impatient, setImpatient] = useState(false);
  const [gliding, setGliding] = useState(false);
  const inbox = useRef(new Inbox()).current;
  const parts = useRef<string[]>([]);

  const size = output ? pageSize(output) : { width: 0, height: 0 };
  // The page is there while it is laid, which lasts, after the paper is put away, until it has handed everything over.
  const shown = laid !== null && framed === laid.placement.frame;
  const picturesLoaded = drawings.every((drawing) => loadedPictures.has(drawing.src));
  const parked = gliding && shown && fresh && picturesLoaded && awaiting === null;
  const covered = useMemo(
    () => (shown && !parked ? coverage(laid.placement, size) : null),
    [shown, parked, laid, size.width, size.height],
  );
  // Until the page has handed over everything asked for, and the pictures are ready to stand in for it.
  const owed = !impatient && (flushed !== flush || !picturesLoaded);

  function lay() {
    const now = output && getCamera(output.name);
    if (now) setLaid({ placement: placementFor(now, size), cameraZoom: now.zoom });
  }

  function takeAway() {
    setLaid(null);
    setFramed(-1);
    setLoad(null);
  }

  /** Asks the page for everything it owes, so that the pictures can stand in for it, then does NEXT. */
  function handOver(next: "relay" | "away") {
    setImpatient(false);
    setFlush((count) => count + 1);
    setAwaiting(next);
  }

  // Out: lay the page where the view is. Put away: once it has handed everything over, take it off.
  useEffect(() => {
    if (out) {
      if (!laid) lay();
      else if (awaiting === "away") setAwaiting(null);
    } else if (laid) {
      if (framed === -1) takeAway();
      else handOver("away");
    }
  }, [out]);

  /** The camera settled: lay the page again if the view has left it. */
  function settled(camera: CameraInfo) {
    setGliding(false);
    if (!out || !laid || !output || covers(laid, camera, output, size)) return;
    if (shown) handOver("relay");
    else lay();
  }

  // What waits, once the page owes nothing.
  useEffect(() => {
    if (!awaiting) return;
    if (owed) {
      // A page that never answers, or a picture that never loads, does not hold the paper up for long.
      const timer = setTimeout(() => setImpatient(true), handOverPatience);
      return () => clearTimeout(timer);
    }
    setAwaiting(null);
    if (awaiting === "away") takeAway();
    else lay();
  }, [owed, awaiting]);

  function handle(message: PaperMessage) {
    switch (message.name) {
      case "hello":
        inbox.reset();
        setReceived(0);
        parts.current = document.parts();
        setLoad({ part: 0, parts: parts.current.length, data: parts.current[0]! });
        break;
      case "loaded": {
        const next = message.value + 1;
        const total = parts.current.length;
        setLoad(next < total ? { part: next, parts: total, data: parts.current[next]! } : null);
        break;
      }
      case "framed":
        setFramed(message.value);
        break;
      case "chunk": {
        const packet = inbox.take(message.value);
        setReceived(inbox.received);
        if (packet) void document.apply(packet);
        break;
      }
      case "wheel":
        if (output && laid) wheel(output, laid, message.value);
        break;
      case "look":
        // Excalidraw's zoom is the page's; the camera's differs where the page stops zooming out.
        if (output && laid) {
          const { x, y, zoom } = message.value;
          moveCamera({ x, y, zoom: zoom * (laid.cameraZoom / laid.placement.zoom) }, { output: output.name });
        }
        break;
      case "tool":
        toolChanged(message.value);
        break;
      case "flushed":
        setFlushed(message.value);
        break;
    }
  }

  const pictureLoaded = useCallback((src: string) => {
    loadedPictures.add(src);
    pictureCame();
  }, []);
  const pictureFailed = useCallback((drawing: Drawing) => document.lose(drawing.id, drawing.version), [document]);

  const props: PaperProps | null = laid && {
    session,
    placement: laid.placement,
    load,
    received,
    tool,
    style,
    flush,
  };

  return (
    <>
      {out && laid && output && (
        <Settling output={output.name} onMoved={() => setGliding(true)} onSettled={settled} />
      )}
      <Pictures
        drawings={drawings}
        covered={covered}
        onLoad={pictureLoaded}
        onError={pictureFailed}
      />
      {props && (
        <Group
          x={props.placement.x}
          y={props.placement.y + (parked ? parking : 0)}
          originX={0}
          originY={0}
          transform={scale(1 / props.placement.zoom)}
          transition={instant}
        >
          <Web
            src={paperPage}
            props={props}
            width={size.width}
            height={size.height}
            // Until it shows its placement, the page is all but transparent rather than hidden,
            // as a hidden page stops drawing; the pictures stand in for it meanwhile.
            opacity={shown ? 1 : 0.001}
            transition={instant}
            autoFocus
            onMessage={(name, value) => handle({ name, value } as PaperMessage)}
            onError={({ message }) => {
              console.error(`paper: ${message}`);
              setOut(false);
            }}
          />
        </Group>
      )}
    </>
  );
}

interface SettlingProps {
  output: string;
  /** The camera started moving. */
  onMoved: () => void;
  /** It has stayed put for a moment, here. */
  onSettled: (camera: CameraInfo) => void;
}

/** Follows OUTPUT's camera; it alone does, so a pan renders nothing else in the world. */
function Settling({ output, onMoved, onSettled }: SettlingProps) {
  const camera = useCamera(output);
  const latest = useRef({ onMoved, onSettled });
  latest.current = { onMoved, onSettled };
  const first = useRef(true);
  useEffect(() => {
    if (!camera) return;
    if (!first.current) latest.current.onMoved();
    first.current = false;
    const timer = setTimeout(() => latest.current.onSettled(camera), settleDelay);
    return () => clearTimeout(timer);
  }, [camera?.x, camera?.y, camera?.zoom]);
  return null;
}

/** The wheel over the page: a pan by screen pixels, or a zoom about the pointer. */
function wheel(output: OutputInfo, laid: Laid, { dx, dy, factor, x, y }: { dx: number; dy: number; factor: number;
                                                                           x: number; y: number }) {
  const camera = getCamera(output.name);
  if (!camera) return;
  const move = { output: output.name, transition: instant };
  if (factor === 1) {
    moveCamera({ x: camera.x + dx / camera.zoom, y: camera.y + dy / camera.zoom }, move);
    return;
  }
  // The canvas point under the pointer stays under it.
  const point = { x: laid.placement.x + x / laid.placement.zoom, y: laid.placement.y + y / laid.placement.zoom };
  const zoom = camera.zoom * factor;
  const keep = camera.zoom / zoom;
  moveCamera({ x: point.x - (point.x - camera.x) * keep, y: point.y - (point.y - camera.y) * keep, zoom }, move);
}

interface PicturesProps {
  drawings: readonly Drawing[];
  /** The canvas the page shows while it is out: the pictures there step aside. */
  covered: Rectangle | null;
  onLoad: (src: string) => void;
  onError: (drawing: Drawing) => void;
}

/** Each element's picture, bottom first. The pointer passes through them to the canvas. */
const Pictures = memo(function Pictures({ drawings, covered, onLoad, onError }: PicturesProps) {
  return (
    <Group interactive={false}>
      {drawings.map((drawing) => (
        <Image
          key={drawing.id}
          src={drawing.src}
          x={drawing.x}
          y={drawing.y}
          width={drawing.width}
          height={drawing.height}
          opacity={covered && within(drawing, covered) ? 0 : 1}
          interactive={false}
          onLoad={() => onLoad(drawing.src)}
          onError={() => onError(drawing)}
        />
      ))}
    </Group>
  );
});
