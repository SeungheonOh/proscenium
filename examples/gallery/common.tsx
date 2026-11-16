// Shared pieces of the gallery's sections: the fixed colors specimens are drawn on
// (so they look the same in both themes), the section frame, and small helpers.

import type { ReactNode } from "react";
import { Box, Text } from "proscenium";
import { Label, useTheme } from "proscenium/ui";

export type GalleryThemeName = "light" | "dark";

/** The theme the gallery shows: GALLERY_THEME=light|dark, light by default. */
export const themeName: GalleryThemeName = process.env.GALLERY_THEME === "dark" ? "dark" : "light";

/** The page behind everything and the panel each section sits on, per theme. */
export const chrome = {
  light: { page: "#ecebe6", panel: "#f7f6f3" },
  dark: { page: "#121214", panel: "#1c1c20" },
}[themeName];

/** Fixed specimen colors, the same in both themes: dark ink on white, and light ink on near black. */
export const onLight = { bg: "#ffffff", ink: "#17171a" } as const;
export const onDark = { bg: "#17171a", ink: "#f2f2f5" } as const;

export interface SectionProps {
  title: string;
  /** Share of the column's height, as flexGrow. */
  grow: number;
  children?: ReactNode;
}

/** A titled panel; its children are laid out in a column below the title. */
export function SectionFrame({ title, grow, children }: SectionProps) {
  const { colors, radii } = useTheme();
  return (
    <Box flexGrow={grow} flexBasis={0} minHeight={0} flexDirection="column" gap={8} padding={12} clip
         fill={chrome.panel} radius={radii.lg} border={{ width: 1, color: colors.line }}>
      <Label variant="caption" tone="muted" size={10}>{title.toUpperCase()}</Label>
      {children}
    </Box>
  );
}

/** A small muted note beside a specimen. */
export function Note({ children, color }: { children: string; color?: string }) {
  const { colors, font } = useTheme();
  return <Text font={font} size={10} weight={500} color={color ?? colors.muted}>{children}</Text>;
}

/** Hue (0..360), saturation and lightness (0..1) as "#rrggbb". */
export function hsl(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** A busy picture to put glass over: colored tiles, bars and some small text. */
export function Busy({ width, height }: { width: number; height: number }) {
  const tile = 14;
  const columns = Math.ceil(width / tile);
  const rows = Math.ceil(height / tile);
  const tiles = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const h = (column * 23 + row * 41) % 360;
      const l = 0.35 + ((column * 7 + row * 13) % 5) * 0.1;
      tiles.push(<Box key={`${row}-${column}`} position="absolute" x={column * tile} y={row * tile} width={tile} height={tile}
                      fill={hsl(h, 0.75, l)} />);
    }
  }
  return (
    <Box width={width} height={height} clip radius={8}>
      {tiles}
      <Box position="absolute" x={0} y={height * 0.4} width={width} height={4} fill="#ffffff" />
      <Box position="absolute" x={0} y={height * 0.7} width={width} height={2} fill="#000000" />
      <Box position="absolute" x={width * 0.55} y={0} width={3} height={height} fill="#ffffff" />
      <Text position="absolute" x={8} y={6} font="Noto Sans, sans-serif" size={11} weight={700} color="#ffffff">
        busy background 0123456789
      </Text>
    </Box>
  );
}

/** The fixed light tray new-primitive specimens sit on, so they read the same in both themes. */
export const tray = "#e9eaee";
export const accent = "#2f6fed";
export const danger = "#e0443e";
export const ink = onLight.ink;

/** A rounded tray holding specimens in a column. */
export function Tray({ children, gap = 8, dark = false }: { children?: ReactNode; gap?: number; dark?: boolean }) {
  return (
    <Box padding={10} gap={gap} radius={8} flexDirection="column" alignSelf="stretch" fill={dark ? onDark.bg : tray}>
      {children}
    </Box>
  );
}

/** A note on a specimen tray: a fixed grey, readable on the tray in either theme. */
export function TNote({ children, color }: { children: string; color?: string }) {
  const { font } = useTheme();
  return <Text font={font} size={10} weight={500} color={color ?? "#17171a99"}>{children}</Text>;
}
