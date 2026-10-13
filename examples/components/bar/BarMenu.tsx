import { useMemo } from "react";
import { scale, Screen, useClipboard, useOutputs, Web } from "proscenium";
import { useBattery } from "../../lib/system/battery.js";
import { setBrightness, useBrightness } from "../../lib/system/brightness.js";
import { mediaCommand, useMedia } from "../../lib/system/media.js";
import { setPowerProfile, usePowerProfile } from "../../lib/system/power.js";
import { setVolume, toggleMute, useVolume } from "../../lib/system/sound.js";
import { useFrozen, useRetained } from "../../hooks/useFrozen.js";
import { glassBorder, motion } from "../../lib/theme.js";
import menuPage from "../../pages/bar-menu/index.tsx?url";
import type { BarMenuMessage, BarMenuProps, MenuKind } from "../../pages/bar-menu/index.js";
import { barLayout } from "./layout.js";

export interface OpenMenu {
  kind: MenuKind;
  /** The bar item that opened the menu, which it hangs under. */
  item: string;
  output: string;
  /** Right edge of that item on its output. */
  right: number;
  /** Counts openings, so the page replays its entrance each time. */
  opened: number;
}

const menuWidth: Record<MenuKind, number> = { sound: 320, battery: 320, clipboard: 360 };

function menuHeight(kind: MenuKind, clipboardEntries: number, hasMedia: boolean) {
  switch (kind) {
    case "battery":
      return 196;
    case "sound":
      return hasMedia ? 206 : 134;
    case "clipboard":
      // Grows with the history, up to six entries before it scrolls.
      return 80 + 36 * Math.min(Math.max(clipboardEntries, 1), 6);
  }
}

interface BarMenuHostProps {
  menu: OpenMenu | null;
  onClose: () => void;
}

/** The menu page: always loaded, springing open under the item that opened it. */
export function BarMenu({ menu, onClose }: BarMenuHostProps) {
  const outputs = useOutputs();
  const volume = useVolume();
  const battery = useBattery();
  const profile = usePowerProfile();
  const media = useMedia();
  const brightness = useBrightness();
  const clipboard = useClipboard();

  // A closing menu keeps its place and content while it fades out, and the
  // hidden page receives nothing until it opens again.
  const shown = useRetained(menu);
  const liveProps = useMemo<BarMenuProps>(
    () => ({
      kind: shown?.kind ?? null,
      opened: shown?.opened ?? 0,
      volume,
      battery,
      profile,
      media,
      brightness,
      clipboard: clipboard.history.slice(0, 12),
    }),
    [shown, volume, battery, profile, media, brightness, clipboard.history],
  );
  const props = useFrozen(liveProps, menu === null);

  const output = outputs.find((candidate) => candidate.name === shown?.output) ?? outputs[0];
  if (!output) return null;

  const kind = props.kind ?? "sound";
  const width = menuWidth[kind];
  const height = menuHeight(kind, props.clipboard?.length ?? 0, Boolean(props.media?.title));
  const right = shown?.right ?? output.width;
  const x = Math.min(Math.max(8, right - width), output.width - width - 8);

  function handleMessage(message: BarMenuMessage) {
    switch (message.name) {
      case "volume":
        return setVolume(message.value);
      case "mute":
        return toggleMute();
      case "media":
        return mediaCommand(message.value);
      case "brightness":
        return setBrightness(message.value);
      case "profile":
        return setPowerProfile(message.value);
      case "clear":
        return clipboard.clear();
      case "copy":
        clipboard.copy(message.value);
        return onClose();
      case "close":
        return onClose();
    }
  }

  return (
    <Screen output={output.name}>
      <Web
        src={menuPage}
        props={props}
        autoFocus
        interactive={menu !== null}
        x={x}
        y={menu ? barLayout.reserve : barLayout.reserve - 10}
        width={width}
        height={height}
        originX={1}
        originY={0}
        radius={14}
        blur={24}
        border={glassBorder}
        shadow={{ color: "#0000002e", blur: 34, y: 12 }}
        opacity={menu ? 1 : 0}
        transform={scale(menu ? 1 : 0.94)}
        transition={motion.pop}
        onMessage={(name, value) => handleMessage({ name, value } as BarMenuMessage)}
      />
    </Screen>
  );
}
