// A markdown file rendered: GitHub-flavoured markdown by marked, sanitized by
// DOMPurify, with diagrams drawn in place: ```mermaid by Mermaid, ```dot and
// ```graphviz by Graphviz (viz.js), $…$ and $$…$$ (and ```math) by KaTeX.
// Other fences are highlighted by the same Lezer parsers the editor uses.
// Images relative to the file come from the world, which reads the disk;
// links to other files in the project open them here.

import { useEffect, useMemo, useRef } from "react";
import { Marked, type TokenizerAndRendererExtension } from "marked";
import DOMPurify from "dompurify";
import katex from "katex";
import "katex/dist/katex.min.css";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { classHighlighter, highlightCode } from "@lezer/highlight";

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function tex(source: string, displayMode: boolean): string {
  try {
    return katex.renderToString(source, { displayMode, throwOnError: false, output: "htmlAndMathml" });
  } catch (error) {
    return `<code class="md-error">${escapeHtml((error as Error).message)}</code>`;
  }
}

const blockMath: TokenizerAndRendererExtension = {
  name: "blockMath",
  level: "block",
  start: (src) => src.indexOf("$$"),
  tokenizer(src) {
    const match = /^\$\$\n?([\s\S]+?)\n?\$\$(?:\n|$)/.exec(src);
    if (match) return { type: "blockMath", raw: match[0], text: match[1] };
  },
  renderer: (token) => `<div class="md-math">${tex(token.text, true)}</div>`,
};

const inlineMath: TokenizerAndRendererExtension = {
  name: "inlineMath",
  level: "inline",
  start: (src) => src.indexOf("$"),
  tokenizer(src) {
    // $x$ but not "costs $5 and $6": no space just inside the dollars.
    const match = /^\$(?!\s)((?:\\.|[^\\$\n])+?)(?<!\s)\$(?!\d)/.exec(src);
    if (match) return { type: "inlineMath", raw: match[0], text: match[1] };
  },
  renderer: (token) => tex(token.text, false),
};

const marked = new Marked({ gfm: true });
marked.use({ extensions: [blockMath, inlineMath] });
marked.use({
  renderer: {
    code({ text, lang }) {
      const language = (lang ?? "").trim().split(/\s+/)[0].toLowerCase();
      if (language === "mermaid") return `<div class="md-diagram" data-kind="mermaid">${escapeHtml(text)}</div>`;
      if (language === "dot" || language === "graphviz") {
        return `<div class="md-diagram" data-kind="dot">${escapeHtml(text)}</div>`;
      }
      if (language === "math" || language === "latex" && /^\s*\\begin/.test(text)) {
        return `<div class="md-math">${tex(text, true)}</div>`;
      }
      return `<pre class="md-code"><code data-lang="${escapeHtml(language)}">${escapeHtml(text)}</code></pre>`;
    },
  },
});

let mermaidReady: Promise<typeof import("mermaid").default> | null = null;
function loadMermaid() {
  return mermaidReady ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      theme: "neutral",
      securityLevel: "strict",
      fontFamily: "Noto Sans, system-ui, sans-serif",
      themeVariables: { background: "#ffffff", primaryColor: "#ddf4ff", primaryBorderColor: "#0969da", lineColor: "#656d76" },
    });
    return mermaid;
  });
}

let vizReady: Promise<import("@viz-js/viz").Viz> | null = null;
const loadViz = () => vizReady ??= import("@viz-js/viz").then((viz) => viz.instance());

let diagrams = 0;

async function drawDiagram(element: HTMLElement): Promise<void> {
  const source = element.textContent ?? "";
  try {
    if (element.dataset.kind === "mermaid") {
      const mermaid = await loadMermaid();
      const { svg, bindFunctions } = await mermaid.render(`mermaid-${++diagrams}`, source);
      element.innerHTML = svg;
      bindFunctions?.(element);
    } else {
      const viz = await loadViz();
      const svg = viz.renderSVGElement(source, {
        graphAttributes: { bgcolor: "transparent", fontcolor: "#1f2328", color: "#656d76" },
        nodeAttributes: { color: "#0969da", fontcolor: "#1f2328", fontname: "Noto Sans" },
        edgeAttributes: { color: "#656d76", fontcolor: "#59636e", fontname: "Noto Sans" },
      });
      element.replaceChildren(svg);
    }
    element.classList.add("drawn");
  } catch (error) {
    element.innerHTML = `<pre class="md-error">${escapeHtml((error as Error).message || String(error))}\n\n${escapeHtml(source)}</pre>`;
  }
}

async function highlight(element: HTMLElement): Promise<void> {
  const name = element.dataset.lang;
  if (!name) return;
  const description = LanguageDescription.matchLanguageName(languages, name, true);
  if (!description) return;
  const support = await description.load().catch(() => null);
  if (!support || !element.isConnected) return;
  const code = element.textContent ?? "";
  let html = "";
  highlightCode(code, support.language.parser.parse(code), classHighlighter,
    (text, classes) => { html += classes ? `<span class="${classes}">${escapeHtml(text)}</span>` : escapeHtml(text); },
    () => { html += "\n"; });
  element.innerHTML = html;
}

/** PATH joined to REF, both relative to the project root; null when REF leaves the project or is a URL. */
function resolveRelative(path: string, ref: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//")) return null;
  const parts = ref.startsWith("/") ? [] : path.split("/").slice(0, -1);
  for (const part of ref.split("/")) {
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}

export interface MarkdownProps {
  path: string;
  content: string;
  /** Asks the world for a project image as a data: URL. */
  image: (path: string) => Promise<string>;
  /** Opens another project file in the viewer. */
  open: (path: string) => void;
}

export function Markdown({ path, content, image, open }: MarkdownProps) {
  const host = useRef<HTMLDivElement>(null);
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(content, { async: false })), [content]);

  useEffect(() => {
    const root = host.current!;
    root.innerHTML = html;
    for (const element of root.querySelectorAll<HTMLElement>(".md-diagram")) void drawDiagram(element);
    for (const element of root.querySelectorAll<HTMLElement>("pre.md-code code")) void highlight(element);
    for (const img of root.querySelectorAll("img")) {
      const ref = img.getAttribute("src") ?? "";
      const target = resolveRelative(path, decodeURI(ref.split(/[?#]/)[0]));
      if (target === null) continue;
      img.removeAttribute("src");
      void image(target).then((url) => { if (img.isConnected) img.src = url; }, () => img.classList.add("missing"));
    }
  }, [html, path]);

  useEffect(() => {
    host.current?.scrollTo(0, 0);
  }, [path]);

  return (
    <div
      className="markdown"
      ref={host}
      onClick={(event) => {
        const link = (event.target as HTMLElement).closest("a");
        const href = link?.getAttribute("href");
        if (!link || !href) return;
        event.preventDefault();
        if (href.startsWith("#")) {
          host.current?.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`)?.scrollIntoView();
          return;
        }
        const target = resolveRelative(path, decodeURI(href.split("#")[0]));
        if (target) open(target);
      }}
    />
  );
}
