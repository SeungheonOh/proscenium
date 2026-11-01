/**
 * Paper on the canvas: drawings, made with Excalidraw, that lie on the canvas
 * under the windows and move with it.
 *
 * Out (Super+P), an Excalidraw page lies on the canvas under the windows, over
 * the view and a wide margin around it, and the compositor moves it with the
 * camera, so pans and zooms neither redraw it nor leave it behind. Only once the
 * view nears the edge of what it covers, or the zoom strays from the page's by
 * `rezoom`, is it placed again where the view is; the compositor shows each of
 * the page's frames where it was drawn for (`frameTag`), so the move shows as
 * one frame. See docs/DESIGN.md, "Pages that draw the canvas".
 * Put away, the paper is pictures only: a PNG of each element, placed where the
 * element is, so pans and zooms cost the drawings nothing and no browser runs.
 * The pictures stand in while the page loads, and the page hands over every
 * picture it owes before it goes.
 */

import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
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
} from "proscenium";
import { PaperDocument, type Drawing } from "./document.js";
import paperPage from "./page/index.tsx?url";
import {
  Inbox,
  type PaperMessage,
  type PaperProps,
  type Placement,
  type Style,
  type Tool,
  type Wheel,
} from "./wire.js";

/** How long the page has to hand over, and the pictures to load, before the paper goes ahead anyway. */
const handOverPatience = 2000;
/** The page's pixels a side, at most; the browser helper's frames go to 4096. */
const pageSide = 4000;
/** The page's margin around the view, a share of it on each side, as far as its pixels allow. */
const pageMargin = 0.4;
/** The page is placed again once the view comes within this share of itself of the page's edge. */
const nearEdge = 0.1;
/**
 * A zoom this far from the page's has the page drawn again at the new one. Within an eighth
 * the page stays inside the 15% by which the compositor would raster it again at the scale
 * it is seen at, a whole redraw that can show one frame at the old size; wider lays it again
 * less often.
 */
const rezoom = 1.3;

/** Placements are numbered 1 to 4095, from anywhere, so a world started again repeats none at once. */
let tags = Math.floor(Math.random() * 4095);

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

interface PaperProviderProps {
  output: OutputInfo | undefined;
  /** What the paper's settings are kept under, and the folder its drawings are kept in. */
  name?: string;
  folder?: string;
  children: ReactNode;
}

export function PaperProvider({ output, name = "canvas.paper", folder = "paper", children }: PaperProviderProps) {
  const [document] = useState(() => new PaperDocument(folder));
  const [out, setOut] = usePersistentState(`${name}.out`, false);
  const [tool, setTool] = usePersistentState<PaperProps["tool"]>(`${name}.tool`, {
    type: "freedraw",
    serial: 0,
  });
  const [style, setStyle] = usePersistentState<PaperProps["style"]>(`${name}.style`, {
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

/** Where the page lies for CAMERA: centered on it, at its zoom, with a new number. */
function placementFor(camera: CameraInfo, size: { width: number; height: number }): Placement {
  tags = (tags % 4095) + 1;
  return {
    x: camera.x - size.width / 2 / camera.zoom,
    y: camera.y - size.height / 2 / camera.zoom,
    zoom: camera.zoom,
    tag: tags,
  };
}

/** Whether PLACEMENT still does for CAMERA: the view, and a little around it, within the page, near its zoom. */
function covers(
  placement: Placement,
  camera: CameraInfo,
  output: OutputInfo,
  size: { width: number; height: number },
): boolean {
  const width = (output.width / camera.zoom) * (1 + 2 * nearEdge);
  const height = (output.height / camera.zoom) * (1 + 2 * nearEdge);
  const left = camera.x - width / 2;
  const top = camera.y - height / 2;
  const ratio = camera.zoom / placement.zoom;
  return left >= placement.x && top >= placement.y &&
    left + width <= placement.x + size.width / placement.zoom &&
    top + height <= placement.y + size.height / placement.zoom &&
    ratio < rezoom && ratio > 1 / rezoom;
}

/** The paper's pictures, and the page while the paper is out, under the windows. */
export function PaperLayer() {
  const { output, document, out, setOut, tool, style, toolChanged } = usePaper();
  const drawings = useSyncExternalStore(document.subscribe, document.getDrawings);
  const [session] = useState(() => Math.random().toString(36).slice(2));
  // Where the page lies while the paper is out, and after, until it has handed everything over.
  const [placement, setPlacement] = useState<Placement | null>(null);
  // The placement the page last drew at; it is placed again only once it has drawn the last.
  const [placed, setPlaced] = useState(0);
  // The page shows the document where it lies, so the pictures step aside.
  const [ready, setReady] = useState(false);
  const [load, setLoad] = useState<PaperProps["load"]>(null);
  const [received, setReceived] = useState(0);
  const [flush, setFlush] = useState(0);
  const [flushed, setFlushed] = useState(0);
  const [handing, setHanding] = useState(false);
  // The pictures the compositor has loaded.
  const [loadedPictures, setLoadedPictures] = useState<ReadonlySet<string>>(() => new Set());
  const [impatient, setImpatient] = useState(false);
  const [inbox] = useState(() => new Inbox());
  const parts = useRef<string[]>([]);

  const size = output ? pageSize(output) : { width: 0, height: 0 };
  const picturesLoaded = drawings.every((drawing) => loadedPictures.has(drawing.src));
  // Until the page has handed over everything asked for, and the pictures are ready to stand in for it.
  const owed = !impatient && (flushed !== flush || !picturesLoaded);

  /**
   * Places the page where CAMERA looks, while the paper is out, unless the page has yet to draw
   * where it was last placed.
   */
  function follow(camera = output && getCamera(output.name)) {
    if (!out || !camera || !output) return;
    if (placement && (placed !== placement.tag || covers(placement, camera, output, size))) return;
    setPlacement(placementFor(camera, size));
  }

  function takeAway() {
    setPlacement(null);
    setReady(false);
    setLoad(null);
    setHanding(false);
  }

  // Out: the page comes. Put away: once it has handed everything over, it goes.
  const outChanged = useEffectEvent((out: boolean) => {
    if (out) {
      if (!placement) follow();
      setHanding(false);
      return;
    }
    if (!placement) return;
    if (!ready) {
      takeAway();
      return;
    }
    setImpatient(false);
    setFlush((count) => count + 1);
    setHanding(true);
  });
  useEffect(() => {
    outChanged(out);
  }, [out]);

  // Once the page has drawn where it lies, the camera may have gone on past it.
  const drew = useEffectEvent(() => follow());
  useEffect(() => {
    drew();
  }, [placed]);

  useEffect(() => {
    if (!handing) return;
    if (!owed) {
      takeAway();
      return;
    }
    // A page that stops answering, or a picture that never loads, does not hold the paper up
    // for long; one still sending its renders is waited for.
    const timer = setTimeout(() => setImpatient(true), handOverPatience);
    return () => clearTimeout(timer);
  }, [owed, handing, received]);

  function handle(message: PaperMessage) {
    switch (message.name) {
      case "hello":
        inbox.reset();
        setReceived(0);
        setReady(false);
        parts.current = document.parts();
        setLoad({ part: 0, parts: parts.current.length, data: parts.current[0]! });
        break;
      case "loaded": {
        const next = message.value + 1;
        const total = parts.current.length;
        setLoad(next < total ? { part: next, parts: total, data: parts.current[next]! } : null);
        break;
      }
      case "ready":
        setReady(true);
        break;
      case "placed":
        setPlaced(message.value);
        break;
      case "chunk": {
        const packet = inbox.take(message.value);
        setReceived(inbox.received);
        if (packet) void document.apply(packet);
        break;
      }
      case "wheel":
        if (output) wheel(output, message.value);
        break;
      case "look":
        if (output) moveCamera(message.value, { output: output.name });
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
    setLoadedPictures((loaded) => (loaded.has(src) ? loaded : new Set(loaded).add(src)));
  }, []);
  const pictureFailed = useCallback((drawing: Drawing) => document.lose(drawing.id, drawing.version), [document]);

  return (
    <>
      <Pictures drawings={drawings} hidden={ready} onLoad={pictureLoaded} onError={pictureFailed} />
      {placement && output && (
        <>
          {out && <Watching output={output.name} onCamera={follow} />}
          <Group
            x={placement.x}
            y={placement.y}
            originX={0}
            originY={0}
            transform={scale(1 / placement.zoom)}
            transition={instant}
          >
            <Web
              src={paperPage}
              props={{ session, placement, load, received, tool, style, flush } satisfies PaperProps}
              frameTag={placement.tag}
              width={size.width}
              height={size.height}
              // Until it is ready the page is all but transparent rather than hidden, as a
              // hidden page stops drawing; the pictures stand in for it meanwhile.
              opacity={ready ? 1 : 0.001}
              transition={instant}
              autoFocus
              onMessage={(name, value) => handle({ name, value } as PaperMessage)}
              onError={({ message }) => {
                console.error(`paper: ${message}`);
                setOut(false);
              }}
            />
          </Group>
        </>
      )}
    </>
  );
}

/** Hears where OUTPUT's camera is headed each time that changes; it alone renders that often. */
function Watching({ output, onCamera }: { output: string; onCamera: (camera: CameraInfo) => void }) {
  const camera = useCamera(output);
  const cameraMoved = useEffectEvent(onCamera);
  useEffect(() => {
    if (camera) cameraMoved(camera);
  }, [camera]);
  return null;
}

/** The wheel over the page: a pan by screen pixels, or a zoom about the canvas point (x, y). */
function wheel(output: OutputInfo, { dx, dy, factor, x, y }: Wheel) {
  const camera = getCamera(output.name);
  if (!camera) return;
  const move = { output: output.name, transition: instant };
  if (factor === 1) {
    moveCamera({ x: camera.x + dx / camera.zoom, y: camera.y + dy / camera.zoom }, move);
    return;
  }
  // The canvas point under the pointer stays under it.
  const zoom = camera.zoom * factor;
  const keep = camera.zoom / zoom;
  moveCamera({ x: x - (x - camera.x) * keep, y: y - (y - camera.y) * keep, zoom }, move);
}

interface PicturesProps {
  drawings: readonly Drawing[];
  /** While the page shows the drawing, the pictures step aside. */
  hidden: boolean;
  onLoad: (src: string) => void;
  onError: (drawing: Drawing) => void;
}

/** Each element's picture, bottom first. The pointer passes through them to the canvas. */
const Pictures = memo(function Pictures({ drawings, hidden, onLoad, onError }: PicturesProps) {
  return (
    <Group interactive={false} opacity={hidden ? 0 : 1} transition={instant}>
      {drawings.map((drawing) => (
        <Image
          key={drawing.id}
          src={drawing.src}
          x={drawing.x}
          y={drawing.y}
          width={drawing.width}
          height={drawing.height}
          interactive={false}
          onLoad={() => onLoad(drawing.src)}
          onError={() => onError(drawing)}
        />
      ))}
    </Group>
  );
});
