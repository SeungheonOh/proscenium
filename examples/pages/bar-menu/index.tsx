/**
 * The bar's menus, rendered by Chromium: sound and what is playing, battery
 * with display brightness and power mode, and clipboard history. One page
 * serves all three, so opening a menu reuses the already loaded page. Each
 * opening replays a short staggered entrance; everything else is CSS
 * transitions, so the page is idle between interactions.
 */

import { useEffect } from "react";
import type { BatteryInfo } from "../../lib/system/battery.js";
import type { BrightnessInfo } from "../../lib/system/brightness.js";
import type { MediaInfo } from "../../lib/system/media.js";
import type { PowerProfileInfo } from "../../lib/system/power.js";
import type { VolumeInfo } from "../../lib/system/sound.js";
import { BatteryMenu } from "./BatteryMenu.js";
import { ClipboardMenu } from "./ClipboardMenu.js";
import { sendBarMenuMessage } from "./messages.js";
import { SoundMenu } from "./SoundMenu.js";
import "./bar-menu.css";

export type { BarMenuMessage } from "./messages.js";

export type MenuKind = "sound" | "battery" | "clipboard";

export interface BarMenuProps {
  kind?: MenuKind | null;
  /** Counts openings; a new value replays the entrance. */
  opened?: number;
  volume?: VolumeInfo | null;
  battery?: BatteryInfo | null;
  profile?: PowerProfileInfo | null;
  media?: MediaInfo | null;
  brightness?: BrightnessInfo | null;
  clipboard?: readonly string[];
}

export default function BarMenuPage({ kind, opened, ...state }: BarMenuProps) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") sendBarMenuMessage({ name: "close" });
    }
    addEventListener("keydown", handleKeyDown);
    return () => removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    // Keyed by opening, so every opening replays the entrance.
    <div className="card" key={`${kind}:${opened}`}>
      {kind === "sound" && <SoundMenu volume={state.volume} media={state.media} />}
      {kind === "battery" && (
        <BatteryMenu
          battery={state.battery}
          profile={state.profile}
          brightness={state.brightness}
        />
      )}
      {kind === "clipboard" && <ClipboardMenu entries={state.clipboard} />}
    </div>
  );
}
