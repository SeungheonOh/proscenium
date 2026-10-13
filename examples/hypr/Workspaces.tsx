import { existsSync } from "node:fs";
import { memo, useRef, useState } from "react";
import {
  GestureBinding,
  Group,
  Image,
  Rect,
  Screen,
  Window,
  type OutputInfo,
  type Rectangle,
  type StageDragEvent,
} from "proscenium";
import { windowMotion } from "../components/TilingWindow.js";
import { boxAt, centered } from "../lib/geometry.js";
import { wallpaper } from "../lib/settings.js";
import { motion } from "../lib/theme.js";
import { HyprWindow } from "./HyprWindow.js";
import { useHypr } from "./HyprProvider.js";
import { workspaceNumbers, workspaceWindows } from "./tiling.js";

const hasWallpaper = existsSync(wallpaper);
const stripGap = 80;
/** How far a three-finger swipe must travel to switch workspace. */
const swipeThreshold = 120;

function Wallpaper({ output }: { output: OutputInfo }) {
  if (hasWallpaper) {
    return <Image src={wallpaper} width={output.width} height={output.height} fit="cover" />;
  }
  return (
    <Rect
      width={output.width}
      height={output.height}
      fill={{ from: "#1e1e2e", to: "#313244", angle: 120 }}
    />
  );
}

interface WorkspaceWindowsProps {
  output: OutputInfo;
  workspace: number;
}

/** One workspace's windows: floating ones above tiled ones, the focused one on top. */
const WorkspaceWindows = memo(function WorkspaceWindows({
  output,
  workspace,
}: WorkspaceWindowsProps) {
  const { state, dispatch, present, boxes, focused } = useHypr();
  const isFloating = (id: number) => Boolean(state.floating[id]);
  const ids = workspaceWindows(state, workspace, present).sort(
    (a, b) =>
      Number(isFloating(a)) - Number(isFloating(b)) ||
      Number(a === focused) - Number(b === focused),
  );

  const tiles = new Map<number, Rectangle>();
  for (const id of ids) {
    const box = boxes.get(id);
    if (box && !isFloating(id)) tiles.set(id, box);
  }

  return ids.map((id) => {
    const box = boxes.get(id) ?? centered(output.workArea, 0.6);

    // A dropped floating window stays where it is; a tiled one swaps with the tile under its center.
    function handleDrop({ x, y }: StageDragEvent) {
      if (isFloating(id)) {
        dispatch({ type: "float", window: id, box: { ...box, x, y } });
        return;
      }
      const target = boxAt(tiles, x + box.width / 2, y + box.height / 2, id);
      if (target !== null) dispatch({ type: "swap", first: id, second: target });
    }

    return (
      <HyprWindow
        key={id}
        id={id}
        box={box}
        floating={isFloating(id)}
        onDrop={handleDrop}
        onResize={({ x, y, width, height }) =>
          dispatch({ type: "float", window: id, box: { x, y, width, height } })
        }
      />
    );
  });
});

interface OutputWorkspacesProps {
  output: OutputInfo;
  /** How far a swipe in progress drags the strip, or null when none is. */
  swipeOffset: number | null;
}

/**
 * An output's workspaces side by side on a strip that slides to the shown one.
 * Workspaces no output shows stay laid out on the first output's strip, so
 * switching slides their windows in instead of popping them up.
 */
function OutputWorkspaces({ output, swipeOffset }: OutputWorkspacesProps) {
  const { state, outputs, present, workspaceOf, dispatch } = useHypr();
  const workspace = workspaceOf(output);
  const stride = output.width + stripGap;
  const isShownSomewhere = (number: number) =>
    outputs.some((other) => workspaceOf(other) === number);
  const visibleWorkspaces = workspaceNumbers.filter(
    (number) => number === workspace || (!isShownSomewhere(number) && output === outputs[0]),
  );

  const fullscreen = state.fullscreen;
  const showFullscreen =
    fullscreen !== null && present.has(fullscreen) && state.workspaces[fullscreen] === workspace;

  return (
    <Screen output={output.name}>
      <Wallpaper output={output} />
      <Group
        x={-(workspace - 1) * stride + (swipeOffset ?? 0)}
        transition={swipeOffset === null ? motion.slide : undefined}
      >
        {visibleWorkspaces.map((number) => (
          <Group key={number} x={(number - 1) * stride}>
            <WorkspaceWindows output={output} workspace={number} />
          </Group>
        ))}
      </Group>
      {showFullscreen && (
        <Window
          window={fullscreen}
          width={output.width}
          height={output.height}
          fullscreen
          transition={windowMotion}
          onFullscreenRequest={({ value }) =>
            dispatch({ type: "fullscreen", window: value ? fullscreen : null })
          }
        />
      )}
    </Screen>
  );
}

/** Every output's workspaces; a three-finger swipe drags the focused output's strip. */
export function Workspaces() {
  const { outputs, focusOutput, currentWorkspace, switchTo } = useHypr();
  const [swipeOffset, setSwipeOffset] = useState<number | null>(null);
  // The running total, which events delivered together would see stale in state.
  const swipeTotal = useRef(0);

  return (
    <>
      {outputs.map((output) => (
        <OutputWorkspaces
          key={output.name}
          output={output}
          swipeOffset={output === focusOutput ? swipeOffset : null}
        />
      ))}
      <GestureBinding
        gesture="swipe"
        fingers={3}
        onBegin={() => {
          swipeTotal.current = 0;
        }}
        onUpdate={({ dx }) => {
          swipeTotal.current += dx;
          setSwipeOffset(swipeTotal.current);
        }}
        onEnd={({ cancelled }) => {
          setSwipeOffset(null);
          if (!cancelled && Math.abs(swipeTotal.current) > swipeThreshold) {
            switchTo(currentWorkspace - Math.sign(swipeTotal.current));
          }
        }}
      />
    </>
  );
}
