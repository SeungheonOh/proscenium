// Modus Operandi, Protesilaos Stavrou's light theme for Emacs (GPL-3.0, the
// colours only; protesilaos.com/emacs/modus-themes), for CodeMirror: its
// palette and its default mapping of syntax faces, its line highlight, region
// and line numbers, and its diff backgrounds for the merge view.

import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

/** The palette entries the theme uses, named as Modus names them. */
export const modus = {
  bgMain: "#ffffff",
  fgMain: "#000000",
  bgDim: "#f2f2f2",
  fgDim: "#595959",
  bgActive: "#c4c4c4",
  border: "#9f9f9f",
  bgRegion: "#bdbdbd",
  bgHlLine: "#dae5ec",
  red: "#a60000",
  redWarmer: "#972500",
  redCooler: "#a0132f",
  green: "#006800",
  greenCooler: "#00663f",
  greenFaint: "#61756c",
  yellowWarmer: "#884900",
  blue: "#0031a9",
  blueWarmer: "#3548cf",
  blueCooler: "#0000b0",
  magenta: "#721045",
  magentaWarmer: "#8f0075",
  magentaCooler: "#531ab6",
  cyan: "#005e8b",
  cyanCooler: "#005f5f",
  bgAdded: "#c1f2d1",
  bgAddedRefine: "#aee5be",
  fgAdded: "#005000",
  bgRemoved: "#ffd8d5",
  bgRemovedRefine: "#f3b5af",
  fgRemoved: "#8f1313",
  bgParen: "#8fcfff",
  bgSearch: "#ffe0a0",
};

const m = modus;

/** Modus' syntax mapping: keyword magenta-cooler, string blue-warmer, type cyan-cooler, and so on. */
export const modusHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword], color: m.magentaCooler },
  { tag: [t.self, t.null, t.bool, t.atom, t.constant(t.variableName), t.standard(t.variableName)], color: m.blueCooler },
  { tag: [t.number, t.integer, t.float], color: m.blueCooler },
  { tag: [t.string, t.special(t.string), t.character, t.attributeValue], color: m.blueWarmer },
  { tag: [t.regexp, t.escape], color: m.greenCooler },
  { tag: [t.docComment, t.docString], color: m.greenFaint },
  { tag: [t.comment, t.lineComment, t.blockComment], color: m.fgDim, fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName))], color: m.magenta },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: m.cyan },
  { tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName)], color: m.cyanCooler },
  { tag: [t.variableName], color: m.fgMain },
  { tag: [t.propertyName], color: m.cyan },
  { tag: [t.standard(t.function(t.variableName)), t.special(t.variableName)], color: m.magentaWarmer },
  { tag: [t.processingInstruction, t.meta, t.annotation], color: m.redCooler },
  { tag: [t.tagName], color: m.magentaCooler },
  { tag: [t.attributeName], color: m.cyan },
  { tag: [t.heading], color: m.fgMain, fontWeight: "bold" },
  { tag: [t.heading1, t.heading2], color: m.fgMain, fontWeight: "bold" },
  { tag: [t.link, t.url], color: m.blueWarmer, textDecoration: "underline" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.strong], fontWeight: "bold" },
  { tag: [t.strikethrough], textDecoration: "line-through" },
  { tag: [t.inserted], color: m.fgAdded },
  { tag: [t.deleted], color: m.fgRemoved },
  { tag: [t.changed], color: m.yellowWarmer },
  { tag: [t.invalid], color: m.red, textDecoration: "underline wavy" },
  { tag: [t.operator, t.punctuation, t.bracket, t.separator], color: m.fgMain },
]);

const theme = EditorView.theme({
  "&": { color: m.fgMain, backgroundColor: m.bgMain },
  ".cm-content": { caretColor: m.fgMain },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: m.fgMain },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: `${m.bgRegion} !important`,
  },
  ".cm-activeLine": { backgroundColor: m.bgHlLine },
  ".cm-gutters": { backgroundColor: m.bgDim, color: m.fgDim, borderRight: "none" },
  ".cm-activeLineGutter": { backgroundColor: m.bgActive, color: m.fgMain },
  ".cm-foldPlaceholder": { backgroundColor: m.bgDim, border: `1px solid ${m.border}`, color: m.fgDim },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: m.bgParen, outline: "none" },
  ".cm-selectionMatch": { backgroundColor: m.bgDim },
  ".cm-searchMatch": { backgroundColor: m.bgSearch, outline: `1px solid ${m.yellowWarmer}` },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: m.bgParen },
  ".cm-panels": { backgroundColor: m.bgDim, color: m.fgMain, borderColor: m.border },
  ".cm-tooltip": { backgroundColor: m.bgDim, border: `1px solid ${m.border}` },
  // The merge view in Modus' diff faces.
  ".cm-changedLine, .cm-insertedLine": { backgroundColor: `${m.bgAdded} !important` },
  ".cm-changedText, .cm-insertedLine .cm-changedText": { background: `${m.bgAddedRefine} !important` },
  ".cm-deletedChunk, .cm-deletedLine": { backgroundColor: `${m.bgRemoved} !important` },
  ".cm-deletedChunk .cm-deletedText, .cm-deletedText": { background: `${m.bgRemovedRefine} !important` },
  ".cm-collapsedLines": { backgroundColor: m.bgDim, color: m.fgDim, backgroundImage: "none" },
  ".cm-changeGutter .cm-changedLineGutter": { backgroundColor: m.green },
  ".cm-deletedLineGutter": { backgroundColor: m.red },
}, { dark: false });

/** The whole theme: chrome and syntax. */
export const modusOperandi = [theme, syntaxHighlighting(modusHighlight)];
