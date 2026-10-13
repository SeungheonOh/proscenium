/**
 * Print saves the first output and Shift+Print an area of any output as a PNG
 * in ~/Pictures/Screenshots. The compositor only renders and reads the pixels;
 * encoding and writing happen here, off its thread.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { useEffect, useState } from "react";
import {
  encodePng,
  Rect,
  Screen,
  screenshot,
  Shortcut,
  tween,
  useOutputs,
  type ShareSource,
} from "proscenium";
import { useFlash } from "../hooks/useFlash.js";
import { useRetained } from "../hooks/useFrozen.js";
import { screenshotDirectory } from "../lib/settings.js";
import { AreaSelection, type OutputArea } from "./AreaSelection.js";
import { BarText } from "./bar/BarText.js";
import { FloatingPill } from "./FloatingPill.js";

const flashFade = tween(0.45, "ease-out");

async function saveScreenshot(source: ShareSource): Promise<string> {
  const png = await encodePng(await screenshot(source));
  // The Swedish locale formats local time as ISO 8601: "2026-10-05 14:30:00".
  const stamp = new Date().toLocaleString("sv-SE").replaceAll(":", "-");
  const path = join(screenshotDirectory, `Screenshot ${stamp}.png`);
  await mkdir(screenshotDirectory, { recursive: true });
  await writeFile(path, png);
  return path;
}

export function Screenshots() {
  const outputs = useOutputs();
  const [selectingArea, setSelectingArea] = useState(false);
  const [request, setRequest] = useState<ShareSource | null>(null);
  const [taken, setTaken] = useState(0);
  const [message, showMessage] = useFlash<string>(1800);
  const shownMessage = useRetained(message);

  // Runs after the commit that removed the area selection, so it is not in the picture.
  useEffect(() => {
    if (!request) return;
    setRequest(null);
    saveScreenshot(request).then(
      () => {
        setTaken((count) => count + 1);
        showMessage("Screenshot saved to Pictures");
      },
      (error: Error) => showMessage(`Screenshot failed: ${error.message}`),
    );
  }, [request, showMessage]);

  function handleArea(area: OutputArea | null) {
    setSelectingArea(false);
    if (!area) return;
    const { output, ...region } = area;
    setRequest({ output, region });
  }

  return (
    <>
      <Shortcut keys="Print" onPress={() => setRequest({ output: outputs[0]?.name })} />
      <Shortcut keys="Shift+Print" onPress={() => setSelectingArea(true)} />

      {selectingArea && (
        <AreaSelection prompt="Drag to capture an area · Esc to cancel" onDone={handleArea} />
      )}

      {/* Each picture fades in a white flash; a new key replays it. */}
      {taken > 0 &&
        outputs.map((output) => (
          <Screen key={`${output.name}:${taken}`} output={output.name}>
            <Rect
              width={output.width}
              height={output.height}
              fill="#ffffff"
              opacity={0}
              initial={{ opacity: 0.45 }}
              transition={flashFade}
            />
          </Screen>
        ))}

      <FloatingPill shown={message !== null}>
        <BarText weight={600}>{shownMessage ?? ""}</BarText>
      </FloatingPill>
    </>
  );
}
