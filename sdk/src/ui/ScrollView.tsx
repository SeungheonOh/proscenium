import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";
import { Box, Rect } from "../components.js";
import type { StageWheelEvent } from "../events.js";
import type { LayoutBox } from "../layout.js";
import type { BoxProps, Style } from "../props.js";
import { spring } from "../motion.js";
import { StyleSheet } from "./styles.js";
import { makeStyles } from "./theme.js";

// Content taller than its box, moved by the wheel or two fingers. The content
// is one Box under a clipping viewport; scrolling changes only its y, which
// the compositor animates, so a notch costs one small commit and no layout.

/** Ways to scroll from outside: `ref.current?.scrollToEnd()`. */
export interface ScrollViewHandle {
  scrollTo(offset: number): void;
  scrollToEnd(): void;
}

export interface ScrollViewProps extends Omit<BoxProps, "children" | "onWheel" | "ref"> {
  children?: ReactNode;
  /** While the end is in view, keep it in view as the content grows: a chat or a log. */
  stickToEnd?: boolean;
  /** The Box holding the content. */
  contentStyle?: Style<BoxProps>;
  ref?: Ref<ScrollViewHandle>;
}

const glide = spring({ duration: 0.28, bounce: 0 });
/** Pixels per wheel notch; finger and continuous scrolling move one to one. */
const notch = 56;

const useStyles = makeStyles(({ colors }) => ({
  ...StyleSheet.create({
    viewport: { clip: true, flexDirection: "column" },
    content: { position: "absolute", x: 0, width: "100%", flexDirection: "column" },
    thumb: { position: "absolute", width: 4, radius: 2, fill: colors.faint },
  }),
}));

/** A Box whose content scrolls: `<ScrollView flexGrow={1} stickToEnd>{messages}</ScrollView>`. */
export function ScrollView({ children, stickToEnd = false, contentStyle, style, ref, ...box }: ScrollViewProps) {
  const styles = useStyles();
  const [viewport, setViewport] = useState<LayoutBox | null>(null);
  const [contentHeight, setContentHeight] = useState(0);
  const [offset, setOffset] = useState(0);
  // Whether the end was in view before the content last changed.
  const atEnd = useRef(true);
  const [moving, setMoving] = useState(false);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const height = viewport?.height ?? 0;
  const max = Math.max(0, contentHeight - height);
  const clamped = Math.min(Math.max(offset, 0), max);

  useEffect(() => {
    if (stickToEnd && atEnd.current && clamped !== max) setOffset(max);
  }, [contentHeight, height]);

  useEffect(() => () => clearTimeout(idle.current), []);

  const scrollTo = (next: number) => {
    const to = Math.min(Math.max(next, 0), max);
    atEnd.current = to >= max - 2;
    setOffset(to);
  };
  useImperativeHandle(ref, () => ({ scrollTo, scrollToEnd: () => scrollTo(Number.MAX_SAFE_INTEGER) }), [max]);

  const wheel = (event: StageWheelEvent) => {
    if (event.orientation !== "vertical" || max === 0) return;
    event.stopPropagation();
    const step = event.source === "wheel" || event.source === "wheel-tilt"
      ? (event.discrete || Math.sign(event.delta)) * notch : event.delta;
    scrollTo(clamped + step);
    // The thumb shows while scrolling and a moment after.
    setMoving(true);
    clearTimeout(idle.current);
    idle.current = setTimeout(() => setMoving(false), 900);
  };

  const thumbHeight = max > 0 && height > 0 ? Math.max(24, height * height / contentHeight) : 0;
  const thumbY = max > 0 ? (height - thumbHeight) * clamped / max : 0;
  return (
    <Box {...box} style={[styles.viewport, style]} onLayout={setViewport} onWheel={wheel}>
      <Box style={[styles.content, contentStyle]} y={-clamped} transition={glide}
           onLayout={(layout) => setContentHeight(layout.height)}>
        {children}
      </Box>
      {thumbHeight > 0 && (
        <Rect style={styles.thumb} x={(viewport?.width ?? 0) - 6} y={thumbY} height={thumbHeight}
              opacity={moving ? 1 : 0} transition={glide} />
      )}
    </Box>
  );
}
