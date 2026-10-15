import { memo, useRef, useState, type ReactNode } from "react";
import {
  focus,
  Image,
  instant,
  Rect,
  scale,
  spring,
  Text,
  translate,
  tween,
  Window,
  type Motion,
} from "proscenium";
import type { Rect as Box } from "./model.js";
import { findPanel, frameToggle } from "./navigation.js";
import { wallpaper } from "./paints.js";
import { gap, stripHeight, type PanelView, type SeamView, type TileView, type WindowView } from "./scene.js";
import { slotWindow, useTrellis } from "./TrellisProvider.js";

/** One motion for every split, dock and close, as TrellisWM has. */
export const layoutMotion = spring({ duration: 0.46, bounce: 0 });
/** A lifted window shrinks to a card no larger than this, keeping the point held. */
const card = { width: 380, height: 260 };
const lifting = tween(0.28, "ease-out");
const doubleClick = 400;
const tabGap = 4;

/** True on the second press within a double-click's time. */
function useDoubleClick() {
  const last = useRef(0);
  return () => {
    const now = Date.now();
    const second = now - last.current < doubleClick;
    last.current = second ? 0 : now;
    return second;
  };
}

/**
 * Everything Trellis draws under the menu bar. Windows, strips, tiles and seams
 * share one list in stacking order, keyed, so a window keeps its node, and the
 * drag that holds it, wherever the layout moves it.
 */
export function Arrangement() {
  const { scene, output, drag, state, act } = useTrellis();
  const [resizing, setResizing] = useState(false);
  const desktopClick = useDoubleClick();
  if (!scene || !output) return null;

  const { width, height } = output;
  const desk = scene.desktop;
  const motion = resizing ? instant : layoutMotion;
  const shown = drag?.shown;
  const slot = scene.panels.find((panel) => panel.windows.includes(slotWindow));
  const tabTarget = shown?.kind === "tab" ? scene.panels.find((panel) => panel.id === shown.panel) : undefined;

  const items: ReactNode[] = [];
  const addPanel = (panel: PanelView) => {
    if (panel.windows.includes(slotWindow)) return;
    for (const id of panel.windows) {
      const view = scene.windows.get(id);
      if (view && !(drag && !drag.byTab && drag.window === id)) {
        items.push(<TrellisWindow key={`w${id}`} view={view} motion={motion} />);
      }
    }
    if (panel.tabbed) items.push(<TabStrip key={`t${panel.id}`} panel={panel} motion={motion} />);
  };
  scene.panels.filter((panel) => !panel.floating).forEach(addPanel);
  for (const tile of scene.tiles) items.push(<Tile key={`g${tile.id}`} tile={tile} motion={motion} />);
  for (const seam of scene.seams) {
    items.push(<Seam key={`s${seam.split}:${seam.index}`} seam={seam} onResizing={setResizing} />);
  }
  scene.panels.filter((panel) => panel.floating).forEach(addPanel);
  if (slot) items.push(<DropSlot key="slot" rect={slot.rect} />);
  if (tabTarget) items.push(<DropSlot key="tab-slot" rect={tabTarget.rect} label="Add as tab" />);
  if (drag && !drag.byTab) {
    const view = drag.view;
    const k = drag.candidate?.kind === "float"
      ? 1
      : Math.min(1, card.width / view.rect.width, card.height / view.rect.height);
    items.push(
      <TrellisWindow
        key={`w${drag.window}`}
        view={view}
        motion={motion}
        lift={k}
        x={drag.pointerX - drag.grabX * k}
        y={drag.pointerY - drag.grabY * k}
      />,
    );
  }

  return (
    <>
      {/* Wider than the screen, so a pinch out or a pan still finds wallpaper. */}
      <Rect
        x={-width}
        y={-height}
        width={3 * width}
        height={3 * height}
        interactive={false}
        shaders={[{
          id: "wallpaper",
          shader: wallpaper,
          uniforms: {
            amount: 1,
            screen: [width, height],
            origin: [width, height],
            desk: [desk.x + width, desk.y + height, desk.width, desk.height],
          },
          transition: motion,
        }]}
      />
      {/* Double-clicking the Desktop frames it, and again steps back. */}
      <Rect
        x={desk.x}
        y={desk.y}
        width={desk.width}
        height={desk.height}
        fill="#00000000"
        transition={motion}
        onPointerDown={() => {
          if (desktopClick()) act(frameToggle(state, { node: "desktop" }));
        }}
      />
      {items}
      <Dock />
      <Dialogs />
    </>
  );
}

interface WindowProps {
  view: WindowView;
  motion: Motion;
  /** Lifted by a drag, shrunk to this share of its size, with its top left at (X, Y). */
  lift?: number;
  x?: number;
  y?: number;
}

/**
 * A window in its box: given the size it gets there, drawn smaller when that is under its
 * minimum. Its title bar picks it up: the request becomes a pointer capture on it, so the
 * drag follows the pointer exactly where it took the window.
 */
const TrellisWindow = memo(function TrellisWindow({ view, motion, lift, x, y }: WindowProps) {
  const { act, state, startDrag, moveDrag, endDrag, look, scene } = useTrellis();
  const iconClick = useDoubleClick();
  const app = look(view.id);
  const s = Math.min(view.scaleX, view.scaleY);
  const k = lift ?? 1;
  const iconSize = Math.min(64, view.rect.width * 0.45, view.rect.height * 0.45) / s;
  const lifted = lift !== undefined;

  const frameIt = () => {
    const panel = findPanel(state, view.id);
    if (panel) act(frameToggle(state, { node: panel }));
  };

  return (
    <Window
      window={view.id}
      x={x ?? view.rect.x}
      y={y ?? view.rect.y}
      width={view.width}
      height={view.height}
      originX={0}
      originY={0}
      transform={[translate(0, 0), scale(view.scaleX * k, view.scaleY * k)]}
      visible={lifted || !view.hidden}
      radius={10 / s}
      tiled={!view.floating && !lifted}
      resizable={view.floating && !lifted}
      shadow={lifted
        ? { color: "#00000080", blur: 48 / s, y: 18 / s }
        : { color: "#00000061", blur: 32 / s, y: 12 / s }}
      border={{ width: 1 / s, color: "#000000b3" }}
      initial={{ opacity: 0, transform: [translate(0, 0), scale(view.scaleX * 0.94, view.scaleY * 0.94)] }}
      exit={{ opacity: 0, transform: [translate(0, 0), scale(view.scaleX * 0.94, view.scaleY * 0.94)] }}
      transition={lifted ? { default: lifting, x: instant, y: instant } : motion}
      onMoveRequest={({ screenX, screenY }) => {
        if (screenX !== undefined && screenY !== undefined) startDrag(view.id, false, view, screenX, screenY);
      }}
      // Only a window being dragged hears the pointer move; hovering costs nothing.
      onPointerMove={lifted ? ({ screenX, screenY }) => moveDrag(screenX, screenY) : undefined}
      onPointerUp={endDrag}
      onResizeEnd={({ x, y, width, height }) => {
        if (!scene) return;
        const deskBox = scene.boxes.get("desktop") ?? scene.screen;
        const corner = scene.map.point(x, y);
        act({
          type: "moveFloat",
          window: view.id,
          rect: {
            x: corner.x - deskBox.x,
            y: corner.y - deskBox.y,
            width: (width * view.scaleX) / scene.map.sx,
            height: (height * view.scaleY) / scene.map.sy,
          },
        });
      }}
      onMaximizeRequest={frameIt}
      onMinimizeRequest={() => act({ type: "minimize", window: view.id })}
      onActivateRequest={() => {
        focus(view.id);
        if (view.icon || view.hidden) frameIt();
      }}
    >
      {/* Too small to use: the app's colour and icon. Double-click goes in. */}
      <Rect
        width={view.width}
        height={view.height}
        radius={10 / s}
        fill={app.color}
        opacity={view.icon && !lifted ? 1 : 0}
        interactive={view.icon && !lifted}
        transition={motion}
        onPointerDown={() => {
          focus(view.id);
          if (iconClick()) frameIt();
        }}
      >
        {app.icon && (
          <Image
            src={app.icon}
            x={(view.width - iconSize) / 2}
            y={(view.height - iconSize) / 2}
            width={iconSize}
            height={iconSize}
            fit="contain"
            interactive={false}
          />
        )}
      </Rect>
    </Window>
  );
});

/** A tab group's glass strip, one tab per window; dragging a tab out tears its window off. */
function TabStrip({ panel, motion }: { panel: PanelView; motion: Motion }) {
  const { act, look, windows, startDrag, moveDrag, endDrag, scene, drag } = useTrellis();
  const grab = useRef({ x: 0, y: 0 });
  const r = panel.rect;
  const tabWidth = (r.width - 10 - tabGap * (panel.windows.length - 1)) / panel.windows.length;
  return (
    <Rect
      x={r.x}
      y={r.y}
      width={r.width}
      height={stripHeight + 12}
      radius={10}
      fill="#282c28bd"
      blur={24}
      border={{ width: 1, color: "#ffffff1f" }}
      transition={motion}
    >
      {panel.windows.map((id, index) => {
        const active = id === panel.active;
        const carried = drag?.byTab === true && drag.window === id;
        const title = (windows.get(id)?.title || look(id).name).split(" — ")[0];
        const tabX = 5 + index * (tabWidth + tabGap);
        return (
          <Rect
            key={id}
            x={tabX}
            y={4}
            width={tabWidth}
            height={26}
            radius={7}
            fill={active ? "#ffffff24" : "#ffffff00"}
            opacity={carried ? 0.7 : 1}
            draggable
            transition={motion}
            onPointerDown={({ localX, localY }) => {
              grab.current = { x: localX, y: localY };
              act({ type: "activate", window: id });
              focus(id);
            }}
            onDragStart={() => {
              const view = scene?.windows.get(id);
              if (view) startDrag(id, true, view, r.x + tabX + grab.current.x, r.y + 4 + grab.current.y);
            }}
            onDrag={({ x, y }) => moveDrag(r.x + x + grab.current.x, r.y + y + grab.current.y)}
            onDragEnd={endDrag}
          >
            <Rect x={10} y={9} width={8} height={8} radius={4} fill={look(id).color} interactive={false} />
            <Text
              x={24}
              y={5}
              width={Math.max(0, tabWidth - 32)}
              size={12.5}
              weight="bold"
              color={active ? "#ffffffde" : "#ffffff94"}
              maxLines={1}
              interactive={false}
            >
              {title}
            </Text>
          </Rect>
        );
      })}
    </Rect>
  );
}

/** A group too small to show, as one tile lined with its splits; double-click goes in. */
function Tile({ tile, motion }: { tile: TileView; motion: Motion }) {
  const { act, state } = useTrellis();
  const click = useDoubleClick();
  const r = tile.rect;
  return (
    <Rect
      x={r.x}
      y={r.y}
      width={r.width}
      height={r.height}
      radius={6}
      fill="#2a2b2e"
      border={{ width: 1, color: "#ffffff1a" }}
      transition={motion}
      onPointerDown={() => {
        if (click()) act(frameToggle(state, { node: tile.id }));
      }}
    >
      {tile.lines.map((line, index) => (
        <Rect
          key={index}
          x={line.axis === "x" ? line.at - r.x : line.from - r.x}
          y={line.axis === "x" ? line.from - r.y : line.at - r.y}
          width={line.axis === "x" ? 1 : line.to - line.from}
          height={line.axis === "x" ? line.to - line.from : 1}
          fill="#ffffff40"
          interactive={false}
          transition={motion}
        />
      ))}
    </Rect>
  );
}

/**
 * The gap between two neighbours: dragging it resizes both, double-clicking evens them. The
 * press holds the pointer, so the seam follows it on screen; the gap itself stays declared
 * where the layout puts it.
 */
function Seam({ seam, onResizing }: { seam: SeamView; onResizing: (resizing: boolean) => void }) {
  const { act, scene } = useTrellis();
  const click = useDoubleClick();
  const pressed = useRef(false);
  const reach = gap / 2 + 6;
  const across = seam.axis === "x";
  const move = (screenX: number, screenY: number) => {
    const box = scene?.boxes.get(seam.split);
    if (!scene || !box) return;
    const point = scene.map.point(screenX, screenY);
    const at = across ? (point.x - box.x) / box.width : (point.y - box.y) / box.height;
    act({ type: "seam", split: seam.split, index: seam.index, at });
  };
  return (
    <Rect
      x={across ? seam.at - reach : seam.from}
      y={across ? seam.from : seam.at - reach}
      width={across ? 2 * reach : seam.to - seam.from}
      height={across ? seam.to - seam.from : 2 * reach}
      fill="#00000000"
      cursor={across ? "ew-resize" : "ns-resize"}
      transition={instant}
      onPointerDown={() => {
        if (click()) {
          act({ type: "evenSeam", split: seam.split, index: seam.index });
          return;
        }
        pressed.current = true;
        onResizing(true);
      }}
      onPointerMove={({ screenX, screenY }) => {
        if (pressed.current) move(screenX, screenY);
      }}
      onPointerUp={({ screenX, screenY }) => {
        if (!pressed.current) return;
        pressed.current = false;
        move(screenX, screenY);
        onResizing(false);
      }}
    />
  );
}

/** Where a drop would land: the slot the layout opened, or a group it would join. */
function DropSlot({ rect, label }: { rect: Box; label?: string }) {
  return (
    <Rect
      x={rect.x}
      y={rect.y}
      width={rect.width}
      height={rect.height}
      radius={10}
      fill="#ffffff14"
      blur={12}
      border={{ width: 1.5, color: "#ffffff59" }}
      interactive={false}
      initial={{ opacity: 0 }}
      exit={{ opacity: 0 }}
      transition={layoutMotion}
    >
      {label && (
        <Text
          width={rect.width}
          y={rect.height / 2 - 10}
          align="center"
          size={14}
          weight="bold"
          color="#ffffffd0"
          interactive={false}
        >
          {label}
        </Text>
      )}
    </Rect>
  );
}

/** Minimized windows, along the bottom of the Desktop; clicking one puts it back where it was. */
function Dock() {
  const { state, act, scene, look } = useTrellis();
  if (!scene || !state.minimized.length) return null;
  const desk = scene.desktop;
  const size = 34;
  const width = state.minimized.length * (size + 6) + 6;
  const deskBox = scene.boxes.get("desktop") ?? scene.screen;
  return (
    <Rect
      x={desk.x + (desk.width - width) / 2}
      y={desk.y + desk.height - size - 18}
      width={width}
      height={size + 12}
      radius={13}
      fill="#3c403c99"
      blur={14}
      border={{ width: 1, color: "#ffffff29" }}
      initial={{ opacity: 0 }}
      exit={{ opacity: 0 }}
      transition={layoutMotion}
    >
      {state.minimized.map(({ window }, index) => {
        const app = look(window);
        return (
          <Rect
            key={window}
            x={6 + index * (size + 6)}
            y={6}
            width={size}
            height={size}
            radius={9}
            fill={app.color}
            onPointerDown={() => {
              act({
                type: "restore",
                window,
                rect: { x: deskBox.width * 0.2, y: deskBox.height * 0.2, width: deskBox.width * 0.6, height: deskBox.height * 0.6 },
              });
              focus(window);
            }}
          >
            {app.icon && <Image src={app.icon} x={5} y={5} width={size - 10} height={size - 10} fit="contain" interactive={false} />}
          </Rect>
        );
      })}
    </Rect>
  );
}

/** Dialogs stay with their windows: centred over them, above everything. */
function Dialogs() {
  const { windows, scene } = useTrellis();
  if (!scene) return null;
  return [...windows.values()]
    .filter((window) => window.mapped && window.parent !== null)
    .map((window) => {
      const parent = scene.windows.get(window.parent!);
      const over = parent?.rect ?? scene.desktop;
      return (
        <Window
          key={window.id}
          window={window.id}
          x={over.x + (over.width - window.width) / 2}
          y={over.y + Math.max(0, (over.height - window.height) / 3)}
          radius={10}
          shadow={{ color: "#00000080", blur: 40, y: 14 }}
          transition={layoutMotion}
        />
      );
    });
}
