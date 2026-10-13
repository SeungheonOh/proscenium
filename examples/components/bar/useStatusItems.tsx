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
import { BarText, RollingText } from "./BarText.js";
import { BatteryGauge } from "./BatteryGauge.js";

export interface StatusItem {
  key: string;
  /** The menu the item opens; items without one call `onPress` instead. */
  menu?: MenuKind;
  onPress?: () => void;
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
  const items: StatusItem[] = [];

  if (sharing.count > 0) {
    items.push({ key: "sharing", onPress: sharing.stopAll, content: <SharingBadge /> });
  }

  if (media?.title) {
    const label = media.artist ? `${media.title} · ${media.artist}` : media.title;
    items.push({
      key: "media",
      menu: "sound",
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
      content: (
        <>
          <Icon src={volume.muted ? mutedIcon : volumeIcon} />
          <BarText>{volume.muted ? "Off" : `${Math.round(volume.volume * 100)}%`}</BarText>
        </>
      ),
    });
  }

  items.push({ key: "clipboard", menu: "clipboard", content: <Icon src={clipboardIcon} /> });

  if (battery) {
    items.push({
      key: "battery",
      menu: "battery",
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
