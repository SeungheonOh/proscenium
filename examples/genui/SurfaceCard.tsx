// One generated interface in its frame: a title bar to drag it by and close it
// with, and the interface itself, drawn natively from its spec as it streams.

import { createContext, memo, useContext } from "react";
import { Box, Text, type AnimatedValues, type Motion, type StagePointerEvent, type Transform } from "proscenium";
import { GeneratedView } from "proscenium/genui";
import { darkTheme, Icon, Label, lightTheme, makeStyles, Pressable, ProgressBar, StyleSheet, Surface,
  ThemeProvider } from "proscenium/ui";
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
}

/** A generated interface with its frame; drag the title bar to move it to another mode. */
export const SurfaceCard = memo(function SurfaceCard({ entry, chrome, width, dimmed = false, scale = 1, frame = {} }: SurfaceCardProps) {
  const theme = entry.theme === "dark" ? darkTheme : lightTheme;
  return (
    <ThemeProvider theme={theme}>
      <Framed entry={entry} chrome={chrome} width={width ?? entry.width} dimmed={dimmed} scale={scale} frame={frame} />
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

function Framed({ entry, chrome, width, dimmed, scale, frame }: Required<SurfaceCardProps>) {
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
    <Surface variant="card" style={styles.card} width={width} {...frame} fill={entry.theme === "dark" ? "#26262b" : "#ffffff"}
             opacity={(frame.opacity ?? 1) * (dimmed ? 0.3 : 1)}>
      {chrome === "full" && (
        <Box style={styles.bar} cursor="grab" {...grip}>
          {/* Title and owner on one line, so they share a baseline. */}
          <Text font={type.strong.font} size={type.strong.size} weight={type.strong.weight} color={colors.ink} maxLines={1}
                flexShrink={1} flexGrow={1}>
            {entry.title ?? entry.id}
            {!entry.agent && <Text weight={500} color={colors.faint}>{`  ${entry.owner}`}</Text>}
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
      <Box style={chrome === "none" ? styles.bareBody : styles.body}>{view}</Box>
    </Surface>
  );
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
