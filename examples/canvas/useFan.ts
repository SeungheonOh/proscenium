import { useCallback, useEffect, useEffectEvent, useRef, useState, type SetStateAction } from "react";
import { useInput, useKeyboardGrab, useModifiers, type Modifier, type Rectangle, type StagePointerEvent } from "proscenium";
import { fanAt, fanLayers } from "./stacks.js";

/** How long Alt+Tab is held before the fan opens: a quick tap just shuffles. */
const openDelay = 150;

/** How far, in screen pixels, a press moves before it is a drag rather than a click. */
const dragAfter = 4;

/** A card being dragged along the fan to a new place in it. */
interface FanDrag {
  window: number;
  /** Where the pointer is, on the canvas. */
  x: number;
  y: number;
  /** Where the pointer holds the card, from its middle. */
  dx: number;
  dy: number;
  /** Where it was pressed, on the screen. */
  pressedAt: { x: number; y: number };
  moved: boolean;
  /** The order before the drag. */
  before: readonly number[];
}

/** A stack fanned out to pick from. */
export interface Fan {
  /** The stack's windows left to right: the front one first, then the order Alt+Tab goes through them. */
  order: readonly number[];
  /** Which one is picked if let go now. */
  at: number;
  /** Showing yet: Alt+Tab waits a moment first. */
  shown: boolean;
  /** Opened with Alt+Tab, picked when Alt is let go; or from the pill, picked with a click or Return. */
  by: "keys" | "pill";
  drag?: FanDrag | undefined;
}

/**
 * A stack fanned out like a hand of cards over PLACES to pick a window from,
 * as Alt+Tab opens a switcher: Tab, the arrows and the pointer go through it,
 * letting go of Alt (or Return, or a click on a window) picks, Escape puts it
 * back as it was. A card dragged along it takes a new place in the stack.
 * ONPICK hears the window picked, and whether the fan never showed; ONREORDER
 * the fan's new order, left to right. A world that opens it with another chord
 * names the MODIFIER whose release picks.
 */
export function useFan(
  places: ReadonlyMap<number, Rectangle>,
  onPick: (window: number, quick: boolean) => void,
  onReorder: (order: readonly number[]) => void,
  modifier: Modifier = "alt",
) {
  const [fan, setDrawn] = useState<Fan | null>(null);
  // The fan as it is now: a press, a move and a release can all come before React draws again.
  const now = useRef<Fan | null>(null);
  const setFan = useCallback((next: SetStateAction<Fan | null>) => {
    now.current = typeof next === "function" ? next(now.current) : next;
    setDrawn(now.current);
  }, []);
  const modifiers = useModifiers();
  // A press on a card is the fan's: it does not close it.
  const ours = useRef(false);

  // Opened with Alt+Tab, it picks when Alt is let go.
  const onModifiers = useEffectEvent((held: readonly Modifier[]) => {
    if (fan?.by === "keys" && !held.includes(modifier)) pick();
  });
  useEffect(() => onModifiers(modifiers), [modifiers]);

  // Opened with Alt+Tab, it waits a moment before it shows.
  const opened = fan !== null;
  const waiting = useEffectEvent(() => fan?.shown === false);
  useEffect(() => {
    if (!waiting()) return;
    const timer = setTimeout(() => setFan((f) => f && { ...f, shown: true }), openDelay);
    return () => clearTimeout(timer);
  }, [opened, setFan]);

  /** Where each card of F shows; a card in hand, under the pointer. */
  const posesOf = (f: Fan | null) => {
    if (!f?.shown) return null;
    const poses = fanAt(f.order, places, f.at);
    const drag = f.drag;
    const pose = drag && poses.get(drag.window);
    if (drag && pose) {
      const { width, height } = pose.rect;
      const rect = { ...pose.rect, x: drag.x - drag.dx - width / 2, y: drag.y - drag.dy - height / 2 };
      poses.set(drag.window, { ...pose, rect, reach: rect });
    }
    return poses;
  };
  const poses = posesOf(fan);
  /** The fan's windows, bottom first: the one picked on top, the rest lower the farther out they are. */
  const layers = fan?.shown ? fanLayers(fan.order, fan.at) : null;

  /** Fan ORDER out, AT picked to begin with. */
  const open = (order: readonly number[], at: number, by: Fan["by"]) =>
    setFan({ order, at, by, shown: by === "pill" });

  const step = (by: 1 | -1) =>
    setFan((f) => (f && !f.drag ? { ...f, at: (f.at + by + f.order.length) % f.order.length } : f));

  const close = () => setFan(null);

  /** The window at AT, or the one picked so far, goes to the front; a card being dragged just keeps its new place. */
  const pick = (at?: number) => {
    const fan = now.current;
    if (!fan) return;
    setFan(null);
    if (fan.drag?.moved) {
      if (!same(fan.order, fan.drag.before)) onReorder(fan.order);
      return;
    }
    onPick(fan.order[at ?? fan.at]!, !fan.shown);
  };

  /** A press on WINDOW: it may be picked, or dragged to a new place. */
  const press = (window: number, event: StagePointerEvent) => {
    const fan = now.current;
    const pose = posesOf(fan)?.get(window);
    if (!fan || !pose || event.worldX === undefined || event.worldY === undefined) return;
    ours.current = true;
    const { x, y, width, height } = pose.rect;
    setFan({
      ...fan,
      at: fan.order.indexOf(window),
      drag: {
        window,
        x: event.worldX,
        y: event.worldY,
        dx: event.worldX - (x + width / 2),
        dy: event.worldY - (y + height / 2),
        pressedAt: { x: event.screenX, y: event.screenY },
        moved: false,
        before: fan.order,
      },
    });
  };

  /** The pointer moved over WINDOW: it is the one picked; or, a card in hand, it follows and the others make room. */
  const hover = (window: number, event: StagePointerEvent) => {
    // A card in hand holds the pointer: a move over another card means its release went astray.
    if (now.current?.drag && now.current.drag.window !== window) release();
    const fan = now.current;
    if (!fan?.shown) return;
    const drag = fan.drag;
    if (!drag) {
      const at = fan.order.indexOf(window);
      if (at >= 0 && at !== fan.at) setFan({ ...fan, at });
      return;
    }
    if (event.worldX === undefined || event.worldY === undefined) return;
    const moved = drag.moved || Math.hypot(event.screenX - drag.pressedAt.x, event.screenY - drag.pressedAt.y) >= dragAfter;
    // It goes to the slot its middle is nearest.
    const middle = event.worldX - drag.dx;
    const slots = [...fanAt(fan.order, places, -1).values()].map((p) => p.rect.x + p.rect.width / 2);
    const nearest = slots.reduce((best, x, i) => (Math.abs(x - middle) < Math.abs(slots[best]! - middle) ? i : best), 0);
    const to = moved ? nearest : fan.at;
    const order = fan.order.filter((id) => id !== drag.window);
    order.splice(to, 0, drag.window);
    setFan({ ...fan, order, at: to, drag: { ...drag, x: event.worldX, y: event.worldY, moved } });
  };

  /** Let go of a card: dragged, it keeps its new place and the fan stays open; clicked, it is picked. */
  const release = () => {
    const fan = now.current;
    const drag = fan?.drag;
    if (!fan || !drag) return;
    if (!drag.moved) {
      pick(fan.order.indexOf(drag.window));
      return;
    }
    setFan({ ...fan, drag: undefined });
    if (!same(fan.order, drag.before)) onReorder(fan.order);
  };

  // While it shows it holds the keyboard.
  useKeyboardGrab(fan ? (event) => {
    if (!event.pressed) return;
    if (event.key === "Tab" || event.key === "Right" || event.key === "Down") step(1);
    else if (event.key === "ISO_Left_Tab" || event.key === "Left" || event.key === "Up") step(-1);
    else if (event.key === "Return" || event.key === "space") pick();
    else if (event.key === "Escape") close();
  } : null);

  // A press anywhere but on one of its windows puts it back.
  useInput(fan?.shown ? (event) => {
    if (event.kind !== "button") return;
    ours.current = false;
    setTimeout(() => {
      if (!ours.current) close();
    }, 0);
  } : null);

  /** The card being dragged, or null. */
  const dragging = fan?.drag?.moved ? fan.drag.window : null;

  return { fan, poses, layers, dragging, open, step, press, hover, release, close };
}

function same(a: readonly number[], b: readonly number[]) {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}
