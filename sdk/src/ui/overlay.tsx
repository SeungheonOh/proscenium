import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode,
  type RefObject } from "react";
import { Box, Rect, Screen } from "../components.js";
import { useOutputs } from "../hooks.js";
import { createPortal, getCamera, watchLayout } from "../index.js";
import type { StageElement, StageKeyboardEvent } from "../events.js";
import type { BoxProps, Style } from "../props.js";
import { currentSession } from "../session.js";
import { instant } from "../motion.js";
import { scale } from "../transform.js";
import type { OutputInfo } from "../store.js";
import { anchorRect, outputBounds, place, takesFocus, type Align, type OutputRect, type Placement,
  type Side } from "./placement.js";
import { StyleSheet } from "./styles.js";
import { makeStyles } from "./theme.js";

// Floating things (menus, popovers, tooltips, dialogs) draw above everything else on an
// output. They mount in a layer: a Screen per output that <OverlayHost> puts after the
// world, into which each floating surface renders through a portal, keeping the
// context, state and events of where it was declared. Without an OverlayHost a surface
// renders a Screen of its own where it is declared, which works but paints in tree
// order, under anything declared after it.

const LayerContext = createContext<Readonly<Record<string, StageElement>> | null>(null);

/**
 * The layer floating surfaces draw in, above CHILDREN: put it around the world, once,
 * near the root: `<OverlayHost><ThemeProvider theme={…}>…</ThemeProvider></OverlayHost>`.
 */
export function OverlayHost({ children }: { children?: ReactNode }) {
  const outputs = useOutputs();
  const [layers, setLayers] = useState<Readonly<Record<string, StageElement>>>({});
  const refs = useRef(new Map<string, (node: StageElement | null) => void>());
  const refFor = (name: string) => {
    let ref = refs.current.get(name);
    if (!ref) {
      ref = (node) => setLayers((all) => {
        if (node === (all[name] ?? null)) return all;
        const next = { ...all };
        if (node) next[name] = node;
        else delete next[name];
        return next;
      });
      refs.current.set(name, ref);
    }
    return ref;
  };
  return (
    <LayerContext.Provider value={layers}>
      {children}
      {outputs.map((output) => <Screen key={output.name} output={output.name} {...{ ref: refFor(output.name) }} />)}
    </LayerContext.Provider>
  );
}

/** CHILDREN drawn above everything on OUTPUT, in its logical pixels. */
export function Overlay({ output, children }: { output: string; children?: ReactNode }) {
  const layers = useContext(LayerContext);
  if (!layers) return <Screen output={output}>{children}</Screen>;
  const layer = layers[output];
  return layer ? createPortal(children, layer) : null;
}

/** Catches presses outside a floating surface, on every output: a press there dismisses it. */
export function Dismisser({ onDismiss, fill }: { onDismiss: () => void; fill?: BoxProps["fill"] }) {
  const outputs = useOutputs();
  return outputs.map((output) => (
    <Overlay key={output.name} output={output.name}>
      <Rect x={0} y={0} width={output.width} height={output.height} fill={fill}
            onPointerDown={(event) => {
              event.stopPropagation();
              onDismiss();
            }}
            onWheel={(event) => event.stopPropagation()} />
    </Overlay>
  ));
}

/** What a floating surface is placed beside: a node (from a ref), or a box or point on an output. */
export type Anchor = RefObject<StageElement | null> | StageElement | OutputRect | { output: string; x: number; y: number };

function isRef(anchor: Anchor): anchor is RefObject<StageElement | null> {
  return "current" in anchor;
}

/** ANCHOR's box on its output, or null while it has none. */
export function resolveAnchor(anchor: Anchor | null | undefined, outputs: readonly OutputInfo[]): OutputRect | null {
  if (!anchor) return null;
  const node = isRef(anchor) ? anchor.current : "id" in anchor && "type" in anchor ? anchor as StageElement : null;
  if (node) return anchorRect(node, outputs, (output) => getCamera(output));
  if (isRef(anchor) || !("output" in anchor)) return null;
  return { width: 0, height: 0, ...anchor } as OutputRect;
}

/** The node behind ANCHOR, if it is one. */
export function anchorNode(anchor: Anchor | null | undefined): StageElement | null {
  if (!anchor) return null;
  if (isRef(anchor)) return anchor.current;
  return "id" in anchor && "type" in anchor ? anchor as StageElement : null;
}

const hiddenScale = [scale(0.96)];
const shownScale = [scale(1)];

const useSurfaceStyles = makeStyles(({ motion }) => ({
  ...StyleSheet.create({
    surface: { position: "absolute", groupOpacity: true },
  }),
  // Opening is quick and settles without bounce; colors and opacity fade critically damped.
  // Its place is set at once: it is measured, then placed, before it first shows.
  transition: { default: motion.fade, transform: motion.pop, x: instant, y: instant },
}));

export interface FloatingProps {
  /** Placed beside this; see Anchor. */
  anchor: Anchor;
  side?: Side;
  align?: Align;
  /** Pixels from the anchor. */
  gap?: number;
  /** Line up the other edge when the aligned one leaves no room, rather than shifting: context menus. */
  flipAlign?: boolean;
  /** At least as wide as the anchor: a select's list. */
  matchWidth?: boolean;
  /** Called with where it was placed. */
  onPlace?: (placement: Placement & OutputRect) => void;
  style?: Style<BoxProps>;
  children?: ReactNode;
  /** Props for the surface Box: handlers, focus, a ref. */
  surface?: BoxProps;
}

/**
 * A surface floating beside an anchor, above everything, placed so it never leaves the
 * output: it flips to the anchor's other side when only that has room, and shifts
 * along the edge. It measures itself before it is first shown, and grows in from the
 * anchor with a short scale and fade (and shrinks out as it goes), as one layer.
 */
export function Floating({ anchor, side, align, gap, flipAlign, matchWidth, onPlace, style, children,
                           surface }: FloatingProps) {
  const outputs = useOutputs();
  const styles = useSurfaceStyles();
  // Where its anchor is: read as it opens, and again when the outputs change or the
  // anchor, or a Box around it, is laid out anew while it shows.
  const [rect, setRect] = useState(() => resolveAnchor(anchor, outputs));
  const latest = useRef({ anchor, outputs });
  latest.current = { anchor, outputs };
  const reread = () => setRect((current) => {
    const next = resolveAnchor(latest.current.anchor, latest.current.outputs);
    return next && current && next.output === current.output && next.x === current.x && next.y === current.y
      && next.width === current.width && next.height === current.height ? current : next ?? current;
  });
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    reread();
  }, [outputs]);
  useEffect(() => {
    const node = anchorNode(anchor);
    if (!node) return;
    const stops: (() => void)[] = [];
    type Tree = StageElement & { parent: Tree | null; type: string };
    for (let at = node as Tree | null; at && at.type !== "screen"; at = at.parent) stops.push(watchLayout(at, reread));
    return () => stops.forEach((stop) => stop());
  }, [anchorNode(anchor)]);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const bounds = rect ? outputBounds(outputs, rect.output) : null;
  const placement = rect && bounds
    ? place(rect, size ?? { width: 0, height: 0 }, bounds, { side, align, gap, flipAlign })
    : null;
  useLayoutEffect(() => {
    if (placement && rect && size) onPlace?.({ ...placement, ...rect, width: size.width, height: size.height,
                                                x: placement.x, y: placement.y });
  }, [placement?.x, placement?.y, size?.width, size?.height]);
  if (!rect || !placement) return null;
  return (
    <Overlay output={rect.output}>
      <Box {...surface} style={[styles.surface, style]} x={placement.x} y={placement.y}
           minWidth={matchWidth ? rect.width : undefined}
           originX={placement.originX} originY={placement.originY}
           // Shown only once measured, so it never appears at a guess and jumps.
           opacity={size ? 1 : 0} transform={shownScale}
           initial={{ opacity: 0, transform: hiddenScale }} exit={{ opacity: 0, transform: hiddenScale }}
           transition={styles.transition}
           onLayout={(box) => {
             if (!size || size.width !== box.width || size.height !== box.height) {
               setSize({ width: box.width, height: box.height });
             }
             surface?.onLayout?.(box);
           }}>
        {children}
      </Box>
    </Overlay>
  );
}

/** Give focus to NODE once it has been sent, by keyboard (shown) or not. */
export function focusLater(node: StageElement | null | undefined, visible?: boolean): void {
  if (node) currentSession().focusNode(node, visible === undefined ? {} : { visible });
}

/**
 * Keeps where focus was when a floating surface opened and gives it back as it closes:
 * to the anchor, if it takes focus. OPEN says whether the surface shows.
 */
export function useReturnFocus(open: boolean, anchor: Anchor | null | undefined): void {
  const node = anchorNode(anchor);
  const target = useRef<StageElement | null>(null);
  useEffect(() => {
    if (open) {
      target.current = takesFocus(node) ? node : null;
      return;
    }
    if (target.current) focusLater(target.current);
    target.current = null;
  }, [open]);
}

export interface PopoverProps extends Omit<FloatingProps, "children"> {
  /** Shown while true. */
  open: boolean;
  /** A press outside it or Escape asks it to close. */
  onClose?: () => void;
  /** Take keyboard focus when it opens (the surface, for its content to pass on); true by default. */
  autoFocus?: boolean;
  /** Presses outside close it, and do nothing else; true by default. */
  modal?: boolean;
  children?: ReactNode;
}

const usePopoverStyles = makeStyles(({ colors, radii, shadows }) => StyleSheet.create({
  popover: { flexDirection: "column", padding: 12, radius: radii.md, fill: colors.popover,
             border: { width: 1, color: colors.popoverLine }, shadow: shadows.float },
}));

/**
 * A surface floating beside an anchor, for content of any kind: `<Popover open={open}
 * onClose={() => setOpen(false)} anchor={buttonRef}>…</Popover>`. A press outside it or
 * Escape closes it, Tab keeps within it, and focus goes back to the anchor as it closes.
 */
export function Popover({ open, onClose, autoFocus = true, modal = true, style, surface, children,
                          ...floating }: PopoverProps) {
  const styles = usePopoverStyles();
  const self = useRef<StageElement | null>(null);
  useReturnFocus(open, floating.anchor);
  useEffect(() => {
    if (open && autoFocus) focusLater(self.current);
  }, [open]);
  const onKeyDown = useCallback((event: StageKeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose?.();
    }
    surface?.onKeyDown?.(event);
  }, [onClose, surface?.onKeyDown]);
  if (!open) return null;
  return (
    <>
      {modal && onClose && <Dismisser onDismiss={onClose} />}
      <Floating {...floating} style={[styles.popover, style]}
                surface={{ ...surface, ref: (node: StageElement | null) => { self.current = node; },
                           tabIndex: -1, focusScope: true, onKeyDown }}>
        {children}
      </Floating>
    </>
  );
}

