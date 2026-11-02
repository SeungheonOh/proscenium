import type { ComponentType } from "react";
import type { OutputInfo } from "proscenium";
import { Bar } from "./bar/Bar.js";
import { MediaKeys } from "./MediaKeys.js";
import { Screenshots } from "./Screenshots.js";
import { ShareChooser } from "./ShareChooser.js";

interface DesktopProps {
  /** The world's own controls, drawn at the left of the bar. */
  barStart?: ComponentType<{ output: OutputInfo }>;
  /** Whether the bar names the focused window; true unless a world says not. */
  windowTitle?: boolean;
}

/** What every example world shares: the bar, media keys, screen sharing and screenshots. */
export function Desktop({ barStart, windowTitle = true }: DesktopProps) {
  return (
    <>
      <Bar start={barStart} windowTitle={windowTitle} />
      <MediaKeys />
      <ShareChooser />
      <Screenshots />
    </>
  );
}
