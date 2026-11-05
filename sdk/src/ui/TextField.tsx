import { memo, useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore, type Ref } from "react";
import { Box, Group, Text } from "../components.js";
import type { StageKeyEvent } from "../events.js";
import { useClipboard, useInput, useKeyboardGrab } from "../hooks.js";
import type { BoxProps, Style, TextProps } from "../props.js";
import type { Dimension } from "../layout.js";
import { escapeMarkup } from "../props.js";
import { resolveStyle, StyleSheet, variants, type StateStyle } from "./styles.js";
import { makeStyles, useTheme } from "./theme.js";

// A text field drawn by the world, not by a client: it holds the keyboard while
// focused (useKeyboardGrab), so keys come to it and windows and pages lose
// keyboard focus meanwhile; shortcuts still work. One field is focused at a
// time. A press anywhere else, Escape, or the field going away lets go.
//
// The caret is drawn by a second, see-through copy of the text laid over the
// first, with a caret glyph at the caret: Pango wraps both alike, so the caret
// lands where the text is, on any line, without measuring anything.

/** What a field's style functions see. */
export interface TextFieldState {
  focused: boolean;
  disabled: boolean;
  empty: boolean;
}

/** Ways to move a field's focus from outside: `ref.current?.focus()`. */
export interface TextFieldHandle {
  focus(): void;
  blur(): void;
}

export interface TextFieldProps {
  value: string;
  onChangeText?: (text: string) => void;
  /** Return pressed: the text as it stands. Shift+Return types a new line in a multiline field. */
  onSubmit?: (text: string) => void;
  /** A key before the field acts on it; return true to say it was handled, e.g. Up for history. */
  onKey?: (event: StageKeyEvent) => boolean;
  onFocusChange?: (focused: boolean) => void;
  placeholder?: string;
  /** Wraps, and Shift+Return types a new line. */
  multiline?: boolean;
  /** Lines shown before the field grows no more; its newest lines stay in view. Defaults to 6. */
  maxLines?: number;
  /** Takes the keyboard as soon as it appears. */
  autoFocus?: boolean;
  disabled?: boolean;
  width?: Dimension;
  ref?: Ref<TextFieldHandle>;
  style?: StateStyle<BoxProps, TextFieldState>;
  textStyle?: Style<TextProps>;
  placeholderStyle?: Style<TextProps>;
}

/** The caret's copy of the text: every glyph clear but the caret. */
const hidden = { color: "#00000001" } as const;

let focusedField: object | null = null;
const focusListeners = new Set<() => void>();

function focusField(field: object | null): void {
  if (focusedField === field) return;
  focusedField = field;
  for (const listener of [...focusListeners]) listener();
}

function subscribeFocus(listener: () => void): () => void {
  focusListeners.add(listener);
  return () => focusListeners.delete(listener);
}

/** Let go of the keyboard if a text field holds it. */
export function blurTextFields(): void {
  focusField(null);
}

const word = /[\p{L}\p{N}_]/u;

function previousWord(text: string, from: number): number {
  let at = from;
  while (at > 0 && !word.test(text[at - 1]!)) at--;
  while (at > 0 && word.test(text[at - 1]!)) at--;
  return at;
}

function nextWord(text: string, from: number): number {
  let at = from;
  while (at < text.length && !word.test(text[at]!)) at++;
  while (at < text.length && word.test(text[at]!)) at++;
  return at;
}

/** Where a character starts that is not inside a surrogate pair, going BACK or forward from AT. */
function characterEdge(text: string, at: number, back: boolean): number {
  const step = back ? -1 : 1;
  let next = at + step;
  const code = text.charCodeAt(back ? next : at);
  // Step over the whole of a surrogate pair.
  if (back && code >= 0xdc00 && code <= 0xdfff && next > 0) next--;
  if (!back && code >= 0xd800 && code <= 0xdbff && next < text.length) next++;
  return Math.min(Math.max(next, 0), text.length);
}

function lineStart(text: string, at: number): number {
  return text.lastIndexOf("\n", at - 1) + 1;
}

function lineEnd(text: string, at: number): number {
  const end = text.indexOf("\n", at);
  return end === -1 ? text.length : end;
}

/** Text whose control characters say nothing a field can type. */
function typed(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

const useStyles = makeStyles(({ colors, type, radii, motion }) => ({
  field: variants({
    base: { flexDirection: "column", paddingX: 10, paddingY: 7, radius: radii.md, fill: colors.hover,
            border: { width: 1, color: colors.accentClear }, transition: motion.pop, clip: true },
    variants: {
      focused: { true: { fill: colors.raised, border: { width: 1, color: colors.accentLine } }, false: {} },
      disabled: { true: { opacity: 0.4 }, false: {} },
    },
    defaults: { focused: false, disabled: false },
  }),
  ...StyleSheet.create({
    lines: { flexDirection: "column", justifyContent: "flex-end" },
    stack: { flexDirection: "column" },
    text: { ...type.body, color: colors.ink, lineHeight: 1.15 },
    placeholder: { ...type.body, color: colors.faint, lineHeight: 1.15 },
    // The compositor draws no text that is wholly clear, so the copy is all but clear.
    caret: { position: "absolute", x: 0, y: 0, width: "100%", ...type.body, lineHeight: 1.15, color: "#00000001" },
    hit: { position: "absolute", x: 0, y: 0, width: "100%", height: "100%" },
  }),
  colors,
  lineSize: type.body.size ?? 13,
}));

/**
 * A field to type into: `<TextField value={text} onChangeText={setText} onSubmit={send} multiline />`.
 * Click it, or give it `autoFocus`, and it takes the keyboard; it keeps a caret
 * and a selection (Shift with arrows, Ctrl+A), moves by words with Ctrl, and
 * copies, cuts and pastes with Ctrl+C, X and V.
 */
export const TextField = memo(function TextField({ value, onChangeText, onSubmit, onKey, onFocusChange, placeholder,
                                                   multiline = false, maxLines = 6, autoFocus = false,
                                                   disabled = false, width, ref, style, textStyle,
                                                   placeholderStyle }: TextFieldProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const clipboard = useClipboard();
  const self = useRef({}).current;
  const focused = useSyncExternalStore(subscribeFocus, () => focusedField === self) && !disabled;
  // The caret, and the other end of the selection while there is one.
  const [caret, setCaret] = useState(value.length);
  const [anchor, setAnchor] = useState<number | null>(null);
  // What the field last showed, so a value changed from outside puts the caret at its end.
  const known = useRef(value);
  const pressedSelf = useRef(0);
  const latest = useRef({ value, caret, anchor });
  latest.current = { value, caret: Math.min(caret, value.length), anchor: anchor === null ? null : Math.min(anchor, value.length) };

  useImperativeHandle(ref, () => ({ focus: () => focusField(self), blur: () => focusedField === self && focusField(null) }), [self]);

  useEffect(() => {
    if (known.current === value) return;
    known.current = value;
    setCaret(value.length);
    setAnchor(null);
  }, [value]);

  useEffect(() => {
    if (autoFocus && !disabled) focusField(self);
    return () => {
      if (focusedField === self) focusField(null);
    };
  }, []);

  const wasFocused = useRef(focused);
  useEffect(() => {
    if (wasFocused.current === focused) return;
    wasFocused.current = focused;
    if (!focused) setAnchor(null);
    onFocusChange?.(focused);
  }, [focused]);

  // A press elsewhere lets go. The field's own press arrives just after the
  // press is heard, so wait a moment for it.
  useInput(focused ? (event) => {
    if (event.kind !== "button") return;
    const heard = performance.now();
    setTimeout(() => {
      if (pressedSelf.current < heard - 5 && focusedField === self) focusField(null);
    }, 60);
  } : null);

  function change(text: string, at: number) {
    known.current = text;
    setCaret(at);
    setAnchor(null);
    onChangeText?.(text);
  }

  function move(to: number, select: boolean) {
    const { caret, anchor } = latest.current;
    setAnchor(select ? anchor ?? caret : null);
    setCaret(to);
  }

  useKeyboardGrab(focused ? (event) => {
    if (!event.pressed) return;
    if (onKey?.(event)) return;
    const { value: text, caret, anchor } = latest.current;
    const modifiers = new Set(event.modifiers);
    const ctrl = modifiers.has("control");
    const shift = modifiers.has("shift");
    const [from, to] = anchor === null ? [caret, caret] : [Math.min(anchor, caret), Math.max(anchor, caret)];
    const insert = (words: string) => change(text.slice(0, from) + words + text.slice(to), from + words.length);
    switch (event.key) {
      case "Return":
      case "KP_Enter":
        if (multiline && shift) insert("\n");
        else onSubmit?.(text);
        return;
      case "Escape":
        focusField(null);
        return;
      case "BackSpace":
        if (from !== to) insert("");
        else if (caret > 0) {
          const start = ctrl ? previousWord(text, caret) : characterEdge(text, caret, true);
          change(text.slice(0, start) + text.slice(caret), start);
        }
        return;
      case "Delete":
      case "KP_Delete":
        if (from !== to) insert("");
        else if (caret < text.length) {
          const end = ctrl ? nextWord(text, caret) : characterEdge(text, caret, false);
          change(text.slice(0, caret) + text.slice(end), caret);
        }
        return;
      case "Left":
      case "KP_Left":
        if (from !== to && !shift) move(from, false);
        else move(ctrl ? previousWord(text, caret) : characterEdge(text, caret, true), shift);
        return;
      case "Right":
      case "KP_Right":
        if (from !== to && !shift) move(to, false);
        else move(ctrl ? nextWord(text, caret) : characterEdge(text, caret, false), shift);
        return;
      case "Home":
      case "KP_Home":
        move(ctrl ? 0 : lineStart(text, caret), shift);
        return;
      case "End":
      case "KP_End":
        move(ctrl ? text.length : lineEnd(text, caret), shift);
        return;
      case "Up":
      case "Down": {
        const start = lineStart(text, caret);
        const column = caret - start;
        if (event.key === "Up") {
          if (start === 0) return move(0, shift);
          const above = lineStart(text, start - 1);
          return move(Math.min(above + column, start - 1), shift);
        }
        const end = lineEnd(text, caret);
        if (end === text.length) return move(text.length, shift);
        return move(Math.min(end + 1 + column, lineEnd(text, end + 1)), shift);
      }
    }
    if (ctrl) {
      const key = event.key.toLowerCase();
      if (key === "a") {
        setAnchor(0);
        setCaret(text.length);
      } else if ((key === "c" || key === "x") && from !== to) {
        clipboard.copy(text.slice(from, to));
        if (key === "x") insert("");
      } else if (key === "v" && clipboard.history[0] !== undefined) {
        const pasted = typed(multiline ? clipboard.history[0] : clipboard.history[0].replace(/\s*\n\s*/g, " "));
        insert(pasted);
      }
      return;
    }
    if (modifiers.has("alt") || modifiers.has("logo")) return;
    const words = typed(event.text);
    if (words) insert(words);
  } : null);

  const shown = latest.current;
  const state: TextFieldState = { focused, disabled, empty: value === "" };
  const lineHeight = Math.ceil(styles.lineSize * 1.15 * 1.17);
  const selection = shown.anchor === null || shown.anchor === shown.caret
    ? null : [Math.min(shown.anchor, shown.caret), Math.max(shown.anchor, shown.caret)] as const;
  const accent = String(colors.accent).slice(0, 7);
  const markup = selection
    ? escapeMarkup(value.slice(0, selection[0])) + `<span background="${accent}" bgalpha="28%">`
      + escapeMarkup(value.slice(selection[0], selection[1])) + "</span>" + escapeMarkup(value.slice(selection[1]))
    : escapeMarkup(value);
  // A word joiner either side keeps the caret glyph from opening a line break.
  const caretMarkup = escapeMarkup(value.slice(0, shown.caret))
    + `\u2060<span foreground="${accent}">|</span>\u2060` + escapeMarkup(value.slice(shown.caret));
  const single = multiline ? undefined : 1;
  return (
    <Box style={[styles.field(state), resolveStyle(style, state)]} width={width}
         maxHeight={multiline ? lineHeight * maxLines + 14 : undefined}>
      <Box style={styles.lines} flexGrow={1}>
        <Box style={styles.stack}>
          {value === "" && placeholder !== undefined
            ? <Text style={[styles.placeholder, placeholderStyle]} maxLines={single}>{placeholder}</Text>
            : <Text markup style={[styles.text, textStyle]} maxLines={single}>{markup || " "}</Text>}
          {focused && <Text markup style={[styles.caret, textStyle, hidden]}>{caretMarkup}</Text>}
        </Box>
      </Box>
      <Group style={styles.hit} cursor={disabled ? undefined : "text"} onPointerDown={disabled ? undefined : () => {
        pressedSelf.current = performance.now();
        focusField(self);
      }} />
    </Box>
  );
});
