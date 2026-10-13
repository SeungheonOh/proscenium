import { useSyncExternalStore } from "react";
import { debounced, follow, latestOnly, run, Source } from "./source.js";

export interface VolumeInfo {
  /** Default output volume, 0..1 (may exceed 1 when amplified). */
  volume: number;
  muted: boolean;
  /** The default output's description, e.g. "Built-in Audio Analog Stereo". */
  device: string;
}

const sink = "@DEFAULT_AUDIO_SINK@";

async function readVolume(): Promise<VolumeInfo | null> {
  const [level, details] = await Promise.all([
    run("wpctl", ["get-volume", sink]),
    run("wpctl", ["inspect", sink]),
  ]);
  const match = level?.match(/Volume:\s*([\d.]+)/);
  if (!match) return null;
  return {
    volume: Number(match[1]),
    muted: level!.includes("[MUTED]"),
    device: details?.match(/node\.description = "([^"]*)"/)?.[1] ?? "Output",
  };
}

const volume = new Source<VolumeInfo | null>(null, (source) => {
  const refresh = debounced(() => void readVolume().then((value) => source.set(value)), 80);
  refresh();
  // pw-mon prints the graph once, then one block per change.
  const stop = follow("pw-mon", ["-N"], (line) => {
    if (line.startsWith("changed:")) refresh();
  });
  return stop;
});

/** The default output's volume; null until known or without PipeWire. */
export function useVolume(): VolumeInfo | null {
  return useSyncExternalStore(volume.subscribe, volume.read);
}

const applyVolume = latestOnly((level: number) =>
  run("wpctl", ["set-volume", sink, level.toFixed(2)]),
);

/** Set the default output's volume, 0..1. Rapid calls (a dragged slider) keep only the latest. */
export function setVolume(level: number): void {
  const clamped = Math.min(Math.max(level, 0), 1);
  if (volume.value) volume.set({ ...volume.value, volume: clamped });
  applyVolume(clamped);
}

export function toggleMute(): void {
  if (volume.value) volume.set({ ...volume.value, muted: !volume.value.muted });
  void run("wpctl", ["set-mute", sink, "toggle"]);
}

/** Change the default output's volume by DELTA (0..1 scale), capped at full volume. */
export function changeVolume(delta: number): void {
  if (volume.value) {
    volume.set({
      ...volume.value,
      muted: false,
      volume: Math.min(Math.max(volume.value.volume + delta, 0), 1),
    });
  }
  const step = `${Math.round(Math.abs(delta) * 100)}%${delta >= 0 ? "+" : "-"}`;
  void run("wpctl", ["set-volume", "-l", "1.0", sink, step]);
  if (delta > 0) void run("wpctl", ["set-mute", sink, "0"]);
}
