import { memo, useRef, useState } from "react";
import { Group, Image, instant, Rect, rotate, scale, Text, tween } from "proscenium";
import { mediaCommand, type MediaInfo } from "../lib/system/media.js";
import { useArt } from "./art.js";
import player from "./assets/player/player.png?url";
import { palette } from "./config.js";
import { fonts } from "./fonts.js";
import { Marquee } from "./Marquee.js";
import { grooves } from "./paints.js";

const press = tween(0.3, [0.33, 1, 0.68, 1]);
const fade = tween(0.15, "linear");

function Skip({ x, glyph, onPress }: { x: number; glyph: string; onPress: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <Group x={x} y={15} width={30} height={30} cursor="pointer" onPointerEnter={() => setHovered(true)}
           onPointerLeave={() => setHovered(false)} onPointerDown={onPress}>
      <Text width={30} align="center" font={fonts.nerd} size={26} color={hovered ? palette.color3 : palette.foreground}
            transition={fade} interactive={false}>{glyph}</Text>
    </Group>
  );
}

/** The cover art as a record turning six degrees a second while it plays, and holding still while not. */
function Record({ media }: { media: MediaInfo | null }) {
  const art = useArt(media?.art ?? "");
  const [hovered, setHovered] = useState(false);
  const turned = useRef({ angle: 0, since: 0, playing: false });
  const playing = media?.playing ?? false;
  const turn = turned.current;
  if (playing !== turn.playing) {
    const now = performance.now() / 1000;
    if (turn.playing) turn.angle = (turn.angle + (now - turn.since) * 6) % 360;
    turn.since = now;
    turn.playing = playing;
  }
  return (
    <Group x={80} y={-5} width={60} height={60}>
      {art && (
        <Group x={8} y={8} width={44} height={44} transform={scale(hovered ? 0.8 : 1)} transition={press}>
          <Image src={art} width={44} height={44} fit="cover" transform={rotate(turn.angle)} transition={instant}
                 shaders={[{ id: "grooves", shader: grooves }]}
                 animate={playing ? { transform: [rotate(turn.angle), rotate(turn.angle + 360)], duration: 60,
                                      ease: "linear", iterations: Infinity, key: turn.since } : undefined} />
        </Group>
      )}
      <Rect width={60} height={60} cursor="pointer" onPointerEnter={() => setHovered(true)}
            onPointerLeave={() => setHovered(false)} onPointerDown={() => mediaCommand("PlayPause")} />
    </Group>
  );
}

/**
 * The bottom left corner, as the original lays out its 800 by 300 window: an
 * MP3 player turned 10°, the artist and title on its screen, and the cover
 * art as a record between the skip buttons.
 */
export const Player = memo(function Player({ bottom, media, moving }: { bottom: number; media: MediaInfo | null;
                                                                          moving: boolean }) {
  return (
    <Group y={bottom - 300} width={800} height={300} clip>
      <Image src={player} x={-20} y={-115} width={500} height={500} fit="contain" transform={rotate(10)}
             interactive={false} />
      <Group x={250} y={115} width={100} height={60} transform={rotate(10)}>
        {media?.artist && (
          <Marquee text={media.artist} x={-43} y={4} maxWidth={100} font={fonts.biolinum} size={16}
                   color={palette.color3} scrolling={moving} />
        )}
        <Marquee text={media ? media.title || "No title" : "No Media"} x={-43} y={23} maxWidth={100}
                 font={fonts.biolinum} size={21.3} color="#000000" scrolling={moving} />
        <Skip x={57} glyph="󰒮" onPress={() => media?.canPrevious && mediaCommand("Previous")} />
        <Record media={media} />
        <Skip x={133} glyph="󰒭" onPress={() => media?.canNext && mediaCommand("Next")} />
      </Group>
    </Group>
  );
});
