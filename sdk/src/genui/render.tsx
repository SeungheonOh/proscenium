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
import { Children, Component, createContext, memo, useContext, useEffect, useRef, useState, useSyncExternalStore,
  type ReactNode } from "react";
import { evaluateVisibility, getByPath, resolveActionParam, resolveBindings, resolveElementProps,
  resolveRepeatStatePath, splitRepeatVisibility, type ActionBinding, type PropResolutionContext, type StateModel,
  type UIElement } from "@json-render/core";
import { Box, Image, Rect, Spacer, Text } from "../components.js";
import type { LayoutBox } from "../layout.js";
import type { BoxProps, TextProps } from "../props.js";
import { Button, Checkbox, ProgressBar as Progress, SegmentedControl, Slider as SliderControl,
  Switch as SwitchControl } from "../ui/controls.js";
import { TextField as Field } from "../ui/TextField.js";
import { Pressable } from "../ui/Pressable.js";
import { StyleSheet } from "../ui/styles.js";
import { darkTheme, makeStyles, ThemeProvider, useTheme, type Theme } from "../ui/theme.js";
import { Divider as Hairline, Label, Surface as Panel } from "../ui/views.js";
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

const useStyles = makeStyles((theme) => {
  const { colors, type, radii, motion } = theme;
  return {
    theme,
    ...StyleSheet.create({
      card: { flexDirection: "column", radius: radii.md, padding: 14, gap: 8, alignSelf: "stretch" },
      plain: { flexDirection: "column", gap: 8, alignSelf: "stretch" },
      tinted: { flexDirection: "column", radius: radii.md, padding: 14, gap: 8, fill: colors.accentSoft, alignSelf: "stretch" },
      ink: { flexDirection: "column", radius: radii.md, padding: 14, gap: 8, fill: "#1f1f24", alignSelf: "stretch" },
      cardTitle: { ...type.title, color: colors.ink },
      cardSubtitle: { ...type.body, color: colors.muted, maxLines: 2 },
      row: { flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "stretch" },
      column: { flexDirection: "column", gap: 2, alignSelf: "stretch" },
      body: { ...type.body, color: colors.soft, lineHeight: 1.2 },
      caption: { font: type.body.font, size: 11, weight: 650, color: colors.muted },
      metricValue: { font: type.title.font, size: 26, weight: 700, color: colors.ink },
      unit: { ...type.body, color: colors.muted },
      badge: { flexDirection: "row", alignItems: "center", height: 20, paddingX: 8, radius: 10, alignSelf: "flex-start",
               flexShrink: 0 },
      badgeText: { font: type.body.font, size: 11, weight: 650 },
      track: { flexGrow: 1, height: 12, radius: 4, fill: colors.track, clip: true },
      bar: { position: "absolute", x: 0, y: 0, height: 12, radius: 4, transition: motion.glide },
      code: { flexDirection: "column", radius: radii.sm, padding: 10, fill: colors.hover, alignSelf: "stretch" },
      mono: { font: "Noto Sans Mono, monospace", size: 12, color: colors.soft, lineHeight: 1.2 },
      item: { flexDirection: "row", alignItems: "center", gap: 10, paddingY: 7, paddingX: 6, radius: radii.sm,
              alignSelf: "stretch", transition: motion.pop },
      cell: { flexGrow: 1, flexBasis: 0, flexDirection: "column" },
      quoteBar: { width: 3, radius: 1.5, fill: colors.accentLine, alignSelf: "stretch" },
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
  const padding = props.padding ? gapOf(props.padding, 14) : undefined;
  const head = Boolean(props.title || props.subtitle) && (
    <Box style={styles.column}>
      {props.title !== undefined && props.title !== null && <Text style={styles.cardTitle}>{text(props.title)}</Text>}
      {props.subtitle !== undefined && props.subtitle !== null && <Text style={styles.cardSubtitle}>{text(props.subtitle)}</Text>}
    </Box>
  );
  if (variant === "ink") {
    return (
      <Box style={styles.ink} padding={padding}>
        <ThemeProvider theme={darkTheme}><Inner>{head}{children}</Inner></ThemeProvider>
      </Box>
    );
  }
  if (variant === "plain") return <Box style={styles.plain} padding={padding}>{head}{children}</Box>;
  if (variant === "tinted") return <Box style={styles.tinted} padding={padding}>{head}{children}</Box>;
  return <Panel variant="card" style={styles.card} padding={padding}>{head}{children}</Panel>;
}

/** Children in a column: what a themed part of a card holds. */
function Inner({ children }: { children?: ReactNode }) {
  return <Box flexDirection="column" gap={8} alignSelf="stretch">{children}</Box>;
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

const textSizes: Record<string, number> = { sm: 12, md: 13, lg: 15, xl: 19 };
const weights: Record<string, number> = { regular: 450, medium: 600, bold: 700 };

function TextElement({ props }: Rendered) {
  const styles = useStyles();
  const color = toneColor(styles.theme, props.tone);
  const lines = props.maxLines === undefined || props.maxLines === null ? undefined : number(props.maxLines, 1);
  return (
    <Text style={[props.mono ? styles.mono : styles.body]} color={color} size={textSizes[text(props.size)]}
          weight={weights[text(props.weight)]} align={props.align as TextProps["align"]} maxLines={lines}>
      {text(props.text)}
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
  const trend = text(props.trend);
  const trendColor = toneColor(styles.theme, trend === "up" ? "success" : trend === "down" ? "danger" : "muted");
  return (
    <Box style={styles.column}>
      <Text style={styles.caption} maxLines={1}>{text(props.label)}</Text>
      <Box flexDirection="row" alignItems="baseline" gap={4}>
        <Text style={styles.metricValue}>{text(props.value)}</Text>
        {props.unit !== undefined && props.unit !== null && <Text style={styles.unit}>{text(props.unit)}</Text>}
      </Box>
      {props.delta !== undefined && props.delta !== null && (
        <Text style={styles.caption} color={trendColor}>
          {`${trend === "up" ? "▲ " : trend === "down" ? "▼ " : ""}${text(props.delta)}`}
        </Text>
      )}
      {props.caption !== undefined && props.caption !== null && <Text style={styles.caption}>{text(props.caption)}</Text>}
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
  return (
    <Box style={styles.column} gap={5}>
      {Boolean(props.label || props.showValue) && (
        <Box style={styles.row} justifyContent="space-between">
          <Text style={styles.body} maxLines={1} flexShrink={1}>{text(props.label)}</Text>
          {props.showValue === true && value !== null && <Text style={styles.caption}>{`${Math.round(value * 100)}%`}</Text>}
        </Box>
      )}
      <Progress value={value} color={toneColor(styles.theme, props.tone)} />
    </Box>
  );
}

function List({ props, children }: Rendered) {
  const items = Children.toArray(children);
  return (
    <Box flexDirection="column" alignSelf="stretch">
      {items.map((item, index) => (
        <Box key={index} flexDirection="column" alignSelf="stretch">
          {index > 0 && props.dividers !== false && <Hairline style={{ marginY: 0 }} />}
          {item}
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
      <Box flexDirection="column" gap={1} flexGrow={1} flexShrink={1}>
        <Text style={styles.body} weight={650} color={styles.theme.colors.ink} maxLines={1}>{text(props.title)}</Text>
        {props.subtitle !== undefined && props.subtitle !== null && (
          <Text style={styles.body} size={12} color={styles.theme.colors.muted} maxLines={2}>{text(props.subtitle)}</Text>
        )}
      </Box>
      {props.trailing !== undefined && props.trailing !== null && (
        <Text style={styles.body} size={12} color={styles.theme.colors.muted} maxLines={1}>{text(props.trailing)}</Text>
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
      <Box style={styles.row} paddingY={4}>
        {columns.map((column, index) => (
          <Box key={index} style={styles.cell}>
            <Text style={styles.caption} align={numeric[index] ? "end" : "start"} maxLines={1}>{column.label}</Text>
          </Box>
        ))}
      </Box>
      {rows.map((row, index) => (
        <Box key={index} flexDirection="column" alignSelf="stretch">
          <Hairline style={{ marginY: 0 }} />
          <Box style={styles.row} paddingY={6}>
            {columns.map((_, at) => (
              <Box key={at} style={styles.cell}>
                <Text style={styles.body} align={numeric[at] ? "end" : "start"} maxLines={2}>{text(row[at])}</Text>
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
              <Text style={styles.caption} align="center" maxLines={1}>{datum.label}</Text>
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
          <Text style={styles.caption} align="end" maxLines={1} width={64}>{`${formatNumber(datum.value)}${unit}`}</Text>
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
  const low = Math.min(...values, 0);
  const high = Math.max(...values, 0);
  const span = high - low || 1;
  const color = toneColor(styles.theme, props.tone ?? "accent");
  return (
    <Box flexDirection="row" height={height} gap={2} alignItems="flex-end" alignSelf="stretch">
      {values.map((value, index) => (
        <Rect key={index} flexGrow={1} flexBasis={0} radius={1.5} fill={color}
              opacity={index === values.length - 1 ? 1 : 0.55} height={Math.max(2, ((value - low) / span) * height)} />
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
  return (
    <Box style={styles.code}>
      <Text style={styles.mono}>{text(props.text) || " "}</Text>
    </Box>
  );
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
  return <Button label={text(props.label)} variant={variant} size={props.size === "small" ? "small" : "medium"}
                 disabled={props.disabled === true} onPress={() => emit("press")}
                 style={danger ? ({ hovered, pressed }) => ({ fill: colors.danger, opacity: pressed ? 0.8 : hovered ? 0.92 : 1 }) : undefined} />;
}

/** A labelled control's caption above it. */
function Caption({ label }: { label: unknown }) {
  const styles = useStyles();
  if (label === undefined || label === null || label === "") return null;
  return <Text style={styles.caption} maxLines={1}>{text(label)}</Text>;
}

/** A value bound to state, or kept here when the spec binds it to nothing. */
function useValue<T>(rendered: Rendered, prop: string, fallback: T): [T, (value: T) => void] {
  const bound = rendered.bound(prop);
  const given = rendered.props[prop] as T | undefined | null;
  const [local, setLocal] = useState<T>(given ?? fallback);
  if (bound) return [given ?? fallback, bound as (value: T) => void];
  return [local, setLocal];
}

function TextFieldElement(rendered: Rendered) {
  const { props, emit } = rendered;
  const [value, setValue] = useValue(rendered, "value", "");
  return (
    <Box flexDirection="column" gap={4} alignSelf="stretch">
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
    <Box flexDirection="column" gap={4} alignSelf="stretch" onLayout={setBox}>
      {Boolean(props.label || props.showValue !== false) && (
        <Box style={styles.row} justifyContent="space-between">
          <Text style={styles.body} maxLines={1} flexShrink={1}>{text(props.label)}</Text>
          {props.showValue !== false && <Text style={styles.caption}>{formatNumber(number(value, min))}</Text>}
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
  const path = `/_clock/${name.replace(/~/g, "~0").replace(/\//g, "~1")}`;
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
  Slider: SliderElement, Tabs, Countdown,
};

/** The component types the renderer draws. */
export const componentNames = Object.keys(components);
