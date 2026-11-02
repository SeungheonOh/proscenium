import { useRef, useState, type ReactNode } from "react";
import { Box, Group } from "../components.js";
import type { StagePointerEvent } from "../events.js";
import type { BoxProps, GroupProps, PointerHandlers } from "../props.js";
import { resolveStyle, type StateStyle } from "./styles.js";

/** What a control looks like it is doing: the pointer over it, or holding it down. */
export interface PressState {
  hovered: boolean;
  pressed: boolean;
}

export interface PressableProps extends Omit<BoxProps, "style" | "children" | keyof PointerHandlers> {
  /** A press let go of over it. */
  onPress?: () => void;
  /** Takes no presses and shows no hover or press. */
  disabled?: boolean;
  /** A style, or a function of the press state giving one. */
  style?: StateStyle<BoxProps, PressState>;
  /** Content, or a function of the press state giving it. */
  children?: ReactNode | ((state: PressState) => ReactNode);
}

const leftButton = 272;

/**
 * Over the content, on top: the node every press lands on, whatever the content
 * is, so its events' local coordinates are always in the control's own box.
 */
const hitArea = { position: "absolute", x: 0, y: 0, width: "100%", height: "100%" } satisfies GroupProps;

/** Whether the pointer is over the hit area an event came to, which hears a held press wherever it goes. */
function over(event: StagePointerEvent): boolean {
  const box = event.currentTarget.layout;
  return box !== null && event.localX >= 0 && event.localY >= 0 && event.localX <= box.width && event.localY <= box.height;
}

/**
 * A Box that can be pressed, as React Native's: `onPress` fires when a press is
 * let go of over it, so sliding off cancels. Hover and press state live here
 * alone, so only this control renders as they change, twice per hover and per
 * press, never on pointer motion; give `style` a `transition` and the
 * compositor animates between the states.
 *
 *     <Pressable onPress={save} style={({ hovered, pressed }) => [styles.button, hovered && styles.hover]}>
 */
export function Pressable({ onPress, disabled = false, style, children, cursor = "pointer", ...box }: PressableProps) {
  const [hovered, setHovered] = useState(false);
  // While a press is held: whether the pointer is still over the control. Motion is heard only then.
  const [held, setHeld] = useState<"over" | "off" | null>(null);
  const holding = useRef(false);
  const state: PressState = { hovered: hovered && !disabled, pressed: held === "over" && !disabled };
  return (
    <Box {...box} style={resolveStyle(style, state)}>
      {typeof children === "function" ? children(state) : children}
      <Group
        style={hitArea}
        cursor={disabled ? undefined : cursor}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onPointerDown={(event) => {
          if (disabled || (event.button ?? leftButton) !== leftButton) return;
          holding.current = true;
          setHeld("over");
        }}
        onPointerMove={held ? (event) => setHeld(over(event) ? "over" : "off") : undefined}
        onPointerUp={(event) => {
          if (!holding.current) return;
          holding.current = false;
          setHeld(null);
          if (over(event) && !disabled) onPress?.();
        }}
      />
    </Box>
  );
}
