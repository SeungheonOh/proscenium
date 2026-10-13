import { Group, Image, Rect } from "proscenium";
import { useBrightness } from "../lib/system/brightness.js";
import { useVolume } from "../lib/system/sound.js";
import { useRetained } from "../hooks/useFrozen.js";
import brightnessIcon from "../icons/brightness.svg";
import mutedIcon from "../icons/volume-muted.svg";
import volumeIcon from "../icons/volume.svg";
import { colors, motion } from "../lib/theme.js";
import { BarText } from "./bar/BarText.js";
import { FloatingPill } from "./FloatingPill.js";

export type Level = "volume" | "brightness";

const trackWidth = 160;

/** The volume or brightness level a key just changed, shown briefly. */
export function LevelIndicator({ level }: { level: Level | null }) {
  const volume = useVolume();
  const brightness = useBrightness();
  const shown = useRetained(level) ?? "volume";

  const value =
    shown === "volume"
      ? volume?.muted
        ? 0
        : (volume?.volume ?? 0)
      : (brightness?.percent ?? 0) / 100;
  const icon = shown === "brightness" ? brightnessIcon : volume?.muted ? mutedIcon : volumeIcon;

  return (
    <FloatingPill shown={level !== null}>
      <Image src={icon} width={16} height={16} opacity={0.85} />
      <Group width={trackWidth} height={6}>
        <Rect width={trackWidth} height={6} radius={3} fill="#17171a17" />
        <Rect
          width={Math.max(6, trackWidth * Math.min(value, 1))}
          height={6}
          radius={3}
          fill={{ from: "#5b8cff", to: colors.accent, angle: 0 }}
          transition={motion.glide}
        />
      </Group>
      <BarText width={26} align="end" weight={600} color={colors.ink}>
        {String(Math.round(value * 100))}
      </BarText>
    </FloatingPill>
  );
}
