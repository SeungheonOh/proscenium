/**
 * The drawer's full-screen menus, rendered by Chromium: calendar, stats,
 * shaders and power, each with the entrance the original gives it.
 */

import { useEffect, type CSSProperties } from "react";
import { send } from "proscenium/page";
import { ease } from "../easing.js";
import { afterPaint } from "../painted.js";
import { Calendar } from "./Calendar.js";
import { Options, type ScreenFilter } from "./Options.js";
import { Power, type PowerAction } from "./Power.js";
import { Stats, type StatsData } from "./Stats.js";
import "../fonts.js";
import "./menus.css";

export type { PowerAction, ScreenFilter, StatsData };

export interface MenusProps {
  menu?: { kind: "calendar" | "stats" | "options" | "power"; serial: number } | null;
  now?: number;
  stats?: StatsData;
  filter?: ScreenFilter | null;
}

/** What the menus ask of the world. */
export type MenusMessage =
  | { name: "close" }
  /** Whether a menu is on screen, sent once it has been drawn. */
  | { name: "showing"; value: boolean }
  | { name: "power"; value: PowerAction }
  | { name: "filter"; value: ScreenFilter | null };

const message = (value: MenusMessage) => send(value.name, "value" in value ? value.value : null);
const close = () => message({ name: "close" });

/** Qt's easings, for the stylesheet. */
const easings = {
  "--out-cubic": ease.outCubic,
  "--in-cubic": ease.inCubic,
  "--back-1-5": ease.outBack(1.5),
  "--back-2": ease.outBack(2),
  "--back-3": ease.outBack(3),
} as CSSProperties;

const noStats: StatsData = { system: null, networks: [], bluetooth: null };

export default function MenusPage({ menu = null, now = Date.now(), stats = noStats, filter = null }: MenusProps) {
  // The world hides this page only once it shows nothing, so reopening never shows the last menu.
  useEffect(() => afterPaint(() => message({ name: "showing", value: menu !== null })), [menu?.serial ?? 0]);

  const kind = menu?.kind;
  return (
    <div className="menus" style={easings}>
      {kind === "calendar" && <Calendar key={menu!.serial} now={now} onClose={close} />}
      {kind === "stats" && <Stats key={menu!.serial} data={stats} onClose={close} />}
      {kind === "options" && (
        <Options key={menu!.serial} filter={filter} onClose={close}
                 onFilter={(value) => message({ name: "filter", value })} />
      )}
      {kind === "power" && (
        <Power key={menu!.serial} onClose={close} onAction={(value) => message({ name: "power", value })} />
      )}
    </div>
  );
}
