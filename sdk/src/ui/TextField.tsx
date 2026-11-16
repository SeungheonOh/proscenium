import { memo, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode,
  type Ref } from "react";
import { Box, Text } from "../components.js";
import type { StageElement, StageKeyboardEvent, StageKeyEvent, StageMeasureEvent, StageSelectEvent,
  StageSubmitEvent, StageTextInputEvent } from "../events.js";
import type { BoxProps, Style, TextProps } from "../props.js";
import type { Dimension } from "../layout.js";
import type { EditAction } from "../protocol.js";
import { currentSession } from "../session.js";
import { useContextMenu, type MenuEntry } from "./Menu.js";
import { controlTransition, ringed } from "./parts.js";
import { resolveStyle, StyleSheet, type StateStyle } from "./styles.js";
import { makeStyles, useTheme, type TextKeymap } from "./theme.js";

// A text field the compositor edits: its text is an editable text node (`editable`), which
// keeps the text, the caret, the selection and the undo history itself, takes keys and
// pointer presses in the frame they come, and draws its caret and selection. The field
// hears of the text as it changes (`onInput`) and declares the value it is given back with
// the revision it last heard, so a value echoed late never undoes newer typing, while a
// value the world chooses (cleared after sending, say) replaces the text.
//
// A value the world chooses is on its way while the compositor goes on taking keys: the
// compositor adds what was typed meanwhile to it and answers with a `replaced` report, and
// until then the field passes on no typing it heard, which that answer includes. Return
// fences typing after it until the world has rendered: a world clearing the field as it
// sends does so before what was typed after Return reaches it, as in a browser.

/** What the field knows of its text: see reconcile. */
export interface FieldSync {
  /** The text the compositor last reported, and its revision. */
  reported: string;
  revision: number;
  /** A value of the world's is on its way: typing heard meanwhile is not passed on. */
  awaiting: boolean;
  /** Return was pressed at this revision with this text, and the world has not rendered since. */
  submitted: { revision: number; text: string } | null;
  /** Typing after Return, held until the world rendered. */
  held: StageTextInputEvent | null;
}

/**
 * What a field does with EVENT, the compositor's report of its text: the text to pass on
 * to `onChangeText`, or null. SYNC changes with it.
 */
export function fieldInput(sync: FieldSync, event: StageTextInputEvent): string | null {
  if (event.replaced) {
    sync.awaiting = false;
    sync.held = null;
  } else if (sync.awaiting) {
    return null;
  } else if (sync.submitted && event.revision > sync.submitted.revision) {
    sync.held = event;
    return null;
  }
  sync.reported = event.text;
  sync.revision = event.revision;
  return event.text;
}

/**
 * After the world rendered VALUE: whether that is a value of its own, now on its way, and
 * the held typing to pass on, if any.
 */
export function fieldRendered(sync: FieldSync, value: string): StageTextInputEvent | null {
  const submitted = sync.submitted;
  sync.submitted = null;
  if (submitted && value === submitted.text) {
    const held = sync.held;
    sync.held = null;
    if (held) {
      sync.reported = held.text;
      sync.revision = held.revision;
    }
    return held;
  }
  sync.held = null;
  if (value !== sync.reported) sync.awaiting = true;
  return null;
}

/** What a field's style functions see. */
export interface TextFieldState {
  focused: boolean;
  /** Always false: the pointer over it shows through the theme's `states`, without rendering. */
  hovered: boolean;
  disabled: boolean;
  readOnly: boolean;
  empty: boolean;
}

/** Ways to act on a field from outside: `ref.current?.focus()`. Offsets are string indices. */
export interface TextFieldHandle {
  focus(): void;
  blur(): void;
  selectAll(): void;
  /** Select START to END, or put the caret at START. */
  setSelection(start: number, end?: number, direction?: "forward" | "backward"): void;
  /** Type TEXT over the selection, as a paste does: an emoji picker, a completion. */
  insertText(text: string): void;
}

export interface TextFieldProps {
  value: string;
  onChangeText?: (text: string) => void;
  /**
   * Return pressed: the text as it stood then. In a multiline field Return sends and
   * Shift+Return types a line break, unless `submitOnEnter` is false.
   */
  onSubmit?: (text: string) => void;
  /**
   * Keys the field leaves to the world, heard by `onKey` (and as keydown) instead of
   * editing, e.g. Up and Down to walk a list or a history, Tab to complete: keysym names,
   * with modifiers as "Control+Return". With `onKey` and no list, single-line fields leave
   * Up, Down, PageUp, PageDown and Escape, multiline ones Escape.
   */
  captureKeys?: readonly string[];
  /**
   * The keys a field does not edit with: those it captures, and those it has no use for
   * (Tab, Escape, shortcuts). The return value is ignored: what a field captures is said
   * ahead by `captureKeys`, as the compositor edits without waiting for the world.
   */
  onKey?: (event: StageKeyEvent) => boolean | void;
  onFocusChange?: (focused: boolean) => void;
  /** The selection moved: string indices, START equal to END for a caret alone. */
  onSelectionChange?: (start: number, end: number) => void;
  placeholder?: string;
  /** Lines that wrap; Return sends with `onSubmit` and Shift+Return types a line break. */
  multiline?: boolean;
  /** Lines shown before the field grows no more and scrolls instead. Defaults to 6. */
  maxLines?: number;
  /** Multiline: Return submits (the default with `onSubmit`). */
  submitOnEnter?: boolean;
  /** Takes keyboard focus as soon as it appears. */
  autoFocus?: boolean;
  /** Focus selects all the text, so typing replaces it: a search box opened again. */
  selectOnFocus?: boolean;
  /** The keys it takes, "emacs" or "standard": the theme's `textKeymap` by default. */
  keymap?: TextKeymap;
  disabled?: boolean;
  /** Selectable and copyable, not editable. */
  readOnly?: boolean;
  /** Bullets for the characters, which are never copied. */
  password?: boolean;
  /** At most this many characters (UTF-16 code units, as `value.length` counts). */
  maxLength?: number;
  /**
   * No fill, edge or focus ring of its own: a field inside something drawn as the field,
   * as a search bar with an icon.
   */
  bare?: boolean;
  /** Inside the field before and after the text: a search icon, a clear button. */
  leading?: ReactNode;
  trailing?: ReactNode;
  width?: Dimension;
  ref?: Ref<TextFieldHandle>;
  style?: StateStyle<BoxProps, TextFieldState>;
  textStyle?: Style<TextProps>;
  /** Only its `color` applies: the placeholder takes the text's font. */
  placeholderStyle?: Style<TextProps>;
}

/** Fields that have focus now: blurTextFields takes it from them. */
const focusedFields = new Set<StageElement>();

/** Take keyboard focus from whichever text field has it. */
export function blurTextFields(): void {
  if (focusedFields.size > 0) currentSession().focusNode(null);
}

/** What a field leaves the world when it has `onKey` but no `captureKeys`. */
const singleLineKeys = ["Up", "Down", "Prior", "Next", "Escape"];
const multilineKeys = ["Escape"];

const useStyles = makeStyles((theme) => {
  const { colors, type, radii, shadows, controls } = theme;
  const ring = ringed(theme, shadows.control);
  const linePitch = Math.round((type.body.size ?? 13) * (type.body.lineHeight ?? 18 / 13));
  // Lines of a multiline field sit as one line sits in a single-line field of medium height.
  const paddingY = Math.max(2, Math.floor((controls.medium - 2 - linePitch) / 2));
  return {
    ...StyleSheet.create({
      field: { flexDirection: "row", alignItems: "stretch", radius: radii.sm,
               fill: colors.field, border: { width: 1, color: colors.border }, shadow: ring.rest,
               transition: controlTransition(theme), clip: true, cursor: "text" },
      singleLine: { height: controls.medium },
      disabled: { opacity: 0.45 },
      bare: { fill: colors.clear, border: { width: 0 }, shadow: [], radius: 0 },
      slot: { flexDirection: "row", alignItems: "center", flexShrink: 0 },
      text: { ...type.body, color: colors.ink },
    }),
    // A field shows its ring while its text has focus, as browsers show one on a focused input.
    states: { hover: { border: { color: colors.borderHover } },
              focusWithin: { border: { color: colors.accent }, shadow: ring.focus } },
    colors,
    linePitch,
    paddingX: 8,
    paddingY,
  };
});

function flatStyle(style: Style<TextProps> | undefined): TextProps {
  if (!style) return {};
  if (Array.isArray(style)) return Object.assign({}, ...style.map((part) => flatStyle(part as Style<TextProps>)));
  return style as TextProps;
}

/**
 * A field to type into: `<TextField value={text} onChangeText={setText} onSubmit={send} multiline />`.
 * Click it, Tab to it or give it `autoFocus`, and it takes keyboard focus. The compositor
 * edits it as a browser edits an `<input>`, with the readline and Emacs keys too (C-a,
 * C-e, C-k, C-y, M-f, …) unless `keymap` or the theme's `textKeymap` is "standard": the
 * caret moves by characters, words and lines; Shift extends the selection, as do dragging
 * (past an edge it scrolls), a double click (words) and a triple click (lines); Ctrl+C, X
 * and V use the clipboard, a middle click pastes the primary selection, Ctrl+Z and
 * Ctrl+Shift+Z undo and redo, and dead keys and Compose sequences type what they make.
 * Its context menu has the same. docs/GUIDE.md lists every key.
 */
export const TextField = memo(function TextField({ value, onChangeText, onSubmit, captureKeys, onKey, onFocusChange,
                                                   onSelectionChange, placeholder, multiline = false, maxLines = 6,
                                                   submitOnEnter, autoFocus = false, selectOnFocus = false, keymap,
                                                   disabled = false, readOnly = false, password = false, maxLength,
                                                   bare = false, leading, trailing, width, ref, style, textStyle,
                                                   placeholderStyle }: TextFieldProps) {
  const styles = useStyles();
  const theme = useTheme();
  const self = useRef<StageElement | null>(null);
  const [focused, setFocused] = useState(false);
  const sync = useRef<FieldSync>({ reported: value, revision: 0, awaiting: false, submitted: null, held: null });
  const latest = useRef(value);
  latest.current = value;
  // Renders the field once Return is handled, whatever the world does, to let typing go on.
  const [, rendered] = useState(0);
  const [selected, setSelected] = useState(false);
  // Lines of a multiline field, as the compositor measured them (up to maxLines).
  const [contentHeight, setContentHeight] = useState<number | null>(null);

  const edit = (action: EditAction, extra: { start?: number; end?: number; text?: string;
                                             direction?: "forward" | "backward" } = {}) => {
    if (self.current) currentSession().editText(self.current, { action, ...extra });
  };
  const focus = () => {
    if (self.current && !disabled) currentSession().focusNode(self.current);
  };
  const blur = () => {
    if (self.current && focusedFields.has(self.current)) currentSession().focusNode(null);
  };
  useImperativeHandle(ref, () => ({
    focus, blur,
    selectAll: () => edit("select-all"),
    setSelection: (start, end = start, direction) => edit("select", { start, end, direction }),
    insertText: (text) => edit("insert", { text }),
  }), [disabled]);

  useLayoutEffect(() => {
    const held = fieldRendered(sync.current, value);
    if (held && held.text !== value) onChangeText?.(held.text);
  });

  useEffect(() => {
    if (autoFocus && !disabled) focus();
    return () => {
      if (self.current) focusedFields.delete(self.current);
    };
  }, []);

  const text = { ...flatStyle(styles.text), ...flatStyle(textStyle) };
  const placeholderColor = flatStyle(placeholderStyle).color ?? styles.colors.faint;
  const pitch = text.size === undefined || (text.size === 13 && text.lineHeight === 18 / 13)
    ? styles.linePitch : Math.round(text.size * (text.lineHeight ?? 18 / 13));
  // The text lies inside the field's edge and padding, as an input's does: its node covers the
  // whole field, so a press anywhere in it places the caret.
  const edge = bare ? 0 : 1;
  const padX = bare ? 0 : styles.paddingX;
  const padY = multiline ? (bare ? 0 : styles.paddingY) : 0;
  const inset: [number, number, number, number] = [edge + padY, edge + (trailing ? 4 : padX), edge + padY,
                                                   edge + (leading ? 4 : padX)];
  const lines = Math.max(pitch, Math.min(contentHeight ?? pitch, pitch * Math.max(1, maxLines)));
  const captured = captureKeys ?? (onKey ? (multiline ? multilineKeys : singleLineKeys) : undefined);

  const state: TextFieldState = { focused, hovered: false, disabled, readOnly, empty: value === "" };
  const menuItems: MenuEntry[] = [
    { label: "Undo", shortcut: "Ctrl+Z", disabled: readOnly, onSelect: () => edit("undo") },
    { label: "Redo", shortcut: "Ctrl+Shift+Z", disabled: readOnly, onSelect: () => edit("redo") },
    "-",
    { label: "Cut", shortcut: "Ctrl+X", disabled: !selected || readOnly || password, onSelect: () => edit("cut") },
    { label: "Copy", shortcut: "Ctrl+C", disabled: !selected || password, onSelect: () => edit("copy") },
    { label: "Paste", shortcut: "Ctrl+V", disabled: readOnly, onSelect: () => edit("paste") },
    "-",
    { label: "Select all", shortcut: (keymap ?? theme.textKeymap) === "emacs" ? "Ctrl+Shift+A" : "Ctrl+A",
      disabled: !value, onSelect: () => edit("select-all") },
  ];
  const menu = useContextMenu(menuItems, {
    disabled,
    // Focus comes back to the field as its menu closes, its selection still there.
    onOpenChange: (open) => {
      if (!open) focus();
    },
  });

  return (
    <Box style={[styles.field, !multiline && styles.singleLine, bare && styles.bare, disabled && styles.disabled,
                 resolveStyle(style, state)]}
         width={width} states={disabled || bare ? undefined : styles.states}
         cursor={disabled ? "default" : "text"} onContextMenu={menu.onContextMenu}>
      {leading && <Box style={styles.slot} paddingLeft={bare ? 0 : 8}>{leading}</Box>}
      <Text ref={(node: StageElement | null) => { self.current = node; }}
            {...text} editable text={value} valueRevision={sync.current.revision} multiline={multiline}
            maxLines={multiline ? Math.max(1, maxLines) : undefined}
            height={multiline ? lines + 2 * (padY + edge) : undefined}
            flexGrow={1} flexShrink={1} alignSelf={multiline ? "flex-start" : "stretch"}
            contentInset={inset} placeholder={placeholder} placeholderColor={placeholderColor}
            readOnly={readOnly || disabled} password={password} maxLength={maxLength}
            caretColor={styles.colors.accent} selectionColor={styles.colors.selection}
            captureKeys={captured} selectOnFocus={selectOnFocus} keymap={keymap ?? theme.textKeymap}
            submitOnEnter={multiline ? submitOnEnter ?? onSubmit !== undefined : undefined}
            tabIndex={disabled ? undefined : 0} interactive={!disabled} cursor={disabled ? "default" : "text"}
            onInput={(event: StageTextInputEvent) => {
              const text = fieldInput(sync.current, event);
              if (text === null) return;
              setSelected(event.selectionStart !== event.selectionEnd);
              if (text !== latest.current) onChangeText?.(text);
            }}
            onSubmit={(event: StageSubmitEvent) => {
              sync.current.submitted = { revision: event.revision, text: event.text };
              rendered((count) => count + 1);
              onSubmit?.(event.text);
            }}
            onSelect={(event: StageSelectEvent) => {
              setSelected(event.selectionStart !== event.selectionEnd);
              onSelectionChange?.(event.selectionStart, event.selectionEnd);
            }}
            onMeasure={multiline ? (event: StageMeasureEvent) => setContentHeight(event.height) : undefined}
            onKeyDown={onKey ? (event: StageKeyboardEvent) => {
              onKey({ key: event.key, text: event.text, code: event.code, pressed: true, repeat: event.repeat,
                      modifiers: event.modifiers });
            } : undefined}
            onFocus={() => {
              if (self.current) focusedFields.add(self.current);
              setFocused(true);
              onFocusChange?.(true);
            }}
            onBlur={() => {
              if (self.current) focusedFields.delete(self.current);
              setFocused(false);
              onFocusChange?.(false);
            }} />
      {trailing && <Box style={styles.slot} paddingRight={bare ? 0 : 6}>{trailing}</Box>}
      {menu.element}
    </Box>
  );
});
