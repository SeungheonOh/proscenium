import {
  Box,
  Group,
  Rect,
  scale,
  Text,
  type BoxProps,
  type Rectangle,
  type StagePointerEvent,
  type TextProps,
  type Transition,
} from "proscenium";
import { useRef } from "react";
import { colors, font, motion } from "../lib/theme.js";
import { bounds } from "./magnetism.js";
import { ScreenSized, useScreenPixel } from "./ScreenSized.js";

const styles = {
  // A row as wide as the stack, its pill at the right end and sitting just above it.
  stackRow: { height: 0, flexDirection: "row", justifyContent: "flex-end", alignItems: "flex-end" },
  stackPill: {
    height: 24,
    marginBottom: 8,
    paddingX: 12,
    // Box lays out in a row: this centres the label up and down.
    alignItems: "center",
    radius: 12,
    fill: colors.ink,
    shadow: { color: "#00000040", blur: 8, y: 2 },
    // The pill is the stack's handle.
    cursor: "grab",
  },
  dropPill: { fill: colors.accent },
} satisfies Record<string, BoxProps>;

const stackLabel = { font, size: 12, weight: 650, color: "#ffffff" } satisfies TextProps;

/** How far, in screen pixels, the pointer may move between pressing the pill and letting go for it to be a click. */
const clickSlop = 4;

interface SelectionProps {
  /** Where each window shows now. */
  places: ReadonlyMap<number, Rectangle>;
  selected: ReadonlySet<number>;
  /** The box being drawn, or null. */
  box: Rectangle | null;
  /** Each stack, bottom first: a pill above it wears the count. */
  stacks: readonly (readonly number[])[];
  /** The stack a window in hand drops into if let go now, without it. */
  dropTarget: readonly number[] | null;
  /** How many windows go into it: one, or a whole stack. */
  dropping: number;
  /** A window on its way out of its stack. */
  leaving: number | null;
  motionOf: (window: number) => Transition;
  /** The pill pressed: the stack whose top window is TOP is picked up whole. */
  onPickUpStack: (top: number, event: StagePointerEvent) => void;
  /** The pill clicked without moving: the stack whose top window is TOP fans out. */
  onOpenStack: (top: number) => void;
  onCarry: (event: StagePointerEvent) => void;
  onLetGo: (event: StagePointerEvent) => void;
}

/**
 * The selection on the canvas: the box being drawn, a ring around each
 * selected window, and above each stack a pill with how many windows it
 * holds, clear of every title bar in the pile. Dragging the pill moves the
 * stack and clicking it fans the stack out; a stack, or a lone window, that a
 * window or a stack is about to drop into lights up.
 */
export function Selection({
  places,
  selected,
  box,
  stacks,
  dropTarget,
  dropping,
  leaving,
  motionOf,
  onPickUpStack,
  onOpenStack,
  onCarry,
  onLetGo,
}: SelectionProps) {
  const pixel = useScreenPixel();
  // Where the pill was pressed: let go there, it was a click.
  const pressedAt = useRef<{ x: number; y: number } | null>(null);
  const isTarget = (ids: readonly number[]) => dropTarget !== null && dropTarget.every((id) => ids.includes(id));
  // A lone window a window is about to start a stack with.
  const startsStack = dropTarget !== null && !stacks.some(isTarget);
  const marker = (ids: readonly number[], target: boolean) => {
    // A window on its way out no longer counts.
    const staying = ids.filter((id) => id !== leaving);
    const rects = staying.flatMap((id) => places.get(id) ?? []);
    if (rects.length === 0 || (staying.length < 2 && !target)) return null;
    const top = staying.at(-1)!;
    return (
      <StackMarker
        key={ids.join("+")}
        pile={bounds(rects)}
        label={pillLabel(staying.length, target, startsStack, dropping)}
        target={target}
        transition={motionOf(top)}
        onPointerDown={(event) => {
          pressedAt.current = { x: event.screenX, y: event.screenY };
          onPickUpStack(top, event);
        }}
        onPointerMove={onCarry}
        onPointerUp={(event) => {
          onLetGo(event);
          const at = pressedAt.current;
          if (at && Math.hypot(event.screenX - at.x, event.screenY - at.y) < clickSlop) onOpenStack(top);
        }}
      />
    );
  };
  return (
    <Group>
      {[...selected].map((id) => {
        const rect = places.get(id);
        return rect && <SelectedRing key={id} rect={rect} transition={motionOf(id)} />;
      })}
      {stacks.map((ids) => marker(ids, isTarget(ids)))}
      {startsStack && marker(dropTarget, true)}
      {box && (
        <Rect {...box} radius={3 * pixel} fill={`${colors.accent}1f`} border={{ width: 1.5 * pixel, color: colors.accent }} />
      )}
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

interface StackMarkerProps extends Pick<BoxProps, "onPointerDown" | "onPointerMove" | "onPointerUp"> {
  /** The bounds of the windows in the stack. */
  pile: Rectangle;
  label: string;
  /** A window is about to drop in: it lights up. */
  target: boolean;
  transition: Transition;
}

/** A stack's pill, the handle that moves it, at the top right just above it; lit with a ring around it while a window is about to drop in. */
function StackMarker({ pile, label, target, transition, ...handlers }: StackMarkerProps) {
  const pixel = useScreenPixel();
  return (
    <Group>
      {target && <DropRing rect={pile} transition={transition} />}
      <ScreenSized x={pile.x} y={pile.y} transition={transition}>
        <Box style={styles.stackRow} width={pile.width / pixel}>
          <Box
            style={[styles.stackPill, target && styles.dropPill]}
            transition={motion.pop}
            initial={{ opacity: 0, transform: scale(0.8) }}
            {...handlers}
          >
            <Text style={stackLabel}>{label}</Text>
          </Box>
        </Box>
      </ScreenSized>
    </Group>
  );
}

/** Around a stack a window is about to drop into: it lights up to take it. */
function DropRing({ rect, transition }: { rect: Rectangle; transition: Transition }) {
  const pixel = useScreenPixel();
  const gap = 10 * pixel;
  return (
    <Rect
      x={rect.x - gap}
      y={rect.y - gap}
      width={rect.width + 2 * gap}
      height={rect.height + 2 * gap}
      radius={18 * pixel}
      border={{ width: 3 * pixel, color: colors.accent }}
      initial={{ opacity: 0 }}
      exit={{ opacity: 0 }}
      transition={transition}
    />
  );
}

/** Around a selected window. */
function SelectedRing({ rect, transition }: { rect: Rectangle; transition: Transition }) {
  const pixel = useScreenPixel();
  const gap = 4 * pixel;
  return (
    <Rect
      x={rect.x - gap}
      y={rect.y - gap}
      width={rect.width + 2 * gap}
      height={rect.height + 2 * gap}
      radius={14 * pixel}
      fill={`${colors.accent}14`}
      border={{ width: 2.5 * pixel, color: colors.accent }}
      transition={transition}
    />
  );
}
