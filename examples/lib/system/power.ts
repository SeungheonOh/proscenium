import { useSyncExternalStore } from "react";
import { debounced, follow, run, Source } from "./source.js";

export interface PowerProfileInfo {
  /** "power-saver", "balanced" or "performance". */
  current: string;
  available: string[];
}

async function readPowerProfile(): Promise<PowerProfileInfo | null> {
  const [current, list] = await Promise.all([
    run("powerprofilesctl", ["get"]),
    run("powerprofilesctl", ["list"]),
  ]);
  if (!current) return null;
  const available = [...(list ?? "").matchAll(/^[* ] ([\w-]+):/gm)].map((match) => match[1]!);
  return {
    current: current.trim(),
    available: available.length > 0 ? available.reverse() : [current.trim()],
  };
}

const powerProfile = new Source<PowerProfileInfo | null>(null, (source) => {
  const refresh = debounced(() => void readPowerProfile().then((value) => source.set(value)), 80);
  refresh();
  // Changes made elsewhere (a power button, the daemon on low battery) arrive as property signals.
  return follow(
    "gdbus",
    ["monitor", "--system", "--dest", "org.freedesktop.UPower.PowerProfiles"],
    (line) => {
      if (line.includes("ActiveProfile")) refresh();
    },
  );
});

/** The active power profile, from power-profiles-daemon; null without it. */
export function usePowerProfile(): PowerProfileInfo | null {
  return useSyncExternalStore(powerProfile.subscribe, powerProfile.read);
}

export function setPowerProfile(name: string): void {
  if (powerProfile.value) powerProfile.set({ ...powerProfile.value, current: name });
  void run("powerprofilesctl", ["set", name])
    .then(() => readPowerProfile())
    .then((value) => powerProfile.set(value));
}
