// Where generated interfaces show, mode by mode, and how the person moves them
// between modes: drag one by its title bar and drop it on a screen edge to dock
// it, in a corner to pin it over everything, on the chat to take it back there,
// on "Pin to canvas" to leave it in the world, or anywhere else to float it.
//
// While dragged, the interface stays where it was, faded, and a live copy
// follows the pointer on the screen; the drop moves it, and the copy hands its
// place over to it (layoutId), so it glides from where it was let go.

import { useMemo, useRef, useState, type ReactNode } from "react";
import { Box, getCamera, Rect, Reserve, Screen, scale, Text } from "proscenium";
import { makeStyles, StyleSheet, Surface } from "proscenium/ui";
import type { HostSurface, UIHost } from "./host.js";
import type { Anchor, Mode, Place } from "./protocol.js";
import { SurfaceCard, type Grabbing } from "./SurfaceCard.js";

export interface Area {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Screenful {
  width: number;
  height: number;
  /** Clear of the bar along the top. */
  top: number;
  output?: string;
}

interface Drag {
  key: string;
  /** Where the pointer holds the card, from its top left, on the screen. */
  grabX: number;
  grabY: number;
  width: number;
  /** The pointer now, and where it went down. */
  x: number;
  y: number;
  fromX: number;
  fromY: number;
  /** Moved far enough to be a drag, not a click. */
  moving: boolean;
}

export interface Zone {
  mode: Mode;
  place: Place;
  label: string;
  /** What lights up. */
  area: Area;
}

const margin = 12;
const edge = 30;
const corner = 110;

/** What docks and the chat leave of the screen's width: where overlays sit. */
export function clearSpan(surfaces: readonly HostSurface[], screen: Screenful, chat: Area | null): { left: number; right: number } {
  const dock = (side: "left" | "right") => surfaces.filter((entry) => entry.mode === "dock" && entry.place.side === side)
    .reduce((most, entry) => Math.max(most, entry.width + margin), 0);
  return { left: margin + dock("left"), right: chat ? chat.x - margin : screen.width - margin - dock("right") };
}

/** Where a card dropped at (X, Y) would go, on SCREEN, with the chat at CHAT if it is open. */
function zoneAt(x: number, y: number, screen: Screenful, chat: Area | null, entry: HostSurface,
                grab: { x: number; y: number; width: number }, clear: { left: number; right: number }): Zone {
  const { width, height, top } = screen;
  const dockHeight = height - top - margin;
  // The pin is drawn over everything while dragging, the chat included, so it comes first.
  const pin = canvasTarget(screen);
  if (inside(x, y, pin)) return { mode: "canvas", place: {}, label: "Pin to canvas", area: pin };
  if (x < edge) return { mode: "dock", place: { side: "left" }, label: "Dock left",
                         area: { x: margin, y: top, width: 320, height: dockHeight } };
  if (x > width - edge) return { mode: "dock", place: { side: "right" }, label: "Dock right",
                                 area: { x: width - margin - 320, y: top, width: 320, height: dockHeight } };
  // Corners of what docks and the chat leave clear, where overlays sit.
  const anchors: [Anchor, boolean][] = [
    ["top-left", x < clear.left + corner && x >= clear.left - edge && y < top + corner],
    ["top-right", x > clear.right - corner && x <= clear.right + edge && y < top + corner],
    ["bottom-left", x < clear.left + corner && x >= clear.left - edge && y > height - corner],
    ["bottom-right", x > clear.right - corner && x <= clear.right + edge && y > height - corner],
  ];
  for (const [anchor, hit] of anchors) {
    if (!hit) continue;
    const left = anchor.endsWith("left");
    const upper = anchor.startsWith("top");
    return { mode: "overlay", place: { anchor }, label: "Pin over everything",
             area: { x: left ? clear.left : clear.right - 300, y: upper ? top : height - margin - 200, width: 300, height: 200 } };
  }
  if (chat && entry.agent && entry.message && inside(x, y, chat)) {
    return { mode: "inline", place: {}, label: "Back to the chat", area: chat };
  }
  return { mode: "floating", place: { x: Math.round(x - grab.x), y: Math.round(y - grab.y) }, label: "",
           area: { x: x - grab.x, y: y - grab.y, width: grab.width, height: 0 } };
}

function canvasTarget(screen: Screenful): Area {
  return { x: screen.width / 2 - 110, y: screen.height - 88, width: 220, height: 52 };
}

function inside(x: number, y: number, area: Area): boolean {
  return x >= area.x && y >= area.y && x <= area.x + area.width && y <= area.y + area.height;
}

/** Screen point (X, Y) in the world, through OUTPUT's camera. */
function toWorld(x: number, y: number, screen: Screenful): { x: number; y: number } {
  const camera = getCamera(screen.output);
  const zoom = camera?.zoom ?? 1;
  return { x: (camera?.x ?? screen.width / 2) + (x - screen.width / 2) / zoom,
           y: (camera?.y ?? screen.height / 2) + (y - screen.height / 2) / zoom };
}

/** The drag of an interface by its title bar, and the zone it would drop in. */
export function useGrabbing(host: UIHost, screen: Screenful, chat: Area | null, surfaces: readonly HostSurface[]) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const latest = useRef(drag);
  latest.current = drag;
  // What the handlers read, current without making them anew, so the cards that hold them need not render.
  const world = useRef({ host, screen, chat, surfaces });
  world.current = { host, screen, chat, surfaces };
  const entry = drag ? surfaces.find((surface) => surface.key === drag.key) : undefined;
  const zone = drag?.moving && entry ? zoneAt(drag.x, drag.y, screen, chat, entry,
                                              { x: drag.grabX, y: drag.grabY, width: drag.width },
                                              clearSpan(surfaces, screen, chat)) : null;
  const handlers = useMemo<Omit<Grabbing, "dragging">>(() => ({
    grab(key, event, size) {
      const scaleBy = size.scale ?? 1;
      const started: Drag = { key, grabX: Math.min(event.localX * scaleBy, size.width - 20), grabY: event.localY * scaleBy,
                              width: size.width, x: event.screenX, y: event.screenY, fromX: event.screenX,
                              fromY: event.screenY, moving: false };
      // Events can come faster than renders: keep what they see current at once.
      latest.current = started;
      setDrag(started);
    },
    move(event) {
      const now = latest.current;
      if (!now) return;
      const moving = now.moving || Math.hypot(event.screenX - now.fromX, event.screenY - now.fromY) > 5;
      latest.current = { ...now, x: event.screenX, y: event.screenY, moving };
      setDrag(latest.current);
    },
    release(event) {
      const now = latest.current;
      latest.current = null;
      setDrag(null);
      if (!now?.moving) return;
      const { host, screen, chat, surfaces } = world.current;
      const dropped = surfaces.find((surface) => surface.key === now.key);
      if (!dropped) return;
      const target = zoneAt(event.screenX, event.screenY, screen, chat, dropped,
                            { x: now.grabX, y: now.grabY, width: now.width }, clearSpan(surfaces, screen, chat));
      if (target.mode === "canvas") {
        // Dropped on the pin at the bottom, the card stays in view, as near to it as it fits.
        const left = Math.min(Math.max(event.screenX - now.grabX, margin), screen.width - now.width - margin);
        const top = Math.min(Math.max(event.screenY - now.grabY, screen.top), screen.height * 0.45);
        const at = toWorld(left, top, screen);
        host.place(now.key, "canvas", { x: Math.round(at.x), y: Math.round(at.y) });
      } else {
        host.place(now.key, target.mode, target.place);
      }
    },
  }), []);
  const dragging = drag?.moving ? drag.key : null;
  const grabbing = useMemo<Grabbing>(() => ({ ...handlers, dragging }), [handlers, dragging]);
  return { grabbing, drag: drag?.moving ? drag : null, zone, entry };
}

const useStyles = makeStyles(({ colors, motion, type }) => ({
  ...StyleSheet.create({
    dock: { position: "absolute", flexDirection: "column", gap: 10 },
    anchored: { position: "absolute", flexDirection: "column", gap: 10 },
    zone: { position: "absolute", radius: 16, fill: colors.accentSoft, border: { width: 2, color: colors.accentLine },
            transition: motion.pop, alignItems: "center", justifyContent: "center" },
    zoneLabel: { ...type.strong, color: colors.accent },
    pin: { position: "absolute", radius: 26, flexDirection: "row", alignItems: "center", justifyContent: "center",
           transition: motion.pop },
    scrim: { position: "absolute", x: 0, y: 0, fill: "#00000059" },
    dialog: { position: "absolute", x: 0, y: 0, flexDirection: "column", gap: 12, alignItems: "center",
              justifyContent: "center" },
  }),
  motion,
}));

const anchorLayout: Record<Anchor, { justifyContent: "flex-start" | "center" | "flex-end"; alignItems: "flex-start" | "center" | "flex-end" }> = {
  "top-left": { justifyContent: "flex-start", alignItems: "flex-start" },
  top: { justifyContent: "flex-start", alignItems: "center" },
  "top-right": { justifyContent: "flex-start", alignItems: "flex-end" },
  left: { justifyContent: "center", alignItems: "flex-start" },
  center: { justifyContent: "center", alignItems: "center" },
  right: { justifyContent: "center", alignItems: "flex-end" },
  "bottom-left": { justifyContent: "flex-end", alignItems: "flex-start" },
  bottom: { justifyContent: "flex-end", alignItems: "center" },
  "bottom-right": { justifyContent: "flex-end", alignItems: "flex-end" },
};

const arriving = { opacity: 0, transform: scale(0.96) };
const leaving = { opacity: 0, transform: scale(0.96) };

/**
 * A card's identity: while a copy of it is dragged the copy takes it, so the card
 * lands from wherever the copy is let go.
 */
export function identity(entry: HostSurface, dragging: string | null): string {
  return dragging === entry.key ? `genui-home:${entry.key}` : `genui:${entry.key}`;
}

/** A card's React key: a new node each time it is moved, which takes its place over from the dragged copy. */
function nodeKey(entry: HostSurface): string {
  return `${entry.key}:${entry.placed}`;
}

/** Interfaces pinned to the canvas: in the world, under the camera. */
export function WorldSurfaces({ surfaces, dragging, output }: { surfaces: readonly HostSurface[]; dragging: string | null;
                                                                output?: string }) {
  const styles = useStyles();
  const zoom = getCamera(output)?.zoom ?? 1;
  return surfaces.filter((entry) => entry.mode === "canvas").map((entry) => (
    <SurfaceCard key={nodeKey(entry)} entry={entry} chrome="full" dimmed={dragging === entry.key} scale={zoom}
                 frame={{ layoutId: identity(entry, dragging), x: entry.place.x ?? 0, y: entry.place.y ?? 0,
                          initial: arriving, exit: leaving, transition: styles.motion.glide }} />
  ));
}

interface ScreenSurfacesProps {
  surfaces: readonly HostSurface[];
  screen: Screenful;
  /** The open chat, which overlays keep clear of, as they do docks. */
  chat: Area | null;
  grab: ReturnType<typeof useGrabbing>;
  /** Drawn between the docks and the floating cards: the chat. */
  middle?: ReactNode;
}

/** Interfaces on the screen: docked, floating, pinned over everything and dialogs, and the one being dragged. */
export function ScreenSurfaces({ surfaces, screen, chat, grab, middle }: ScreenSurfacesProps) {
  const styles = useStyles();
  const dragging = grab.grabbing.dragging;
  const docked = (side: "left" | "right") => surfaces.filter((entry) => entry.mode === "dock" && entry.place.side === side);
  const left = docked("left");
  const right = docked("right");
  const dockWidth = (entries: readonly HostSurface[]) => entries.reduce((most, entry) => Math.max(most, entry.width), 0);
  const overlays = new Map<Anchor, HostSurface[]>();
  for (const entry of surfaces) {
    if (entry.mode !== "overlay") continue;
    const anchor = entry.place.anchor ?? "top-right";
    overlays.set(anchor, [...(overlays.get(anchor) ?? []), entry]);
  }
  const dialogs = surfaces.filter((entry) => entry.mode === "dialog");
  const { width, height, top } = screen;
  const glide = styles.motion.glide;
  // Overlays sit in what docks and the chat leave of the screen.
  const { left: clearLeft, right: clearRight } = clearSpan(surfaces, screen, chat);
  return (
    <>
      <Reserve output={screen.output} left={left.length ? dockWidth(left) + margin : 0}
               right={right.length ? dockWidth(right) + margin : 0} />
      <Screen output={screen.output}>
        {([["left", left], ["right", right]] as const).map(([side, entries]) => entries.length > 0 && (
          <Box key={side} style={styles.dock} x={side === "left" ? margin : width - margin - dockWidth(entries)}
               y={top} width={dockWidth(entries)} maxHeight={height - top - margin} transition={glide}>
            {entries.map((entry) => (
              <SurfaceCard key={nodeKey(entry)} entry={entry} chrome="full" width={dockWidth(entries)}
                           dimmed={dragging === entry.key}
                           frame={{ layoutId: identity(entry, dragging), initial: arriving, exit: leaving, transition: glide }} />
            ))}
          </Box>
        ))}
        {middle}
        {surfaces.filter((entry) => entry.mode === "floating").map((entry) => (
          <SurfaceCard key={nodeKey(entry)} entry={entry} chrome="full" dimmed={dragging === entry.key}
                       frame={{ layoutId: identity(entry, dragging), x: entry.place.x ?? 0, y: entry.place.y ?? 0,
                                initial: arriving, exit: leaving, transition: glide }} />
        ))}
        {[...overlays].map(([anchor, entries]) => (
          <Box key={anchor} style={styles.anchored} {...anchorLayout[anchor]} x={clearLeft} y={top}
               width={clearRight - clearLeft} height={height - top - margin} interactive={false} transition={glide}>
            {entries.map((entry) => (
              <SurfaceCard key={nodeKey(entry)} entry={entry} chrome="slim" dimmed={dragging === entry.key}
                           frame={{ layoutId: identity(entry, dragging), initial: arriving, exit: leaving, transition: glide }} />
            ))}
          </Box>
        ))}
        {dialogs.length > 0 && (
          <>
            {/* The backdrop takes presses, so the rest waits for an answer. */}
            <Rect style={styles.scrim} width={width} height={height} initial={{ opacity: 0 }} exit={{ opacity: 0 }}
                  transition={glide} onPointerDown={() => {}} />
            <Box style={styles.dialog} width={width} height={height} interactive={false}>
              {dialogs.map((entry) => (
                <SurfaceCard key={nodeKey(entry)} entry={entry} chrome="full"
                             frame={{ layoutId: `genui:${entry.key}`, initial: arriving, exit: leaving, transition: glide }} />
              ))}
            </Box>
          </>
        )}
        <DropZones grab={grab} screen={screen} />
      </Screen>
    </>
  );
}

function DropZones({ grab, screen }: { grab: ReturnType<typeof useGrabbing>; screen: Screenful }) {
  const styles = useStyles();
  const { drag, zone, entry } = grab;
  if (!drag || !entry) return null;
  const pin = canvasTarget(screen);
  const lit = zone && zone.mode !== "floating" ? zone : null;
  const onCanvas = zone?.mode === "canvas";
  return (
    <>
      {lit && lit.mode !== "canvas" && (
        <Box style={styles.zone} x={lit.area.x} y={lit.area.y} width={lit.area.width} height={lit.area.height}
             initial={{ opacity: 0 }} exit={{ opacity: 0 }} interactive={false}>
          <Text style={styles.zoneLabel}>{lit.label}</Text>
        </Box>
      )}
      <Surface variant={onCanvas ? "accent" : "glass"} style={styles.pin} x={pin.x} y={pin.y} width={pin.width}
               height={pin.height} initial={{ opacity: 0 }} exit={{ opacity: 0 }} interactive={false}>
        <Text style={styles.zoneLabel} color={onCanvas ? "#ffffff" : undefined}>Pin to canvas</Text>
      </Surface>
      <SurfaceCard entry={entry} chrome="full"
                   frame={{ layoutId: `genui:${entry.key}`, x: drag.x - drag.grabX, y: drag.y - drag.grabY,
                            transform: scale(1.02), opacity: 0.94, interactive: false }} />
    </>
  );
}
