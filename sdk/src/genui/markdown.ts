// Markdown as blocks of Pango markup, for Text nodes: the common subset a model
// writes (paragraphs, headings, lists, quotes, code blocks, rules; bold, italic,
// strike, code and links inline). Half-written markup, as while it streams,
// shows as it is.

import { escapeMarkup } from "../props.js";

export type MarkdownBlock =
  | { kind: "paragraph"; markup: string }
  | { kind: "heading"; level: number; markup: string }
  | { kind: "list"; ordered: boolean; items: { markup: string; marker: string; depth: number }[] }
  | { kind: "quote"; markup: string }
  | { kind: "code"; text: string; language: string }
  | { kind: "rule" };

export interface InlineColors {
  /** Links. */
  accent: string;
  /** Behind inline code. */
  code: string;
}

const defaults: InlineColors = { accent: "#2f6fed", code: "#17171a" };

/** Inline Markdown in TEXT as Pango markup. */
export function inlineMarkup(text: string, colors: InlineColors = defaults): string {
  const codes: string[] = [];
  // Code spans first, so nothing inside them is read as emphasis.
  let out = text.replace(/`([^`\n]+)`/g, (_, code: string) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = escapeMarkup(out);
  out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label: string) =>
    `<span foreground="${colors.accent}" underline="single">${label}</span>`);
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>").replace(/__([^_\n]+)__/g, "<b>$1</b>");
  out = out.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\w)/g, "$1<i>$2</i>");
  out = out.replace(/(^|[^_\w])_([^_\s][^_\n]*?)_(?!\w)/g, "$1<i>$2</i>");
  out = out.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
  return out.replace(/\u0000(\d+)\u0000/g, (_, index: string) =>
    `<span font_family="Noto Sans Mono, monospace" size="92%" background="${colors.code}" bgalpha="9%"> ${escapeMarkup(codes[Number(index)]!)} </span>`);
}

/** TEXT's blocks. */
export function markdownBlocks(text: string, colors: InlineColors = defaults): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];
  let list: Extract<MarkdownBlock, { kind: "list" }> | null = null;
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", markup: inlineMarkup(paragraph.join(" "), colors) });
    paragraph = [];
    list = null;
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const fence = /^\s*(```+|~~~+)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      index++;
      while (index < lines.length && !lines[index]!.trim().startsWith(fence[1]!)) code.push(lines[index++]!);
      blocks.push({ kind: "code", text: code.join("\n"), language: fence[2] ?? "" });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1]!.length, markup: inlineMarkup(heading[2]!.replace(/\s+#+\s*$/, ""), colors) });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      if (paragraph.length) {
        blocks.push({ kind: "paragraph", markup: inlineMarkup(paragraph.join(" "), colors) });
        paragraph = [];
      }
      const ordered = /\d/.test(item[2]!);
      const current: Extract<MarkdownBlock, { kind: "list" }> =
        list ?? { kind: "list", ordered, items: [] };
      if (!list) blocks.push(current);
      list = current;
      const task = /^\[([ xX])\]\s+(.*)$/.exec(item[3]!);
      current.items.push({
        markup: inlineMarkup(task ? task[2]! : item[3]!, colors),
        marker: task ? (task[1] === " " ? "☐" : "☑") : ordered ? item[2]!.replace(")", ".") : "•",
        depth: Math.min(Math.floor(item[1]!.replace(/\t/g, "  ").length / 2), 3),
      });
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      const last = list.items[list.items.length - 1]!;
      last.markup += " " + inlineMarkup(line.trim(), colors);
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      const previous = blocks[blocks.length - 1];
      if (previous?.kind === "quote") previous.markup += " " + inlineMarkup(quote[1]!, colors);
      else blocks.push({ kind: "quote", markup: inlineMarkup(quote[1]!, colors) });
      continue;
    }
    list = null;
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}
