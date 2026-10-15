import { useRef, useState } from "react";
import { Box, PointerBinding, Rect, Screen, Shortcut, spring, Text, type StagePointerEvent } from "proscenium";
import { bestFit, find, targetBox, walk, type Node, type Rect as Area, type Split, type Target } from "./model.js";
import { useTrellis } from "./TrellisProvider.js";

/** The least a marquee spans each way before it frames anything. */
const minimumSize = 8;
const outlineMotion = spring({ duration: 0.16, bounce: 0 });
/** Escape, with or without the keys that drew the marquee still held. */
const escapes = ["Escape", "Super+Escape", "Shift+Escape", "Super+Shift+Escape"];

/**
 * TrellisWM's ⌘⇧-drag as Super+Shift+drag: a rectangle drawn either way,
 * outlining the space or run of spaces that best fits it. Letting go frames
 * that; Escape lets go without.
 */
export function Marquee() {
  const { state, act, scene, output, windows, look } = useTrellis();
  const start = useRef<{ x: number; y: number } | null>(null);
  const [area, setArea] = useState<Area | null>(null);

  // Computed from each event, not from state, which can be one event behind.
  function areaTo(event: StagePointerEvent): Area | null {
    if (!start.current) return null;
    const { x, y } = start.current;
    return {
      x: Math.min(x, event.screenX),
      y: Math.min(y, event.screenY),
      width: Math.abs(event.screenX - x),
      height: Math.abs(event.screenY - y),
    };
  }

  /** What AREA on screen would frame: the target that best fits it in the arrangement. */
  function fitOf(area: Area | null): Target | null {
    if (!scene || !area || area.width < minimumSize || area.height < minimumSize) return null;
    const from = scene.map.point(area.x, area.y);
    const to = scene.map.point(area.x + area.width, area.y + area.height);
    return bestFit(state.root, scene.boxes, { x: from.x, y: from.y, width: to.x - from.x, height: to.y - from.y });
  }

  const cancel = () => {
    start.current = null;
    setArea(null);
  };
  const target = fitOf(area);
  const outline = target && scene && targetBox(state.root, scene.visual, target);
  const title = (window: number) => (windows.get(window)?.title || look(window).name).split(" — ")[0]!;
  // The label stays on screen however far the outline reaches past it.
  const label = outline && scene && clip(outline, scene.screen);

  return (
    <>
      <PointerBinding
        button="left"
        modifiers={["super", "shift"]}
        onDown={(event) => {
          start.current = { x: event.screenX, y: event.screenY };
          setArea(areaTo(event));
        }}
        onMove={(event) => {
          if (start.current) setArea(areaTo(event));
        }}
        onUp={(event) => {
          const chosen = fitOf(areaTo(event));
          cancel();
          if (chosen) act({ type: "frame", target: chosen });
        }}
      />
      {area && escapes.map((keys) => <Shortcut key={keys} keys={keys} onPress={cancel} />)}
      {output && area && (
        <Screen output={output.name}>
          {outline && (
            <Rect
              x={outline.x}
              y={outline.y}
              width={outline.width}
              height={outline.height}
              radius={10}
              fill="#ffffff0d"
              border={{ width: 2, color: "#ffffffd9" }}
              interactive={false}
              initial={{ opacity: 0 }}
              transition={outlineMotion}
            />
          )}
          <Rect
            x={area.x}
            y={area.y}
            width={area.width}
            height={area.height}
            fill="#ffffff14"
            border={{ width: 1, color: "#ffffffa6" }}
            interactive={false}
          />
          {target && label && (
            <Box
              x={label.x}
              y={label.y}
              width={label.width}
              height={label.height}
              alignItems="center"
              justifyContent="center"
              interactive={false}
            >
              <Box height={30} paddingX={12} radius={8} fill="#282c28d9" blur={24} justifyContent="center" interactive={false}>
                <Text size={13} weight="bold" color="#ffffff" maxLines={1} interactive={false}>
                  {`Release to frame ${nameOf(state.root, target, title)} · Esc to cancel`}
                </Text>
              </Box>
            </Box>
          )}
        </Screen>
      )}
    </>
  );
}

/** TARGET in a few words: a window's title, the Desktop, everything, or what it holds. */
function nameOf(root: Node, target: Target, title: (window: number) => string): string {
  if ("node" in target && target.node === root.id && root.kind === "split") return "everything";
  const parts = "node" in target
    ? [find(root, target.node)!.node]
    : (find(root, target.split)!.node as Split).children.slice(target.from, target.to + 1);
  const panels = parts.flatMap((part) => [...walk(part)].map((entry) => entry.node))
    .filter((node) => node.kind !== "split");
  const docked = panels.flatMap((node) => (node.kind === "panel" ? [node] : []));
  const desktop = panels.length > docked.length;
  if (docked.length === 1 && !desktop) return title(docked[0]!.active);
  const count = docked.reduce((total, panel) => total + panel.windows.length, 0);
  const named = [count && `${count} window${count === 1 ? "" : "s"}`, desktop && "the Desktop"].filter(Boolean);
  return named.join(" and ");
}

function clip(a: Area, b: Area): Area {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
  };
}
