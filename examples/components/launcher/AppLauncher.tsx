/**
 * The application launcher drawn by the world with proscenium/ui: a search field over a
 * scrolling list of installed applications. Type to filter, Up and Down (or the pointer)
 * to choose, Enter or a click to launch, Escape or a press outside to close. A right
 * click on an application offers its desktop actions, such as a private window.
 */

import { useRef, useState } from "react";
import { Box, Rect, Shortcut, scale, type OutputInfo, type StageScrollEvent } from "proscenium";
import {
  Glyph, Label, List, ListItem, makeStyles, Overlay, ScrollView, StyleSheet, TextField, ThemeProvider, type MenuEntry,
  type ScrollViewHandle, type TextFieldHandle, type Theme,
} from "proscenium/ui";
import {
  iconFile, launchApplication, launchApplicationAction, useApplications, type ApplicationInfo,
} from "../../lib/system/applications.js";

const width = 640;
/** A row's height and the gap between rows, so a row's place is known without measuring. */
const rowHeight = 46, rowGap = 2, rowsShown = 7;

/** Applications matching QUERY, best first: names starting with it, then words in names, then anywhere. */
export function rankApplications(applications: readonly ApplicationInfo[], query: string): ApplicationInfo[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...applications];
  const scored: { app: ApplicationInfo; score: number }[] = [];
  for (const app of applications) {
    const name = app.name.toLowerCase();
    const score = name.startsWith(needle) ? 0
      : name.split(/[\s\-_.]+/).some((word) => word.startsWith(needle)) ? 1
      : name.includes(needle) ? 2
      : `${app.detail} ${app.id}`.toLowerCase().includes(needle) ? 3 : -1;
    if (score >= 0) scored.push({ app, score });
  }
  return scored.sort((a, b) => a.score - b.score || a.app.name.localeCompare(b.app.name)).map(({ app }) => app);
}

const useStyles = makeStyles(({ colors, radii, shadows, glassBorder, type, motion }) => ({
  ...StyleSheet.create({
    panel: { position: "absolute", width, flexDirection: "column", padding: 10, gap: 8, radius: 16,
             fill: colors.glass, blur: 28, border: glassBorder, shadow: shadows.modal, groupOpacity: true },
    search: { flexDirection: "row", alignItems: "center", gap: 10, height: 48, paddingX: 14, radius: radii.md + 2,
              fill: colors.hover, border: { width: 1, color: colors.line } },
    field: { flexGrow: 1, height: 48, paddingY: 12 },
    fieldText: { ...type.body, size: 17, lineHeight: 24 / 17, color: colors.ink },
    list: { gap: rowGap },
    row: { minHeight: rowHeight, height: rowHeight, paddingX: 10, gap: 12, radius: radii.md },
    placeholder: { width: 28, height: 28, radius: 7, fill: colors.accentSoft, alignItems: "center", justifyContent: "center" },
    initial: { ...type.strong, color: colors.accent },
    empty: { height: 64, alignItems: "center", justifyContent: "center" },
    footer: { flexDirection: "row", justifyContent: "space-between", paddingX: 6, paddingBottom: 2 },
  }),
  colors,
  motion,
}));

interface PanelProps {
  output: OutputInfo;
  onClose: () => void;
}

/** The launcher while it shows: mounted on opening, so each opening starts with an empty search. */
function LauncherPanel({ output, onClose }: PanelProps) {
  const styles = useStyles();
  const applications = useApplications();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const list = useRef<ScrollViewHandle>(null);
  const field = useRef<TextFieldHandle>(null);
  // Rows moving under a still pointer, as the list filters, choose nothing until it moves.
  const [still, setStill] = useState(true);
  const scrolled = useRef(0);
  const matches = rankApplications(applications, query);
  const chosen = Math.min(selected, Math.max(matches.length - 1, 0));
  const viewport = Math.min(matches.length, rowsShown) * (rowHeight + rowGap) - rowGap;

  const launch = (app: ApplicationInfo | undefined) => {
    if (!app) return;
    launchApplication(app.id);
    onClose();
  };

  /** Choose row INDEX, scrolling it into view. */
  const choose = (index: number) => {
    const next = Math.min(Math.max(index, 0), matches.length - 1);
    if (next < 0) return;
    setSelected(next);
    const top = next * (rowHeight + rowGap), bottom = top + rowHeight;
    if (top < scrolled.current) list.current?.scrollTo(top);
    else if (bottom > scrolled.current + viewport) list.current?.scrollTo(bottom - viewport);
  };

  const menuFor = (app: ApplicationInfo): MenuEntry[] => [
    { label: "Open", onSelect: () => launch(app) },
    ...(app.actions.length ? ["-" as const] : []),
    ...app.actions.map((action) => ({ label: action.name, onSelect: () => {
      launchApplicationAction(app.id, action.id);
      onClose();
    } })),
  ];

  const x = Math.round((output.width - width) / 2);
  const y = Math.round(output.height * 0.2);
  return (
    <>
      {/* A press anywhere else closes it. */}
      <Rect x={0} y={0} width={output.width} height={output.height} onPointerDown={onClose} />
      <Box style={styles.panel} x={x} y={y} onPointerMove={still ? () => setStill(false) : undefined} originY={0} transition={{ default: styles.motion.fade, transform: styles.motion.pop }}
           initial={{ opacity: 0, transform: [scale(0.97)] }} exit={{ opacity: 0, transform: [scale(0.97)] }}>
        <Box style={styles.search}>
          <Glyph shape="search" size={18} color={styles.colors.muted} />
          <TextField ref={field} bare autoFocus selectOnFocus value={query} placeholder="Search applications"
                     captureKeys={["Escape", "Up", "Down", "KP_Up", "KP_Down", "Prior", "Next", "Control+n", "Control+p"]}
                     style={styles.field} textStyle={styles.fieldText} placeholderStyle={[styles.fieldText, { color: styles.colors.faint }]}
                     onChangeText={(text) => {
                       setQuery(text);
                       setSelected(0);
                       setStill(true);
                       list.current?.scrollTo(0);
                     }}
                     onSubmit={() => launch(matches[chosen])}
                     onKey={(event) => {
                       // C-n and C-p walk the list too, as in Emacs.
                       const key = event.modifiers.includes("control") ? { n: "Down", p: "Up" }[event.key] ?? "" : event.key;
                       switch (key) {
                         case "Escape": onClose(); break;
                         case "Down": case "KP_Down": choose(chosen + 1); break;
                         case "Up": case "KP_Up": choose(chosen - 1); break;
                         case "Page_Down": case "Next": choose(chosen + rowsShown); break;
                         case "Page_Up": case "Prior": choose(chosen - rowsShown); break;
                       }
                     }} />
        </Box>
        {matches.length === 0 ? (
          <Box style={styles.empty}>
            <Label tone="muted">{applications.length ? `No applications match “${query.trim()}”` : "Looking for applications…"}</Label>
          </Box>
        ) : (
          <ScrollView ref={list} height={viewport}
                      onScroll={(event: StageScrollEvent) => { scrolled.current = event.scrollY; }}>
            <List style={styles.list}>
              {matches.map((app, index) => {
                const icon = iconFile(app.icon);
                return (
                  <ListItem key={app.id} style={styles.row} label={app.name} description={app.detail || undefined}
                            icon={icon ?? undefined} iconSize={28} iconTint={null} focusable={false}
                            leading={<Box style={styles.placeholder}><Label style={styles.initial}>{app.name.slice(0, 1)}</Label></Box>}
                            selected={index === chosen}
                            onPointerEnter={still ? undefined : () => setSelected(index)}
                            onMenuOpenChange={(open) => {
                              if (!open) field.current?.focus();
                            }}
                            onPress={() => launch(app)}
                            menu={menuFor(app)} />
                );
              })}
            </List>
          </ScrollView>
        )}
        <Box style={styles.footer}>
          <Label variant="small" tabularNumbers>{`${matches.length} application${matches.length === 1 ? "" : "s"}`}</Label>
          <Label variant="small">↑↓ choose · Enter open · Esc close</Label>
        </Box>
      </Box>
    </>
  );
}

export interface AppLauncherProps {
  output?: OutputInfo;
  theme: Theme;
}

/** The launcher on Super+D, on OUTPUT. Nothing of it exists while it is closed. */
export function AppLauncher({ output, theme }: AppLauncherProps) {
  const [open, setOpen] = useState(process.env.LAUNCHER_OPEN === "1");
  if (!output) return <Shortcut keys="Super+D" onPress={() => setOpen((current) => !current)} />;
  return (
    <>
      <Shortcut keys="Super+D" onPress={() => setOpen((current) => !current)} />
      <ThemeProvider theme={theme}>
        {/* Kept mounted, so the panel's removal plays its exit. */}
        <Overlay output={output.name}>
          {open && <LauncherPanel output={output} onClose={() => setOpen(false)} />}
        </Overlay>
      </ThemeProvider>
    </>
  );
}
