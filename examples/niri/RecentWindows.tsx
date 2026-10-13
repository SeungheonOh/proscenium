import { useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Group,
  Mirror,
  Rect,
  Screen,
  Shortcut,
  Text,
  useKeyboardGrab,
  useModifiers,
  useWindows,
  type OutputInfo,
  type WindowInfo,
} from "proscenium";
import { motion } from "./config.js";
import { fitOffset } from "./model.js";
import { useNiri } from "./NiriProvider.js";
import { allWindows, locate } from "./state.js";

type Scope = "all" | "workspace" | "output";
const scopes: Scope[] = ["all", "workspace", "output"];

/** Focus has to rest this long on a window before it counts as used. */
const debounce = 750;
/** The switcher shows only after this long, so a quick Alt+Tab just switches. */
const openDelay = 150;
const highlight = { color: "#999999", padding: 30, border: 2 };
const titleGap = 14;
const gap = 16;
/** How much of the next preview always peeks in from the side. */
const strut = 192;

/** Windows by when they were last used, most recent first. */
function useRecency(focused: number | null, present: readonly number[]): number[] {
  const [order, setOrder] = useState<number[]>([]);
  useEffect(() => {
    if (focused === null) return;
    const timer = setTimeout(() => setOrder((current) => [focused, ...current.filter((id) => id !== focused)]),
                             debounce);
    return () => clearTimeout(timer);
  }, [focused]);
  return useMemo(() => {
    const known = order.filter((id) => present.includes(id));
    return [...known, ...present.filter((id) => !known.includes(id))];
  }, [order, present]);
}

/** A preview's size: at most half the output's height or 480 pixels, and half the window's size. */
function previewSize(window: WindowInfo, output: OutputInfo) {
  const maxHeight = Math.min(480, output.height * 0.5);
  const maxWidth = maxHeight * output.width / output.height;
  const width = Math.max(window.width, 1);
  const height = Math.max(window.height, 1);
  const least = Math.min(1, 16 / Math.max(width, height));
  const scale = Math.max(least, Math.min(maxWidth / width, maxHeight / height, 0.5));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

interface Session {
  scope: Scope;
  /** Only windows of this application, for Alt+grave. */
  app: string | null;
  selected: number;
  shown: boolean;
  /** The modifier that holds the switcher open. */
  holding: "alt" | "logo";
}

/**
 * niri's recent-windows switcher on Alt+Tab or Super+Tab: windows by recent
 * use, previewed live over a dark backdrop; letting go of the modifier switches.
 */
export function RecentWindows() {
  const { state, focused, act, outputs } = useNiri();
  const windows = useWindows();
  const present = useMemo(() => allWindows(state).filter((id) => windows.some((window) => window.id === id)),
                          [state, windows]);
  const recency = useRecency(focused, present);
  const modifiers = useModifiers();
  const [session, setSession] = useState<Session | null>(null);
  const output = outputs.find((candidate) => candidate.name === state.activeOutput) ?? outputs[0];

  const list = useMemo(() => {
    if (!session) return [];
    return recency.filter((id) => {
      const place = locate(state, id);
      if (!place) return false;
      const monitor = state.monitors[place.output]!;
      if (session.scope === "output" && place.output !== state.activeOutput) return false;
      if (session.scope === "workspace" && (place.output !== state.activeOutput || place.workspace !== monitor.active)) {
        return false;
      }
      return !session.app || windows.find((window) => window.id === id)?.appId === session.app;
    });
  }, [session?.scope, session?.app, recency, state, windows]);

  // Letting go of the modifier that opened it picks the selection.
  useEffect(() => {
    if (session && !modifiers.includes(session.holding)) confirm();
  }, [modifiers]);

  useEffect(() => {
    if (!session || session.shown) return;
    const timer = setTimeout(() => setSession((current) => current && { ...current, shown: true }), openDelay);
    return () => clearTimeout(timer);
  }, [session !== null]);

  function open(step: 1 | -1, holding: Session["holding"], sameApp: boolean) {
    if (session) {
      setSession({ ...session, selected: session.selected + step });
      return;
    }
    const app = sameApp ? windows.find((window) => window.id === focused)?.appId ?? null : null;
    setSession({ scope: "all", app, selected: step, shown: false, holding });
  }

  function close() {
    setSession(null);
  }

  function confirm(index?: number) {
    const count = list.length;
    if (session && count) {
      const chosen = list[(((index ?? session.selected) % count) + count) % count];
      if (chosen !== undefined) act({ type: "activate", window: chosen });
    }
    close();
  }

  const selectedIndex = list.length ? ((session!.selected % list.length) + list.length) % list.length : 0;
  const move = (to: number) => () => session && setSession({ ...session, selected: to });
  const scope = (to: Scope) => () => session && setSession({ ...session, scope: to, selected: 0 });

  const triggers: [keys: string, step: 1 | -1, holding: Session["holding"], sameApp: boolean][] = [
    ["Alt+Tab", 1, "alt", false],
    ["Alt+Shift+ISO_Left_Tab", -1, "alt", false],
    ["Alt+grave", 1, "alt", true],
    ["Alt+Shift+asciitilde", -1, "alt", true],
    ["Super+Tab", 1, "logo", false],
    ["Super+Shift+ISO_Left_Tab", -1, "logo", false],
    ["Super+grave", 1, "logo", true],
    ["Super+Shift+asciitilde", -1, "logo", true],
  ];

  // While open it holds the keyboard, whatever modifiers are held.
  useKeyboardGrab(session ? (event) => {
    if (!event.pressed) return;
    const key = event.key.toLowerCase();
    if (key === "escape") close();
    else if (key === "return" || key === "space") confirm();
    else if (key === "left") move(selectedIndex - 1)();
    else if (key === "right") move(selectedIndex + 1)();
    else if (event.repeat) return;
    else if (key === "home") move(0)();
    else if (key === "end") move(list.length - 1)();
    else if (key === "a") scope("all")();
    else if (key === "w") scope("workspace")();
    else if (key === "o") scope("output")();
    else if (key === "s") scope(scopes[(scopes.indexOf(session.scope) + 1) % scopes.length]!)();
  } : null);

  return (
    <>
      {triggers.map(([keys, step, holding, sameApp]) => (
        <Shortcut key={keys} keys={keys} repeat onPress={() => open(step, holding, sameApp)} />
      ))}
      {session?.shown && output && (
        <Switcher output={output} list={list} windows={windows} selected={selectedIndex}
                  scope={session.scope} onPick={confirm} onDismiss={close} />
      )}
    </>
  );
}

interface SwitcherProps {
  output: OutputInfo;
  list: number[];
  windows: readonly WindowInfo[];
  selected: number;
  scope: Scope;
  onPick: (index: number) => void;
  onDismiss: () => void;
}

function Switcher({ output, list, windows, selected, scope, onPick, onDismiss }: SwitcherProps) {
  const pad = highlight.padding + highlight.border;
  const step = pad + gap + pad;
  const boxes: { id: number; x: number; y: number; width: number; height: number }[] = [];
  let x = 0;
  for (const id of list) {
    const window = windows.find((candidate) => candidate.id === id);
    if (!window) continue;
    const size = previewSize(window, output);
    boxes.push({ id, x, y: Math.round((output.height - size.height) / 2), ...size });
    x += size.width + step;
  }
  const stripWidth = Math.max(0, x - step);
  // The strip is centered while it fits; otherwise it scrolls the least that shows the selection.
  const working = Math.max(0, output.width - 2 * (strut + gap));
  const current = boxes[selected];
  const previousView = useRef<number | null>(null);
  const from = previousView.current ?? 0;
  const view = stripWidth <= working || !current
    ? -(output.width - stripWidth) / 2
    : fitOffset(from + strut + gap, working, current.x, current.width, 0) + current.x - (strut + gap);
  previousView.current = view;
  const scopeText = scopes.map((name) => {
    const label = `<span font_family="monospace" bgcolor="#2C2C2C"><b>${name[0]!.toUpperCase()}</b></span>${name.slice(1)}`;
    return name === scope ? label : `<span foreground="#999999">${label}</span>`;
  }).join("  ");

  return (
    <Screen output={output.name}>
      <Rect width={output.width} height={output.height} fill="#000000cc" initial={{ opacity: 0 }}
            transition={motion.windowMovement} onPointerDown={onDismiss} />
      <Group x={-view} transition={motion.windowMovement}>
        {boxes.map((box, index) => {
          const title = windows.find((window) => window.id === box.id)?.title ?? "";
          const chosen = index === selected;
          return (
            <Group key={box.id} x={box.x} y={box.y}>
              {chosen && (
                <Rect x={-highlight.padding} y={-highlight.padding} width={box.width + 2 * highlight.padding}
                      height={box.height + 2 * highlight.padding + titleGap + 17 - highlight.padding / 2}
                      fill={`${highlight.color}80`} border={{ width: highlight.border, color: highlight.color }} />
              )}
              <Mirror window={box.id} width={box.width} height={box.height}
                      initial={{ opacity: 0 }} transition={motion.windowOpen} />
              <Rect width={box.width} height={box.height} cursor="pointer" onPointerDown={() => onPick(index)} />
              <Text y={box.height + titleGap} width={box.width} align="center" maxLines={1} font="sans" size={14}
                    color="#ffffff">{title}</Text>
            </Group>
          );
        })}
      </Group>
      <Box width={output.width} justifyContent="center" paddingTop={2 * highlight.padding} interactive={false}>
        <Box fill="#1a1a1a" border={{ width: 2, color: "#808080" }} padding={12}>
          <Text markup font="sans" size={14} color="#ffffff">{`<span font_family="monospace" bgcolor="#2C2C2C"><b>S</b></span><span foreground="#999999">cope:</span>  ${scopeText}`}</Text>
        </Box>
      </Box>
    </Screen>
  );
}
