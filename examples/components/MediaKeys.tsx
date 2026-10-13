import type { ComponentType } from "react";
import { Shortcut } from "proscenium";
import { changeBrightness } from "../lib/system/brightness.js";
import { mediaCommand } from "../lib/system/media.js";
import { changeVolume, toggleMute } from "../lib/system/sound.js";
import { useFlash } from "../hooks/useFlash.js";
import { LevelIndicator, type Level } from "./LevelIndicator.js";

interface MediaKeysProps {
  /** Shows the level a key changed; null for a world that shows levels itself. */
  indicator?: ComponentType<{ level: Level | null }> | null;
}

/** The media, volume and brightness keys; level changes show briefly. */
export function MediaKeys({ indicator: Indicator = LevelIndicator }: MediaKeysProps) {
  const [level, showLevel] = useFlash<Level>(1300);

  const adjust = (kind: Level, change: () => void) => () => {
    change();
    showLevel(kind);
  };

  return (
    <>
      {Indicator && <Indicator level={level} />}

      <Shortcut
        keys="XF86AudioRaiseVolume"
        repeat
        onPress={adjust("volume", () => changeVolume(0.05))}
      />
      <Shortcut
        keys="XF86AudioLowerVolume"
        repeat
        onPress={adjust("volume", () => changeVolume(-0.05))}
      />
      <Shortcut keys="XF86AudioMute" onPress={adjust("volume", toggleMute)} />

      <Shortcut
        keys="XF86MonBrightnessUp"
        repeat
        onPress={adjust("brightness", () => changeBrightness(5))}
      />
      <Shortcut
        keys="XF86MonBrightnessDown"
        repeat
        onPress={adjust("brightness", () => changeBrightness(-5))}
      />

      <Shortcut keys="XF86AudioPlay" onPress={() => mediaCommand("PlayPause")} />
      <Shortcut keys="XF86AudioPause" onPress={() => mediaCommand("PlayPause")} />
      <Shortcut keys="XF86AudioNext" onPress={() => mediaCommand("Next")} />
      <Shortcut keys="XF86AudioPrev" onPress={() => mediaCommand("Previous")} />
      <Shortcut keys="XF86AudioStop" onPress={() => mediaCommand("Stop")} />
    </>
  );
}
