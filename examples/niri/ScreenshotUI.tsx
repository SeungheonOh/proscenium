import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { useEffect, useRef, useState } from "react";
import {
  Box,
  copyData,
  encodePng,
  Group,
  Image,
  Rect,
  Screen,
  screenshot,
  Shortcut,
  Text,
  useKeyboardGrab,
  type OutputInfo,
  type Rectangle,
  type Screenshot,
  type ShareSource,
  type StagePointerEvent,
} from "proscenium";
import { floatingStep, motion, screenshotPath } from "./config.js";
import { keyCap } from "./HotkeyOverlay.js";
import { useNiri } from "./NiriProvider.js";

type Selection = Rectangle & { output: string };

/** niri's file name for a screenshot taken now. */
function screenshotFile(now = new Date()): string {
  const two = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} `
    + `${two(now.getHours())}-${two(now.getMinutes())}-${two(now.getSeconds())}`;
  return screenshotPath.replace("~", homedir()).replace("%Y-%m-%d %H-%M-%S", stamp);
}

/** Puts SHOT on the clipboard as a PNG and, unless only copying, saves it as niri names it. */
async function save(shot: Screenshot, toDisk = true): Promise<void> {
  const png = await encodePng(shot);
  await copyData("image/png", png);
  if (!toDisk) return;
  const path = screenshotFile();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, png);
}

/** The part of SHOT (an output at SCALE) inside AREA, in logical pixels. */
function crop(shot: Screenshot, area: Rectangle, scale: number): Screenshot {
  const x = Math.max(0, Math.round(area.x * scale));
  const y = Math.max(0, Math.round(area.y * scale));
  const width = Math.max(1, Math.min(shot.width - x, Math.round(area.width * scale)));
  const height = Math.max(1, Math.min(shot.height - y, Math.round(area.height * scale)));
  const pixels = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const start = ((y + row) * shot.width + x) * 4;
    pixels.set(shot.pixels.subarray(start, start + width * 4), row * width * 4);
  }
  return { width, height, pixels };
}

/** Saves and copies SOURCE straight away, as Ctrl+Print and Alt+Print do. */
export function captureNow(source: ShareSource): void {
  screenshot(source).then((shot) => save(shot))
    .catch((error: Error) => console.error(`screenshot: ${error.message}`));
}

/** The selection last confirmed or cancelled, which the next opening starts from. */
let remembered: Selection | null = null;

interface Frozen {
  shot: Screenshot;
  /** A PNG of it for the screen to show, once written. */
  path: string | null;
}

/**
 * niri's screenshot UI on Print: the screens freeze, dimmed outside a
 * selection that a drag draws anew and Mod+drag moves. Space or Enter saves it.
 */
export function ScreenshotUI() {
  const { outputs, overlays, setOverlay, state } = useNiri();
  const open = overlays.screenshot;
  const [frozen, setFrozen] = useState<Record<string, Frozen>>({});
  const [selection, setSelection] = useState<Selection | null>(null);
  const drag = useRef<{ kind: "new" | "move"; x: number; y: number; origin: Selection } | null>(null);

  // Freezes every output as the UI opens; the UI shows at once and the frozen frames fade in under it.
  useEffect(() => {
    if (!open) return;
    let live = true;
    const files: string[] = [];
    for (const output of outputs) {
      screenshot({ output: output.name }).then(async (shot) => {
        if (!live) return;
        setFrozen((current) => ({ ...current, [output.name]: { shot, path: null } }));
        const path = join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), `niri-frozen-${output.name}-${Date.now()}.png`);
        files.push(path);
        await writeFile(path, await encodePng(shot));
        if (live) setFrozen((current) => ({ ...current, [output.name]: { shot, path } }));
      }).catch(() => undefined);
    }
    return () => {
      live = false;
      setFrozen({});
      for (const file of files) void rm(file, { force: true });
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const output = outputs.find((candidate) => candidate.name === remembered?.output)
      ?? outputs.find((candidate) => candidate.name === state.activeOutput) ?? outputs[0];
    if (!output) return;
    const fits = remembered && remembered.output === output.name
      && remembered.x + remembered.width <= output.width && remembered.y + remembered.height <= output.height;
    setSelection(fits ? remembered : {
      output: output.name, x: output.width / 4, y: output.height / 4, width: output.width / 2, height: output.height / 2,
    });
  }, [open]);

  function close() {
    remembered = selection;
    setOverlay("screenshot", false);
  }

  /** Takes the selection: to the clipboard, and to a file unless only copying. */
  function confirm(toDisk = true) {
    const shown = selection;
    const output = outputs.find((candidate) => candidate.name === shown?.output);
    const shot = shown && frozen[shown.output]?.shot;
    close();
    if (!shown || !output) return;
    const area = { x: shown.x, y: shown.y, width: shown.width, height: shown.height };
    if (shot) void save(crop(shot, area, output.scale), toDisk).catch(() => undefined);
    else captureNow({ output: output.name, region: area });
  }

  /** Moves or resizes the selection, kept on its output. */
  function adjust(change: (selection: Selection, output: OutputInfo) => Rectangle) {
    setSelection((current) => {
      const output = outputs.find((candidate) => candidate.name === current?.output);
      if (!current || !output) return current;
      const next = change(current, output);
      const width = Math.min(Math.max(next.width, 1), output.width);
      const height = Math.min(Math.max(next.height, 1), output.height);
      return {
        output: current.output, width, height,
        x: Math.min(Math.max(next.x, 0), output.width - width),
        y: Math.min(Math.max(next.y, 0), output.height - height),
      };
    });
  }

  const move = (dx: number, dy: number) => () => adjust((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
  const resize = (dw: number, dh: number) => () => adjust((current, output) => ({
    ...current, width: current.width + dw * output.width, height: current.height + dh * output.height,
  }));

  function press(output: OutputInfo, event: StagePointerEvent) {
    if (event.button !== 272) return;
    const x = Math.min(Math.max(event.screenX, 0), output.width);
    const y = Math.min(Math.max(event.screenY, 0), output.height);
    if (event.modifiers.includes("logo")) {
      if (selection?.output === output.name) drag.current = { kind: "move", x, y, origin: selection };
      return;
    }
    const origin = { output: output.name, x, y, width: 0, height: 0 };
    drag.current = { kind: "new", x, y, origin };
    setSelection(origin);
  }

  function follow(output: OutputInfo, event: StagePointerEvent) {
    const current = drag.current;
    if (!current) return;
    const x = Math.min(Math.max(event.screenX, 0), output.width);
    const y = Math.min(Math.max(event.screenY, 0), output.height);
    if (current.kind === "move") {
      const { origin } = current;
      adjust(() => ({ ...origin, x: origin.x + x - current.x, y: origin.y + y - current.y }));
      return;
    }
    setSelection({
      output: current.origin.output, x: Math.min(x, current.x), y: Math.min(y, current.y),
      width: Math.abs(x - current.x), height: Math.abs(y - current.y),
    });
  }

  function release() {
    const current = drag.current;
    drag.current = null;
    // A click selects a small square around it.
    if (current?.kind === "new" && selection && selection.width <= 1 && selection.height <= 1) {
      adjust(() => ({ x: current.x - 16, y: current.y - 16, width: 32, height: 32 }));
    }
  }

  // niri's screenshot keys: Escape cancels, Space or Enter saves, Ctrl+C only copies.
  useKeyboardGrab(open ? (event) => {
    if (!event.pressed || event.repeat) return;
    const plain = !event.modifiers.some((modifier) => modifier !== "logo");
    if (event.key === "Escape") close();
    else if ((event.key === "space" || event.key === "Return") && plain) confirm();
    else if (event.key.toLowerCase() === "c" && event.modifiers.includes("control")) confirm(false);
  } : null);

  if (!open) return null;
  const dragging = drag.current?.kind === "new";
  return (
    <>
      {(["Left", "H"] as const).map((key) => (
        <Shortcut key={key} keys={`Super+Ctrl+${key}`} repeat onPress={move(-floatingStep, 0)} />))}
      {(["Right", "L"] as const).map((key) => (
        <Shortcut key={key} keys={`Super+Ctrl+${key}`} repeat onPress={move(floatingStep, 0)} />))}
      {(["Up", "K"] as const).map((key) => (
        <Shortcut key={key} keys={`Super+Ctrl+${key}`} repeat onPress={move(0, -floatingStep)} />))}
      {(["Down", "J"] as const).map((key) => (
        <Shortcut key={key} keys={`Super+Ctrl+${key}`} repeat onPress={move(0, floatingStep)} />))}
      <Shortcut keys="Super+minus" repeat onPress={resize(-0.1, 0)} />
      <Shortcut keys="Super+equal" repeat onPress={resize(0.1, 0)} />
      <Shortcut keys="Super+Shift+underscore" repeat onPress={resize(0, -0.1)} />
      <Shortcut keys="Super+Shift+plus" repeat onPress={resize(0, 0.1)} />
      {outputs.map((output) => {
        const still = frozen[output.name];
        const selected = selection?.output === output.name ? selection : null;
        return (
          <Screen key={output.name} output={output.name}>
            <Group initial={{ opacity: 0 }} transition={motion.screenshotOpen}>
              {still?.path && (
                <Image src={still.path} width={output.width} height={output.height} fit="fill" />
              )}
              <Dim output={output} selection={selected} />
              {selected && (
                <Rect x={selected.x - 2} y={selected.y - 2} width={selected.width + 4} height={selected.height + 4}
                      border={{ width: 2, color: "#ffffff" }} />
              )}
              <Rect
                width={output.width}
                height={output.height}
                cursor="crosshair"
                onPointerDown={(event) => press(output, event)}
                onPointerMove={(event) => follow(output, event)}
                onPointerUp={release}
              />
              <Panel output={output} dimmed={dragging} onCapture={() => confirm()} />
            </Group>
          </Screen>
        );
      })}
    </>
  );
}

/** Half-black over everything but the selection. */
function Dim({ output, selection }: { output: OutputInfo; selection: Rectangle | null }) {
  const shade = "#00000080";
  if (!selection) return <Rect width={output.width} height={output.height} fill={shade} />;
  const { x, y, width, height } = selection;
  return (
    <>
      <Rect width={output.width} height={y} fill={shade} />
      <Rect y={y + height} width={output.width} height={output.height - y - height} fill={shade} />
      <Rect y={y} width={x} height={height} fill={shade} />
      <Rect x={x + width} y={y} width={output.width - x - width} height={height} fill={shade} />
    </>
  );
}

/** The help panel at the bottom: a shutter button and the keys. */
function Panel({ output, dimmed, onCapture }: { output: OutputInfo; dimmed: boolean; onCapture: () => void }) {
  const radius = 16;
  return (
    <Box
      width={output.width}
      height={output.height}
      flexDirection="column"
      justifyContent="flex-end"
      alignItems="center"
      paddingBottom={16}
      interactive={false}
    >
      <Box
        fill="#1a1a1a"
        border={{ width: 2, color: "#4d4d4d" }}
        padding={8}
        gap={8}
        flexDirection="row"
        alignItems="center"
        opacity={dimmed ? 0.3 : 0.9}
      >
        <Rect width={2 * radius} height={2 * radius} radius={radius} fill="#ffffff" cursor="pointer"
              onPointerDown={onCapture}>
          <Rect x={2} y={2} width={2 * radius - 4} height={2 * radius - 4} radius={radius - 2} fill="#1a1a1a"
                interactive={false}>
            <Rect x={2} y={2} width={2 * radius - 8} height={2 * radius - 8} radius={radius - 4} fill="#ffffff"
                  interactive={false} />
          </Rect>
        </Rect>
        <Text markup font="sans" size={14} color="#ffffff">
          {`Press ${keyCap("Space", "#2c2c2c")} to save the screenshot.`}
        </Text>
      </Box>
    </Box>
  );
}
