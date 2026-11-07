// Draws a generated interface: walks its json-render spec from the root,
// resolving visibility, repeats, dynamic props and two-way bindings against its
// state with json-render's own functions, and renders each element with
// proscenium/ui. Events run the element's `on` bindings: setState, pushState and
// removeState change the state here, and any other action goes to `onAction`,
// for whoever owns the interface.
//
// Elements that have not arrived yet are skipped, so a spec still streaming in
// draws what it has. A spec that fails to draw shows why, inside its own box,
// and never takes the world down with it.

import { createHash } from "node:crypto";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Children, Component, createContext, memo, useContext, useEffect, useMemo, useRef, useState,
  useSyncExternalStore, type ReactNode } from "react";
import { evaluateVisibility, getByPath, resolveActionParam, resolveBindings, resolveElementProps,
  resolveRepeatStatePath, splitRepeatVisibility, type ActionBinding, type PropResolutionContext, type StateModel,
  type UIElement } from "@json-render/core";
import { Box, Image, Rect, Spacer, Text } from "../components.js";
import type { LayoutBox } from "../layout.js";
import type { BoxProps, TextProps } from "../props.js";
import { rotate } from "../transform.js";
import { Button, Checkbox, ProgressBar as Progress, SegmentedControl, Slider as SliderControl,
  Switch as SwitchControl } from "../ui/controls.js";
import { TextField as Field } from "../ui/TextField.js";
import { Pressable } from "../ui/Pressable.js";
import { StyleSheet } from "../ui/styles.js";
import { darkTheme, makeStyles, ThemeProvider, useTheme, type Theme } from "../ui/theme.js";
import { Divider as Hairline, Label, Surface as Panel } from "../ui/views.js";
import { diffTexts, parsePatch, type DiffFile, type DiffLine } from "./diff.js";
import { markdownBlocks } from "./markdown.js";
import type { Surface } from "./surface.js";

/** An action the interface does not handle itself, with its params resolved. */
export type ActionHandler = (action: string, params: Record<string, unknown>) => void;

export interface GeneratedViewProps {
  surface: Surface;
  /** Actions other than setState, pushState and removeState: ask, close, copy, or a program's own. */
  onAction?: ActionHandler;
  /** Shown until the spec has a root to draw, as while it starts streaming. */
  fallback?: ReactNode;
}

interface Scope {
  item?: unknown;
  index?: number;
  basePath?: string;
}

interface Generation {
  surface: Surface;
  /** The root element's key: a Card there draws no card of its own, as its frame is one. */
  root: string;
  elements: Record<string, UIElement>;
  state: StateModel;
  run: (bindings: ActionBinding | ActionBinding[] | undefined, scope: Scope) => void;
}

const GenerationContext = createContext<Generation | null>(null);

/** What a component gets: its resolved props, children, events and bindings. */
interface Rendered {
  type: string;
  /** The element's key, with the item's index inside a repeat: a name for state it keeps. */
  name: string;
  /** The interface's state, for state a component keeps there to outlive its node. */
  store: Surface["state"];
  /** The spec's root element. */
  root: boolean;
  props: Record<string, unknown>;
  children?: ReactNode;
  /** Run the element's bindings for EVENT. */
  emit: (event: string) => void;
  /** Whether the element binds EVENT to anything, e.g. to look pressable. */
  listens: (event: string) => boolean;
  /** A setter for a prop bound with $bindState or $bindItem, if it is. */
  bound: (prop: string) => ((value: unknown) => void) | undefined;
}

let nextId = 0;

/** VALUE with every {"$state"} read and every "$id" made, as pushState's value is. */
function deepResolve(value: unknown, get: (path: string) => unknown): unknown {
  if (value === "$id") return `${Date.now().toString(36)}-${(nextId++).toString(36)}`;
  if (Array.isArray(value)) return value.map((item) => deepResolve(item, get));
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (typeof object.$state === "string" && Object.keys(object).length === 1) return get(object.$state);
    return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, deepResolve(item, get)]));
  }
  return value;
}

/** A generated interface, drawn live from SURFACE: `<GeneratedView surface={surface} onAction={…} />`. */
export function GeneratedView({ surface, onAction, fallback = null }: GeneratedViewProps) {
  const spec = useSyncExternalStore(surface.subscribe, surface.getSpec);
  const state = useSyncExternalStore(surface.state.subscribe, surface.state.getSnapshot);
  const latest = useRef(onAction);
  latest.current = onAction;
  const generation: Generation = {
    surface,
    root: spec.root,
    elements: spec.elements,
    state,
    run: (bindings, scope) => {
      for (const binding of bindings === undefined ? [] : Array.isArray(bindings) ? bindings : [bindings]) {
        runBinding(surface, binding, scope, latest.current);
      }
    },
  };
  if (!spec.root || !spec.elements[spec.root]) return <>{fallback}</>;
  return (
    <GenerationContext.Provider value={generation}>
      <Boundary key={spec.root}>
        <ElementView id={spec.root} scope={{}} />
      </Boundary>
    </GenerationContext.Provider>
  );
}

function runBinding(surface: Surface, binding: ActionBinding, scope: Scope, onAction: ActionHandler | undefined): void {
  if (!binding || typeof binding.action !== "string") return;
  const store = surface.state;
  const context = propContext(store.getSnapshot(), scope);
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(binding.params ?? {})) params[key] = resolveActionParam(value, context);
  switch (binding.action) {
    case "setState":
      if (typeof params.statePath === "string") store.set(params.statePath, params.value);
      break;
    case "pushState": {
      if (typeof params.statePath !== "string") break;
      const value = deepResolve(binding.params?.value, store.get);
      const list = store.get(params.statePath);
      store.set(params.statePath, [...(Array.isArray(list) ? list : []), value]);
      if (typeof params.clearStatePath === "string") store.set(params.clearStatePath, "");
      break;
    }
    case "resetTimer": {
      // A countdown's clock lives in the interface's state; without one it starts over.
      // Inside a repeat, the countdown is the one of this item. Models name the
      // param as they please; with none, every countdown starts over.
      const named = params.timer ?? params.key ?? params.elementKey ?? params.id ?? params.target ?? params.element;
      const wanted = typeof named === "string" ? [named]
        : Object.entries(surface.spec.elements).filter(([, element]) => element.type === "Countdown").map(([key]) => key);
      for (const timer of wanted) {
        // Back to its seconds, and stopped: a running bound to state is set false.
        const running = (surface.spec.elements[timer]?.props as Record<string, unknown> | undefined)?.running as
          { $state?: unknown; $bindState?: unknown } | undefined;
        const path = running && typeof running === "object" ? running.$bindState ?? running.$state : undefined;
        if (typeof path === "string") store.set(path, false);
        store.set(ownStatePath(scope.index === undefined ? timer : `${timer}.${scope.index}`, "clock"), undefined);
      }
      break;
    }
    case "removeState": {
      if (typeof params.statePath !== "string") break;
      const list = store.get(params.statePath);
      if (Array.isArray(list)) store.set(params.statePath, list.filter((_, index) => index !== Number(params.index)));
      break;
    }
    default:
      onAction?.(binding.action, params);
  }
  const success = binding.onSuccess as { set?: Record<string, unknown> } | undefined;
  if (success?.set) store.update(success.set);
}

function propContext(state: StateModel, scope: Scope): PropResolutionContext {
  return { stateModel: state, repeatItem: scope.item, repeatIndex: scope.index, repeatBasePath: scope.basePath };
}

class Boundary extends Component<{ children?: ReactNode }, { error: string | null }> {
  override state = { error: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  override render() {
    if (this.state.error === null) return this.props.children;
    return <Label tone="danger" maxLines={3}>This interface failed to draw: {this.state.error}</Label>;
  }
}

const ElementView = memo(function ElementView({ id, scope }: { id: string; scope: Scope }) {
  const generation = useContext(GenerationContext)!;
  const element = generation.elements[id];
  if (!element) return null;
  const context = propContext(generation.state, scope);
  let visible = element.visible;
  let itemFilter: UIElement["visible"];
  if (element.repeat) ({ container: visible, itemFilter } = splitRepeatVisibility(element.visible));
  if (visible !== undefined && !evaluateVisibility(visible, context)) return null;
  const props = resolveElementProps(element.props ?? {}, context);
  const bindings = resolveBindings(element.props ?? {}, context) ?? {};
  let children: ReactNode;
  if (element.repeat) {
    const path = resolveRepeatStatePath(element.repeat.statePath, scope.basePath ?? null);
    const items = path === undefined ? undefined : getByPath(generation.state, path);
    const keyField = element.repeat.key;
    children = Array.isArray(items) ? items.flatMap((item, index) => {
      if (itemFilter !== undefined
          && !evaluateVisibility(itemFilter, { ...context, repeatItem: item, repeatIndex: index })) return [];
      const itemScope: Scope = { item, index, basePath: `${path}/${index}` };
      const key = keyField && item && typeof item === "object"
        ? String((item as Record<string, unknown>)[keyField] ?? index) : String(index);
      return (element.children ?? []).map((child) => <ElementView key={`${key}:${child}`} id={child} scope={itemScope} />);
    }) : null;
  } else {
    children = (element.children ?? []).map((child) => <ElementView key={child} id={child} scope={scope} />);
  }
  const Drawn = components[element.type] ?? Unknown;
  const on = element.on as Record<string, ActionBinding | ActionBinding[]> | undefined;
  const rendered: Rendered = {
    type: element.type,
    name: scope.index === undefined ? id : `${id}.${scope.index}`,
    store: generation.surface.state,
    root: id === generation.root,
    props,
    children,
    emit: (event) => generation.run(on?.[event], scope),
    listens: (event) => on?.[event] !== undefined,
    bound: (prop) => {
      const path = bindings[prop];
      return path === undefined ? undefined : (value) => generation.surface.state.set(path, value);
    },
  };
  return (
    <>
      <Drawn {...rendered} />
      {element.watch && <Watch watch={element.watch as Record<string, ActionBinding | ActionBinding[]>} scope={scope} />}
    </>
  );
});

/** Runs an element's `watch` bindings when the state at their paths changes, never at first. */
function Watch({ watch, scope }: { watch: Record<string, ActionBinding | ActionBinding[]>; scope: Scope }) {
  const generation = useContext(GenerationContext)!;
  const seen = useRef<Record<string, unknown> | null>(null);
  useEffect(() => {
    const now = Object.fromEntries(Object.keys(watch).map((path) => [path, getByPath(generation.state, path)]));
    const before = seen.current;
    seen.current = now;
    if (!before) return;
    for (const [path, bindings] of Object.entries(watch)) {
      if (before[path] !== now[path]) generation.run(bindings, scope);
    }
  });
  return null;
}

// Plain values from whatever a model sent.

function text(value: unknown, fallback = ""): string {
  if (value === undefined || value === null) return fallback;
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function number(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

const gaps: Record<string, number> = { none: 0, xs: 2, sm: 4, md: 8, lg: 14, xl: 20 };

function gapOf(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : gaps[text(value)] ?? fallback;
}

const alignments: Record<string, BoxProps["alignItems"]> = {
  start: "flex-start", center: "center", end: "flex-end", stretch: "stretch",
};
const justifications: Record<string, BoxProps["justifyContent"]> = {
  start: "flex-start", center: "center", end: "flex-end", between: "space-between",
};

/** Colors for a tone, on light and dark alike. */
function toneColor(theme: Theme, tone: unknown): string | undefined {
  const dark = theme === darkTheme || String(theme.colors.ink).toLowerCase().startsWith("#f");
  switch (tone) {
    case "muted": return String(theme.colors.muted);
    case "accent": return String(theme.colors.accent);
    case "success": return dark ? "#4ade80" : "#16a34a";
    case "warning": return dark ? "#fbbf24" : "#d97706";
    case "danger": return String(theme.colors.danger);
    default: return undefined;
  }
}

// One scale of space and type for every component, so interfaces line up however
// they are composed: 14 around and inside cards, 6 between a label and its control,
// 8 between things in a row; labels at 12, everything that shares a line with
// something else at that something's size.
export const pad = 14;
const labelGap = 6;
const rowGap = 8;

const useStyles = makeStyles((theme) => {
  const { colors, type, radii, motion } = theme;
  return {
    theme,
    ...StyleSheet.create({
      card: { flexDirection: "column", radius: radii.md, padding: pad, gap: rowGap, alignSelf: "stretch" },
      plain: { flexDirection: "column", gap: rowGap, alignSelf: "stretch" },
      tinted: { flexDirection: "column", radius: radii.md, padding: pad, gap: rowGap, fill: colors.accentSoft, alignSelf: "stretch" },
      ink: { flexDirection: "column", radius: radii.md, padding: pad, gap: rowGap, fill: "#1f1f24", alignSelf: "stretch" },
      head: { flexDirection: "column", gap: 2, alignSelf: "stretch" },
      cardTitle: { ...type.title, color: colors.ink },
      cardSubtitle: { ...type.body, color: colors.muted, maxLines: 2 },
      row: { flexDirection: "row", alignItems: "center", gap: rowGap, alignSelf: "stretch" },
      labelled: { flexDirection: "column", gap: labelGap, alignSelf: "stretch" },
      column: { flexDirection: "column", gap: 2, alignSelf: "stretch" },
      body: { ...type.body, color: colors.soft, lineHeight: 1.2 },
      label: { font: type.body.font, size: 12, weight: 600, color: colors.muted },
      value: { ...type.body, color: colors.muted },
      metricValue: { font: type.title.font, size: 26, weight: 700, color: colors.ink },
      badge: { flexDirection: "row", alignItems: "center", height: 20, paddingX: 8, radius: 10, alignSelf: "flex-start",
               flexShrink: 0 },
      badgeText: { font: type.body.font, size: 11, weight: 650 },
      track: { flexGrow: 1, height: 10, radius: 5, fill: colors.track, clip: true },
      bar: { position: "absolute", x: 0, y: 0, height: 10, radius: 5, transition: motion.glide },
      code: { flexDirection: "column", radius: radii.sm, paddingX: 10, paddingY: 8, fill: colors.hover, alignSelf: "stretch" },
      mono: { font: "Noto Sans Mono, monospace", size: 12, color: colors.soft, lineHeight: 1.25 },
      // A row of a list reaches past the content's edges by its own padding, so its words line up with the rest.
      item: { flexDirection: "row", alignItems: "center", gap: 10, paddingY: 5, paddingX: 6, marginX: -6, radius: radii.sm,
              transition: motion.pop },
      listRow: { flexDirection: "column", paddingY: 5, alignSelf: "stretch" },
      cell: { flexGrow: 1, flexBasis: 0, flexDirection: "column" },
      quoteBar: { width: 3, radius: 1.5, fill: colors.accentLine, alignSelf: "stretch" },
      choice: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingX: 12, paddingY: 10, radius: radii.md,
                alignSelf: "stretch", transition: motion.pop },
    }),
    hover: colors.hover,
    selected: colors.accentTint,
  };
});

type Drawn = (rendered: Rendered) => ReactNode;

function Unknown({ type }: Rendered) {
  return <Label tone="faint" maxLines={1}>{`[no component "${type}"]`}</Label>;
}

function Stack({ props, children }: Rendered) {
  const horizontal = props.direction === "horizontal";
  return (
    <Box flexDirection={horizontal ? "row" : "column"} gap={gapOf(props.gap, 8)}
         alignItems={alignments[text(props.align)] ?? (horizontal ? "center" : "stretch")}
         justifyContent={justifications[text(props.justify)]} flexWrap={props.wrap ? "wrap" : undefined}
         padding={props.padding ? gapOf(props.padding, 0) : undefined} alignSelf="stretch">
      {children}
    </Box>
  );
}

function Card({ props, children, root }: Rendered) {
  const styles = useStyles();
  // At the root, the frame around the interface is the card already.
  const variant = root && (props.variant ?? "card") === "card" ? "plain" : text(props.variant, "card");
  const padding = props.padding ? gapOf(props.padding, pad) : undefined;
  const content = <><CardHead title={props.title} subtitle={props.subtitle} />{children}</>;
  if (variant === "ink") {
    return (
      <Box style={styles.ink} padding={padding}>
        <ThemeProvider theme={darkTheme}><Inner>{content}</Inner></ThemeProvider>
      </Box>
    );
  }
  if (variant === "plain") return <Box style={styles.plain} padding={padding}>{content}</Box>;
  if (variant === "tinted") return <Box style={styles.tinted} padding={padding}>{content}</Box>;
  return <Panel variant="card" style={styles.card} padding={padding}>{content}</Panel>;
}

/** A card's title and subtitle, drawn in the theme of the card they head. */
function CardHead({ title, subtitle }: { title: unknown; subtitle: unknown }) {
  const styles = useStyles();
  const hasTitle = title !== undefined && title !== null && title !== "";
  const hasSubtitle = subtitle !== undefined && subtitle !== null && subtitle !== "";
  if (!hasTitle && !hasSubtitle) return null;
  return (
    <Box style={styles.head}>
      {hasTitle && <Text style={styles.cardTitle}>{text(title)}</Text>}
      {hasSubtitle && <Text style={styles.cardSubtitle}>{text(subtitle)}</Text>}
    </Box>
  );
}

/** Children in a column: what a themed part of a card holds. */
function Inner({ children }: { children?: ReactNode }) {
  return <Box flexDirection="column" gap={rowGap} alignSelf="stretch">{children}</Box>;
}

function Grid({ props, children }: Rendered) {
  const columns = Math.max(1, Math.round(number(props.columns, 2)));
  const gap = gapOf(props.gap, 8);
  const cells = Children.toArray(children);
  const rows: ReactNode[][] = [];
  for (let index = 0; index < cells.length; index += columns) rows.push(cells.slice(index, index + columns));
  return (
    <Box flexDirection="column" gap={gap} alignSelf="stretch">
      {rows.map((row, index) => (
        <Box key={index} flexDirection="row" gap={gap} alignItems="stretch">
          {Array.from({ length: columns }, (_, column) => (
            <Box key={column} flexGrow={1} flexBasis={0} flexDirection="column">{row[column] ?? null}</Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

const headingSizes = { 1: 22, 2: 17, 3: 14 } as const;

function Heading({ props }: Rendered) {
  const { colors, font } = useTheme();
  const level = Math.min(Math.max(Math.round(number(props.level, 2)), 1), 3) as 1 | 2 | 3;
  return <Text font={font} size={headingSizes[level]} weight={level === 3 ? 650 : 700} color={colors.ink}>
    {text(props.text)}
  </Text>;
}

const textSizes: Record<string, number> = { sm: 12, md: 13, lg: 15, xl: 19, "2xl": 30, "3xl": 46 };

// Text is placed by layout, which keeps it on whole pixels, rather than aligned
// inside its box by Pango, which can leave its glyphs between pixels and blurred.
// Pango's alignment is left for long text, whose lines wrap: a box sized by layout
// is rounded up to a whole pixel, and aligning within it shifts by the remainder.
const selfAlign: Record<string, TextProps["alignSelf"]> = { center: "center", end: "flex-end" };
const weights: Record<string, number> = { regular: 450, medium: 600, bold: 700 };

function TextElement({ props }: Rendered) {
  const styles = useStyles();
  // A display size is one big figure, in ink even when mono (whose small text is soft, like code).
  const display = props.size === "2xl" || props.size === "3xl";
  const color = toneColor(styles.theme, props.tone) ?? (display ? String(styles.theme.colors.ink) : undefined);
  const lines = props.maxLines === undefined || props.maxLines === null ? undefined : number(props.maxLines, 1);
  const words = text(props.text);
  return (
    <Text style={[props.mono ? styles.mono : styles.body]} color={color} size={textSizes[text(props.size)]}
          weight={weights[text(props.weight)]} maxLines={lines} alignSelf={selfAlign[text(props.align)]}
          align={words.length > 48 && lines !== 1 ? props.align as TextProps["align"] : undefined}>
      {words}
    </Text>
  );
}

function Markdown({ props }: Rendered) {
  return <MarkdownView text={text(props.text)} />;
}

/** Markdown drawn as Text nodes in a column: `<MarkdownView text={reply} />`. */
export const MarkdownView = memo(function MarkdownView({ text: source, style }: { text: string; style?: TextProps["style"] }) {
  const styles = useStyles();
  const { colors, font } = useTheme();
  const blocks = markdownBlocks(source, { accent: String(colors.accent).slice(0, 7), code: String(colors.ink).slice(0, 7) });
  return (
    <Box flexDirection="column" gap={7} alignSelf="stretch">
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "paragraph":
            return <Text key={index} markup style={[styles.body, style]}>{block.markup}</Text>;
          case "heading":
            return <Text key={index} markup font={font} size={block.level === 1 ? 18 : block.level === 2 ? 15 : 13}
                         weight={700} color={colors.ink}>{block.markup}</Text>;
          case "list":
            return (
              <Box key={index} flexDirection="column" gap={3} alignSelf="stretch">
                {block.items.map((item, at) => (
                  <Box key={at} flexDirection="row" gap={6} paddingLeft={item.depth * 14} alignSelf="stretch">
                    <Text style={[styles.body, style]} color={colors.muted}>{item.marker}</Text>
                    <Text markup style={[styles.body, style]} flexShrink={1} flexGrow={1}>{item.markup}</Text>
                  </Box>
                ))}
              </Box>
            );
          case "quote":
            return (
              <Box key={index} flexDirection="row" gap={8} alignSelf="stretch">
                <Rect style={styles.quoteBar} />
                <Text markup style={[styles.body, style]} color={colors.muted} italic flexShrink={1} flexGrow={1}>{block.markup}</Text>
              </Box>
            );
          case "code":
            return (
              <Box key={index} style={styles.code}>
                <Text style={styles.mono}>{block.text || " "}</Text>
              </Box>
            );
          case "rule":
            return <Hairline key={index} />;
        }
      })}
    </Box>
  );
});

function Badge({ props }: Rendered) {
  const styles = useStyles();
  const color = toneColor(styles.theme, props.tone ?? "accent") ?? String(styles.theme.colors.muted);
  return (
    <Box style={styles.badge} fill={`${color.slice(0, 7)}24`}>
      <Text style={styles.badgeText} color={color} maxLines={1}>{text(props.text)}</Text>
    </Box>
  );
}

function Metric({ props }: Rendered) {
  const styles = useStyles();
  const { colors } = styles.theme;
  const trend = text(props.trend);
  const trendColor = toneColor(styles.theme, trend === "up" ? "success" : trend === "down" ? "danger" : "muted");
  const unit = props.unit === undefined || props.unit === null || props.unit === "" ? null : text(props.unit);
  return (
    <Box style={styles.column}>
      <Text style={styles.label} maxLines={1}>{text(props.label)}</Text>
      {/* The unit is part of the value's line, so it sits on its baseline. */}
      <Text style={styles.metricValue} maxLines={1}>
        {text(props.value)}
        {unit !== null && <Text size={14} weight={600} color={colors.muted}>{` ${unit}`}</Text>}
      </Text>
      {props.delta !== undefined && props.delta !== null && (
        <Text style={styles.label} color={trendColor} maxLines={1}>
          {`${trend === "up" ? "▲ " : trend === "down" ? "▼ " : ""}${text(props.delta)}`}
        </Text>
      )}
      {props.caption !== undefined && props.caption !== null && <Text style={styles.label}>{text(props.caption)}</Text>}
    </Box>
  );
}

function KeyValue({ props }: Rendered) {
  const styles = useStyles();
  return (
    <Box style={styles.row} justifyContent="space-between">
      <Text style={styles.body} color={styles.theme.colors.muted} maxLines={1} flexShrink={1}>{text(props.label)}</Text>
      <Text style={styles.body} weight={650} color={toneColor(styles.theme, props.tone) ?? styles.theme.colors.ink}
            maxLines={1} flexShrink={1}>{text(props.value)}</Text>
    </Box>
  );
}

function ProgressBar({ props }: Rendered) {
  const styles = useStyles();
  const raw = props.value === null || props.value === undefined ? null : number(props.value, 0);
  const value = raw === null ? null : raw > 1 ? raw / 100 : raw;
  const label = props.label === undefined || props.label === null ? "" : text(props.label);
  const percent = props.showValue === true && value !== null ? `${Math.round(value * 100)}%` : "";
  return (
    <Box style={styles.labelled}>
      {Boolean(label || percent) && (
        <Box style={styles.row} justifyContent="space-between">
          <Text style={styles.body} maxLines={1} flexShrink={1}>{label}</Text>
          {percent && <Text style={styles.value}>{percent}</Text>}
        </Box>
      )}
      <Progress value={value} color={toneColor(styles.theme, props.tone)} />
    </Box>
  );
}

function List({ props, children }: Rendered) {
  const styles = useStyles();
  const items = Children.toArray(children);
  return (
    <Box flexDirection="column" alignSelf="stretch">
      {items.map((item, index) => (
        <Box key={index} flexDirection="column" alignSelf="stretch">
          {index > 0 && props.dividers !== false && <Hairline style={{ marginY: 0 }} />}
          <Box style={styles.listRow}>{item}</Box>
        </Box>
      ))}
    </Box>
  );
}

/** A short leading mark: an emoji as it is, a word as its initial in a circle. */
function Leading({ mark }: { mark: string }) {
  const { colors, font } = useTheme();
  if ([...mark].length <= 2 && !/^[\p{L}\p{N}]/u.test(mark)) return <Text size={18}>{mark}</Text>;
  return (
    <Box width={30} height={30} radius={15} fill={colors.accentSoft} alignItems="center" justifyContent="center">
      <Text font={font} size={12} weight={700} color={colors.accent}>{initials(mark)}</Text>
    </Box>
  );
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words.length > 1 ? words[words.length - 1]![0] : "")).toUpperCase() || "?";
}

function ListItem({ props, emit, listens }: Rendered) {
  const styles = useStyles();
  const content = (
    <>
      {props.leading !== undefined && props.leading !== null && <Leading mark={text(props.leading)} />}
      <Box flexDirection="column" gap={1} flexGrow={1} flexShrink={1} flexBasis={0}>
        <Text style={styles.body} weight={650} color={styles.theme.colors.ink} maxLines={1}>{text(props.title)}</Text>
        {props.subtitle !== undefined && props.subtitle !== null && (
          <Text style={styles.body} size={12} color={styles.theme.colors.muted} maxLines={2}>{text(props.subtitle)}</Text>
        )}
      </Box>
      {props.trailing !== undefined && props.trailing !== null && (
        <Text style={styles.value} size={12} maxLines={1}>{text(props.trailing)}</Text>
      )}
    </>
  );
  if (!listens("press")) return <Box style={styles.item} fill={props.selected ? styles.selected : undefined}>{content}</Box>;
  return (
    <Pressable onPress={() => emit("press")}
               style={({ hovered, pressed }) => [styles.item,
                 { fill: props.selected ? styles.selected : pressed || hovered ? styles.hover : styles.theme.colors.clear }]}>
      {content}
    </Pressable>
  );
}

interface Column {
  key: string;
  label: string;
  align: "start" | "end";
}

function Table({ props }: Rendered) {
  const styles = useStyles();
  const columns: Column[] = (Array.isArray(props.columns) ? props.columns : []).map((column, index) =>
    typeof column === "object" && column !== null
      ? { key: text((column as Record<string, unknown>).key, String(index)), label: text((column as Record<string, unknown>).label),
          align: (column as Record<string, unknown>).align === "end" ? "end" : "start" }
      : { key: String(index), label: text(column), align: "start" });
  const rows = (Array.isArray(props.rows) ? props.rows : []).map((row) =>
    Array.isArray(row) ? row : columns.map((column) => (row as Record<string, unknown>)?.[column.key]));
  // Columns of numbers line up on the right.
  const numeric = columns.map((column, index) =>
    column.align === "end" || (rows.length > 0 && rows.every((row) => typeof row[index] === "number")));
  return (
    <Box flexDirection="column" alignSelf="stretch">
      <Box style={styles.row} paddingBottom={6}>
        {columns.map((column, index) => (
          <Box key={index} style={styles.cell}>
            <Text style={styles.label} maxLines={1} alignSelf={numeric[index] ? "flex-end" : undefined}>{column.label}</Text>
          </Box>
        ))}
      </Box>
      {rows.map((row, index) => (
        <Box key={index} flexDirection="column" alignSelf="stretch">
          <Hairline style={{ marginY: 0 }} />
          <Box style={styles.row} paddingY={6}>
            {columns.map((_, at) => (
              <Box key={at} style={styles.cell}>
                <Text style={styles.body} maxLines={2} alignSelf={numeric[at] ? "flex-end" : undefined}>{text(row[at])}</Text>
              </Box>
            ))}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

function BarChart({ props }: Rendered) {
  const styles = useStyles();
  const data = (Array.isArray(props.data) ? props.data : []).map((datum) => {
    const entry = (datum ?? {}) as Record<string, unknown>;
    return { label: text(entry.label), value: number(entry.value, 0), color: typeof entry.color === "string" ? entry.color : undefined };
  });
  const most = Math.max(...data.map((datum) => Math.abs(datum.value)), 0) || 1;
  const unit = props.unit ? ` ${text(props.unit)}` : "";
  const accent = styles.theme.colors.accent;
  if (props.orientation === "vertical") {
    const height = number(props.height, 120);
    return (
      <Box flexDirection="column" gap={4} alignSelf="stretch">
        <Box flexDirection="row" height={height} gap={6} alignItems="flex-end">
          {data.map((datum, index) => (
            <Box key={index} flexGrow={1} flexBasis={0} height="100%" flexDirection="column" justifyContent="flex-end">
              <Rect radius={4} fill={datum.color ?? accent} height={Math.max(2, (Math.abs(datum.value) / most) * height)}
                    transition={styles.theme.motion.glide} />
            </Box>
          ))}
        </Box>
        <Box flexDirection="row" gap={6}>
          {data.map((datum, index) => (
            <Box key={index} flexGrow={1} flexBasis={0}>
              <Text style={styles.label} maxLines={1} alignSelf="center">{datum.label}</Text>
            </Box>
          ))}
        </Box>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" gap={6} alignSelf="stretch">
      {data.map((datum, index) => (
        <Box key={index} style={styles.row}>
          <Text style={styles.body} size={12} maxLines={1} width="28%">{datum.label}</Text>
          <Box style={styles.track}>
            <Rect style={styles.bar} fill={datum.color ?? accent} width={`${Math.max(2, (Math.abs(datum.value) / most) * 100)}%`} />
          </Box>
          <Box width={64} flexDirection="row" justifyContent="flex-end">
            <Text style={styles.label} maxLines={1}>{`${formatNumber(datum.value)}${unit}`}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}

function formatNumber(value: number): string {
  if (Math.abs(value) >= 10000) return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
  return Number.isInteger(value) ? String(value) : value.toFixed(Math.abs(value) < 10 ? 2 : 1);
}

function Sparkline({ props }: Rendered) {
  const styles = useStyles();
  const values = (Array.isArray(props.values) ? props.values : []).map((value) => number(value, 0)).slice(-60);
  const height = number(props.height, 32);
  // A fixed scale when given (a percentage's 0 to 100), else the series' own.
  const low = props.min === null || props.min === undefined ? Math.min(...values, 0) : number(props.min, 0);
  const high = props.max === null || props.max === undefined ? Math.max(...values, 0) : number(props.max, 1);
  const span = high - low || 1;
  const color = toneColor(styles.theme, props.tone ?? "accent");
  // It takes the room it is given, in a row as in a column.
  return (
    <Box flexDirection="row" height={height} gap={2} alignItems="flex-end" alignSelf="stretch" flexGrow={1} minWidth={60}>
      {values.map((value, index) => (
        <Rect key={index} flexGrow={1} flexBasis={0} radius={1.5} fill={color}
              opacity={index === values.length - 1 ? 1 : 0.55} height={Math.max(2, Math.min(1, (value - low) / span) * height)} />
      ))}
    </Box>
  );
}

const imageFolder = join(process.env.XDG_RUNTIME_DIR || tmpdir(), "proscenium-genui-images");

/** SRC as a file the compositor can open: an absolute path as it is, an https URL fetched once. */
function useImageFile(src: string): string | null {
  const local = src.startsWith("/") ? src : null;
  const [file, setFile] = useState<string | null>(local);
  useEffect(() => {
    if (local || !/^https:\/\//.test(src)) return;
    const name = createHash("sha1").update(src).digest("hex") + (/\.(png|jpe?g|webp|gif|svg|avif)(\?|$)/i.exec(src)?.[0]?.replace(/\?$/, "") ?? "");
    const path = join(imageFolder, name);
    if (existsSync(path)) return void setFile(path);
    let live = true;
    fetch(src, { signal: AbortSignal.timeout(15000) }).then(async (response) => {
      if (!response.ok) throw new Error(String(response.status));
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > 20_000_000) throw new Error("too large");
      mkdirSync(imageFolder, { recursive: true });
      writeFileSync(path, bytes);
      if (live) setFile(path);
    }).catch(() => {});
    return () => { live = false; };
  }, [src]);
  return file;
}

function ImageElement({ props }: Rendered) {
  const file = useImageFile(text(props.src));
  const width = props.width === null || props.width === undefined ? undefined : number(props.width, 0);
  const height = props.height === null || props.height === undefined ? (width ? undefined : 160) : number(props.height, 160);
  const { colors } = useTheme();
  if (!file) return <Box width={width ?? "100%"} height={height ?? 160} radius={number(props.radius, 8)} fill={colors.hover} />;
  return <Image src={file} width={width ?? "100%"} height={height} fit={props.fit === "contain" ? "contain" : "cover"}
                radius={number(props.radius, 8)} />;
}

function Code({ props }: Rendered) {
  const styles = useStyles();
  let words = text(props.text);
  // With maxLines, the end of it: output that grows keeps its newest lines in view.
  const keep = props.maxLines === undefined || props.maxLines === null ? 0 : Math.max(1, Math.round(number(props.maxLines, 1)));
  if (keep) {
    const lines = words.replace(/\n$/, "").split("\n");
    if (lines.length > keep) words = lines.slice(-keep).join("\n");
  }
  return (
    <Box style={styles.code}>
      <Text style={styles.mono}>{words || " "}</Text>
    </Box>
  );
}

const mono = "Noto Sans Mono, monospace";

/** A file's change, or a unified diff's files: numbered lines, removals and additions tinted, unchanged runs folded. */
function DiffElement({ props }: Rendered) {
  const styles = useStyles();
  const { colors } = styles.theme;
  const patch = props.patch === undefined || props.patch === null ? "" : text(props.patch);
  const before = props.before === undefined || props.before === null ? "" : text(props.before);
  const after = props.after === undefined || props.after === null ? "" : text(props.after);
  const path = props.path === undefined || props.path === null ? undefined : text(props.path);
  const startLine = Math.max(1, Math.round(number(props.startLine, 1)));
  const files = useMemo<DiffFile[]>(() => {
    const found = patch ? parsePatch(patch) : [diffTexts(before, after, { path, startLine })];
    if (path && found.length === 1 && !found[0]!.path) found[0]!.path = path;
    return found;
  }, [patch, before, after, path, startLine]);
  // Cards scroll inside their frames, so a long diff can show in full.
  const limit = Math.max(4, Math.round(number(props.maxLines, 200)));
  const added = String(toneColor(styles.theme, "success")).slice(0, 7);
  const removed = String(colors.danger).slice(0, 7);
  // Wide enough for the biggest line number, in a face whose digits are one width.
  const most = Math.max(0, ...files.flatMap((file) => file.hunks.flatMap((hunk) => hunk.lines.map((line) => Math.max(line.old ?? 0, line.new ?? 0)))));
  const digits = String(most).length;
  // A patch that numbers no lines (Codex's) has no gutter for them.
  const numbered = most > 0;
  let shown = 0;
  let hidden = 0;
  const row = (line: DiffLine, key: string) => {
    if (shown >= limit) {
      hidden++;
      return null;
    }
    shown++;
    const tint = line.kind === "added" ? added : line.kind === "removed" ? removed : undefined;
    const numbers = `${line.old === undefined ? "".padStart(digits) : String(line.old).padStart(digits)} ${line.new === undefined ? "".padStart(digits) : String(line.new).padStart(digits)}`;
    return (
      <Box key={key} flexDirection="row" alignSelf="stretch" fill={tint ? `${tint}1f` : undefined} paddingX={8} gap={8}>
        {numbered && <Text font={mono} size={11} lineHeight={1.4} color={colors.faint} flexShrink={0}>{numbers}</Text>}
        <Text font={mono} size={11} lineHeight={1.4} color={tint ?? colors.faint} weight={700} flexShrink={0}>
          {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
        </Text>
        {/* A column of its own, measured at the width left, so a long line wraps and the row grows with it. */}
        <Box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0}>
          <Text font={mono} size={11} lineHeight={1.4} color={line.kind === "same" ? colors.muted : colors.ink}
                maxLines={4}>{line.text || " "}</Text>
        </Box>
      </Box>
    );
  };
  const fold = (label: string, key: string) => (
    <Box key={key} flexDirection="row" alignSelf="stretch" fill={colors.hover} paddingX={8} paddingY={2}>
      <Text font={mono} size={11} lineHeight={1.4} color={colors.faint} maxLines={1} flexShrink={1}>{label}</Text>
    </Box>
  );
  return (
    <Box flexDirection="column" gap={8} alignSelf="stretch">
      {files.map((file, at) => (
        <Box key={at} flexDirection="column" alignSelf="stretch" radius={styles.theme.radii.sm} clip
             border={{ width: 1, color: colors.line }}>
          {(file.path || file.added || file.removed) ? (
            <Box flexDirection="row" alignItems="center" gap={8} paddingX={10} paddingY={6} alignSelf="stretch"
                 fill={colors.hover}>
              <Text font={mono} size={12} weight={600} color={colors.ink} maxLines={1} flexShrink={1} flexGrow={1}>
                {file.path ?? ""}
              </Text>
              <Text font={styles.theme.type.body.font} size={12} weight={650} color={added} flexShrink={0}>{`+${file.added}`}</Text>
              <Text font={styles.theme.type.body.font} size={12} weight={650} color={removed} flexShrink={0}>{`−${file.removed}`}</Text>
            </Box>
          ) : null}
          {file.hunks.length === 0 && fold("No changes", "none")}
          {file.hunks.map((hunk, index) => (
            <Box key={index} flexDirection="column" alignSelf="stretch">
              {(hunk.skipped || (index > 0 && hunk.context)) && shown < limit
                ? fold(`⋯ ${hunk.skipped ? `${hunk.skipped} unchanged line${hunk.skipped === 1 ? "" : "s"}` : ""}${hunk.context ? `  ${hunk.context}` : ""}`, "fold")
                : null}
              {hunk.lines.map((line, number) => row(line, String(number)))}
            </Box>
          ))}
        </Box>
      ))}
      {hidden > 0 && <Text style={styles.label}>{`${hidden} more line${hidden === 1 ? "" : "s"}`}</Text>}
    </Box>
  );
}

interface Choice {
  value: string;
  label: string;
  description?: string;
  badge?: string;
}

/** Answers to pick from: one like radio buttons, or any number with `multiple`. */
function ChoicesElement(rendered: Rendered) {
  const styles = useStyles();
  const { colors } = styles.theme;
  const multiple = rendered.props.multiple === true;
  const options: Choice[] = (Array.isArray(rendered.props.options) ? rendered.props.options : []).map((option) => {
    if (typeof option !== "object" || option === null) return { value: text(option), label: text(option) };
    const entry = option as Record<string, unknown>;
    const label = text(entry.label ?? entry.value);
    const optional = (value: unknown) => (value === undefined || value === null || value === "" ? undefined : text(value));
    return { value: text(entry.value ?? label), label, description: optional(entry.description), badge: optional(entry.badge) };
  });
  const [value, setValue] = useValue<unknown>(rendered, "value", multiple ? [] : null);
  const chosen = new Set(Array.isArray(value) ? value.map((each) => text(each))
    : value === undefined || value === null || value === "" ? [] : [text(value)]);
  const pick = (option: Choice) => {
    if (multiple) {
      const next = new Set(chosen);
      if (next.has(option.value)) next.delete(option.value);
      else next.add(option.value);
      setValue(options.filter((each) => next.has(each.value)).map((each) => each.value));
    } else {
      setValue(option.value);
    }
    rendered.emit("change");
  };
  return (
    <Box flexDirection="column" gap={6} alignSelf="stretch">
      {options.map((option, index) => {
        const selected = chosen.has(option.value);
        return (
          <Pressable key={`${index}:${option.value}`} onPress={() => pick(option)}
                     style={({ hovered, pressed }) => [styles.choice, {
                       fill: selected ? colors.accentSoft : pressed ? colors.press : hovered ? colors.hover : colors.clear,
                       border: { width: 1, color: selected ? colors.accentLine : colors.line },
                     }]}>
            <Box paddingTop={1}><ChoiceMark selected={selected} multiple={multiple} /></Box>
            <Box flexDirection="column" gap={2} flexGrow={1} flexShrink={1} flexBasis={0}>
              <Text style={styles.body} weight={650} color={colors.ink}>{option.label}</Text>
              {option.description !== undefined && (
                <Text style={styles.body} size={12} color={colors.muted}>{option.description}</Text>
              )}
            </Box>
            {option.badge !== undefined && (
              <Box style={styles.badge} fill={`${String(colors.accent).slice(0, 7)}24`}>
                <Text style={styles.badgeText} color={colors.accent} maxLines={1}>{option.badge}</Text>
              </Box>
            )}
          </Pressable>
        );
      })}
    </Box>
  );
}

/** A radio's dot or a checkbox's tick, 18 pixels across. */
function ChoiceMark({ selected, multiple }: { selected: boolean; multiple: boolean }) {
  const styles = useStyles();
  const { colors, motion } = styles.theme;
  if (multiple) {
    return (
      <Box width={18} height={18} radius={5} transition={motion.pop} fill={selected ? colors.accent : colors.clear}
           border={{ width: selected ? 1 : 1.5, color: selected ? colors.accent : colors.control }}>
        <Tick shown={selected} />
      </Box>
    );
  }
  return (
    <Box width={18} height={18} radius={9} alignItems="center" justifyContent="center" transition={motion.pop}
         fill={selected ? colors.accent : colors.clear}
         border={{ width: selected ? 1 : 1.5, color: selected ? colors.accent : colors.control }}>
      <Rect width={6} height={6} radius={3} fill={colors.onAccent} opacity={selected ? 1 : 0} transition={motion.pop} />
    </Box>
  );
}

/** A tick in an 18-pixel box, drawn as two strokes so it sits in the middle whatever the font. */
function Tick({ shown, color }: { shown: boolean; color?: string }) {
  const styles = useStyles();
  const fill = color ?? styles.theme.colors.onAccent;
  return (
    <Box position="absolute" x={0} y={0} width={18} height={18} opacity={shown ? 1 : 0} transition={styles.theme.motion.pop}>
      <Rect position="absolute" x={3.9} y={10.1} width={4.8} height={2} radius={1} fill={fill} transform={tickShort} />
      <Rect position="absolute" x={5.4} y={7.9} width={9.4} height={2} radius={1} fill={fill} transform={tickLong} />
    </Box>
  );
}

const tickShort = rotate(45);
const tickLong = rotate(-47);
const crossOne = rotate(45);
const crossTwo = rotate(-45);

type StepStatus = "pending" | "active" | "done" | "failed" | "skipped";

/** A status as models and agents write it: TodoWrite's in_progress and completed, and the like. */
function stepStatus(value: unknown): StepStatus {
  const status = text(value).toLowerCase().replace(/[\s-]+/g, "_");
  if (["done", "completed", "complete", "success", "succeeded", "finished", "passed"].includes(status)) return "done";
  if (["active", "in_progress", "running", "current", "doing", "working", "started"].includes(status)) return "active";
  if (["failed", "error", "failure", "blocked"].includes(status)) return "failed";
  if (["skipped", "cancelled", "canceled", "deleted"].includes(status)) return "skipped";
  return "pending";
}

const breathe = { opacity: [0.35, 1, 0.35], duration: 1.4, iterations: Infinity };

/** A plan as a timeline: each step's mark, a line down to the next, its title and detail. */
function StepsElement({ props }: Rendered) {
  const styles = useStyles();
  const { colors } = styles.theme;
  const success = String(toneColor(styles.theme, "success"));
  const items = (Array.isArray(props.items) ? props.items : []).map((item) => {
    const entry = (typeof item === "object" && item !== null ? item : { title: item }) as Record<string, unknown>;
    const detail = entry.detail ?? entry.activeForm;
    return { title: text(entry.title ?? entry.content ?? entry.subject), status: stepStatus(entry.status),
             detail: detail === undefined || detail === null || detail === "" ? undefined : text(detail) };
  });
  return (
    <Box flexDirection="column" alignSelf="stretch">
      {items.map((item, index) => {
        const last = index === items.length - 1;
        const active = item.status === "active";
        return (
          <Box key={index} flexDirection="row" gap={10} alignSelf="stretch">
            <Box width={18} flexDirection="column" alignItems="center">
              <StepMark status={item.status} />
              {!last && <Rect width={2} flexGrow={1} minHeight={6} radius={1} marginTop={3} marginBottom={3}
                              fill={item.status === "done" ? `${success.slice(0, 7)}66` : colors.line} />}
            </Box>
            <Box flexDirection="column" gap={1} flexGrow={1} flexShrink={1} flexBasis={0} paddingBottom={last ? 0 : 10}>
              <Text style={styles.body} weight={active ? 650 : 500} lineHeight={1.38}
                    color={active ? colors.ink : item.status === "pending" ? colors.soft : colors.muted}>{item.title}</Text>
              {item.detail !== undefined && (active || item.status === "failed") && (
                <Text style={styles.body} size={12} color={item.status === "failed" ? colors.danger : colors.muted}>{item.detail}</Text>
              )}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

function StepMark({ status }: { status: StepStatus }) {
  const styles = useStyles();
  const { colors, motion } = styles.theme;
  const success = String(toneColor(styles.theme, "success"));
  const base = { width: 18, height: 18, radius: 9, transition: motion.pop } as const;
  switch (status) {
    case "done":
      return <Box {...base} fill={success}><Tick shown color={String(colors.onAccent)} /></Box>;
    case "active":
      return (
        <Box {...base} alignItems="center" justifyContent="center" border={{ width: 2, color: colors.accent }}>
          <Rect width={8} height={8} radius={4} fill={colors.accent} animate={breathe} />
        </Box>
      );
    case "failed":
      return (
        <Box {...base} fill={colors.danger}>
          <Rect position="absolute" x={4} y={8} width={10} height={2} radius={1} fill={colors.onAccent} transform={crossOne} />
          <Rect position="absolute" x={4} y={8} width={10} height={2} radius={1} fill={colors.onAccent} transform={crossTwo} />
        </Box>
      );
    case "skipped":
      return (
        <Box {...base} alignItems="center" justifyContent="center" border={{ width: 1.5, color: colors.line }}>
          <Rect width={8} height={2} radius={1} fill={colors.faint} />
        </Box>
      );
    default:
      return <Box {...base} border={{ width: 1.5, color: colors.control }} />;
  }
}

function Avatar({ props }: Rendered) {
  const { colors, font } = useTheme();
  const size = number(props.size, 36);
  return (
    <Box width={size} height={size} radius={size / 2} fill={colors.accentSoft} alignItems="center" justifyContent="center">
      <Text font={font} size={Math.round(size * 0.38)} weight={700} color={colors.accent}>{initials(text(props.name))}</Text>
    </Box>
  );
}

function DividerElement() {
  return <Hairline />;
}

function SpacerElement() {
  return <Spacer />;
}

function ButtonElement({ props, emit }: Rendered) {
  const { colors } = useTheme();
  const danger = props.variant === "danger";
  const variant = danger ? "filled" : props.variant === "filled" || props.variant === "tinted" ? props.variant : "plain";
  const button = (
    <Button label={text(props.label)} variant={variant} size={props.size === "small" ? "small" : "medium"}
            disabled={props.disabled === true} onPress={() => emit("press")} flexGrow={props.block === true ? 1 : undefined}
            style={danger ? ({ hovered, pressed }) => ({ fill: colors.danger, opacity: pressed ? 0.8 : hovered ? 0.92 : 1 }) : undefined} />
  );
  // As wide as its words, in a column as in a row, unless it is a block.
  return <Box flexDirection="row" alignSelf={props.block === true ? "stretch" : undefined}>{button}</Box>;
}

/** A labelled control's caption above it. */
function Caption({ label }: { label: unknown }) {
  const styles = useStyles();
  if (label === undefined || label === null || label === "") return null;
  return <Text style={styles.label} maxLines={1}>{text(label)}</Text>;
}

/**
 * Where the renderer keeps an element's own state inside its interface's state:
 * the value of an input the spec binds to nothing, a countdown's clock. There it
 * outlives the element's node (moves between modes, reloads), and reaches the
 * interface's owner with its actions and state like any other value.
 */
export function ownStatePath(name: string, part: string): string {
  return `/_ui/${name.replace(/~/g, "~0").replace(/\//g, "~1")}/${part}`;
}

/** A value bound to state, or kept in the interface's own state when the spec binds it to nothing. */
function useValue<T>(rendered: Rendered, prop: string, fallback: T): [T, (value: T) => void] {
  const bound = rendered.bound(prop);
  const given = rendered.props[prop] as T | undefined | null;
  if (bound) return [given ?? fallback, bound as (value: T) => void];
  const path = ownStatePath(rendered.name, prop);
  const own = rendered.store.get(path) as T | undefined;
  return [own ?? given ?? fallback, (value) => rendered.store.set(path, value)];
}

function TextFieldElement(rendered: Rendered) {
  const styles = useStyles();
  const { props, emit } = rendered;
  const [value, setValue] = useValue(rendered, "value", "");
  return (
    <Box style={styles.labelled}>
      <Caption label={props.label} />
      <Field value={text(value)} placeholder={props.placeholder ? text(props.placeholder) : undefined}
             multiline={props.multiline === true}
             onChangeText={(next) => { setValue(next); emit("change"); }}
             onSubmit={() => emit("submit")} />
    </Box>
  );
}

function SwitchElement(rendered: Rendered) {
  const styles = useStyles();
  const [checked, setChecked] = useValue(rendered, "checked", false);
  return (
    <Box style={styles.row}>
      <Text style={styles.body} flexGrow={1} flexShrink={1}>{text(rendered.props.label)}</Text>
      <SwitchControl value={checked === true} onValueChange={(next) => { setChecked(next); rendered.emit("change"); }} />
    </Box>
  );
}

function CheckboxElement(rendered: Rendered) {
  const [checked, setChecked] = useValue(rendered, "checked", false);
  return <Checkbox value={checked === true} label={rendered.props.label ? text(rendered.props.label) : undefined}
                   onValueChange={(next) => { setChecked(next); rendered.emit("change"); }} />;
}

function SliderElement(rendered: Rendered) {
  const styles = useStyles();
  const { props, emit } = rendered;
  const min = number(props.min, 0);
  const max = number(props.max, min < 1 ? 1 : 100);
  const [value, setValue] = useValue(rendered, "value", min);
  const [box, setBox] = useState<LayoutBox | null>(null);
  const step = props.step === null || props.step === undefined ? undefined : number(props.step, 0) || undefined;
  return (
    <Box style={styles.labelled} onLayout={setBox}>
      {Boolean(props.label || props.showValue !== false) && (
        <Box style={styles.row} justifyContent="space-between">
          <Text style={styles.body} maxLines={1} flexShrink={1}>{text(props.label)}</Text>
          {props.showValue !== false && <Text style={styles.value}>{formatNumber(number(value, min))}</Text>}
        </Box>
      )}
      <SliderControl value={number(value, min)} min={min} max={max} step={step} width={Math.max(60, box?.width ?? 200)}
                     onValueChange={(next) => { setValue(next); emit("change"); }} />
    </Box>
  );
}

function Tabs(rendered: Rendered) {
  const options = (Array.isArray(rendered.props.options) ? rendered.props.options : []).map((option) =>
    typeof option === "object" && option !== null
      ? { value: text((option as Record<string, unknown>).value), label: text((option as Record<string, unknown>).label) }
      : { value: text(option), label: text(option) });
  const [value, setValue] = useValue(rendered, "value", options[0]?.value ?? "");
  return (
    <Box flexDirection="row" alignSelf="flex-start">
      <SegmentedControl options={options} value={text(value)} onChange={(next) => { setValue(next); rendered.emit("change"); }} />
    </Box>
  );
}

const countdownSizes: Record<string, number> = { md: 18, lg: 30, xl: 46 };

function clockFace(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`;
}

/** A countdown's clock, kept in its interface's state so it runs on wherever the interface moves. */
interface Clock {
  /** The `seconds` it counts from, to start over when that changes. */
  from: number;
  /** When it ends, while running; else what is left. */
  endsAt: number | null;
  left: number;
  /** It reached zero and said so. */
  done?: boolean;
}

function Countdown({ props, emit, name, store }: Rendered) {
  const { colors } = useTheme();
  const until = props.until === null || props.until === undefined ? null
    : typeof props.until === "number" ? props.until : Date.parse(text(props.until));
  const seconds = number(props.seconds, 0);
  const running = props.running !== false;
  const path = ownStatePath(name, "clock");
  const kept = store.get(path) as Clock | undefined;
  const clock: Clock = kept && kept.from === seconds ? kept
    : { from: seconds, left: seconds, endsAt: running ? Date.now() + seconds * 1000 : null };
  const [, tick] = useState(0);
  useEffect(() => {
    let next = clock;
    if (running && next.endsAt === null) next = { ...next, endsAt: Date.now() + next.left * 1000 };
    if (!running && next.endsAt !== null) next = { ...next, left: Math.max(0, (next.endsAt - Date.now()) / 1000), endsAt: null };
    if (next !== kept) store.set(path, next);
  });
  const end = until !== null && Number.isFinite(until) ? until : clock.endsAt;
  const remaining = end === null ? clock.left : Math.max(0, (end - Date.now()) / 1000);
  useEffect(() => {
    if (end === null || remaining <= 0) return;
    // Wake at the next whole second.
    const timer = setTimeout(() => tick((count) => count + 1), (remaining % 1) * 1000 + 15 || 1000);
    return () => clearTimeout(timer);
  });
  useEffect(() => {
    if (remaining > 0 || end === null || store.get(`${path}/done`) === true) return;
    store.set(path, { ...clock, endsAt: until === null ? null : clock.endsAt, left: 0, done: true });
    emit("done");
  });
  return (
    <Text font="Noto Sans Mono, monospace" size={countdownSizes[text(props.size)] ?? 30} weight={700}
          color={remaining <= 0 && end !== null ? colors.danger : colors.ink}>{clockFace(remaining)}</Text>
  );
}

const components: Record<string, Drawn> = {
  Stack, Card, Grid, Heading, Text: TextElement, Markdown, Badge, Metric, KeyValue, ProgressBar, List, ListItem, Table,
  BarChart, Sparkline, Image: ImageElement, Code, Avatar, Divider: DividerElement, Spacer: SpacerElement,
  Button: ButtonElement, TextField: TextFieldElement, Switch: SwitchElement, Checkbox: CheckboxElement,
  Slider: SliderElement, Tabs, Countdown, Diff: DiffElement, Choices: ChoicesElement, Steps: StepsElement,
};

/** The component types the renderer draws. */
export const componentNames = Object.keys(components);
