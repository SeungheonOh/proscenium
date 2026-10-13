import { useEffect, useRef, useState } from "react";

/**
 * SRC as a blob URL. The page's own scheme serves a file whole, with no length
 * or ranges, which a video element cannot play from; a blob it can.
 */
function useBlob(src: string): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let current: string | undefined;
    let gone = false;
    void fetch(src).then((response) => response.blob()).then((blob) => {
      if (gone) return;
      current = URL.createObjectURL(blob);
      setUrl(current);
    });
    return () => {
      gone = true;
      if (current) URL.revokeObjectURL(current);
    };
  }, [src]);
  return url;
}

interface VideoProps {
  src: string;
  /** Plays while true and is paused otherwise; it loads from the start either way. */
  playing: boolean;
  loop?: boolean;
  hidden?: boolean;
  onEnded?: () => void;
  onPlaying?: () => void;
}

/** A muted video covering the page. */
export function Video({ src, playing, loop = false, hidden = false, onEnded, onPlaying }: VideoProps) {
  const url = useBlob(src);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (playing && url) void video.current!.play();
    else video.current!.pause();
  }, [playing, url]);
  return (
    <video ref={video} className="backdrop" src={url} muted loop={loop} preload="auto" hidden={hidden}
           onEnded={onEnded} onPlaying={onPlaying} />
  );
}
