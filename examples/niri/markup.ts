const escapes: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

/** TEXT as Pango markup shows it literally. */
export function escapeMarkup(text: string): string {
  return text.replace(/[&<>"']/g, (char) => escapes[char]!);
}
