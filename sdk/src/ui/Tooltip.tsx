import { cloneElement, isValidElement, useEffect, useRef, useState, type ReactElement, type ReactNode,
  type Ref } from "react";
import { useOutputs } from "../hooks.js";
import type { StageElement, StageFocusEvent, StagePointerEvent } from "../events.js";
import type { BoxProps, Style } from "../props.js";
import { Floating } from "./overlay.js";
import { rememberAnchor, type Align, type Side } from "./placement.js";
import { StyleSheet } from "./styles.js";
import { makeStyles } from "./theme.js";
import { Label } from "./views.js";

// A tooltip waits before it shows, as every desktop's does, so passing over a control
// shows nothing; once one has shown, the next shows at once while the pointer moves
// from control to control, until it rests away from them a moment. A press hides it,
// and keyboard focus that came by keyboard shows it.

/** How long the pointer rests before a tooltip shows, and how long after one hides the next still shows at once. */
const showDelay = 500, warmFor = 600;

let lastHidden = -Infinity;
let showing = 0;

export interface TooltipProps {
  /** What it says: a few words, or content of its own. */
  content: ReactNode;
  /** The control it describes: one element, which takes pointer and focus handlers and a ref. */
  children: ReactElement;
  /** The side of the control it shows on; above by default, below where there is no room. */
  side?: Side;
  align?: Align;
  /** Show nothing. */
  disabled?: boolean;
  style?: Style<BoxProps>;
}

const useStyles = makeStyles(({ colors, radii, type }) => StyleSheet.create({
  tip: { flexDirection: "row", alignItems: "center", paddingX: 8, paddingY: 4, radius: radii.sm, fill: colors.tooltip,
         maxWidth: 280, shadow: [{ color: "#0000001f", blur: 6, y: 2 }] },
  text: { ...type.small, color: colors.onTooltip, maxLines: 3 },
}));

type Handlers = {
  ref?: Ref<StageElement>;
  onPointerEnter?: (event: StagePointerEvent) => void;
  onPointerLeave?: (event: StagePointerEvent) => void;
  onPointerDown?: (event: StagePointerEvent) => void;
  onFocus?: (event: StageFocusEvent) => void;
  onBlur?: (event: StageFocusEvent) => void;
};

/** Sets REF, a callback or an object ref, to NODE. */
function assign(ref: Ref<StageElement> | undefined, node: StageElement | null): void {
  if (typeof ref === "function") ref(node);
  else if (ref) (ref as { current: StageElement | null }).current = node;
}

/**
 * Words about a control, shown as the pointer rests on it:
 * `<Tooltip content="Close"><IconButton icon={close} onPress={…} /></Tooltip>`. The
 * control takes the pointer and focus handlers it needs, its own still called.
 */
export function Tooltip({ content, children, side = "top", align = "center", disabled = false, style }: TooltipProps) {
  const styles = useStyles();
  const outputs = useOutputs();
  const node = useRef<StageElement | null>(null);
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // A press hides it until the pointer leaves and comes back.
  const pressed = useRef(false);
  useEffect(() => () => {
    clearTimeout(timer.current);
  }, []);
  useEffect(() => {
    if (!shown) return;
    showing++;
    return () => {
      showing--;
      lastHidden = performance.now();
    };
  }, [shown]);
  if (!isValidElement(children)) return children;
  const own = children.props as Handlers;
  const show = (now: boolean) => {
    if (disabled || pressed.current) return;
    clearTimeout(timer.current);
    if (now || showing > 0 || performance.now() - lastHidden < warmFor) setShown(true);
    else timer.current = setTimeout(() => setShown(true), showDelay);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setShown(false);
  };
  const handlers: Handlers = {
    ref: (element: StageElement | null) => {
      node.current = element;
      assign(own.ref, element);
    },
    onPointerEnter: (event) => {
      own.onPointerEnter?.(event);
      pressed.current = false;
      if (node.current) rememberAnchor(node.current, event, outputs);
      show(false);
    },
    onPointerLeave: (event) => {
      own.onPointerLeave?.(event);
      pressed.current = false;
      hide();
    },
    onPointerDown: (event) => {
      own.onPointerDown?.(event);
      pressed.current = true;
      hide();
    },
    onFocus: (event) => {
      own.onFocus?.(event);
      if (event.visible) show(true);
    },
    onBlur: (event) => {
      own.onBlur?.(event);
      hide();
    },
  };
  return (
    <>
      {cloneElement(children as ReactElement<Handlers>, handlers)}
      {shown && !disabled && (
        <Floating anchor={node} side={side} align={align} gap={6} style={[styles.tip, style]}>
          {typeof content === "string" ? <Label style={styles.text}>{content}</Label> : content}
        </Floating>
      )}
    </>
  );
}
