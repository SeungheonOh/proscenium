/**
 * The theme's fonts, from scripts/fetch-persona, which installs them; where the
 * theme names a font that is not free, a font of its kind stands in.
 */

export const fonts = {
  yahei: "Microsoft YaHei, Selawik, Noto Sans",
  bahnschrift: "Bahnschrift Condensed, Barlow Condensed, Noto Sans",
  biolinum: "Linux Biolinum, Libertinus Sans, Noto Sans",
  nerd: "JetBrainsMono Nerd Font, JetBrains Mono, Symbols Nerd Font Mono, monospace",
};

/** TEXT as Pango markup spaced by PIXELS between letters (Pango counts in 1024ths of a point). */
export function spaced(text: string, pixels: number): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<span letter_spacing="${Math.round(pixels * 0.75 * 1024)}">${escaped}</span>`;
}
