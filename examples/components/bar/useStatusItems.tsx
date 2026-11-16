import type { ReactNode } from "react";
import { Box, Image, Rect, scale } from "proscenium";
import { useBattery } from "../../lib/system/battery.js";
import { useMedia } from "../../lib/system/media.js";
import { useVolume } from "../../lib/system/sound.js";
import { useSharing } from "../../hooks/useSharing.js";
import clipboardIcon from "../../icons/clipboard.svg";
import musicIcon from "../../icons/music.svg";
import mutedIcon from "../../icons/volume-muted.svg";
import volumeIcon from "../../icons/volume.svg";
import { colors, motion } from "../../lib/theme.js";
import type { MenuKind } from "../../pages/bar-menu/index.js";
import type { MenuEntry } from "proscenium/ui";
import { useClipboard } from "proscenium";
import { mediaCommand } from "../../lib/system/media.js";
import { setPowerProfile, usePowerProfile } from "../../lib/system/power.js";
import { toggleMute } from "../../lib/system/sound.js";
import { profileNames } from "./KitBarMenu.js";
import { BarText, RollingText } from "./BarText.js";
import { BatteryGauge } from "./BatteryGauge.js";

export interface StatusItem {
  key: string;
  /** The menu the item opens; items without one call `onPress` instead. */
  menu?: MenuKind;
  onPress?: () => void;
  /** What a right click on it offers. */
  contextMenu?: MenuEntry[];
  /** Laid out in a row; the item sizes to it. */
  content: ReactNode;
}

function Icon({ src, opacity = 0.85 }: { src: string; opacity?: number }) {
  return <Image src={src} width={16} height={16} opacity={opacity} transition={motion.pop} />;
}

function SharingBadge() {
  return (
    <Box
      flexDirection="row"
      alignItems="center"
      gap={6}
      height={22}
      paddingX={10}
      radius={11}
      fill="#e0443e1c"
      initial={{ opacity: 0, transform: scale(0.8) }}
      transition={motion.pop}
    >
      <Rect width={8} height={8} radius={4} fill={colors.danger} />
      <BarText weight={600} color="#c0322c">
        Sharing
      </BarText>
    </Box>
  );
}

/** The bar's right-hand items, left to right, for whatever this machine has. */
export function useStatusItems(): StatusItem[] {
  const sharing = useSharing();
  const media = useMedia();
  const volume = useVolume();
  const battery = useBattery();
  const profile = usePowerProfile();
  const clipboard = useClipboard();
  const items: StatusItem[] = [];

  if (sharing.count > 0) {
    items.push({ key: "sharing", onPress: sharing.stopAll, content: <SharingBadge /> });
  }

  if (media?.title) {
    const label = media.artist ? `${media.title} · ${media.artist}` : media.title;
    items.push({
      key: "media",
      menu: "sound",
      contextMenu: [
        { label: media.playing ? "Pause" : "Play", onSelect: () => mediaCommand("PlayPause") },
        { label: "Next", disabled: !media.canNext, onSelect: () => mediaCommand("Next") },
        { label: "Previous", disabled: !media.canPrevious, onSelect: () => mediaCommand("Previous") },
      ],
      content: (
        <>
          <Icon src={musicIcon} opacity={media.playing ? 0.85 : 0.4} />
          <RollingText
            identity={media.title}
            maxWidth={196}
            color={media.playing ? "#17171acc" : "#17171a80"}
          >
            {label}
          </RollingText>
        </>
      ),
    });
  }

  if (volume) {
    items.push({
      key: "sound",
      menu: "sound",
      contextMenu: [{ label: "Mute", checked: volume.muted, onSelect: toggleMute }],
      content: (
        <>
          <Icon src={volume.muted ? mutedIcon : volumeIcon} />
          <BarText>{volume.muted ? "Off" : `${Math.round(volume.volume * 100)}%`}</BarText>
        </>
      ),
    });
  }

  items.push({
    key: "clipboard",
    menu: "clipboard",
    contextMenu: [{ label: "Clear history", danger: true, disabled: clipboard.history.length === 0, onSelect: clipboard.clear }],
    content: <Icon src={clipboardIcon} />,
  });

  if (battery) {
    items.push({
      key: "battery",
      menu: "battery",
      contextMenu: profile ? [
        { type: "label", label: "Power mode" },
        ...profile.available.map((name) => ({
          label: profileNames[name] ?? name, checked: name === profile.current, onSelect: () => setPowerProfile(name),
        })),
      ] : undefined,
      content: (
        <>
          <BatteryGauge percent={battery.percent} charging={battery.charging} />
          <BarText>{`${battery.percent}%`}</BarText>
        </>
      ),
    });
  }

  return items;
}
