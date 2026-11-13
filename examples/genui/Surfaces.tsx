// Where generated interfaces show, mode by mode, and how the person moves them
// between modes: drag one by its title bar and drop it on a screen edge to dock
// it, in a corner to pin it over everything, on the chat to take it back there,
// on "Pin to canvas" to leave it in the world, or anywhere else to float it.
//
// While dragged, the interface stays where it was, faded, and a live copy
// follows the pointer on the screen; the drop moves it, and the copy hands its
// place over to it (layoutId), so it glides from where it was let go. Docks,
// corners and dialogs lay their cards out in boxes whose origin is the screen's,
// so a card's place in its box is its place on the screen, which is what the copy
// hands over. A card pinned to the canvas lands in the world, under the camera,
// where screen places mean nothing, and so does one dropped back in the chat: the copy fades
// away and the card fades in.

import { useMemo, useRef, useState, type ReactNode } from "react";
import { Box, getCamera, instant, Rect, Reserve, Screen, scale, Text, type StagePointerEvent } from "proscenium";
import { makeStyles, StyleSheet, Surface } from "proscenium/ui";
import { barLayout } from "../components/bar/layout.js";
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
  /** How tall it is on the screen. */
  height: number;
  /** The pointer now, and where it went down. */
  x: number;
  y: number;
  fromX: number;
  fromY: number;
  /** Moved far enough to be a drag, not a click. */
  moving: boolean;
  /**
   * For a card pinned to the canvas: carried in the world rather than lifted onto the screen.
   * Where it is now, the pointer's offset from it, and whether it stays on the canvas whatever
   * it is let go over (Super+drag, as windows move) rather than docking on an edge or corner.
   */
  world?: { x: number; y: number; dx: number; dy: number; free: boolean };
}

/** What a world's Super+drag hands a card pinned to the canvas, so it moves as windows do. */
export interface CanvasCarry {
  /** Pick up the card under the pointer, if there is one: false leaves the press to the world. */
  carry(event: StagePointerEvent): boolean;
  move(event: StagePointerEvent): void;
  release(event: StagePointerEvent): void;
}

/** The world's generated interfaces, while they are on: a world reaches its canvas cards through it. */
export const canvasCards: { current: CanvasCarry | null } = { current: null };

export interface Zone {
  mode: Mode;
  place: Place;
  label: string;
  /** What lights up. */
  area: Area;
}

/** From the screen's edges, as the bar keeps from them. */
export const margin = barLayout.margin;
const edge = 30;
const corner = 110;

/** What docks and the chat leave of the screen's width, where overlays sit; and how wide each dock is. */
export function clearSpan(surfaces: readonly HostSurface[], screen: Screenful, chat: Area | null):
    { left: number; right: number; docks: { left: number; right: number } } {
  const dock = (side: "left" | "right") => surfaces.filter((entry) => entry.mode === "dock" && entry.place.side === side)
    .reduce((most, entry) => Math.max(most, entry.width), 0);
  const docks = { left: dock("left"), right: dock("right") };
  const room = (width: number) => (width ? width + margin : 0);
  return { left: margin + room(docks.left), right: chat ? chat.x - margin : screen.width - margin - room(docks.right), docks };
}

/** Where a card dropped at (X, Y) would go, on SCREEN, with the chat at CHAT if it is open. */
function zoneAt(x: number, y: number, screen: Screenful, chat: Area | null, entry: HostSurface,
                grab: { x: number; y: number; width: number; height?: number },
                clear: ReturnType<typeof clearSpan>): Zone {
  const { width, height, top } = screen;
  const dockHeight = height - top - margin;
  // The pin is drawn over everything while dragging, the chat included, so it comes first.
  const pin = canvasTarget(screen);
  if (inside(x, y, pin)) return { mode: "canvas", place: {}, label: "Pin to canvas", area: pin };
  // A dock is as wide as its widest card, this one included.
  const dockWidth = (side: "left" | "right") => clear.docks[side] > 0 ? Math.max(clear.docks[side], entry.width) : entry.width;
  if (x < edge) return { mode: "dock", place: { side: "left" }, label: "Dock left",
                         area: { x: margin, y: top, width: dockWidth("left"), height: dockHeight } };
  if (x > width - edge) return { mode: "dock", place: { side: "right" }, label: "Dock right",
                                 area: { x: width - margin - dockWidth("right"), y: top, width: dockWidth("right"),
                                         height: dockHeight } };
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
    // As wide as the card; as tall as it was, near enough.
    const tall = Math.min(grab.height ?? 200, height - top - margin);
    return { mode: "overlay", place: { anchor }, label: "Pin over everything",
             area: { x: left ? clear.left : clear.right - entry.width, y: upper ? top : height - margin - tall,
                     width: entry.width, height: tall } };
  }
  if (chat && entry.agent && entry.message && inside(x, y, chat)) {
    return { mode: "inline", place: {}, label: "Back to the chat", area: chat };
  }
  // Below the bar: a card let go over it drops just under it.
  const below = Math.max(y - grab.y, top);
  return { mode: "floating", place: { x: Math.round(x - grab.x), y: Math.round(below) }, label: "",
           area: { x: x - grab.x, y: below, width: grab.width, height: 0 } };
}

function canvasTarget(screen: Screenful): Area {
  return { x: Math.round(screen.width / 2 - 110), y: screen.height - 88, width: 220, height: 52 };
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
  // How tall each card on the canvas was last laid out, in the world's units: what Super+drag picks among.
  const heights = useRef(new Map<string, number>());
  const entry = drag ? surfaces.find((surface) => surface.key === drag.key) : undefined;
  const zone = drag?.moving && entry ? dropZone(drag, screen, chat, entry, surfaces) : null;
  const handlers = useMemo<Omit<Grabbing, "dragging"> & CanvasCarry>(() => {
    const begin = (started: Drag) => {
      // Events can come faster than renders: keep what they see current at once.
      latest.current = started;
      setDrag(started);
    };
    const pickUp = (found: HostSurface, event: StagePointerEvent, size: { width: number; height?: number; scale?: number },
                    free: boolean) => {
      const scaleBy = size.scale ?? 1;
      const x = found.place.x ?? 0;
      const y = found.place.y ?? 0;
      begin({ key: found.key, grabX: Math.min(event.localX * scaleBy, size.width - 20), grabY: event.localY * scaleBy,
              width: size.width, height: (size.height ?? 0) * scaleBy, x: event.screenX, y: event.screenY,
              fromX: event.screenX, fromY: event.screenY, moving: free,
              world: found.mode === "canvas" ? { x, y, dx: x - event.worldX, dy: y - event.worldY, free } : undefined });
    };
    return {
      grab(key, event, size) {
        const found = world.current.surfaces.find((surface) => surface.key === key);
        if (found) pickUp(found, event, size, false);
      },
      carry(event) {
        // The topmost card pinned to the canvas under the pointer: the last drawn, as they are in raised order.
        const found = world.current.surfaces.filter((surface) => surface.mode === "canvas").reverse().find((surface) => {
          const x = surface.place.x ?? 0;
          const y = surface.place.y ?? 0;
          const height = heights.current.get(surface.key) ?? 0;
          return event.worldX >= x && event.worldX <= x + surface.width && event.worldY >= y && event.worldY <= y + height;
        });
        if (!found) return false;
        world.current.host.raise(found.key);
        pickUp(found, event, { width: found.width }, true);
        return true;
      },
      move(event) {
        const now = latest.current;
        if (!now) return;
        const moving = now.moving || Math.hypot(event.screenX - now.fromX, event.screenY - now.fromY) > 5;
        const carried = now.world && moving
          ? { ...now.world, x: Math.round(event.worldX + now.world.dx), y: Math.round(event.worldY + now.world.dy) }
          : now.world;
        latest.current = { ...now, x: event.screenX, y: event.screenY, moving, world: carried };
        setDrag(latest.current);
      },
      release(event) {
        const now = latest.current;
        latest.current = null;
        const { host, screen, chat, surfaces } = world.current;
        const dropped = now?.moving ? surfaces.find((surface) => surface.key === now.key) : undefined;
        if (now?.world && dropped) {
          // Let go over a dock or a corner it goes there; anywhere else it stays on the canvas, where it was carried.
          // Placed before the drag ends, so it never glides back to where it was picked up.
          const target = dropZone({ ...now, x: event.screenX, y: event.screenY }, screen, chat, dropped, surfaces);
          if (target) host.place(now.key, target.mode, target.place);
          else host.carry(now.key, Math.round(event.worldX + now.world.dx), Math.round(event.worldY + now.world.dy));
        }
        setDrag(null);
        if (!now?.moving || !dropped || now.world) return;
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
    };
  }, []);
  // A card carried on the canvas is itself what moves: no copy follows the pointer, so nothing hands over to one.
  const dragging = drag?.moving && !drag.world ? drag.key : null;
  const grabbing = useMemo<Grabbing>(() => ({ ...handlers, dragging }), [handlers, dragging]);
  const carried = drag?.moving && drag.world ? { key: drag.key, x: drag.world.x, y: drag.world.y } : null;
  const measure = useMemo(() => (key: string, height: number) => { heights.current.set(key, height); }, []);
  return { grabbing, carry: handlers as CanvasCarry, drag: drag?.moving ? drag : null, zone, entry, carried, measure };
}

/**
 * Where DRAG would drop. A card carried on the canvas only leaves it for a dock, a corner or
 * the chat, and not at all on Super+drag: anywhere else (null) it stays where it was carried.
 */
function dropZone(drag: Drag, screen: Screenful, chat: Area | null, entry: HostSurface,
                  surfaces: readonly HostSurface[]): Zone | null {
  if (drag.world?.free) return null;
  const zone = zoneAt(drag.x, drag.y, screen, chat, entry,
                      { x: drag.grabX, y: drag.grabY, width: drag.width, height: drag.height }, clearSpan(surfaces, screen, chat));
  if (!drag.world) return zone;
  return zone.mode === "dock" || zone.mode === "overlay" || zone.mode === "inline" ? zone : null;
}

// Cards stacked in a dock, a corner or a dialog are a row's gap apart, as cards are inside an interface.
const stacked = 8;

const useStyles = makeStyles(({ colors, motion, type, radii }) => ({
  ...StyleSheet.create({
    // At the screen's origin, the cards placed by padding: see the top of this file.
    dock: { position: "absolute", x: 0, y: 0, flexDirection: "column", gap: stacked },
    anchored: { position: "absolute", x: 0, y: 0, flexDirection: "column", gap: stacked },
    zone: { position: "absolute", radius: radii.lg, fill: colors.accentSoft, border: { width: 2, color: colors.accentLine },
            transition: motion.pop, alignItems: "center", justifyContent: "center" },
    // Moves with the zone, which it sits in the middle of.
    zoneLabel: { ...type.strong, color: colors.accent, transition: motion.pop },
    pin: { position: "absolute", radius: 26, flexDirection: "row", alignItems: "center", justifyContent: "center",
           transition: motion.pop },
    scrim: { position: "absolute", x: 0, y: 0, fill: "#00000059" },
    dialog: { position: "absolute", x: 0, y: 0, flexDirection: "column", gap: stacked, alignItems: "center",
              justifyContent: "center" },
  }),
  motion,
  // The copy under the pointer follows it at once; the rest of it (fading in) springs.
  follow: { default: motion.pop, x: instant, y: instant },
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
/** The copy picked up: it comes up from the faded card it was taken from. */
const lifted = { opacity: 0.3 };
const dropped = { opacity: 0 };
const anchors = Object.keys(anchorLayout) as Anchor[];

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
export function WorldSurfaces({ surfaces, grab, output }: { surfaces: readonly HostSurface[];
                                                             grab: ReturnType<typeof useGrabbing>; output?: string }) {
  const styles = useStyles();
  const zoom = getCamera(output)?.zoom ?? 1;
  const dragging = grab.grabbing.dragging;
  return surfaces.filter((entry) => entry.mode === "canvas").map((entry) => {
    // One being carried follows the pointer at once, and glides from wherever it is let go.
    const carried = grab.carried?.key === entry.key ? grab.carried : null;
    return (
      <SurfaceCard key={nodeKey(entry)} entry={entry} chrome="full" dimmed={dragging === entry.key} scale={zoom}
                   onLaid={grab.measure}
                   frame={{ layoutId: identity(entry, dragging), x: carried?.x ?? entry.place.x ?? 0,
                            y: carried?.y ?? entry.place.y ?? 0, initial: arriving, exit: leaving,
                            transition: carried ? styles.follow : styles.motion.glide }} />
    );
  });
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
  // Containers stay once they have held a card, so the last card to leave one still fades out.
  const used = useRef(new Set<Anchor>());
  for (const anchor of overlays.keys()) used.current.add(anchor);
  return (
    <>
      <Reserve output={screen.output} left={left.length ? dockWidth(left) + margin : 0}
               right={right.length ? dockWidth(right) + margin : 0} />
      <Screen output={screen.output}>
        {([["left", left], ["right", right]] as const).map(([side, entries]) => (
          <Box key={side} style={styles.dock} paddingLeft={side === "left" ? margin : width - margin - dockWidth(entries)}
               paddingTop={top} width={side === "left" ? margin + dockWidth(entries) : width - margin}
               maxHeight={height - margin} interactive={false}>
            {entries.map((entry) => (
              <SurfaceCard key={nodeKey(entry)} entry={entry} chrome="full" width={dockWidth(entries)}
                           dimmed={dragging === entry.key} maxHeight={height - top - margin}
                           frame={{ layoutId: identity(entry, dragging), initial: arriving, exit: leaving, transition: glide }} />
            ))}
          </Box>
        ))}
        {middle}
        {surfaces.filter((entry) => entry.mode === "floating").map((entry) => (
          <SurfaceCard key={nodeKey(entry)} entry={entry} chrome="full" dimmed={dragging === entry.key}
                       maxHeight={Math.max(240, height - Math.max(top, entry.place.y ?? top) - margin)}
                       // Kept below the bar wherever a program asks for it.
                       frame={{ layoutId: identity(entry, dragging), x: entry.place.x ?? 0, y: Math.max(entry.place.y ?? top, top),
                                initial: arriving, exit: leaving, transition: glide }} />
        ))}
        {anchors.filter((anchor) => used.current.has(anchor)).map((anchor) => (
          <Box key={anchor} style={styles.anchored} {...anchorLayout[anchor]} paddingLeft={clearLeft} paddingTop={top}
               width={clearRight} height={height - margin} interactive={false}>
            {(overlays.get(anchor) ?? []).map((entry) => (
              <SurfaceCard key={nodeKey(entry)} entry={entry} chrome="slim" dimmed={dragging === entry.key}
                           maxHeight={height - top - margin}
                           frame={{ layoutId: identity(entry, dragging), initial: arriving, exit: leaving, transition: glide }} />
            ))}
          </Box>
        ))}
        {/* The backdrop takes presses, so the rest waits for an answer. */}
        {dialogs.length > 0 && (
          <Rect style={styles.scrim} width={width} height={height} initial={{ opacity: 0 }} exit={{ opacity: 0 }}
                transition={glide} onPointerDown={() => {}} />
        )}
        {/* Dialogs sit in the middle of what the bar leaves. */}
        <Box style={styles.dialog} width={width} height={height} paddingTop={top} paddingBottom={margin} interactive={false}>
          {dialogs.map((entry) => (
            <SurfaceCard key={nodeKey(entry)} entry={entry} chrome="full" maxHeight={height - top - 2 * margin}
                         frame={{ layoutId: `genui:${entry.key}`, initial: arriving, exit: leaving, transition: glide }} />
          ))}
        </Box>
        <DropZones grab={grab} screen={screen} />
      </Screen>
    </>
  );
}

function DropZones({ grab, screen }: { grab: ReturnType<typeof useGrabbing>; screen: Screenful }) {
  const styles = useStyles();
  const { drag, zone, entry } = grab;
  if (!drag || !entry) return null;
  // A card carried on the canvas moves itself: only the dock or corner it would go to lights up.
  if (drag.world) {
    return zone && (
      <Box style={styles.zone} x={zone.area.x} y={zone.area.y} width={zone.area.width} height={zone.area.height}
           initial={{ opacity: 0 }} exit={{ opacity: 0 }} interactive={false}>
        <Text style={styles.zoneLabel}>{zone.label}</Text>
      </Box>
    );
  }
  const pin = canvasTarget(screen);
  const lit = zone && zone.mode !== "floating" ? zone : null;
  const onCanvas = zone?.mode === "canvas";
  // In the world, and in the chat's scrolling stream, a place on the screen means nothing to
  // the card that lands there: the copy hands nothing over, and fades as the card fades in.
  const handsOver = !onCanvas && zone?.mode !== "inline";
  return (
    <>
      {lit && lit.mode !== "canvas" && (
        <Box style={styles.zone} x={lit.area.x} y={lit.area.y} width={lit.area.width} height={lit.area.height}
             initial={{ opacity: 0 }} exit={{ opacity: 0 }} interactive={false}>
          <Text style={styles.zoneLabel}>{lit.label}</Text>
        </Box>
      )}
      {/* Unscaled, so its words stay sharp. */}
      <SurfaceCard entry={entry} chrome="full"
                   frame={{ layoutId: handsOver ? `genui:${entry.key}` : undefined, x: Math.round(drag.x - drag.grabX),
                            y: Math.round(drag.y - drag.grabY), opacity: 0.94, interactive: false, initial: lifted,
                            exit: dropped, transition: styles.follow }} />
      {/* Over the copy, which would otherwise hide it just as it is reached. */}
      <Surface variant={onCanvas ? "accent" : "glass"} style={styles.pin} x={pin.x} y={pin.y} width={pin.width}
               height={pin.height} initial={{ opacity: 0 }} exit={{ opacity: 0 }} interactive={false}>
        <Text style={styles.zoneLabel} color={onCanvas ? "#ffffff" : undefined}>Pin to canvas</Text>
      </Surface>
    </>
  );
}
