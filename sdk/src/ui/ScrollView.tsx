import { useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";
import { Box, Rect } from "../components.js";
import type { StageElement } from "../events.js";
import type { BoxProps, Style } from "../props.js";
import { currentSession } from "../session.js";
import { StyleSheet } from "./styles.js";
import { makeStyles } from "./theme.js";

// Content taller than its box, scrolled by the compositor: the viewport is a
// Box with `scroll`, whose offset the compositor owns, so the wheel glides,
// fingers track and coast, and the ends stretch with no commit at all. The
// content is one Box laid out at its own height, whose extent the host sends;
// the thumb is a Rect the compositor places, shows while scrolling and fades.

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

/** The thumb's width, at rest and under the pointer, and its gap from the edge. */
const thin = 4, wide = 8, edge = 2;

const useStyles = makeStyles(({ colors, motion }) => StyleSheet.create({
  viewport: { flexDirection: "column" },
  content: { position: "absolute", x: 0, y: 0, width: "100%", flexDirection: "column" },
  // `y` is the inset at either end of the track and `height` the shortest the thumb gets.
  thumb: { position: "absolute", y: edge, width: thin, height: 24, radius: thin / 2, fill: colors.faint,
           transition: motion.scroll },
  thumbHover: { fill: colors.muted },
}));

/** A Box whose content scrolls: `<ScrollView flexGrow={1} stickToEnd>{messages}</ScrollView>`. */
export function ScrollView({ children, stickToEnd = false, contentStyle, style, ref, onLayout, ...box }: ScrollViewProps) {
  const styles = useStyles();
  const viewport = useRef<StageElement>(null);
  const [width, setWidth] = useState(0);
  useImperativeHandle(ref, () => ({
    // Whole pixels: content resting between pixels draws its text blurred.
    scrollTo: (offset: number) => {
      if (viewport.current) currentSession().scrollTo(viewport.current, { y: Math.round(offset) });
    },
    // Past any content: the compositor keeps the offset within it.
    scrollToEnd: () => {
      if (viewport.current) currentSession().scrollTo(viewport.current, { y: 1e9 });
    },
  }), []);
  return (
    <Box {...box} ref={viewport} style={[styles.viewport, style]} scroll="y" stickToEnd={stickToEnd}
         onLayout={(layout) => {
           setWidth(layout.width);
           onLayout?.(layout);
         }}>
      <Box style={[styles.content, contentStyle]}>{children}</Box>
      <Rect style={styles.thumb} scrollThumb="y" x={width - thin - edge}
            states={{ hover: { x: width - wide - edge, width: wide, radius: wide / 2, ...styles.thumbHover } }} />
    </Box>
  );
}
