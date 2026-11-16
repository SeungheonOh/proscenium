// Themes: the colors, type, sizes, shadows and motion every control is drawn with.
//
// A theme is a plain object. Components build their styles from it once per
// theme with makeStyles, so a theme costs nothing per render; switching theme
// renders what reads it once. Without a ThemeProvider everything uses lightTheme,
// whose values are also exported on their own (`colors`, `type`, …).

import { createContext, createElement, useContext, type ReactNode } from "react";
import type { Color } from "../color.js";
import type { Animation } from "../animation.js";
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
  /** A filled danger control under the pointer. */
  dangerHover: Color;
  /** Danger as a soft tint: a destructive menu item under the pointer. */
  dangerSoft: Color;
  /** Under a plain control the pointer is over, and one held down. */
  hover: Color;
  press: Color;
  /** Hairlines: dividers and the edges of cards. */
  line: Color;
  /** The edge of a control with a surface of its own: a field, an outlined button, an empty checkbox. */
  border: Color;
  /** That edge under the pointer. */
  borderHover: Color;
  /** The fill of such a control: a field, an outlined button, a select; under the pointer, and held down. */
  field: Color;
  fieldHover: Color;
  fieldPress: Color;
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
  /** Menus, popovers, tooltips' opposite: what floats over everything, and its edge. */
  popover: Color;
  popoverLine: Color;
  /** A tooltip's fill and text. */
  tooltip: Color;
  onTooltip: Color;
  /** Behind a modal dialog. */
  scrim: Color;
  /** Behind selected text. */
  selection: Color;
  /** The keyboard focus ring, and the gap between it and the control: the surface a control usually sits on. */
  ring: Color;
  ringOffset: Color;
  /** The well a segmented control's segments sit in. */
  well: Color;
  /** No color, for states a fill fades out to. */
  clear: Color;
}

export type TextRole = "body" | "label" | "strong" | "caption" | "small" | "title";

/** Heights of controls, in pixels: a toolbar's small buttons, the usual ones, and large. */
export interface ControlSizes {
  small: number;
  medium: number;
  large: number;
}

export interface Theme {
  colors: ThemeColors;
  font: string;
  /**
   * Text styles by role, in pixels; a Label's `variant`. Each role's `lineHeight` puts
   * its lines a whole number of pixels apart, so no line of wrapped text sits between pixels.
   * `body` is running text, `label` the words on controls, `strong` emphasis and headings
   * within a panel, `caption` small headings, `small` hints and shortcuts, `title` a panel's title.
   */
  type: Record<TextRole, Pick<TextProps, "font" | "size" | "weight" | "lineHeight" | "letterSpacing">>;
  /** Space between and inside things, in pixels: `label` is a label's distance from its control. */
  space: { xs: number; sm: number; label: number; md: number; lg: number; xl: number };
  /**
   * Corner radii, in pixels: `xs` small marks (a checkbox, a menu item), `sm` controls,
   * `md` grouped controls and menus, `lg` cards and panels. A pill's radius is half its height.
   */
  radii: { xs: number; sm: number; md: number; lg: number };
  /** Heights of controls: buttons, fields, selects and segmented controls share them. */
  controls: ControlSizes;
  /**
   * Shadows by how far a surface floats, each an ambient shadow close under it and a key
   * shadow further down pulled in by a negative spread, so it stays tight to the surface:
   * `control` under a button or field with a surface, `pill` a pill on content, `card` a
   * card, `float` a menu or popover, `modal` a dialog, `knob` a switch knob or slider thumb.
   */
  shadows: { control: Shadow[]; pill: Shadow[]; card: Shadow[]; float: Shadow[]; modal: Shadow[]; knob: Shadow[] };
  /**
   * The keyboard focus ring, drawn outside a control as shadows: a gap in `colors.ringOffset`
   * and a near-solid accent ring outside it (`ring`) while focus shows, and `ringClear`, the
   * same at nothing, at rest, so it grows rather than appears.
   */
  focus: { ring: Shadow[]; ringClear: Shadow[] };
  /** The edge of frosted glass. */
  glassBorder: Border;
  /**
   * One-shot springs. Nothing loops, so a still interface costs nothing to show.
   * `fade` is for colors, fills and opacity: critically damped, so a hover never
   * overshoots, and settled in about a tenth of a second. `press` is a control's own
   * small moves (a knob, a scale), `glide` and `pop` things that move and grow, slightly
   * underdamped; `layout` moves things a change of content pushes about, and the frames
   * around them, together and without overshoot; `scroll` follows a wheel's notches.
   */
  motion: { fade: Motion; press: Motion; glide: Motion; pop: Motion; roll: Motion; arrive: Motion; slide: Motion;
            layout: Motion; scroll: Motion };
  /** The one loop for something under way: typing dots, an active step, work of unknown length. */
  breathe: Animation;
  /**
   * The keys text fields take: "emacs" (the default) adds the readline and Emacs bindings
   * (C-a, C-e, C-k, C-y, M-f, …) to the usual ones, moving select all to Ctrl+Shift+A;
   * "standard" is a browser's, Ctrl+A selecting all. See docs/GUIDE.md.
   */
  textKeymap: TextKeymap;
}

/** Which keys text fields take; see Theme.textKeymap. */
export type TextKeymap = "emacs" | "standard";

const font = "Noto Sans, sans-serif";

const typeScale: Theme["type"] = {
  body: { font, size: 13, weight: 400, lineHeight: 18 / 13 },
  label: { font, size: 13, weight: 500, lineHeight: 18 / 13 },
  strong: { font, size: 13, weight: 600, lineHeight: 18 / 13 },
  caption: { font, size: 12, weight: 600, lineHeight: 16 / 12 },
  small: { font, size: 12, weight: 400, lineHeight: 16 / 12 },
  title: { font, size: 15, weight: 600, lineHeight: 20 / 15, letterSpacing: -0.15 },
};

/** A 2-pixel ring of RING outside a 2-pixel gap of OFFSET, and the same at nothing. */
function focusRing(ring: Color, offset: Color): Theme["focus"] {
  const clear = (color: Color) => String(color).slice(0, 7) + "00";
  return {
    ring: [{ color: offset, blur: 0, spread: 2 }, { color: ring, blur: 0, spread: 4 }],
    ringClear: [{ color: clear(offset), blur: 0, spread: 0 }, { color: clear(ring), blur: 0, spread: 0 }],
  };
}

export const lightTheme: Theme = {
  colors: {
    ink: "#17171a",
    soft: "#17171acc",
    muted: "#17171a99",
    faint: "#17171a4d",
    inverse: "#ffffff",
    onAccent: "#ffffff",
    paper: "#ecebe6",
    accent: "#2f6fed",
    accentLight: "#5b8cff",
    accentHover: "#2a64d8",
    accentPress: "#2559c2",
    accentSoft: "#2f6fed1a",
    accentSoftHover: "#2f6fed29",
    accentSoftPress: "#2f6fed38",
    accentTint: "#2f6fed24",
    accentLine: "#2f6fed59",
    accentClear: "#2f6fed00",
    danger: "#dc3d37",
    dangerHover: "#c9342e",
    dangerSoft: "#dc3d371a",
    hover: "#0000000d",
    press: "#00000017",
    line: "#00000014",
    border: "#00000021",
    borderHover: "#00000033",
    field: "#ffffff",
    fieldHover: "#f8f8f9",
    fieldPress: "#f1f1f3",
    track: "#17171a17",
    control: "#17171a24",
    controlHover: "#17171a33",
    knob: "#ffffff",
    raised: "#ffffff",
    glass: "#ffffffd9",
    card: "#ffffffe6",
    cardLine: "#00000014",
    popover: "#ffffff",
    popoverLine: "#00000017",
    tooltip: "#1d1d21",
    onTooltip: "#f5f5f7",
    scrim: "#0000003d",
    selection: "#2f6fed40",
    ring: "#2f6fede6",
    ringOffset: "#ffffff",
    well: "#17171a12",
    clear: "#00000000",
  },
  font,
  type: typeScale,
  space: { xs: 2, sm: 4, label: 6, md: 8, lg: 14, xl: 20 },
  radii: { xs: 4, sm: 6, md: 8, lg: 12 },
  controls: { small: 24, medium: 28, large: 32 },
  textKeymap: "emacs",
  shadows: {
    control: [{ color: "#0000000d", blur: 2, y: 1 }],
    pill: [{ color: "#0000000f", blur: 2, y: 1 }, { color: "#00000024", blur: 10, y: 4, spread: -2 }],
    card: [{ color: "#0000000d", blur: 3, y: 1 }, { color: "#0000001a", blur: 12, y: 4, spread: -2 }],
    float: [{ color: "#00000014", blur: 3, y: 1 }, { color: "#00000029", blur: 24, y: 12, spread: -4 }],
    modal: [{ color: "#0000001a", blur: 4, y: 2 }, { color: "#00000038", blur: 48, y: 24, spread: -8 }],
    knob: [{ color: "#0000000f", blur: 0, spread: 0.5 }, { color: "#00000033", blur: 3, y: 1 }],
  },
  focus: focusRing("#2f6fede6", "#ffffff"),
  glassBorder: { width: 1, color: { from: "#ffffffee", to: "#00000017", angle: 90 } },
  motion: {
    fade: spring({ duration: 0.16, bounce: 0 }),
    press: spring({ duration: 0.2, bounce: 0.1 }),
    glide: spring({ duration: 0.3, bounce: 0.1 }),
    pop: spring({ duration: 0.24, bounce: 0.08 }),
    roll: spring({ duration: 0.42, bounce: 0.06 }),
    arrive: spring({ duration: 0.7, bounce: 0.16 }),
    slide: spring({ duration: 0.42, bounce: 0.04 }),
    layout: spring({ duration: 0.3, bounce: 0 }),
    scroll: spring({ duration: 0.28, bounce: 0 }),
  },
  breathe: { opacity: [0.3, 1], duration: 0.7, direction: "alternate", ease: "ease-in-out", iterations: Infinity },
};

/** Light text on dark glass and cards; the accent stays. */
export const darkTheme: Theme = createTheme({
  colors: {
    ink: "#f2f2f5",
    soft: "#f2f2f5cc",
    muted: "#f2f2f599",
    faint: "#f2f2f552",
    inverse: "#17171a",
    paper: "#1c1c20",
    accent: "#4a82ff",
    accentLight: "#7da5ff",
    accentHover: "#5b8eff",
    accentPress: "#3f74ea",
    accentSoft: "#4a82ff29",
    accentSoftHover: "#4a82ff3d",
    accentSoftPress: "#4a82ff4d",
    accentTint: "#4a82ff33",
    accentLine: "#4a82ff80",
    accentClear: "#4a82ff00",
    danger: "#ff5a54",
    dangerHover: "#ff6e69",
    dangerSoft: "#ff5a5424",
    hover: "#ffffff12",
    press: "#ffffff1f",
    line: "#ffffff17",
    border: "#ffffff29",
    borderHover: "#ffffff40",
    field: "#ffffff0d",
    fieldHover: "#ffffff17",
    fieldPress: "#ffffff21",
    track: "#ffffff2b",
    control: "#ffffff3d",
    controlHover: "#ffffff4d",
    knob: "#f5f5f7",
    raised: "#5a5a63",
    glass: "#26262bd9",
    card: "#26262bf2",
    cardLine: "#ffffff17",
    popover: "#2b2b30",
    popoverLine: "#ffffff1c",
    tooltip: "#f2f2f5",
    onTooltip: "#17171a",
    scrim: "#00000080",
    selection: "#4a82ff59",
    ring: "#5b8effee",
    ringOffset: "#1c1c20",
    well: "#ffffff1a",
    clear: "#ffffff00",
  },
  shadows: {
    control: [{ color: "#00000033", blur: 2, y: 1 }],
    pill: [{ color: "#00000040", blur: 2, y: 1 }, { color: "#00000066", blur: 10, y: 4, spread: -2 }],
    card: [{ color: "#00000033", blur: 3, y: 1 }, { color: "#00000059", blur: 12, y: 4, spread: -2 }],
    float: [{ color: "#00000040", blur: 3, y: 1 }, { color: "#00000073", blur: 24, y: 12, spread: -4 }],
    modal: [{ color: "#0000004d", blur: 4, y: 2 }, { color: "#00000099", blur: 48, y: 24, spread: -8 }],
    knob: [{ color: "#00000026", blur: 0, spread: 0.5 }, { color: "#00000066", blur: 3, y: 1 }],
  },
  focus: focusRing("#5b8effee", "#1c1c20"),
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
export const controls = lightTheme.controls;
export const shadows = lightTheme.shadows;
export const glassBorder = lightTheme.glassBorder;
export const motion = lightTheme.motion;
export const breathe = lightTheme.breathe;
export { font };
