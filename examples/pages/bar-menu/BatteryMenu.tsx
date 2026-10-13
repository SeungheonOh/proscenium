import type { BatteryInfo } from "../../lib/system/battery.js";
import type { BrightnessInfo } from "../../lib/system/brightness.js";
import type { PowerProfileInfo } from "../../lib/system/power.js";
import { cx } from "../shared.js";
import { sendBarMenuMessage } from "./messages.js";
import { Row } from "./Row.js";
import { Slider } from "./Slider.js";

const profileNames: Record<string, string> = {
  "power-saver": "Saver",
  balanced: "Balanced",
  performance: "Performance",
};

function formatDuration(minutes: number) {
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}

function describeBattery(battery: BatteryInfo) {
  if (battery.full) return "Fully charged";
  if (battery.pluggedIn && !battery.charging) return "Plugged in";
  const remaining = battery.minutes === null ? null : formatDuration(battery.minutes);
  if (battery.charging) return remaining ? `Charging · ${remaining} to full` : "Charging";
  return remaining ? `${remaining} left` : "On battery";
}

interface BatteryMenuProps {
  battery?: BatteryInfo | null;
  profile?: PowerProfileInfo | null;
  brightness?: BrightnessInfo | null;
}

export function BatteryMenu({ battery, profile, brightness }: BatteryMenuProps) {
  return (
    <>
      <Row index={0}>
        <span className="big">{battery ? `${battery.percent}%` : "—"}</span>
        <span className={cx("badge", battery?.charging && "charging")}>
          {battery ? describeBattery(battery) : "No battery"}
        </span>
        {battery?.watts ? <span className="muted">{battery.watts} W</span> : null}
      </Row>

      {brightness && (
        <>
          <Row index={1} className="between">
            <span className="title">Display</span>
            <span className="muted">{brightness.percent}%</span>
          </Row>
          <Row index={2}>
            <Slider
              min={1}
              value={brightness.percent}
              onChange={(value) => sendBarMenuMessage({ name: "brightness", value })}
            />
          </Row>
        </>
      )}

      {profile && (
        <Row index={3}>
          <div className="segment grow">
            {profile.available.map((name) => (
              <button
                key={name}
                className={cx(name === profile.current && "on")}
                onClick={() => sendBarMenuMessage({ name: "profile", value: name })}
              >
                {profileNames[name] ?? name}
              </button>
            ))}
          </div>
        </Row>
      )}
    </>
  );
}
