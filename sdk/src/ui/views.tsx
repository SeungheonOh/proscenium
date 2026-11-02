import { memo } from "react";
import { Box, Image, Rect, Text } from "../components.js";
import type { Color } from "../color.js";
import type { BoxProps, ImageProps, RectProps, Style, TextProps } from "../props.js";
import { filterShader, type Shading } from "../shader.js";
import { StyleSheet, variants } from "./styles.js";
import { makeStyles, useTheme, type TextRole } from "./theme.js";

// Each component puts its own look first in `style`, so a caller's `style`
// overrides it and the caller's props override both. Looks come from the theme in
// effect, built once per theme.

const layout = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center" },
  column: { flexDirection: "column" },
  horizontal: { height: 1, marginY: 4, alignSelf: "stretch" },
  vertical: { width: 1, marginX: 4, alignSelf: "stretch" },
  centered: { alignSelf: "center" },
  pill: { flexDirection: "row", alignItems: "center" },
});

/** Children side by side, centred up and down: `<Row gap={8}>`. */
export function Row({ style, ...props }: BoxProps) {
  return <Box style={[layout.row, style]} {...props} />;
}

/** Children top to bottom: `<Column gap={4}>`. */
export function Column({ style, ...props }: BoxProps) {
  return <Box style={[layout.column, style]} {...props} />;
}

const useDividerStyles = makeStyles((theme) => StyleSheet.create({ line: { fill: theme.colors.line } }));

export interface DividerProps {
  /** A line between items of a Row, rather than of a Column. */
  vertical?: boolean;
  /** How long the line is; it spans its Row or Column without one. */
  length?: number;
  style?: Style<RectProps>;
}

/** A hairline between groups of items. */
export const Divider = memo(function Divider({ vertical = false, length, style }: DividerProps) {
  const styles = useDividerStyles();
  return (
    <Rect
      style={[styles.line, vertical ? layout.vertical : layout.horizontal, length !== undefined && layout.centered, style]}
      width={vertical ? undefined : length}
      height={vertical ? length : undefined}
    />
  );
});

export type SurfaceVariant = "glass" | "card" | "ink" | "accent";

const useSurface = makeStyles((theme) => variants({
  base: { radius: theme.radii.lg },
  variants: {
    variant: {
      /** Frosted glass, for over still content. */
      glass: { fill: theme.colors.glass, blur: 22, border: theme.glassBorder, shadow: theme.shadows.float },
      /** A plain card, for over moving content, which glass would blur again every frame. */
      card: { fill: theme.colors.card, border: { width: 1, color: theme.colors.cardLine }, shadow: theme.shadows.card },
      /** In ink, for a label that must stand out from anything. */
      ink: { fill: theme.colors.ink, shadow: theme.shadows.pill },
      accent: { fill: theme.colors.accent, shadow: theme.shadows.pill },
    } satisfies Record<SurfaceVariant, BoxProps>,
  },
  defaults: { variant: "card" },
}));

export interface SurfaceProps extends BoxProps {
  variant?: SurfaceVariant;
}

/** A panel, card or bar: a Box with a fill, an edge and a shadow from the theme. */
export function Surface({ variant, style, ...props }: SurfaceProps) {
  const surface = useSurface();
  return <Box style={[surface({ variant }), style]} {...props} />;
}

export interface PillProps extends SurfaceProps {
  /** Pixels; the ends are round, as much room is left at each, and a quarter of it between children. Defaults to 28. */
  height?: number;
}

const pillShapes = new Map<number, BoxProps>();

/** The shape of a pill HEIGHT pixels high, made once per height. */
function pillShape(height: number): BoxProps {
  let shape = pillShapes.get(height);
  if (!shape) pillShapes.set(height, (shape = { height, radius: height / 2, paddingX: height / 2, gap: Math.round(height / 4) }));
  return shape;
}

/** A Surface with round ends, its children in a centred row: a status, a handle, a toast. */
export function Pill({ height = 28, style, ...props }: PillProps) {
  return <Surface style={[layout.pill, pillShape(height), style]} {...props} />;
}

export type LabelVariant = TextRole;
export type Tone = "ink" | "soft" | "muted" | "faint" | "inverse" | "onAccent" | "accent" | "danger";

const useLabel = makeStyles(({ colors, type }) => variants({
  base: { maxLines: 1 },
  variants: {
    variant: {
      body: { ...type.body, color: colors.soft },
      strong: { ...type.strong, color: colors.ink },
      caption: { ...type.caption, color: colors.ink },
      title: { ...type.title, color: colors.ink },
    } satisfies Record<LabelVariant, TextProps>,
    tone: {
      ink: { color: colors.ink },
      soft: { color: colors.soft },
      muted: { color: colors.muted },
      faint: { color: colors.faint },
      inverse: { color: colors.inverse },
      onAccent: { color: colors.onAccent },
      accent: { color: colors.accent },
      danger: { color: colors.danger },
    } satisfies Record<Tone, TextProps>,
  },
  defaults: { variant: "body" },
}));

export interface LabelProps extends TextProps {
  /** The text style: body (the default), strong, caption or title. */
  variant?: LabelVariant;
  /** Its color, if not the variant's own. */
  tone?: Tone;
}

/**
 * Text in one of the theme's styles, on one line ending in an ellipsis when
 * its Box leaves too little room (`maxLines` changes that):
 * `<Label variant="strong">Magnet</Label>`.
 */
export const Label = memo(function Label({ variant, tone, style, ...props }: LabelProps) {
  const label = useLabel();
  return <Text style={[label({ variant, tone }), style]} {...props} />;
});

export type BadgeTone = "accent" | "ink" | "danger" | "muted";

const useBadge = makeStyles(({ colors, type }) => ({
  box: variants({
    base: { alignItems: "center", justifyContent: "center" },
    variants: {
      tone: {
        accent: { fill: colors.accent },
        ink: { fill: colors.ink },
        danger: { fill: colors.danger },
        muted: { fill: colors.faint },
      } satisfies Record<BadgeTone, BoxProps>,
      shape: {
        count: { height: 18, minWidth: 18, paddingX: 5, radius: 9 },
        dot: { width: 8, height: 8, radius: 4 },
      },
    },
    defaults: { tone: "accent", shape: "dot" },
  }),
  // The text spans the badge and Pango centres the line in it: centring its box instead
  // rounds it to a whole pixel, and a digit then sits a pixel off the middle.
  text: variants({
    base: { ...type.caption, size: 11, flexGrow: 1, align: "center" },
    variants: {
      tone: {
        accent: { color: colors.onAccent },
        ink: { color: colors.inverse },
        danger: { color: colors.onAccent },
        muted: { color: colors.ink },
      } satisfies Record<BadgeTone, TextProps>,
    },
    defaults: { tone: "accent" },
  }),
}));

export interface BadgeProps extends Omit<BoxProps, "children"> {
  /** A number or a word to show; a plain dot without one. */
  count?: number | string;
  tone?: BadgeTone;
  /** The count's text. */
  textStyle?: Style<TextProps>;
}

/** A dot, or a small round count: unread items, a status. */
export const Badge = memo(function Badge({ count, tone, style, textStyle, ...props }: BadgeProps) {
  const badge = useBadge();
  const shown = count !== undefined && count !== "";
  return (
    <Box style={[badge.box({ tone, shape: shown ? "count" : "dot" }), style]} {...props}>
      {shown && <Text style={[badge.text({ tone }), textStyle]}>{count}</Text>}
    </Box>
  );
});

/** Draws an image's shape in one color: its pixels' alpha, times `tint`. Clear, it leaves the image as it is. */
const tintFilter = filterShader({
  uniforms: { tint: 4 },
  gate: { uniform: "tint", component: 3 },
  source: `
vec4 filter(vec4 color, vec2 position) {
  return vec4(tint.rgb, 1.0) * tint.a * color.a;
}
`,
});

const tints = new Map<string, readonly Shading[]>();

/** The shaders tinting an icon COLOR, made once per color. */
function tinted(color: Color): readonly Shading[] {
  const key = String(color);
  let shaders = tints.get(key);
  if (!shaders) tints.set(key, (shaders = [{ id: "tint", shader: tintFilter, uniforms: { tint: color } }]));
  return shaders;
}

export interface IconProps extends Omit<ImageProps, "width" | "height"> {
  /** Its side, in pixels; defaults to 20. */
  size?: number;
  /** Its color by role, as a Label's: ink by default. */
  tone?: Tone;
  /** Its color, over `tone`; null keeps the image's own colors. */
  tint?: Color | null;
}

/**
 * A one-color icon from an image, drawn in the theme's ink, or in TONE or TINT:
 * `<Icon src={pen} />`. Only the image's shape counts, so a black SVG shows up on
 * dark themes too; `tint={null}` keeps a picture's own colors.
 */
export const Icon = memo(function Icon({ size = 20, tone = "ink", tint, shaders, ...props }: IconProps) {
  const { colors } = useTheme();
  const color = tint === null ? null : tint ?? colors[tone];
  const own = color === null ? shaders : shaders ? [...tinted(color), ...shaders] : tinted(color);
  return <Image width={size} height={size} shaders={own} {...props} />;
});
