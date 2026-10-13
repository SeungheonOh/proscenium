import { useEffect, useRef, useState } from "react";
import { Screen, Web } from "proscenium";
import { useHypr } from "../hypr/HyprProvider.js";
import { useFlash } from "../hooks/useFlash.js";
import { useBrightness } from "../lib/system/brightness.js";
import { useVolume } from "../lib/system/sound.js";
import osdPage from "./pages/osd/index.tsx?url";
import type { OsdProps } from "./pages/osd/index.js";

/** Calls CHANGED when VALUE changes, though not when it first becomes known. */
function useChange(value: unknown, changed: () => void) {
  const previous = useRef<unknown>(undefined);
  useEffect(() => {
    if (value === undefined || value === null) return;
    if (previous.current !== undefined && previous.current !== value) changed();
    previous.current = value;
  }, [value]);
}

/** A pill near the top of the screen for a second whenever the volume or the brightness changes. */
export function Osd() {
  const { focusOutput } = useHypr();
  const volume = useVolume();
  const brightness = useBrightness();
  const [shown, flash] = useFlash<"volume" | "brightness">(1000);
  // Shown once at the start, so Chromium draws the first change at once.
  const [ready, setReady] = useState(false);
  useChange(volume && `${volume.volume} ${volume.muted}`, () => flash("volume"));
  useChange(brightness?.percent, () => flash("brightness"));
  if (!focusOutput) return null;

  const props: OsdProps = shown === "brightness"
    ? { shown: true, kind: "brightness", level: brightness?.percent ?? 0 }
    : { shown: shown !== null, kind: "volume", level: Math.round((volume?.volume ?? 0) * 100),
        muted: volume?.muted ?? false };
  return (
    <Screen output={focusOutput.name}>
      <Web
        src={osdPage}
        props={props}
        x={(focusOutput.width - 550) / 2}
        y={focusOutput.height / 9}
        width={550}
        height={50}
        visible={shown !== null || !ready}
        interactive={false}
        focusable={false}
        onMessage={(name) => name === "ready" && setReady(true)}
      />
    </Screen>
  );
}
