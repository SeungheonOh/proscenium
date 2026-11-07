// One generated interface in its frame: a title bar to drag it by and close it
// with, and the interface itself, drawn natively from its spec as it streams.

import { createContext, memo, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Box, Rect, spring, Text, translate, type AnimatedValues, type LayoutBox, type Motion, type StagePointerEvent,
  type StageWheelEvent, type Transform } from "proscenium";
import { GeneratedView } from "proscenium/genui";
import { darkTheme, Icon, Label, lightTheme, makeStyles, Pressable, ProgressBar, StyleSheet, Surface,
  ThemeProvider, type Theme } from "proscenium/ui";
import closeIcon from "./icons/close.svg";
import type { HostSurface, UIHost } from "./host.js";

/** Starts dragging an interface by its title bar; the drag itself lives in Surfaces.tsx. */
export interface Grabbing {
  grab(key: string, event: StagePointerEvent, size: { width: number; scale?: number }): void;
  move(event: StagePointerEvent): void;
  release(event: StagePointerEvent): void;
  /** The interface being dragged, if any. */
  dragging: string | null;
}

export const GrabContext = createContext<Grabbing | null>(null);

/** The themes an interface is drawn with, as its `theme` asks: the world's own pair, the stock one by default. */
export const SurfaceThemes = createContext<{ light: Theme; dark: Theme }>({ light: lightTheme, dark: darkTheme });
export const HostContext = createContext<UIHost | null>(null);

export type Chrome = "full" | "slim" | "none";

// The frame's words and buttons line up with the interface's edges: 14 in from
// each side, the close button's mark included.
const inset = 14;

const useStyles = makeStyles(({ colors, motion }) => StyleSheet.create({
  card: { flexDirection: "column", radius: 14, clip: true, transition: motion.pop },
  // Tall enough that the title sits as far from the top as the content does from the sides.
  bar: { flexDirection: "row", alignItems: "center", gap: 6, height: 34, paddingLeft: inset, paddingRight: inset - 6,
         alignSelf: "stretch" },
  slimBar: { flexDirection: "row", alignItems: "center", gap: 6, height: 28, paddingLeft: inset, paddingRight: inset - 6,
             alignSelf: "stretch" },
  title: { flexShrink: 1 },
  owner: { flexShrink: 0 },
  body: { flexDirection: "column", paddingX: inset, paddingBottom: inset, alignSelf: "stretch" },
  bareBody: { flexDirection: "column", padding: inset, alignSelf: "stretch" },
  close: { width: 24, height: 24, radius: 7, alignItems: "center", justifyContent: "center", transition: motion.pop },
  building: { flexDirection: "column", gap: 8, paddingY: 6, alignSelf: "stretch" },
  rule: { height: 1, fill: colors.line, alignSelf: "stretch" },
}));

const useColors = makeStyles(({ colors }) => colors);
const useType = makeStyles(({ type }) => type);

/** Where and how the card's frame sits and moves, set on its own node so a Box can lay it out. */
export interface Frame {
  layoutId?: string;
  x?: number;
  y?: number;
  initial?: AnimatedValues;
  exit?: AnimatedValues;
  transition?: Motion;
  transform?: Transform;
  opacity?: number;
  interactive?: boolean;
}

export interface SurfaceCardProps {
  entry: HostSurface;
  frame?: Frame;
  chrome: Chrome;
  /** Pixels, or the width of the Box it is in. */
  width?: number | "100%";
  /** Faded while a copy of it is being dragged. */
  dimmed?: boolean;
  /** Its zoom, for a card in the world: grabs measure on the screen. */
  scale?: number;
  /** The most it may take of the screen's height: a taller interface scrolls inside its frame. */
  maxHeight?: number;
}

/** A generated interface with its frame; drag the title bar to move it to another mode. */
export const SurfaceCard = memo(function SurfaceCard({ entry, chrome, width, dimmed = false, scale = 1, frame = {}, maxHeight = 0 }: SurfaceCardProps) {
  const themes = useContext(SurfaceThemes);
  const theme = entry.theme === "dark" ? themes.dark : themes.light;
  return (
    <ThemeProvider theme={theme}>
      <Framed entry={entry} chrome={chrome} width={width ?? entry.width} dimmed={dimmed} scale={scale} frame={frame}
              maxHeight={maxHeight} />
    </ThemeProvider>
  );
}, (before, after) => {
  // Frames are written inline, so they are compared by what they hold.
  const { frame: a = {}, ...restBefore } = before;
  const { frame: b = {}, ...restAfter } = after;
  return shallowSame(restBefore, restAfter) && shallowSame(a, b);
});

function shallowSame(a: object, b: object): boolean {
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.is(left[key], right[key]));
}

function Framed({ entry, chrome, width, dimmed, scale, frame, maxHeight }: Required<SurfaceCardProps>) {
  const styles = useStyles();
  const colors = useColors();
  const type = useType();
  const host = useContext(HostContext)!;
  const grabbing = useContext(GrabContext);
  const grip = grabbing && entry.mode !== "dialog" ? {
    onPointerDown: (event: StagePointerEvent) => {
      host.raise(entry.key);
      grabbing.grab(entry.key, event, { width: typeof width === "number" ? width : entry.width, scale });
    },
    onPointerMove: (event: StagePointerEvent) => grabbing.move(event),
    onPointerUp: (event: StagePointerEvent) => grabbing.release(event),
  } : {};
  const close = (
    <Pressable onPress={() => host.dismiss(entry.key)}
               style={({ hovered, pressed }) => [styles.close, { fill: pressed ? colors.press : hovered ? colors.hover : colors.clear }]}>
      <Icon src={closeIcon} size={12} tone="muted" />
    </Pressable>
  );
  const view = (
    <GeneratedView surface={entry.surface} onAction={(action, params) => host.act(entry.key, action, params)}
                   fallback={<Building />} />
  );
  return (
    <Surface variant="card" style={styles.card} width={width} {...frame} fill={solid(colors.card)}
             opacity={(frame.opacity ?? 1) * (dimmed ? 0.3 : 1)}>
      {chrome === "full" && (
        <Box style={styles.bar} cursor="grab" {...grip}>
          {/* Title and owner on one line, so they share a baseline. */}
          <Text font={type.strong.font} size={type.strong.size} weight={type.strong.weight} color={colors.ink} maxLines={1}
                flexShrink={1} flexGrow={1}>
            {entry.title ?? entry.id}
            {!entry.agent && entry.owner !== (entry.title ?? entry.id)
              && <Text weight={500} color={colors.faint}>{`  ${entry.owner}`}</Text>}
          </Text>
          {close}
        </Box>
      )}
      {chrome === "slim" && (
        <Box style={styles.slimBar} cursor="grab" {...grip}>
          <Text font={type.caption.font} size={12} weight={650} color={colors.muted} maxLines={1} flexShrink={1}
                flexGrow={1}>{entry.title ?? entry.id}</Text>
          {close}
        </Box>
      )}
      <Fit maxHeight={maxHeight ? maxHeight - (chrome === "full" ? 34 : chrome === "slim" ? 28 : 0) : 0}>
        <Box style={chrome === "none" ? styles.bareBody : styles.body}>{view}</Box>
      </Fit>
    </Surface>
  );
}

const glide = spring({ duration: 0.28, bounce: 0 });

/**
 * Its content as tall as it is, up to MAXHEIGHT (none: any height); past that,
 * clipped, moved by the wheel, with a thumb on the right saying there is more.
 * The content stays in the flow, so the frame takes its height from it.
 */
function Fit({ maxHeight, children }: { maxHeight: number; children: ReactNode }) {
  const colors = useColors();
  const [box, setBox] = useState<LayoutBox | null>(null);
  const [content, setContent] = useState(0);
  const [offset, setOffset] = useState(0);
  const height = box?.height ?? 0;
  const most = maxHeight > 0 ? Math.max(0, Math.round(content - height)) : 0;
  const at = Math.min(Math.max(offset, 0), most);
  const stale = useRef(at);
  stale.current = at;
  // Content that shrank back keeps what is in view.
  useEffect(() => {
    if (offset > most) setOffset(most);
  }, [most]);
  if (maxHeight <= 0) return <>{children}</>;
  const wheel = (event: StageWheelEvent) => {
    if (event.orientation !== "vertical" || most === 0) return;
    event.stopPropagation();
    const step = event.source === "wheel" || event.source === "wheel-tilt" ? (event.discrete || Math.sign(event.delta)) * 56 : event.delta;
    // Whole pixels: text resting between them draws blurred.
    setOffset(Math.round(Math.min(Math.max(stale.current + step, 0), most)));
  };
  const thumb = most > 0 && height > 0 ? Math.max(24, (height * height) / content) : 0;
  return (
    <Box flexDirection="column" alignSelf="stretch" maxHeight={maxHeight} clip onLayout={setBox} onWheel={wheel}>
      <Box flexDirection="column" alignSelf="stretch" flexShrink={0} transform={translate(0, -at)} transition={glide}
           onLayout={(layout) => setContent(layout.height)}>
        {children}
      </Box>
      {thumb > 0 && (
        <Rect position="absolute" x={(box?.width ?? 0) - 6} y={((height - thumb) * at) / most} width={4} height={thumb}
              radius={2} fill={colors.faint} transition={glide} />
      )}
    </Box>
  );
}

/** COLOR without its alpha: the card's own color, solid, so what moves behind it never shows through. */
function solid(color: unknown): string {
  const text = String(color);
  return /^#[0-9a-f]{8}$/i.test(text) ? text.slice(0, 7) : /^#[0-9a-f]{4}$/i.test(text) ? text.slice(0, 4) : text;
}

/** What shows while an interface's first elements are on their way. */
function Building() {
  const styles = useStyles();
  return (
    <Box style={styles.building}>
      <Label tone="muted">Building…</Label>
      <ProgressBar value={null} />
    </Box>
  );
}
