import { useSyncExternalStore } from "react";
import { debounced, follow, run, Source } from "./source.js";

export interface MediaInfo {
  /** Bus name of the player, e.g. "org.mpris.MediaPlayer2.firefox.instance_1_42". */
  player: string;
  /** The player's own name, e.g. "Firefox". */
  identity: string;
  playing: boolean;
  title: string;
  artist: string;
  canNext: boolean;
  canPrevious: boolean;
}

const mprisPrefix = "org.mpris.MediaPlayer2.";
const mprisPath = "/org/mpris/MediaPlayer2";

async function busProperties(
  name: string,
  iface: string,
  properties: string[],
): Promise<unknown[] | null> {
  const output = await run("busctl", [
    "--user",
    "--json=short",
    "get-property",
    name,
    mprisPath,
    iface,
    ...properties,
  ]);
  if (!output) return null;
  try {
    return output
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { data: unknown }).data);
  } catch {
    return null;
  }
}

async function readMedia(): Promise<MediaInfo | null> {
  const listing = await run("busctl", ["--user", "list", "--no-legend"]);
  const players = (listing ?? "")
    .split("\n")
    .map((line) => line.split(/\s+/))
    .filter(([name, pid]) => name?.startsWith(mprisPrefix) && pid !== "-")
    .map(([name]) => name!);
  const states = await Promise.all(
    players.map(async (player) => {
      const values = await busProperties(player, "org.mpris.MediaPlayer2.Player", [
        "PlaybackStatus",
        "Metadata",
        "CanGoNext",
        "CanGoPrevious",
      ]);
      return values ? { player, values } : null;
    }),
  );
  const known = states.filter((state) => state !== null);
  // The player that is playing, else the first one that has something loaded.
  const chosen = known.find((state) => state.values[0] === "Playing") ?? known[0];
  if (!chosen) return null;
  const metadata = (chosen.values[1] ?? {}) as Record<string, { data: unknown }>;
  const identity = await busProperties(chosen.player, "org.mpris.MediaPlayer2", ["Identity"]);
  const artist = metadata["xesam:artist"]?.data;
  return {
    player: chosen.player,
    identity: String(identity?.[0] ?? chosen.player.slice(mprisPrefix.length).split(".")[0]),
    playing: chosen.values[0] === "Playing",
    title: String(metadata["xesam:title"]?.data ?? ""),
    artist: Array.isArray(artist) ? artist.join(", ") : String(artist ?? ""),
    canNext: chosen.values[2] === true,
    canPrevious: chosen.values[3] === true,
  };
}

const media = new Source<MediaInfo | null>(null, (source) => {
  const refresh = debounced(() => void readMedia().then((value) => source.set(value)), 150);
  refresh();
  // Players announce state and track changes; nothing is polled.
  return follow(
    "dbus-monitor",
    [
      "--session",
      `type='signal',interface='org.freedesktop.DBus.Properties',member='PropertiesChanged',path='${mprisPath}'`,
      "type='signal',sender='org.freedesktop.DBus',member='NameOwnerChanged',arg0namespace='org.mpris.MediaPlayer2'",
    ],
    (line) => {
      if (line.startsWith("signal")) refresh();
    },
  );
});

/** The media player that is playing, or the first one with a track; null without any. */
export function useMedia(): MediaInfo | null {
  return useSyncExternalStore(media.subscribe, media.read);
}

/** Send a player command; without PLAYER, to the current one. */
export function mediaCommand(
  command: "PlayPause" | "Next" | "Previous" | "Stop",
  player?: string,
): void {
  const target = player ?? media.value?.player;
  if (!target) return;
  if (command === "PlayPause" && media.value)
    media.set({ ...media.value, playing: !media.value.playing });
  void run("busctl", [
    "--user",
    "call",
    target,
    mprisPath,
    "org.mpris.MediaPlayer2.Player",
    command,
  ]);
}
