import type { MediaInfo } from "../../lib/system/media.js";
import type { VolumeInfo } from "../../lib/system/sound.js";
import { cx } from "../shared.js";
import { sendBarMenuMessage } from "./messages.js";
import { NowPlaying } from "./NowPlaying.js";
import { Row } from "./Row.js";
import { Slider } from "./Slider.js";

interface SoundMenuProps {
  volume?: VolumeInfo | null;
  media?: MediaInfo | null;
}

export function SoundMenu({ volume, media }: SoundMenuProps) {
  if (!volume) {
    return (
      <Row index={0} className="muted">
        No sound output
      </Row>
    );
  }

  const percent = Math.round(volume.volume * 100);
  const first = media?.title ? 1 : 0;

  return (
    <>
      {media?.title && <NowPlaying media={media} />}
      <Row index={first} className="between">
        <span className="title">Sound</span>
        <span className="muted">{volume.muted ? "Muted" : `${percent}%`}</span>
      </Row>
      <Row index={first + 1}>
        <Slider
          value={volume.muted ? 0 : percent}
          onChange={(value) => sendBarMenuMessage({ name: "volume", value: value / 100 })}
        />
      </Row>
      <Row index={first + 2} className="between">
        <span className="muted ellipsis">{volume.device}</span>
        <button
          className={cx("toggle", volume.muted && "on")}
          onClick={() => sendBarMenuMessage({ name: "mute" })}
        >
          {volume.muted ? "Unmute" : "Mute"}
        </button>
      </Row>
    </>
  );
}
