import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Box, Rect } from "../components.js";
import { useOutputs } from "../hooks.js";
import type { StageElement, StageKeyboardEvent } from "../events.js";
import type { BoxProps, Style } from "../props.js";
import { scale } from "../transform.js";
import { instant } from "../motion.js";
import { focusLater, Overlay, useReturnFocus, type Anchor } from "./overlay.js";
import { StyleSheet } from "./styles.js";
import { makeStyles } from "./theme.js";
import { Label } from "./views.js";

export interface DialogProps {
  /** Shown while true. */
  open: boolean;
  /** Escape, or a press on the scrim when `dismissable`, asks it to close. */
  onClose?: () => void;
  title?: string;
  /** A sentence or two under the title. */
  description?: string;
  /** Buttons along the bottom, right-aligned: the confirming one last. */
  actions?: ReactNode;
  children?: ReactNode;
  /** Pixels; defaults to 420. */
  width?: number;
  /** The output it shows on; the first by default. Its scrim covers every output. */
  output?: string;
  /** A press on the scrim closes it; true by default. */
  dismissable?: boolean;
  /** Where focus goes when it closes: the control that opened it, if that takes focus. */
  returnFocus?: Anchor;
  /**
   * What takes focus, shown, as it opens: its safest action, or a field. Without one the
   * dialog itself does, and Tab then reaches its first control; Escape always closes it.
   */
  initialFocus?: RefObject<StageElement | null>;
  style?: Style<BoxProps>;
}

const hidden = [scale(0.96)];
const shown = [scale(1)];

const useStyles = makeStyles(({ colors, radii, shadows, motion, type }) => ({
  ...StyleSheet.create({
    surface: { position: "absolute", flexDirection: "column", gap: 8, padding: 20, radius: radii.lg, fill: colors.popover,
               border: { width: 1, color: colors.popoverLine }, shadow: shadows.modal, groupOpacity: true },
    description: { ...type.body, color: colors.muted },
    actions: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 12 },
  }),
  scrim: colors.scrim,
  transition: { default: motion.fade, transform: motion.pop, x: instant, y: instant },
  scrimMotion: motion.fade,
}));

/**
 * A modal dialog over a dimmed screen: `<Dialog open={asking} onClose={cancel} title="Delete 3 files?"
 * actions={<><Button label="Cancel" onPress={cancel} /><Button label="Delete" variant="danger" onPress={remove} /></>} />`.
 * Tab keeps within it and Escape closes it; give `returnFocus` (the button that opened it) for
 * focus to go back there after.
 */
export function Dialog({ open, onClose, title, description, actions, children, width = 420, output, dismissable = true,
                         returnFocus, initialFocus, style }: DialogProps) {
  useReturnFocus(open, returnFocus);
  if (!open) return null;
  return <DialogSurface {...{ onClose, title, description, actions, children, width, output, dismissable, initialFocus,
                              style }} />;
}

function DialogSurface({ onClose, title, description, actions, children, width, output, dismissable, initialFocus,
                         style }: Omit<DialogProps, "open">) {
  const styles = useStyles();
  const outputs = useOutputs();
  const surface = useRef<StageElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const screen = outputs.find((candidate) => candidate.name === output) ?? outputs[0];
  useEffect(() => {
    if (initialFocus?.current) focusLater(initialFocus.current, true);
    else focusLater(surface.current, false);
  }, []);
  if (!screen) return null;
  const onKeyDown = (event: StageKeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onClose?.();
  };
  // A little above the middle, where the eye expects a dialog.
  const x = size ? Math.round((screen.width - size.width) / 2) : 0;
  const y = size ? Math.round((screen.height - size.height) * 0.42) : 0;
  return (
    <>
      {outputs.map((each) => (
        <Overlay key={each.name} output={each.name}>
          <Rect x={0} y={0} width={each.width} height={each.height} fill={styles.scrim} opacity={1}
                initial={{ opacity: 0 }} exit={{ opacity: 0 }} transition={styles.scrimMotion}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  if (dismissable) onClose?.();
                }}
                onWheel={(event) => event.stopPropagation()} />
        </Overlay>
      ))}
      <Overlay output={screen.name}>
        <Box ref={(node: StageElement | null) => { surface.current = node; }}
             style={[styles.surface, style]} width={width} x={x} y={y}
             tabIndex={-1} focusScope onKeyDown={onKeyDown}
             opacity={size ? 1 : 0} transform={shown} initial={{ opacity: 0, transform: hidden }}
             exit={{ opacity: 0, transform: hidden }} transition={styles.transition}
             onLayout={(box) => {
               if (!size || size.width !== box.width || size.height !== box.height) setSize({ width: box.width, height: box.height });
             }}>
          {title !== undefined && <Label variant="title" maxLines={2}>{title}</Label>}
          {description !== undefined && <Label style={styles.description} maxLines={8}>{description}</Label>}
          {children}
          {actions && <Box style={styles.actions}>{actions}</Box>}
        </Box>
      </Overlay>
    </>
  );
}
