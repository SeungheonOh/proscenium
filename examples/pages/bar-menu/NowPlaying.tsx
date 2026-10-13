import type { MediaInfo } from "../../lib/system/media.js";
import { Icon, icons } from "./Icon.js";
import { sendBarMenuMessage } from "./messages.js";
import { Row } from "./Row.js";

/** The playing track and its controls, above the volume. */
export function NowPlaying({ media }: { media: MediaInfo }) {
  const subtitle = [media.artist, media.identity].filter(Boolean).join(" · ");
  return (
    <>
      <Row index={0}>
        <div className="grow">
          <div className="title ellipsis">{media.title}</div>
          <div className="muted ellipsis">{subtitle}</div>
        </div>
        <button
          className="round"
          disabled={!media.canPrevious}
          onClick={() => sendBarMenuMessage({ name: "media", value: "Previous" })}
        >
          <Icon path={icons.previous} />
        </button>
        <button
          className="round play primary"
          onClick={() => sendBarMenuMessage({ name: "media", value: "PlayPause" })}
        >
          <Icon path={media.playing ? icons.pause : icons.play} />
        </button>
        <button
          className="round"
          disabled={!media.canNext}
          onClick={() => sendBarMenuMessage({ name: "media", value: "Next" })}
        >
          <Icon path={icons.next} />
        </button>
      </Row>
      <div className="divider" />
    </>
  );
}
