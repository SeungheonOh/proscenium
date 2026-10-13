import { readdirSync, readFileSync } from "node:fs";
import { useSyncExternalStore } from "react";
import { debounced, follow, Source } from "./source.js";

export interface BatteryInfo {
  /** Charge, 0..100. */
  percent: number;
  charging: boolean;
  full: boolean;
  /** On external power, whether or not it is charging. */
  pluggedIn: boolean;
  /** Minutes until empty while discharging, or until full while charging; null if unknown. */
  minutes: number | null;
  /** Current draw or charge rate in watts, when the battery reports it. */
  watts: number | null;
}

function readBattery(): BatteryInfo | null {
  try {
    const name = readdirSync("/sys/class/power_supply").find((entry) => entry.startsWith("BAT"));
    if (!name) return null;
    const field = (key: string) => {
      try {
        return readFileSync(`/sys/class/power_supply/${name}/${key}`, "utf8").trim();
      } catch {
        return null;
      }
    };
    const number = (key: string) => {
      const value = Number(field(key));
      return Number.isFinite(value) ? value : null;
    };
    const status = field("status");
    const now = number("energy_now") ?? number("charge_now");
    const full = number("energy_full") ?? number("charge_full");
    const rate = number("power_now") ?? number("current_now");
    const charging = status === "Charging";
    const adapter = readdirSync("/sys/class/power_supply").find((entry) => {
      try {
        return readFileSync(`/sys/class/power_supply/${entry}/type`, "utf8").trim() === "Mains";
      } catch {
        return false;
      }
    });
    const online = adapter
      ? readFileSync(`/sys/class/power_supply/${adapter}/online`, "utf8").trim() === "1"
      : status !== "Discharging";
    const minutes =
      rate && rate > 0 && now !== null && full !== null
        ? Math.round((60 * (charging ? full - now : now)) / rate)
        : null;
    return {
      percent: Number(field("capacity") ?? 0),
      charging,
      full: status === "Full",
      pluggedIn: online,
      minutes,
      watts: rate && number("power_now") !== null ? Math.round(rate / 1e5) / 10 : null,
    };
  } catch {
    return null;
  }
}

const battery = new Source(readBattery(), (source) => {
  const refresh = debounced(() => source.set(readBattery()), 200);
  source.set(readBattery());
  // UPower reports charge and power changes; without it, read the battery every few minutes.
  let fallback: NodeJS.Timeout | undefined;
  const stop = follow("upower", ["--monitor"], refresh, () => {
    fallback = setInterval(refresh, 300_000);
  });
  return () => {
    stop();
    clearInterval(fallback);
  };
});

/** The first battery's state; null without a battery. */
export function useBattery(): BatteryInfo | null {
  return useSyncExternalStore(battery.subscribe, battery.read);
}
