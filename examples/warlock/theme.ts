/**
 * Warlock's design language ("Lacquer"): its colours for the Night, Dawn and
 * high-contrast themes, type, shape and shadows, taken from its tokens
 * (site/assets/shared/tokens.css) and the skin its desktop is drawn with
 * (shell-skin.css, desktop.css). A theme is made once per combination of
 * settings, so styles built from it are made once too.
 */

import { createContext, useContext } from "react";
import type { Color, Shadow, TextProps } from "proscenium";

export type ThemeName = "night" | "dawn" | "high-contrast";
export type TextScale = 100 | 125 | 150 | 200;

/** What the Settings panel stores as appearance. */
export interface Appearance {
  theme: ThemeName;
  textScale: TextScale;
  /** "Disable soft effects": no shadows, glows, glass or portal. */
  effectsOff: boolean;
  /** "Reduce transparency": opaque bar and popups. */
  reducedTransparency: boolean;
}

export const defaultAppearance: Appearance = {
  theme: "night",
  textScale: 100,
  effectsOff: false,
  reducedTransparency: false,
};

export interface Palette {
  canvas: string;
  surfaceRecessed: string;
  surface: string;
  surfaceRaised: string;
  surfaceHover: string;
  surfacePressed: string;
  surfaceSelected: string;
  surfaceSelectedHover: string;
  surfaceSelectedPressed: string;
  text: string;
  textSecondary: string;
  brandText: string;
  actionFill: string;
  actionFillHover: string;
  actionFillPressed: string;
  onAction: string;
  borderEssential: string;
  windowEdgeUnfocused: string;
  windowEdgeFocused: string;
  focus: string;
  info: string;
  positive: string;
  warning: string;
  danger: string;
}

const palettes: Record<ThemeName, Palette> = {
  night: {
    canvas: "#100e0e",
    surfaceRecessed: "#141112",
    surface: "#191516",
    surfaceRaised: "#221d1e",
    surfaceHover: "#2c2627",
    surfacePressed: "#383032",
    surfaceSelected: "#331c1e",
    surfaceSelectedHover: "#3a252a",
    surfaceSelectedPressed: "#423035",
    text: "#f6efe8",
    textSecondary: "#bdb2af",
    brandText: "#fca399",
    actionFill: "#b02026",
    actionFillHover: "#c4262d",
    actionFillPressed: "#961a20",
    onAction: "#fff8f5",
    borderEssential: "#9e9290",
    windowEdgeUnfocused: "#707078",
    windowEdgeFocused: "#f6efe8",
    focus: "#8ec8ff",
    info: "#8ec8ff",
    positive: "#6ee0b8",
    warning: "#f2c172",
    danger: "#ff9eb0",
  },
  dawn: {
    canvas: "#f6f1ea",
    surfaceRecessed: "#efe9e0",
    surface: "#fffdf9",
    surfaceRaised: "#ffffff",
    surfaceHover: "#ede6dc",
    surfacePressed: "#e3dbd0",
    surfaceSelected: "#fce8e4",
    surfaceSelectedHover: "#f4e3df",
    surfaceSelectedPressed: "#ecdad5",
    text: "#181314",
    textSecondary: "#5c5250",
    brandText: "#a11d22",
    actionFill: "#a11d22",
    actionFillHover: "#8a181d",
    actionFillPressed: "#751418",
    onAction: "#fffdf9",
    borderEssential: "#706562",
    windowEdgeUnfocused: "#706562",
    windowEdgeFocused: "#181314",
    focus: "#14539a",
    info: "#14539a",
    positive: "#0e634c",
    warning: "#7d4e0a",
    danger: "#9b1b3b",
  },
  "high-contrast": {
    canvas: "#000000",
    surfaceRecessed: "#000000",
    surface: "#000000",
    surfaceRaised: "#000000",
    surfaceHover: "#000000",
    surfacePressed: "#000000",
    surfaceSelected: "#000000",
    surfaceSelectedHover: "#000000",
    surfaceSelectedPressed: "#000000",
    text: "#ffffff",
    textSecondary: "#ffffff",
    brandText: "#ffb3ac",
    actionFill: "#ffffff",
    actionFillHover: "#ffffff",
    actionFillPressed: "#ffffff",
    onAction: "#000000",
    borderEssential: "#ffffff",
    windowEdgeUnfocused: "#767676",
    windowEdgeFocused: "#ffffff",
    focus: "#00ffff",
    info: "#9ed0ff",
    positive: "#9cf5c4",
    warning: "#ffe08a",
    danger: "#ffb3c1",
  },
};

/** COLOR, a "#rrggbb", at ALPHA (0..1). */
export function alpha(color: string, amount: number): string {
  const value = Math.round(Math.min(Math.max(amount, 0), 1) * 255);
  return color.slice(0, 7) + value.toString(16).padStart(2, "0");
}

export const fonts = {
  body: "Inter, Noto Sans, sans-serif",
  display: "Space Grotesk, Inter, Noto Sans, sans-serif",
  code: "JetBrains Mono, monospace",
};

type TextStyle = Pick<TextProps, "font" | "size" | "weight" | "lineHeight" | "color">;

export interface WarlockTheme extends Appearance {
  palette: Palette;
  /** What soft effects show: the portal in full, as a brief outline, or not at all. */
  effects: "full" | "off";
  /** Whether the bar and popups are frosted glass. */
  glass: boolean;
  /** PIXELS at the text size in effect: what CSS gives in rem, as pixels at 100%. */
  rem: (pixels: number) => number;
  /** Translucent fills of the skin. */
  skin: {
    glass: Color;
    glassStrong: Color;
    hairline: string;
    tile: string;
    hover: string;
    press: string;
    selected: string;
    selectedHover: string;
    selectedPress: string;
  };
  type: {
    /** A popup's heading. */
    title: TextStyle;
    /** The line under it. */
    status: TextStyle;
    label: TextStyle;
    labelStrong: TextStyle;
    detail: TextStyle;
    caption: TextStyle;
    code: TextStyle;
  };
  shadows: {
    popup: Shadow | undefined;
    windowFocused: Shadow | undefined;
    window: Shadow | undefined;
    raised: Shadow | undefined;
    card: Shadow | undefined;
  };
  barHeight: number;
  titleBarHeight: number;
}

const made = new Map<string, WarlockTheme>();

/** The theme for APPEARANCE, the same object for the same settings. */
export function makeTheme(appearance: Appearance): WarlockTheme {
  const key = JSON.stringify([
    appearance.theme,
    appearance.textScale,
    appearance.effectsOff,
    appearance.reducedTransparency,
  ]);
  const known = made.get(key);
  if (known) return known;

  const palette = palettes[appearance.theme];
  const contrast = appearance.theme === "high-contrast";
  const soft = !appearance.effectsOff && !contrast;
  const glass = soft && !appearance.reducedTransparency;
  const scale = appearance.textScale / 100;
  const rem = (pixels: number) => Math.round(pixels * scale * 2) / 2;
  const text = (
    font: string,
    size: number,
    weight: number,
    line: number,
    color: string,
  ): TextStyle => ({ font, size: rem(size), weight, lineHeight: line / size, color });

  const theme: WarlockTheme = {
    ...appearance,
    palette,
    effects: soft ? "full" : "off",
    glass,
    rem,
    skin: {
      glass: glass ? alpha(palette.surface, 0.78) : palette.surface,
      glassStrong: glass ? alpha(palette.surfaceRaised, 0.88) : palette.surfaceRaised,
      // High contrast draws its marks solid: a faint white line on black would not read.
      hairline: contrast ? palette.text : alpha(palette.text, 0.09),
      tile: contrast ? palette.surface : alpha(palette.text, 0.04),
      hover: contrast ? alpha(palette.text, 0.2) : alpha(palette.text, 0.07),
      press: contrast ? alpha(palette.text, 0.3) : alpha(palette.text, 0.11),
      selected: contrast ? alpha(palette.text, 0.25) : alpha(palette.actionFill, 0.22),
      selectedHover: contrast ? alpha(palette.text, 0.3) : alpha(palette.actionFill, 0.3),
      selectedPress: contrast ? alpha(palette.text, 0.36) : alpha(palette.actionFill, 0.36),
    },
    type: {
      title: text(fonts.display, 22, 700, 27.5, palette.text),
      status: text(fonts.body, 13, 400, 19, palette.textSecondary),
      label: text(fonts.body, 14, 500, 20, palette.text),
      labelStrong: text(fonts.body, 14, 600, 20, palette.text),
      detail: text(fonts.body, 12, 400, 16, palette.textSecondary),
      caption: text(fonts.body, 12, 500, 16, palette.textSecondary),
      code: text(fonts.code, 13, 400, 20, palette.text),
    },
    shadows: {
      popup: soft ? { color: "#0000009e", blur: 60, y: 24, spread: -12 } : undefined,
      windowFocused: soft ? { color: "#000000c7", blur: 60, y: 26, spread: -14 } : undefined,
      window: soft ? { color: "#000000b3", blur: 44, y: 18, spread: -14 } : undefined,
      raised: soft ? { color: "#00000059", blur: 24, y: 8 } : undefined,
      card: soft ? { color: "#00000038", blur: 2, y: 1 } : undefined,
    },
    barHeight: Math.round(48 * scale + 8),
    titleBarHeight: Math.round(32 * scale),
  };
  made.set(key, theme);
  return theme;
}

const ThemeContext = createContext<WarlockTheme>(makeTheme(defaultAppearance));

export const WarlockThemeProvider = ThemeContext.Provider;

/** The Warlock theme in effect. */
export function useWarlockTheme(): WarlockTheme {
  return useContext(ThemeContext);
}

/**
 * A hook giving the styles BUILD makes from the theme in effect, made once per
 * theme: `const useStyles = themed((theme) => ({ row: { fill: theme.skin.tile } }))`.
 */
export function themed<T>(build: (theme: WarlockTheme) => T): () => T {
  const styles = new WeakMap<WarlockTheme, T>();
  return () => {
    const theme = useWarlockTheme();
    let style = styles.get(theme);
    if (style === undefined) styles.set(theme, (style = build(theme)));
    return style;
  };
}

/** The height of the title bar the shell draws over WINDOW: none over one that draws its own. */
export function titleBarOf(
  theme: WarlockTheme,
  window: { decorations: "client" | "server" } | undefined,
): number {
  return window?.decorations === "client" ? 0 : theme.titleBarHeight;
}

/** Warlock's one easing, and its two timings: a fill changing under the pointer, and under a press. */
export const standardEasing = [0.2, 0, 0, 1] as const;
export const stateSeconds = 0.09;
export const pressSeconds = 0.06;
