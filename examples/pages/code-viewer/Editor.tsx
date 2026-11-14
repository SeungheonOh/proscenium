// The file itself, in CodeMirror 6 (codemirror.net, MIT): read-only, with
// line numbers, folding, search (Ctrl+F) and the language its name implies,
// coloured in Modus Operandi (modus.ts),
// loaded on first use from @codemirror/language-data. The diff is
// @codemirror/merge's unified view against the file at HEAD. A file that
// changes under the agent is updated in place, so the view keeps its scroll.

import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { unifiedMergeView } from "@codemirror/merge";
import { search } from "@codemirror/search";
import { modusOperandi } from "./modus.js";

/** Past this, the merge view's diff and the parser would hold the page for seconds. */
const maxRich = 400 * 1024;

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "12.5px" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.55" },
  ".cm-content": { paddingBottom: "24px" },
  "&.cm-focused": { outline: "none" },
  // Square, like the rest of the world.
  ".cm-button, .cm-textfield, .cm-tooltip, .cm-panel button, .cm-foldPlaceholder, .cm-collapsedLines, .cm-selectionMatch, .cm-searchMatch": {
    borderRadius: "0", backgroundImage: "none",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 6px 0 4px" },
}, { dark: false });

export interface EditorProps {
  path: string;
  content: string;
  /** The file at HEAD while the diff shows; "" for a file HEAD lacks. */
  original: string | null;
  /** Where to put the cursor: a line, and a match in it to select. */
  jump?: { line?: number; column?: number; length?: number; seq: number } | null;
}

/** The language for PATH, loaded once and remembered by language-data. */
async function languageFor(path: string): Promise<Extension> {
  const name = path.split("/").pop() ?? path;
  const description = LanguageDescription.matchFilename(languages, name)
    ?? (/\.(tsx|jsx)$/.test(name) ? LanguageDescription.matchLanguageName(languages, "tsx") : null);
  if (!description) return [];
  try {
    return await description.load();
  } catch {
    return [];
  }
}

/** The smallest replacement turning OLD into NEXT, so unchanged text above keeps its place. */
function changeBetween(old: string, next: string) {
  let start = 0;
  const shortest = Math.min(old.length, next.length);
  while (start < shortest && old.charCodeAt(start) === next.charCodeAt(start)) start++;
  let end = 0;
  while (end < shortest - start && old.charCodeAt(old.length - 1 - end) === next.charCodeAt(next.length - 1 - end)) end++;
  return { from: start, to: old.length - end, insert: next.slice(start, next.length - end) };
}

export function Editor({ path, content, original, jump = null }: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const language = useRef(new Compartment());
  const merge = useRef(new Compartment());
  const shownPath = useRef<string | null>(null);
  const rich = content.length <= maxRich;

  useEffect(() => {
    view.current = new EditorView({ parent: host.current! });
    return () => view.current?.destroy();
  }, []);

  // A new file starts a new state; the same file changing is edited in place.
  useEffect(() => {
    const editor = view.current!;
    const diff = original !== null && rich ? unifiedMergeView({
      original,
      mergeControls: false,
      syntaxHighlightDeletions: true,
      collapseUnchanged: { margin: 3, minSize: 8 },
    }) : [];
    if (shownPath.current !== path) {
      shownPath.current = path;
      editor.setState(EditorState.create({
        doc: content,
        extensions: [
          basicSetup,
          search({ top: true }),
          EditorState.readOnly.of(true),
          modusOperandi,
          theme,
          language.current.of([]),
          merge.current.of(diff),
        ],
      }));
      editor.scrollDOM.scrollTo(0, 0);
      if (rich) {
        void languageFor(path).then((support) => {
          if (shownPath.current === path) editor.dispatch({ effects: language.current.reconfigure(support) });
        });
      }
      return;
    }
    const old = editor.state.doc.toString();
    editor.dispatch({
      changes: old === content ? undefined : changeBetween(old, content),
      effects: merge.current.reconfigure(diff),
    });
  }, [path, content, original]);

  // A jump selects its match (or puts the cursor on its line) and centres it, once per jump.
  const jumped = useRef<number | null>(null);
  useEffect(() => {
    const editor = view.current!;
    if (!jump?.line || jumped.current === jump.seq) return;
    jumped.current = jump.seq;
    const doc = editor.state.doc;
    const line = doc.line(Math.max(1, Math.min(doc.lines, jump.line)));
    const from = Math.min(line.to, line.from + (jump.column ?? 0));
    const to = Math.min(line.to, from + (jump.length ?? 0));
    editor.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
    editor.focus();
  }, [jump?.seq, path, content]);

  return <div className="editor" ref={host} />;
}
