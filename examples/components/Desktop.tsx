import type { ComponentType } from "react";
import type { OutputInfo } from "proscenium";
import { Bar } from "./bar/Bar.js";
import { MediaKeys } from "./MediaKeys.js";
import { Screenshots } from "./Screenshots.js";
import { ShareChooser } from "./ShareChooser.js";

interface DesktopProps {
  /** The world's own controls, drawn at the left of the bar. */
  barStart?: ComponentType<{ output: OutputInfo }>;
}

/** What every example world shares: the bar, media keys, screen sharing and screenshots. */
export function Desktop({ barStart }: DesktopProps) {
  return (
    <>
      <Bar start={barStart} />
      <MediaKeys />
      <ShareChooser />
      <Screenshots />
    </>
  );
}
