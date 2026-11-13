import type { ComponentType, ReactNode } from "react";
import type { OutputInfo } from "proscenium";
import { GenerativeUI } from "../genui/GenerativeUI.js";
import { Bar } from "./bar/Bar.js";
import { MediaKeys } from "./MediaKeys.js";
import { Screenshots } from "./Screenshots.js";
import { ShareChooser } from "./ShareChooser.js";

interface DesktopProps {
  /** The world's own controls, drawn at the left of the bar. */
  barStart?: ComponentType<{ output: OutputInfo }>;
  /** Whether the bar names the focused window; true unless a world says not. */
  windowTitle?: boolean;
  /** The world's own screen chrome (a minimap), drawn with the bar: over cards pinned to the canvas. */
  chrome?: ReactNode;
}

/**
 * What every example world shares: the bar, media keys, screen sharing, screenshots,
 * and generated interfaces with the assistant's chat (Super+A).
 */
export function Desktop({ barStart, windowTitle = true, chrome }: DesktopProps) {
  return (
    <>
      <MediaKeys />
      <ShareChooser />
      <Screenshots />
      {/* The bar goes in among the generated interfaces, over the canvas's and under the screen's. */}
      <GenerativeUI bar={<>{chrome}<Bar start={barStart} windowTitle={windowTitle} /></>} />
    </>
  );
}
