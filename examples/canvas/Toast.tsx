import { useCallback, useEffect, useRef, useState } from "react";
import { Rect } from "proscenium";
import { BarText } from "../components/bar/BarText.js";
import { FloatingPill } from "../components/FloatingPill.js";
import { useRetained } from "../hooks/useFrozen.js";
import { colors, motion } from "../lib/theme.js";

/** What just changed, said briefly at the bottom of the screen. */
export interface ToastMessage {
  /** What it is: "Magnet", "Guides". */
  label: string;
  /** What it is now: "On · Firm", "3 columns". */
  detail?: string;
  /** The dot before it: on (the accent), off (grey), or a colour of its own. */
  dot?: "on" | "off" | string;
}

/** How long a message stays before it sinks away, in milliseconds. */
const showFor = 1400;

/** A message to show and a function that shows one, replacing whatever was showing. */
export function useToast(): [ToastMessage | null, (message: ToastMessage) => void] {
  const [message, setMessage] = useState<ToastMessage | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    return () => clearTimeout(timer.current);
  }, []);
  const show = useCallback((next: ToastMessage) => {
    setMessage(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(null), showFor);
  }, []);
  return [message, show];
}

/** The colour of a message's DOT, or undefined for none. */
function dotColor(dot: ToastMessage["dot"]): string | undefined {
  if (dot === "on") return colors.accent;
  if (dot === "off") return "#17171a40";
  return dot;
}

/** The toast: a frosted pill that rises at the bottom of every output while a message shows. */
export function Toast({ message }: { message: ToastMessage | null }) {
  // The last message stays in the pill while it sinks away.
  const shown = useRetained(message);
  if (!shown) return null;
  const dot = dotColor(shown.dot);
  return (
    <FloatingPill shown={message !== null}>
      {dot && <Rect width={10} height={10} radius={5} fill={dot} transition={motion.pop} />}
      {/* New words fade in while the pill grows to hold them, and never show outside it. */}
      <BarText key={`label-${shown.label}`} weight={650} color={colors.ink} initial={{ opacity: 0 }} transition={motion.pop}>
        {shown.label}
      </BarText>
      {shown.detail && (
        <BarText key={`detail-${shown.detail}`} color={colors.muted} initial={{ opacity: 0 }} transition={motion.pop}>
          {shown.detail}
        </BarText>
      )}
    </FloatingPill>
  );
}
