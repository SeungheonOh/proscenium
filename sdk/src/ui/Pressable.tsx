import { useEffect, useRef, useState, type ReactNode } from "react";
import { Box, Group } from "../components.js";
import type { StageClickEvent, StageContextMenuEvent, StageElement, StagePointerEvent } from "../events.js";
import { currentSession } from "../session.js";
import type { BoxProps, GroupProps, PointerHandlers, States } from "../props.js";
import { resolveStyle, type StateStyle } from "./styles.js";

/** What a control looks like it is doing: the pointer over it, holding it down, or keyboard focus on it. */
export interface PressState {
  hovered: boolean;
  pressed: boolean;
  focused: boolean;
}

export interface PressableProps
  extends Omit<BoxProps, "style" | "children" | "onClick" | "onContextMenu" | keyof PointerHandlers> {
  /**
   * A press let go of over it, or Enter or Space while it has keyboard focus: the click,
   * whose `count` is 0 when it came from a key.
   */
  onPress?: (event: StageClickEvent) => void;
  /**
   * The secondary button went down on it, or Menu or Shift+F10 while it has focus: open
   * a menu at the event's position (`screenX`/`screenY`, or `x`/`y` in the parent's space).
   */
  onContextMenu?: (event: StageContextMenuEvent) => void;
  /** Takes no presses or focus and shows no states. */
  disabled?: boolean;
  /**
   * Takes keyboard focus, shown, as it appears: Tab only moves focus once something has
   * it, so give the first control of a panel, dialog or world this to make it keyboard-ready.
   */
  autoFocus?: boolean;
  /**
   * Whether it takes keyboard focus; true by default. Tab reaches it at a `tabIndex` of 0
   * (the default) or more; at -1 only a press or `focusNode` focuses it.
   */
  focusable?: boolean;
  /**
   * Values to show while the pointer is over it, holds it down, or keyboard focus is on
   * it, resolved in the compositor in the frame the pointer arrives:
   * `{ hover: { fill: "#fff1" }, pressed: { transform: [scale(0.97)] }, focusVisible: { border: … } }`.
   * Children with `states={{ group: true, … }}` show the same states.
   */
  states?: States;
  /** A style, or a function of the press state giving one (this renders as the state changes). */
  style?: StateStyle<BoxProps, PressState>;
  /** Content, or a function of the press state giving it (this renders as the state changes). */
  children?: ReactNode | ((state: PressState) => ReactNode);
}

const leftButton = 272;
const resting: PressState = { hovered: false, pressed: false, focused: false };

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
 * let go of over it, so sliding off cancels, or on Enter or Space while it has
 * keyboard focus, which Tab gives it. Its look by state comes from `states`, which
 * the compositor resolves as the pointer moves, with no render at all; give it a
 * `transition` and the compositor animates between them.
 *
 *     <Pressable onPress={save} style={styles.button}
 *                states={{ hover: { fill: colors.hover }, pressed: { fill: colors.pressed } }}>
 *
 * A `style` or `children` that is a function of the press state still works: then
 * the state is tracked here, and this control renders as it changes (twice per
 * hover and per press, never on pointer motion).
 */
export function Pressable({ onPress, onContextMenu, disabled = false, focusable = true, autoFocus = false, states, style,
  children, cursor = "pointer", ref, ...box }: PressableProps) {
  const own = useRef<StageElement | null>(null);
  useEffect(() => {
    if (autoFocus && !disabled && own.current) currentSession().focusNode(own.current, { visible: true });
  }, []);
  const setRef = (node: StageElement | null) => {
    own.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) (ref as { current: StageElement | null }).current = node;
  };
  const tracked = typeof style === "function" || typeof children === "function";
  const control = {
    stateGroup: true,
    states: disabled ? undefined : states,
    tabIndex: disabled || !focusable ? undefined : box.tabIndex ?? 0,
    onClick: disabled || !onPress ? undefined : (event: StageClickEvent) => onPress(event),
    onContextMenu: disabled ? undefined : onContextMenu,
  } satisfies BoxProps;
  if (!tracked) {
    return (
      <Box {...box} {...control} ref={setRef} cursor={disabled ? undefined : cursor} style={style as BoxProps["style"]}>
        {children as ReactNode}
      </Box>
    );
  }
  return <TrackedPressable box={{ ...box, ref: setRef }} control={control} disabled={disabled} cursor={cursor} style={style}>
    {children}
  </TrackedPressable>;
}

interface TrackedProps {
  box: Omit<BoxProps, "style" | "children">;
  control: BoxProps;
  disabled: boolean;
  cursor: BoxProps["cursor"];
  style: PressableProps["style"];
  children: PressableProps["children"];
}

/** A Pressable whose style or content is a function of its state, which it tracks itself. */
function TrackedPressable({ box, control, disabled, cursor, style, children }: TrackedProps) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  // While a press is held: whether the pointer is still over the control. Motion is heard only then.
  const [held, setHeld] = useState<"over" | "off" | null>(null);
  const holding = useRef(false);
  const state: PressState = disabled
    ? resting
    : { hovered, pressed: held === "over", focused };
  return (
    <Box {...box} {...control} style={resolveStyle(style, state)}
         onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}>
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
        onPointerUp={() => {
          if (!holding.current) return;
          holding.current = false;
          setHeld(null);
        }}
      />
    </Box>
  );
}
