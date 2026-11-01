import { readdirSync, readFileSync } from "node:fs";
import { useSyncExternalStore } from "react";
import { latestOnly, run, Source } from "./source.js";

export interface BrightnessInfo {
  /** 0..100. */
  percent: number;
  device: string;
}

/** Each backlight's maximum, read with its brightness. */
const brightnessMaximum = new Map<string, number>();

function readBrightness(): BrightnessInfo | null {
  try {
    const device = readdirSync("/sys/class/backlight")[0];
    if (!device) return null;
    const value = (file: string) =>
      Number(readFileSync(`/sys/class/backlight/${device}/${file}`, "utf8"));
    const maximum = Math.max(1, value("max_brightness"));
    brightnessMaximum.set(device, maximum);
    return { device, percent: Math.round((100 * value("brightness")) / maximum) };
  } catch {
    return null;
  }
}

const brightness = new Source<BrightnessInfo | null>(readBrightness(), (source) => {
  source.set(readBrightness());
  return () => undefined;
});

/** The first backlight's brightness; null without one. */
export function useBrightness(): BrightnessInfo | null {
  return useSyncExternalStore(brightness.subscribe, brightness.read);
}

const applyBrightness = latestOnly(({ device, value }: { device: string; value: number }) =>
  run("busctl", [
    "call",
    "org.freedesktop.login1",
    "/org/freedesktop/login1/session/auto",
    "org.freedesktop.login1.Session",
    "SetBrightness",
    "ssu",
    "backlight",
    device,
    String(value),
  ]),
);

/**
 * Set the backlight to PERCENT through logind, which allows the session's own
 * user; never below FLOOR, so a slider dragged to the end leaves the screen
 * lit. Rapid calls keep only the latest.
 */
export function setBrightness(percent: number, floor = 1): void {
  const current = brightness.value ?? readBrightness();
  const maximum = current && brightnessMaximum.get(current.device);
  if (!current || !maximum) return;
  const target = Math.min(Math.max(Math.round(percent), floor), 100);
  brightness.set({ ...current, percent: target });
  applyBrightness({ device: current.device, value: Math.round((maximum * target) / 100) });
}

/** Step the backlight by DELTA percent; the brightness keys step it all the way down to off. */
export function changeBrightness(delta: number): void {
  const current = brightness.value ?? readBrightness();
  if (current) setBrightness(current.percent + delta, 0);
}
