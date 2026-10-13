import { useEffect, useRef } from "react";
import { instant, Rect, type LayoutBox, type Transition } from "proscenium";
import { useRetained } from "../../hooks/useFrozen.js";
import { motion } from "../../lib/theme.js";
import { barLayout } from "./layout.js";

interface HighlightProps {
  /** The item's box, from its onLayout. */
  target: LayoutBox | null;
  /** Whether the target's menu is open. */
  active: boolean;
}

/**
 * One highlight shared by all bar items. It glides between targets, appears on
 * the first one in place, and fades out where it was when there is none.
 */
export function Highlight({ target, active }: HighlightProps) {
  const shown = useRetained(target);
  const wasVisible = useRef(false);

  useEffect(() => {
    wasVisible.current = target !== null;
  });

  if (!shown) return null;

  const transition: Transition = wasVisible.current
    ? motion.glide
    : { default: motion.glide, x: instant, width: instant };

  return (
    <Rect
      position="absolute"
      x={shown.x}
      y={4}
      width={shown.width}
      height={barLayout.height - 8}
      radius={9}
      opacity={target ? 1 : 0}
      fill={active ? "#2f6fed1f" : "#17171a0f"}
      transition={transition}
    />
  );
}
