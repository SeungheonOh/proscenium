/** The picture on a theme's card in Settings: a small desktop in that theme's own colours. */

import { Box, paintShader, Rect, type Shading } from "proscenium";
import { alpha, defaultAppearance, makeTheme, useWarlockTheme, type ThemeName } from "../theme.js";

/** The colours of a theme's picture, whichever theme is in effect. */
export function previewColors(name: ThemeName) {
  const { palette } = makeTheme({ ...defaultAppearance, theme: name });
  const contrast = name === "high-contrast";
  return {
    canvas: palette.canvas,
    /** What the canvas warms to at its far corner; Warlock fixes it per theme. */
    glow: contrast ? palette.canvas : name === "dawn" ? "#f3d9d3" : "#4a1418",
    bar: palette.surfaceRaised,
    frame: contrast ? palette.text : palette.surfacePressed,
    surface: palette.surface,
    text: palette.text,
    secondary: name === "dawn" ? palette.borderEssential : palette.textSecondary,
    accent: contrast ? palette.brandText : palette.actionFill,
  };
}

/**
 * The picture's backdrop: one colour for the first part of the way across,
 * then turning into the other, at CSS's 150 degrees, in a rounded box.
 */
const backdropPaint = paintShader({
  uniforms: { canvas: 4, glow: 4, hold: 1 },
  extent: { pixel: 1 },
  gate: [
    { uniform: "canvas", component: 3 },
    { uniform: "glow", component: 3 },
  ],
  source: `
vec4 paint(vec2 position) {
  vec2 half_size = size * 0.5;
  vec2 point = position - half_size;
  vec2 q = abs(point) - half_size + radius;
  float away = min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - radius;
  vec2 direction = vec2(0.5, 0.8660254);
  float along = 0.5 + dot(point, direction) / dot(size, direction);
  vec4 color = mix(canvas, glow, clamp((along - hold) / (1.0 - hold), 0.0, 1.0));
  return vec4(color.rgb * color.a, color.a) * clamp(0.5 - away / pixel, 0.0, 1.0);
}
`,
});

const backdrops = new Map<ThemeName, readonly Shading[]>();

function backdrop(name: ThemeName): readonly Shading[] {
  let shading = backdrops.get(name);
  if (!shading) {
    const { canvas, glow } = previewColors(name);
    shading = [{ id: "backdrop", shader: backdropPaint, uniforms: { canvas, glow, hold: 0.4 } }];
    backdrops.set(name, shading);
  }
  return shading;
}

/** A theme's desktop in small: the bar with its mark, a window with lines of text and an action, and a second window. */
export function ThemePreview({ name, width }: { name: ThemeName; width: number }) {
  const { rem } = useWarlockTheme();
  const colors = previewColors(name);
  const height = rem(68);
  const bar = rem(14);
  const radius = 7;
  const windowTop = rem(23.2);
  const windowHeight = rem(36.8);
  const frame = { width: 1, color: colors.frame };
  return (
    <Box width={width} height={height} radius={radius} flexShrink={0} shaders={backdrop(name)}>
      {/* The bar keeps to the picture's round top corners: a round box, squared off below them. */}
      <Rect
        position="absolute"
        x={0}
        y={0}
        width={width}
        height={bar}
        radius={radius}
        fill={colors.bar}
      />
      <Rect
        position="absolute"
        x={0}
        y={radius}
        width={width}
        height={bar - radius}
        fill={colors.bar}
      />
      <Rect position="absolute" x={0} y={bar} width={width} height={1} fill={colors.frame} />
      <Rect
        position="absolute"
        x={8}
        y={rem(5)}
        width={rem(8)}
        height={rem(5)}
        fill={colors.accent}
      />

      <Rect
        position="absolute"
        x={14}
        y={windowTop}
        width={width * 0.62}
        height={windowHeight}
        fill={colors.surface}
        border={frame}
      />
      <Rect
        position="absolute"
        x={22}
        y={rem(31.2)}
        width={width * 0.22}
        height={rem(4)}
        fill={colors.text}
      />
      <Rect
        position="absolute"
        x={22}
        y={rem(39.2)}
        width={width * 0.34}
        height={rem(3)}
        fill={colors.secondary}
      />
      <Rect
        position="absolute"
        x={22}
        y={rem(47.2)}
        width={rem(24)}
        height={rem(5)}
        fill={colors.accent}
      />

      <Rect
        position="absolute"
        x={width - 14 - width * 0.2}
        y={windowTop}
        width={width * 0.2}
        height={windowHeight}
        fill={colors.surface}
        border={frame}
      />

      <Rect
        position="absolute"
        x={0}
        y={0}
        width={width}
        height={height}
        radius={radius}
        border={{ width: 1, color: alpha(colors.text, 0.14) }}
      />
    </Box>
  );
}
