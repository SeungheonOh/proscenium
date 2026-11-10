/**
 * A window in the frame the shell draws: an edge, Warlock's title bar with
 * minimize, maximize, menu and close, and the client under it. A frame lies on
 * its output's canvas; it glides to a new place, follows the hand at once, and
 * shrinks to its taskbar button and back as its window is minimized and restored.
 */

import { memo, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Box,
  focus,
  Group,
  instant,
  Rect,
  rotate,
  scale,
  spring,
  Text,
  translate,
  tween,
  useWindow,
  Window,
  type Cursor,
  type Motion,
  type Rectangle,
  type StagePointerEvent,
  type StageRequestEvent,
  type Transition,
} from "proscenium";
import { alpha, fonts, standardEasing, themed, useWarlockTheme } from "./theme.js";
import { useWarlock } from "./WarlockProvider.js";

export const leftButton = 272;
export const rightButton = 273;
/** Two presses this close together are a double click. */
const doubleClickMs = 400;

export interface Edges {
  left: boolean;
  right: boolean;
  top: boolean;
  bottom: boolean;
}

export const noEdges: Edges = { left: false, right: false, top: false, bottom: false };

/** What a frame tells the desktop about the hand on it: a press that may move or resize it, and where the pointer goes after. */
export interface DragController {
  begin: (kind: "move" | "resize", window: number, event: StageRequestEvent, edges?: Edges) => void;
  move: (event: StagePointerEvent) => void;
  end: (event: StagePointerEvent) => void;
}

/** How a frame gets to where it is drawn: its place, and its size. */
export interface FrameMotion {
  x: Motion;
  y: Motion;
  size: Motion;
}

/** Warlock's window spring: critically damped, mass 1, stiffness 450, damping 43. */
export const glide = spring({ stiffness: 450, damping: 43, mass: 1 });
/** A frame that jumps to its place: with motion reduced, or under a resize. */
export const stillMotion: FrameMotion = { x: instant, y: instant, size: instant };
export const glideMotion: FrameMotion = { x: glide, y: glide, size: glide };
/** A frame in the hand: it follows the pointer at once, and takes a new size smoothly. */
export const heldMotion: FrameMotion = { x: instant, y: instant, size: glide };

/** Minimizing takes 190 ms and restoring 230, as Warlock's own motion does. */
export const minimizeSeconds = 0.19;
export const restoreSeconds = 0.23;
const minimizing = tween(minimizeSeconds, [...standardEasing]);
const restoring = tween(restoreSeconds, [...standardEasing]);

/** Where a frame is drawn from its place on its way to or from its taskbar button: moved, and shrunk about its middle. */
export interface Flight {
  x: number;
  y: number;
  scale: number;
}

/** A frame fanned out of its stack: turned (degrees) and shrunk about its middle. */
export interface Tilt {
  angle: number;
  scale: number;
}

/**
 * What lies over a frame that is there to be picked, not used: fanned out of
 * its stack, or in the overview. It takes the pointer, so a press reaches no
 * client and no button.
 */
export interface Veil {
  /** How far down the frame it reaches; all of it without one. */
  reach?: number;
  press: (window: number, event: StagePointerEvent) => void;
  hover?: (window: number, event: StagePointerEvent) => void;
  release?: () => void;
}

const resting = [translate(0, 0), rotate(0), scale(1)];

const useFrameStyles = themed((theme) => {
  const { palette } = theme;
  const title = {
    font: fonts.body,
    size: theme.rem(13),
    weight: 600,
    lineHeight: 4 / 3,
    maxLines: 1,
  } as const;
  return {
    guard: {
      radius: 11,
      border: { width: 1, color: palette.canvas },
      fill: alpha(palette.canvas, 0),
    },
    focused: {
      radius: 10,
      fill: palette.surfaceRaised,
      border: { width: 1, color: palette.windowEdgeFocused },
      shadow: theme.shadows.windowFocused,
    },
    unfocused: {
      radius: 10,
      fill: theme.effects === "full" ? alpha(palette.surface, 0.88) : palette.surface,
      border: { width: 1, color: palette.windowEdgeUnfocused },
      shadow: theme.shadows.window,
    },
    titleFocused: { ...title, color: palette.text },
    titleUnfocused: { ...title, color: palette.textSecondary },
    glyph: { font: fonts.body, size: theme.rem(16), weight: 400, align: "center" } as const,
    rule: alpha(palette.text, 0.07),
  };
});

interface TitleButtonProps {
  glyph: string;
  color: string;
  /** The close button: red under the pointer. */
  danger?: boolean;
  /** How it keeps its place as the frame changes size. */
  transition: Transition;
  onPress: () => void;
  /** The pointer has come to it. */
  onEnter?: () => void;
}

function TitleButton({
  glyph,
  color,
  danger = false,
  transition,
  onPress,
  onEnter,
}: TitleButtonProps) {
  const theme = useWarlockTheme();
  const styles = useFrameStyles();
  const [hovered, setHovered] = useState(false);
  const [held, setHeld] = useState(false);
  // A frame gliding past a still pointer puts its buttons under it: only a pointer that moves has come to one.
  const entered = useRef(false);
  const fill = hovered
    ? danger
      ? theme.palette.actionFill
      : theme.palette.surfaceHover
    : alpha(theme.palette.surfaceHover, 0);
  return (
    <Box
      width={theme.rem(44)}
      alignSelf="stretch"
      alignItems="center"
      justifyContent="center"
      fill={fill}
      transition={transition}
      cursor="pointer"
      onPointerEnter={() => {
        entered.current = false;
        setHovered(true);
      }}
      onPointerMove={
        onEnter && hovered
          ? () => {
              if (entered.current) return;
              entered.current = true;
              onEnter();
            }
          : undefined
      }
      onPointerLeave={() => setHovered(false)}
      onPointerDown={(event) => {
        event.stopPropagation();
        setHeld((event.button ?? leftButton) === leftButton);
      }}
      onPointerUp={(event) => {
        event.stopPropagation();
        const layout = event.currentTarget.layout;
        const over =
          layout !== null &&
          event.localX >= 0 &&
          event.localY >= 0 &&
          event.localX <= layout.width &&
          event.localY <= layout.height;
        if (held && over) onPress();
        setHeld(false);
      }}
    >
      <Text
        style={styles.glyph}
        color={hovered && danger ? theme.palette.onAction : color}
        width={theme.rem(44)}
        interactive={false}
      >
        {glyph}
      </Text>
    </Box>
  );
}

export interface WindowFrameProps {
  id: number;
  /** Where it is drawn, in the world. */
  rect: Rectangle;
  title: string;
  focused: boolean;
  /** A window of the application in use: a red line under its title bar. */
  active: boolean;
  maximized: boolean;
  /** Its edges can be dragged. */
  resizable: boolean;
  dialog: boolean;
  /** Being dragged: it hears the pointer move. */
  grabbed: boolean;
  controller: DragController;
  /** Where a point of the world shows on the frame's output, in its pixels. */
  onScreen: (x: number, y: number) => { x: number; y: number };
  motion: FrameMotion;
  /** Fanned out of its stack. */
  tilt?: Tilt | undefined;
  /** There to be picked: what the pointer does to it instead of reaching it. */
  veil?: Veil | undefined;
  /** Minimized just now: it goes to its taskbar button and fades. */
  away?: Flight | undefined;
  /** Restored just now: it comes from its taskbar button. */
  arriving?: Flight | undefined;
  /** Drawn over it, in its own space: the portal it opens through. */
  children?: ReactNode;
}

const resizeHandles: readonly { edges: Edges; cursor: Cursor }[] = [
  { edges: { ...noEdges, top: true }, cursor: "ns-resize" },
  { edges: { ...noEdges, bottom: true }, cursor: "ns-resize" },
  { edges: { ...noEdges, left: true }, cursor: "ew-resize" },
  { edges: { ...noEdges, right: true }, cursor: "ew-resize" },
  { edges: { ...noEdges, top: true, left: true }, cursor: "nwse-resize" },
  { edges: { ...noEdges, bottom: true, right: true }, cursor: "nwse-resize" },
  { edges: { ...noEdges, top: true, right: true }, cursor: "nesw-resize" },
  { edges: { ...noEdges, bottom: true, left: true }, cursor: "nesw-resize" },
];

/** Where a resize handle lies round a frame WIDTH by HEIGHT: a strip along an edge, or a square at a corner. */
function handleBox({ left, right, top, bottom }: Edges, width: number, height: number): Rectangle {
  const reach = 5;
  const corner = 14;
  const horizontal = left || right;
  const vertical = top || bottom;
  if (horizontal && vertical)
    return {
      x: left ? -reach : width - corner + reach,
      y: top ? -reach : height - corner + reach,
      width: corner,
      height: corner,
    };
  if (horizontal)
    return {
      x: left ? -reach : width - reach,
      y: corner,
      width: 2 * reach,
      height: height - 2 * corner,
    };
  return {
    x: corner,
    y: top ? -reach : height - reach,
    width: width - 2 * corner,
    height: 2 * reach,
  };
}

function flown({ x, y, scale: size }: Flight) {
  return [translate(x, y), rotate(0), scale(size)];
}

/** A window in Warlock's frame: an edge, a title bar with minimize, maximize, menu and close, and the client under it. */
export const WindowFrame = memo(function WindowFrame({
  id,
  rect,
  title,
  focused,
  active,
  maximized,
  resizable,
  dialog,
  grabbed,
  controller,
  onScreen,
  motion,
  tilt,
  veil,
  away,
  arriving,
  children,
}: WindowFrameProps) {
  const theme = useWarlockTheme();
  const styles = useFrameStyles();
  const {
    minimize,
    toggleMaximize,
    closeWindow,
    openPopup,
    canSnap,
    notify,
    setFullscreen,
    activate,
    popup,
    keepPopup,
  } = useWarlock();
  const lastPress = useRef(0);
  const pressed = useRef<number | null>(null);
  // A window that draws its own title bar (it would not leave it to the shell) gets only the edge.
  const own = useWindow(id)?.decorations === "client";
  const bar = own ? 0 : theme.titleBarHeight;
  const color = focused ? theme.palette.text : theme.palette.textSecondary;
  const client = {
    x: 1,
    y: 1 + bar,
    width: Math.max(1, rect.width - 2),
    height: Math.max(1, rect.height - bar - 2),
  };

  // The frame goes to its place by MOTION; what it holds keeps up with its size.
  const flying = away ? minimizing : arriving ? restoring : null;
  const outer = useMemo<Transition>(
    () => ({
      default: instant,
      x: motion.x,
      y: motion.y,
      width: motion.size,
      height: motion.size,
      opacity: flying ?? instant,
      transform: flying ?? motion.size,
    }),
    [motion, flying],
  );
  const inner = useMemo<Transition>(
    () => ({
      default: instant,
      x: motion.size,
      y: motion.size,
      width: motion.size,
      height: motion.size,
    }),
    [motion],
  );
  const across = useMemo<Transition>(() => ({ default: instant, width: motion.size }), [motion]);

  function menuAt(x: number, y: number) {
    focus(id);
    openPopup({ mode: "menu", window: id }, { anchor: { x, y } });
  }

  return (
    <Group
      x={rect.x}
      y={rect.y}
      width={rect.width}
      height={rect.height}
      transform={
        away
          ? flown(away)
          : tilt
            ? [translate(0, 0), rotate(tilt.angle), scale(tilt.scale)]
            : resting
      }
      opacity={away ? 0 : 1}
      initial={arriving ? { opacity: 0, transform: flown(arriving) } : undefined}
      transition={outer}
    >
      <Rect
        x={-1}
        y={-1}
        width={rect.width + 2}
        height={rect.height + 2}
        style={styles.guard}
        transition={inner}
        interactive={false}
      />
      <Rect
        width={rect.width}
        height={rect.height}
        style={focused ? styles.focused : styles.unfocused}
        transition={inner}
      />
      <Rect {...client} radius={9} fill={theme.palette.surface} transition={inner} />
      {/* The client's corners are round, but under the title bar they must be square: its top
          corners show the client's fill, square, rather than the frame through a cut. */}
      {!own && (
        <Rect
          x={client.x}
          y={client.y}
          width={client.width}
          height={10}
          fill={theme.palette.surface}
          transition={inner}
          interactive={false}
        />
      )}
      <Window
        window={id}
        {...client}
        radius={9}
        tiled
        maximized={maximized}
        transition={inner}
        onMoveRequest={(event: StageRequestEvent) => controller.begin("move", id, event)}
        onResizeRequest={(event: StageRequestEvent) => {
          const edges = event.edges ?? 0;
          if (!resizable) return;
          controller.begin("resize", id, event, {
            top: (edges & 1) !== 0,
            bottom: (edges & 2) !== 0,
            left: (edges & 4) !== 0,
            right: (edges & 8) !== 0,
          });
        }}
        onPointerMove={grabbed ? controller.move : undefined}
        onPointerUp={controller.end}
        onMaximizeRequest={({ value }) => {
          if (!dialog && value !== maximized) toggleMaximize(id);
        }}
        onMinimizeRequest={() => !dialog && minimize(id)}
        onFullscreenRequest={({ value }) => !dialog && setFullscreen(id, Boolean(value))}
        onActivateRequest={() => activate(id)}
      />
      {!own && (
        <>
          <Box
            x={1}
            y={1}
            width={rect.width - 2}
            height={bar}
            flexDirection="row"
            alignItems="stretch"
            transition={across}
          >
            <Box
              flexGrow={1}
              flexShrink={1}
              flexDirection="row"
              alignItems="center"
              paddingX={14}
              transition={across}
              onPointerDown={(event) => {
                pressed.current = event.button ?? leftButton;
                if (pressed.current !== leftButton) return;
                focus(id);
                const now = performance.now();
                if (!dialog && now - lastPress.current < doubleClickMs) {
                  lastPress.current = 0;
                  pressed.current = null;
                  toggleMaximize(id);
                  return;
                }
                lastPress.current = now;
                controller.begin("move", id, event);
              }}
              onPointerMove={grabbed ? controller.move : undefined}
              onPointerUp={(event) => {
                if (pressed.current === rightButton && !dialog)
                  menuAt(event.screenX, event.screenY);
                else if (pressed.current === leftButton) controller.end(event);
                pressed.current = null;
              }}
            >
              {focused && (
                <Rect
                  position="absolute"
                  x={6}
                  y={bar * 0.275}
                  width={3}
                  height={bar * 0.45}
                  radius={1.5}
                  fill={color}
                />
              )}
              <Text
                style={focused ? styles.titleFocused : styles.titleUnfocused}
                flexShrink={1}
                interactive={false}
              >
                {title}
              </Text>
            </Box>
            {!dialog && (
              <TitleButton
                glyph={"−"}
                color={color}
                transition={inner}
                onPress={() => {
                  focus(id);
                  minimize(id);
                }}
              />
            )}
            {!dialog && (
              <TitleButton
                glyph={"□"}
                color={color}
                transition={inner}
                onPress={() => toggleMaximize(id)}
                onEnter={() => {
                  // Hovering the focused window's maximize button offers the snap layouts.
                  if (!focused || popup?.mode === "snap") return;
                  if (canSnap(id)) {
                    keepPopup();
                    openPopup({ mode: "snap", window: id });
                  } else notify("Snap layouts are unavailable for this window.", 4);
                }}
              />
            )}
            {!dialog && (
              <TitleButton
                glyph={"⋮"}
                color={color}
                transition={inner}
                onPress={() => {
                  // Under the title bar's left end, wherever the frame shows on the screen.
                  const { x, y } = onScreen(rect.x, rect.y + bar);
                  menuAt(x, y);
                }}
              />
            )}
            <TitleButton
              glyph={"×"}
              color={color}
              danger
              transition={inner}
              onPress={() => closeWindow(id)}
            />
          </Box>
          <Rect
            x={1}
            y={bar + 1 - (active ? 2 : 1)}
            width={rect.width - 2}
            height={active ? 2 : 1}
            fill={active ? theme.palette.brandText : styles.rule}
            transition={across}
            interactive={false}
          />
        </>
      )}
      {resizable &&
        resizeHandles.map(({ edges, cursor }, index) => (
          <Rect
            key={index}
            {...handleBox(edges, rect.width, rect.height)}
            cursor={cursor}
            onPointerDown={(event) => {
              if ((event.button ?? leftButton) !== leftButton) return;
              focus(id);
              controller.begin("resize", id, event, edges);
            }}
            onPointerMove={grabbed ? controller.move : undefined}
            onPointerUp={controller.end}
          />
        ))}
      {children}
      {veil && (
        <Rect
          width={rect.width}
          height={veil.reach ?? rect.height}
          cursor="pointer"
          onPointerDown={(event) => veil.press(id, event)}
          // Only a move counts: a frame shifting under a still pointer leaves the pick to the keys.
          onPointerMove={veil.hover && ((event) => veil.hover?.(id, event))}
          onPointerUp={veil.release}
        />
      )}
    </Group>
  );
});
