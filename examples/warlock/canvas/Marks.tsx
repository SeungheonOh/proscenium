/**
 * What the canvas draws over the windows, in Warlock's colours: the selection
 * box and a line round each selected window, a pill on each stack's front
 * title bar with how many windows it holds, and the guides holding a window in hand. After the
 * canvas world's Selection and Guides (examples/canvas), whose hooks decide
 * what shows here. Lines keep their width, and pills their size, at any zoom.
 */

import { useRef } from "react";
import {
  Box,
  Group,
  instant,
  Rect,
  scale,
  Text,
  tween,
  type Rectangle,
  type StagePointerEvent,
  type Transition,
} from "proscenium";
import { bounds } from "../../canvas/magnetism.js";
import type { Guide } from "../../canvas/snapping.js";
import { alpha, standardEasing, themed } from "../theme.js";
import { useFeedZoom, type CameraFeed } from "./CameraFeed.js";

/** How far, in screen pixels, the pointer may move between pressing a pill and letting go for it to be a click. */
const clickSlop = 4;
const appear = tween(0.12, [...standardEasing]);
/** The width a pill is centred in, in screen pixels. */
const pillRoom = 320;

const useMarkStyles = themed((theme) => {
  const { palette, skin } = theme;
  return {
    titleBar: theme.titleBarHeight,
    line: palette.brandText,
    wash: skin.selected,
    faintWash: alpha(palette.brandText, 0.07),
    pill: {
      height: 24,
      paddingX: 10,
      radius: 12,
      alignItems: "center",
      flexDirection: "row",
      fill: palette.surfaceRaised,
      border: {
        width: 1,
        color: theme.theme === "high-contrast" ? palette.text : alpha(palette.text, 0.18),
      },
      shadow: theme.shadows.raised,
    } as const,
    pillTarget: {
      fill: palette.actionFill,
      border: { width: 1, color: palette.brandText },
    } as const,
    label: { ...theme.type.caption, color: palette.text, maxLines: 1 } as const,
    labelTarget: { ...theme.type.caption, color: palette.onAction, maxLines: 1 } as const,
  };
});

export interface MarksProps {
  feed: CameraFeed;
  /** Where each window shows now, in the world. */
  places: ReadonlyMap<number, Rectangle>;
  selected: ReadonlySet<number>;
  /** The selection box being drawn, or null. */
  box: Rectangle | null;
  /** Each stack that wears a pill, bottom first. */
  stacks: readonly (readonly number[])[];
  /** The stack a window in hand drops into if let go now, without it. */
  dropTarget: readonly number[] | null;
  /** How many windows go into it: one, or a whole stack. */
  dropping: number;
  /** A window on its way out of its stack. */
  leaving: number | null;
  guides: readonly Guide[];
  /** How what marks WINDOW moves with it. */
  motionOf: (window: number) => Transition;
  /** Pills appear with a fade. */
  animated: boolean;
  /** A pill pressed: the stack whose top window is TOP is picked up whole. */
  onPickUpStack: (top: number, event: StagePointerEvent) => void;
  /** A pill clicked without moving: the stack whose top window is TOP fans out. */
  onOpenStack: (top: number) => void;
  onCarry: (event: StagePointerEvent) => void;
  onLetGo: (event: StagePointerEvent) => void;
}

export function Marks({
  feed,
  places,
  selected,
  box,
  stacks,
  dropTarget,
  dropping,
  leaving,
  guides,
  motionOf,
  animated,
  onPickUpStack,
  onOpenStack,
  onCarry,
  onLetGo,
}: MarksProps) {
  const styles = useMarkStyles();
  // One screen pixel in canvas units.
  const pixel = 1 / useFeedZoom(feed);
  // Where a pill was pressed, and which: let go there, it was a click.
  const pressed = useRef<{ x: number; y: number; top: number } | null>(null);
  if (selected.size === 0 && !box && stacks.length === 0 && !dropTarget && guides.length === 0)
    return null;

  const isTarget = (ids: readonly number[]) =>
    dropTarget !== null && dropTarget.every((id) => ids.includes(id));
  // A lone window a window is about to start a stack with.
  const startsStack = dropTarget !== null && !stacks.some(isTarget);

  const marker = (ids: readonly number[], target: boolean) => {
    // A window on its way out no longer counts.
    const staying = ids.filter((id) => id !== leaving);
    const rects = staying.flatMap((id) => places.get(id) ?? []);
    if (rects.length === 0 || (staying.length < 2 && !target)) return null;
    const top = staying.at(-1)!;
    const front = places.get(top);
    if (!front) return null;
    const pile = bounds(rects);
    const transition = motionOf(top);
    const gap = 8 * pixel;
    return (
      <Group key={ids.join("+")}>
        {target && (
          <Rect
            x={pile.x - gap}
            y={pile.y - gap}
            width={pile.width + 2 * gap}
            height={pile.height + 2 * gap}
            radius={16 * pixel}
            fill={styles.faintWash}
            border={{ width: 2 * pixel, color: styles.line }}
            transition={transition}
            interactive={false}
          />
        )}
        {/* The pill sits in the middle of the front window's title bar, drawn at screen size: above it there may be no room. */}
        <Group
          x={front.x + front.width / 2}
          y={front.y + styles.titleBar / 2}
          originX={0}
          originY={0}
          transform={scale(pixel)}
          transition={transition}
        >
          <Box
            x={-pillRoom / 2}
            width={pillRoom}
            height={0}
            flexDirection="row"
            justifyContent="center"
            alignItems="center"
          >
            <Box
              style={[styles.pill, target && styles.pillTarget]}
              cursor="grab"
              initial={animated ? { opacity: 0 } : undefined}
              transition={{ default: instant, opacity: appear }}
              onPointerDown={(event) => {
                pressed.current = { x: event.screenX, y: event.screenY, top };
                onPickUpStack(top, event);
              }}
              onPointerMove={pressed.current?.top === top ? onCarry : undefined}
              onPointerUp={(event) => {
                const at = pressed.current;
                pressed.current = null;
                onLetGo(event);
                if (at && Math.hypot(event.screenX - at.x, event.screenY - at.y) < clickSlop)
                  onOpenStack(top);
              }}
            >
              <Text style={target ? styles.labelTarget : styles.label} interactive={false}>
                {pillLabel(staying.length, target, startsStack, dropping)}
              </Text>
            </Box>
          </Box>
        </Group>
      </Group>
    );
  };

  const gap = 4 * pixel;
  return (
    <Group>
      {[...selected].map((id) => {
        const rect = places.get(id);
        return (
          rect && (
            <Rect
              key={id}
              x={rect.x - gap}
              y={rect.y - gap}
              width={rect.width + 2 * gap}
              height={rect.height + 2 * gap}
              radius={10 + gap}
              fill={styles.faintWash}
              border={{ width: 2 * pixel, color: styles.line }}
              transition={motionOf(id)}
              interactive={false}
            />
          )
        );
      })}
      {stacks.map((ids) => marker(ids, isTarget(ids)))}
      {startsStack && marker(dropTarget, true)}
      {box && (
        <Rect
          {...box}
          radius={3 * pixel}
          fill={styles.wash}
          border={{ width: 1.5 * pixel, color: styles.line }}
          interactive={false}
        />
      )}
      {guideLines(guides, pixel).map((line, index) => (
        <Rect key={`guide-${index}`} {...line} fill={styles.line} interactive={false} />
      ))}
    </Group>
  );
}

/**
 * The words on the pill of a stack of COUNT windows: how many it holds, or, as the drop TARGET, what letting go does,
 * DROPPING windows going in, or with STARTSSTACK a lone window and the one in hand starting a stack.
 */
function pillLabel(count: number, target: boolean, startsStack: boolean, dropping: number): string {
  if (!target) return `Stack · ${count}`;
  if (startsStack) return "New stack · 2";
  const total = count + dropping;
  return dropping > 1 ? `Merge stacks · ${total}` : `Add to stack · ${total}`;
}

/** GUIDES as hairlines PIXEL wide: a line along a shared edge or centre, a gap marked with a tick at each end. */
function guideLines(guides: readonly Guide[], pixel: number): Rectangle[] {
  const tick = 4 * pixel;
  const lines: Rectangle[] = [];
  for (const guide of guides) {
    const { from, to } = guide;
    const horizontal = from.y === to.y;
    const x = Math.min(from.x, to.x);
    const y = Math.min(from.y, to.y);
    lines.push(
      horizontal
        ? { x, y: y - pixel / 2, width: Math.abs(to.x - from.x), height: pixel }
        : { x: x - pixel / 2, y, width: pixel, height: Math.abs(to.y - from.y) },
    );
    if (guide.kind !== "gap") continue;
    for (const end of [from, to]) {
      lines.push(
        horizontal
          ? { x: end.x - pixel / 2, y: end.y - tick, width: pixel, height: 2 * tick }
          : { x: end.x - tick, y: end.y - pixel / 2, width: 2 * tick, height: pixel },
      );
    }
  }
  return lines;
}
