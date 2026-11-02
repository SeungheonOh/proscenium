// Themes: the colors, type, sizes, shadows and motion every control is drawn with.
//
// A theme is a plain object. Components build their styles from it once per
// theme with makeStyles, so a theme costs nothing per render; switching theme
// renders what reads it once. Without a ThemeProvider everything uses lightTheme,
// whose values are also exported on their own (`colors`, `type`, …).

import { createContext, createElement, useContext, type ReactNode } from "react";
import type { Color } from "../color.js";
import type { Border, Shadow, TextProps } from "../props.js";
import type { Motion } from "../motion.js";
import { spring } from "../motion.js";

export interface ThemeColors {
  /** Text and icons at full strength, and the ink surface. */
  ink: Color;
  /** Body text: a little softer than ink. */
  soft: Color;
  /** Secondary text. */
  muted: Color;
  /** Hints, off states and disabled text. */
  faint: Color;
  /** Text and icons on the ink surface. */
  inverse: Color;
  /** Text and icons on the accent. */
  onAccent: Color;
  paper: Color;
  accent: Color;
  /** A lighter accent, where a gradient starts: a slider's fill. */
  accentLight: Color;
  /** A filled accent control under the pointer, and held down. */
  accentHover: Color;
  accentPress: Color;
  /** The accent as a soft tint at rest, under the pointer and held down: tinted controls. */
  accentSoft: Color;
  accentSoftHover: Color;
  accentSoftPress: Color;
  /** Behind a selected control, and the line around it. */
  accentTint: Color;
  accentLine: Color;
  /** The accent with no alpha: what accent lines fade out to without darkening on the way. */
  accentClear: Color;
  danger: Color;
  /** Under a plain control the pointer is over, and one held down. */
  hover: Color;
  press: Color;
  /** Hairlines: dividers and the edges of cards. */
  line: Color;
  /** An empty slider track. */
  track: Color;
  /** An off switch, and one under the pointer. */
  control: Color;
  controlHover: Color;
  /** Switch knobs and slider thumbs. */
  knob: Color;
  /** The chosen segment's card: raised above its track. */
  raised: Color;
  /** Surfaces: frosted glass, and plain cards for over moving content (glass would re-blur it every frame). */
  glass: Color;
  card: Color;
  cardLine: Color;
  /** No color, for states a fill fades out to. */
  clear: Color;
}

export type TextRole = "body" | "strong" | "caption" | "title";

export interface Theme {
  colors: ThemeColors;
  font: string;
  /** Text styles by role, in pixels; a Label's `variant`. */
  type: Record<TextRole, Pick<TextProps, "font" | "size" | "weight">>;
  /** Space between and inside things, in pixels. */
  space: { xs: number; sm: number; md: number; lg: number; xl: number };
  /** Corner radii, in pixels; a pill's radius is half its height. */
  radii: { sm: number; md: number; lg: number };
  /** Shadows by how far a surface floats: a pill on content, a card, a floating panel, a knob. */
  shadows: { pill: Shadow; card: Shadow; float: Shadow; knob: Shadow };
  /** The edge of frosted glass. */
  glassBorder: Border;
  /** One-shot springs. Nothing loops, so a still interface costs nothing to show. */
  motion: { glide: Motion; pop: Motion; roll: Motion; arrive: Motion; slide: Motion };
}

const font = "Noto Sans, sans-serif";

export const lightTheme: Theme = {
  colors: {
    ink: "#17171a",
    soft: "#17171acc",
    muted: "#17171a99",
    faint: "#17171a40",
    inverse: "#ffffff",
    onAccent: "#ffffff",
    paper: "#ecebe6",
    accent: "#2f6fed",
    accentLight: "#5b8cff",
    accentHover: "#2a64d8",
    accentPress: "#2559c2",
    accentSoft: "#2f6fed1f",
    accentSoftHover: "#2f6fed2e",
    accentSoftPress: "#2f6fed40",
    accentTint: "#2f6fed26",
    accentLine: "#2f6fed59",
    accentClear: "#2f6fed00",
    danger: "#e0443e",
    hover: "#0000000f",
    press: "#0000001c",
    line: "#00000017",
    track: "#17171a17",
    control: "#17171a29",
    controlHover: "#17171a3d",
    knob: "#ffffff",
    raised: "#ffffff",
    glass: "#ffffffd9",
    card: "#ffffffe6",
    cardLine: "#00000018",
    clear: "#00000000",
  },
  font,
  type: {
    body: { font, size: 13, weight: 500 },
    strong: { font, size: 13, weight: 650 },
    caption: { font, size: 12, weight: 650 },
    title: { font, size: 15, weight: 650 },
  },
  space: { xs: 2, sm: 4, md: 8, lg: 14, xl: 20 },
  radii: { sm: 6, md: 9, lg: 14 },
  shadows: {
    pill: { color: "#00000040", blur: 8, y: 2 },
    card: { color: "#0000001f", blur: 18, y: 6 },
    float: { color: "#00000029", blur: 28, y: 10 },
    knob: { color: "#00000040", blur: 3, y: 1 },
  },
  glassBorder: { width: 1, color: { from: "#ffffffee", to: "#00000017", angle: 90 } },
  motion: {
    glide: spring({ duration: 0.34, bounce: 0.14 }),
    pop: spring({ duration: 0.26, bounce: 0.08 }),
    roll: spring({ duration: 0.42, bounce: 0.06 }),
    arrive: spring({ duration: 0.7, bounce: 0.16 }),
    slide: spring({ duration: 0.42, bounce: 0.04 }),
  },
};

/** Light text on dark glass and cards; the accent stays. */
export const darkTheme: Theme = createTheme({
  colors: {
    ink: "#f2f2f5",
    soft: "#f2f2f5cc",
    muted: "#f2f2f599",
    faint: "#f2f2f547",
    inverse: "#17171a",
    paper: "#1c1c20",
    accent: "#4a82ff",
    accentLight: "#7da5ff",
    accentHover: "#5b8eff",
    accentPress: "#3f74ea",
    accentSoft: "#4a82ff2e",
    accentSoftHover: "#4a82ff40",
    accentSoftPress: "#4a82ff52",
    accentTint: "#4a82ff33",
    accentLine: "#4a82ff80",
    accentClear: "#4a82ff00",
    danger: "#ff5a54",
    hover: "#ffffff14",
    press: "#ffffff24",
    line: "#ffffff1a",
    track: "#ffffff1f",
    control: "#ffffff2e",
    controlHover: "#ffffff42",
    knob: "#f2f2f5",
    raised: "#4a4a52",
    glass: "#26262bd9",
    card: "#26262bf2",
    cardLine: "#ffffff1a",
    clear: "#ffffff00",
  },
  shadows: {
    pill: { color: "#00000080", blur: 8, y: 2 },
    card: { color: "#00000066", blur: 18, y: 6 },
    float: { color: "#00000073", blur: 28, y: 10 },
    knob: { color: "#00000066", blur: 3, y: 1 },
  },
  glassBorder: { width: 1, color: { from: "#ffffff38", to: "#ffffff0d", angle: 90 } },
});

/** Changes to a theme: any group, and within it any entry. */
export type ThemeOverrides = { [K in keyof Theme]?: Theme[K] extends string ? Theme[K] : Partial<Theme[K]> };

/**
 * A theme from BASE (the light theme by default) with OVERRIDES on top, group
 * by group: `createTheme({ colors: { accent: "#e5484d" }, radii: { md: 4 } })`.
 * Make themes once, at module level: each new object builds every style anew.
 */
export function createTheme(overrides: ThemeOverrides, base: Theme = lightTheme): Theme {
  const theme = { ...base } as Record<string, unknown>;
  for (const [group, values] of Object.entries(overrides)) {
    if (values === undefined) continue;
    const current = theme[group];
    theme[group] = typeof values === "object" && typeof current === "object" ? { ...current, ...values } : values;
  }
  return theme as unknown as Theme;
}

const ThemeContext = createContext<Theme>(lightTheme);

/** Children drawn with THEME: `<ThemeProvider theme={darkTheme}>`. */
export function ThemeProvider({ theme, children }: { theme: Theme; children?: ReactNode }) {
  return createElement(ThemeContext.Provider, { value: theme }, children);
}

/** The theme in effect here. */
export function useTheme(): Theme {
  return useContext(ThemeContext);
}

/**
 * A hook giving the styles BUILD makes from the theme in effect, made once per
 * theme and kept, as React Native's StyleSheet styles are made once:
 *
 *     const useStyles = makeStyles((theme) => StyleSheet.create({
 *       card: { fill: theme.colors.card, radius: theme.radii.lg },
 *     }));
 *     function Card() { const styles = useStyles(); return <Box style={styles.card} />; }
 */
export function makeStyles<T>(build: (theme: Theme) => T): () => T {
  const made = new WeakMap<Theme, T>();
  return () => {
    const theme = useTheme();
    let styles = made.get(theme);
    if (styles === undefined) made.set(theme, (styles = build(theme)));
    return styles;
  };
}

// The light theme's values on their own, for styles that need no theming.
export const colors = lightTheme.colors;
export const type = lightTheme.type;
export const space = lightTheme.space;
export const radii = lightTheme.radii;
export const shadows = lightTheme.shadows;
export const glassBorder = lightTheme.glassBorder;
export const motion = lightTheme.motion;
export { font };
