/** The volume and brightness indicator: a pill near the top of the screen. */

import { useEffect } from "react";
import { send } from "proscenium/page";
import { afterPaint } from "../painted.js";
import "../fonts.js";
import "./osd.css";

export interface OsdProps {
  /** Hidden, it draws nothing, so it never shows an old level. */
  shown?: boolean;
  kind?: "volume" | "brightness";
  /** 0..100. */
  level?: number;
  muted?: boolean;
}

export default function OsdPage({ shown = false, kind = "volume", level = 0, muted = false }: OsdProps) {
  const icon = kind === "brightness" ? "󰃠" : muted || level === 0 ? "󰖁" : "󰕾";
  // Drawn for the first time: it may be hidden until a level changes.
  useEffect(() => afterPaint(() => send("ready")), []);
  if (!shown) return null;
  return (
    <div className="osd">
      <span className="icon">{icon}</span>
      <div className="track"><div className="level" style={{ width: `${Math.min(level, 100)}%` }} /></div>
      <span className="value">{`${level}%`}</span>
    </div>
  );
}
