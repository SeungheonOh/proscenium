// The sidebar: herdr as tree tabs. Each herdr session holds its workspaces,
// each workspace its tabs, and a tab split into several panes lists them below
// it, as tabs opened from a tab nest in a browser's tree tabs. A tab of one
// pane is itself the leaf. Every row carries herdr's agent status: working
// pulses, blocked asks for you, done waits to be seen. Windows other than the
// consoles follow in a group of their own. Folded, the sidebar is a rail of
// one status dot per pane, still selectable.
//
// Every row works alike (see Ui.tsx): clicking does the obvious thing (select
// a pane or window, fold a workspace or session, start a stopped session), and
// right-clicking it or its ⋯ asks the world for its menu, which holds the rest.

import { useState } from "react";
import { Box, Group, Rect, Spacer, Text, type OutputInfo, type WindowInfo } from "proscenium";
import { UiScreen } from "./UiScale.js";
import { isMenuPress, MoreButton, rowFill, SelectedBar, usePointAt } from "./Ui.js";
import { looks, paneName, type AgentStatus, type Pane, type Session, type Snapshot, type Tab } from "./client.js";

export const sidebarWidth = 232;
/** The folded sidebar's width. */
export const railWidth = 22;
const rowHeight = 22;
const indent = 10;
const palette = {
  panel: "#f6f8fa",
  edge: "#d0d7de",
  ink: "#1f2328",
  muted: "#656d76",
  faint: "#8c959f",
  hover: "#0000000a",
  selected: "#0969da1a",
  guide: "#0000000f",
};

/** What a tab of the sidebar selects: a pane of a session, or a window. */
export type TabKey = `p:${string}|${string}` | `w:${number}`;

export const paneKey = (session: string, pane: string): TabKey => `p:${session}|${pane}`;

/** What a row's menu is about. */
export type MenuTarget =
  | { kind: "session"; session: Session }
  | { kind: "workspace"; session: Session; workspace: Snapshot["workspaces"][number] }
  | { kind: "pane"; session: Session; pane: Pane }
  | { kind: "window"; window: WindowInfo };

export interface SidebarProps {
  output: OutputInfo;
  sessions: readonly Session[];
  windows: readonly WindowInfo[];
  selected: TabKey | null;
  collapsed: Record<string, boolean>;
  /** herdr's own trouble (not reaching it, a session failing); what actions say goes to the toast. */
  error: string | null;
  loaded: boolean;
  folded: boolean;
  onFold: (folded: boolean) => void;
  onSelect: (key: TabKey) => void;
  onToggle: (key: string) => void;
  onStart: (session: Session) => void;
  /** A row's menu, asked for at a point in UI units. */
  onMenu: (target: MenuTarget, at: { x: number; y: number }) => void;
  /** Notifications not yet read, and opening the notification center. */
  unread: number;
  onInbox: () => void;
  onHelp: () => void;
}

type Row =
  | { kind: "session"; session: Session }
  | { kind: "workspace"; session: Session; workspace: Snapshot["workspaces"][number] }
  | { kind: "tab"; session: Session; tab: Tab; panes: Pane[]; last: boolean }
  | { kind: "pane"; session: Session; pane: Pane; last: boolean }
  | { kind: "heading"; label: string }
  | { kind: "window"; window: WindowInfo };

/** A tab's panes in herdr's order. */
export function panesOf(snapshot: Snapshot, tab: string): Pane[] {
  return snapshot.panes.filter((pane) => pane.tab_id === tab);
}

/** The pane a tab row selects: the tab's focused pane, else its first. */
export function tabPane(snapshot: Snapshot, tab: string): Pane | undefined {
  const focused = snapshot.layouts.find((layout) => layout.tab_id === tab)?.focused_pane_id;
  const panes = panesOf(snapshot, tab);
  return panes.find((pane) => pane.pane_id === focused) ?? panes[0];
}

/** Every selectable pane in sidebar order, for stepping through with keys. */
export function orderedPanes(sessions: readonly Session[], collapsed: Record<string, boolean>): TabKey[] {
  const keys: TabKey[] = [];
  for (const session of sessions) {
    if (!session.snapshot || collapsed[`s:${session.name}`]) continue;
    for (const workspace of session.snapshot.workspaces) {
      if (collapsed[`w:${session.name}|${workspace.workspace_id}`]) continue;
      for (const tab of session.snapshot.tabs.filter((t) => t.workspace_id === workspace.workspace_id)) {
        const panes = panesOf(session.snapshot, tab.tab_id);
        if (panes.length === 1) keys.push(paneKey(session.name, panes[0].pane_id));
        else for (const pane of panes) keys.push(paneKey(session.name, pane.pane_id));
      }
    }
  }
  return keys;
}

function rowsOf(sessions: readonly Session[], windows: readonly WindowInfo[], collapsed: Record<string, boolean>): Row[] {
  const rows: Row[] = [];
  for (const session of sessions) {
    rows.push({ kind: "session", session });
    const snapshot = session.snapshot;
    if (!snapshot || collapsed[`s:${session.name}`]) continue;
    for (const workspace of snapshot.workspaces) {
      rows.push({ kind: "workspace", session, workspace });
      if (collapsed[`w:${session.name}|${workspace.workspace_id}`]) continue;
      const tabs = snapshot.tabs.filter((tab) => tab.workspace_id === workspace.workspace_id);
      tabs.forEach((tab, index) => {
        const panes = panesOf(snapshot, tab.tab_id);
        rows.push({ kind: "tab", session, tab, panes, last: index === tabs.length - 1 });
        if (panes.length > 1) {
          panes.forEach((pane, at) => rows.push({ kind: "pane", session, pane, last: at === panes.length - 1 }));
        }
      });
    }
  }
  if (windows.length) {
    rows.push({ kind: "heading", label: "Windows" });
    for (const window of windows) rows.push({ kind: "window", window });
  }
  return rows;
}

function rowKey(row: Row): string {
  switch (row.kind) {
    case "session": return `s:${row.session.name}`;
    case "workspace": return `w:${row.session.name}|${row.workspace.workspace_id}`;
    case "tab": return `t:${row.session.name}|${row.tab.tab_id}`;
    case "pane": return `p:${row.session.name}|${row.pane.pane_id}`;
    case "heading": return `h:${row.label}`;
    case "window": return `x:${row.window.id}`;
  }
}

function agentOf(session: Session, pane: Pane) {
  return session.snapshot?.agents.find((agent) => agent.pane_id === pane.pane_id);
}

/** A status dot, pulsing while the agent works. */
function Dot({ status, size = 8 }: { status: AgentStatus; size?: number }) {
  const look = looks(status);
  return (
    <Rect width={size} height={size} fill={look.color}
          animate={status === "working"
            ? { opacity: [1, 0.35, 1], duration: 1.4, iterations: Infinity, ease: "ease-in-out" }
            : undefined} />
  );
}

/** The button that folds or unfolds the sidebar. */
function FoldButton({ folded, onFold }: { folded: boolean; onFold: (folded: boolean) => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <Box width={18} height={18} justifyContent="center" alignItems="center"
         fill={hovered ? "#0000000f" : "transparent"} cursor="pointer"
         onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
         onPointerDown={() => onFold(!folded)}>
      <Text size={12} color={hovered ? palette.ink : palette.muted}>{folded ? "»" : "«"}</Text>
    </Box>
  );
}

/** A small square button in the sidebar's header. */
function HeaderButton({ label, onPress }: { label: string; onPress: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <Box width={18} height={18} justifyContent="center" alignItems="center" cursor="pointer"
         fill={hovered ? "#0000000f" : "transparent"}
         onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
         onPointerDown={onPress}>
      <Text size={11.5} weight="bold" color={hovered ? palette.ink : palette.muted}>{label}</Text>
    </Box>
  );
}

/** The notification center's button: how many are unread. */
function Inbox({ unread, onInbox, compact = false }: { unread: number; onInbox: () => void; compact?: boolean }) {
  const [hovered, setHovered] = useState(false);
  return (
    <Box height={18} paddingX={compact ? 0 : 5} width={compact ? 18 : undefined} gap={4} alignItems="center"
         justifyContent="center" cursor="pointer"
         fill={unread ? "#0969da" : hovered ? "#0000000f" : "transparent"}
         onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
         onPointerDown={onInbox}>
      <Text size={10.5} weight={unread ? "bold" : "normal"} color={unread ? "#ffffff" : palette.muted}>
        {compact ? String(unread) : `inbox ${unread}`}
      </Text>
    </Box>
  );
}

/** The folded sidebar: every pane and window as a dot, in the sidebar's order. */
function Rail({ output, sessions, windows, selected, onSelect, onFold, unread, onInbox }: SidebarProps) {
  const [hover, setHover] = useState<string | null>(null);
  const top = 26;
  const items: { key: TabKey; status: AgentStatus | null; gap: boolean }[] = [];
  for (const session of sessions) {
    if (!session.snapshot) continue;
    orderedPanes([session], {}).forEach((key, index) => {
      const pane = session.snapshot!.panes.find((candidate) => paneKey(session.name, candidate.pane_id) === key);
      items.push({ key, status: pane?.agent_status ?? "unknown", gap: index === 0 && items.length > 0 });
    });
  }
  windows.forEach((window, index) => items.push({ key: `w:${window.id}`, status: null, gap: index === 0 && items.length > 0 }));
  let y = 0;
  const placed = items.map((item) => {
    if (item.gap) y += 6;
    const at = y;
    y += rowHeight;
    return { ...item, y: at };
  });

  return (
    <UiScreen output={output.name}>
      <Rect width={railWidth} height={output.height} fill={palette.panel} />
      <Rect x={railWidth - 1} width={1} height={output.height} fill={palette.edge} />
      <Box x={0} y={0} width={railWidth - 1} height={top} justifyContent="center" alignItems="center">
        <FoldButton folded onFold={onFold} />
      </Box>
      {unread > 0 && (
        <Box x={1} y={output.height - 20} width={railWidth - 3} height={18} justifyContent="center">
          <Inbox unread={unread} onInbox={onInbox} compact />
        </Box>
      )}
      <Group y={top} width={railWidth} height={output.height - top} clip>
        {placed.map((item) => {
          const chosen = selected === item.key;
          return (
            <Box key={item.key} x={0} y={item.y} width={railWidth - 1} height={rowHeight}
                 justifyContent="center" alignItems="center" cursor="pointer"
                 fill={rowFill(chosen, hover === item.key)}
                 onPointerEnter={() => setHover(item.key)} onPointerLeave={() => setHover(null)}
                 onPointerDown={() => onSelect(item.key)}>
              {chosen && <SelectedBar height={rowHeight} />}
              {item.status ? <Dot status={item.status} size={6} /> : <Rect width={6} height={6} fill="#8c959f" />}
            </Box>
          );
        })}
      </Group>
    </UiScreen>
  );
}

export function Sidebar(props: SidebarProps) {
  if (props.folded) return <Rail {...props} />;
  const { output, sessions, windows, collapsed, error, loaded } = props;
  const [scroll, setScroll] = useState(0);
  const [hover, setHover] = useState<string | null>(null);
  const rows = rowsOf(sessions, windows, collapsed);
  const top = 26;
  const listHeight = output.height - top - (error ? 56 : 0);
  const maxScroll = Math.max(0, rows.length * rowHeight - listHeight);
  const offset = Math.min(scroll, maxScroll);
  const agents = sessions.flatMap((session) => session.snapshot?.agents ?? []);
  const blocked = agents.filter((agent) => agent.agent_status === "blocked").length;
  const working = agents.filter((agent) => agent.agent_status === "working").length;

  return (
    <UiScreen output={output.name}>
      <Rect width={sidebarWidth} height={output.height} fill={palette.panel} />
      <Rect x={sidebarWidth - 1} width={1} height={output.height} fill={palette.edge} />
      <Box x={8} y={0} width={sidebarWidth - 12} height={top} alignItems="center" gap={6}>
        <Text size={12} weight="bold" color={palette.ink}>herdr</Text>
        <Spacer />
        {working > 0 && <Box gap={4} alignItems="center"><Dot status="working" size={6} /><Text size={11} color={palette.muted}>{String(working)}</Text></Box>}
        {blocked > 0 && <Box gap={4} alignItems="center"><Dot status="blocked" size={6} /><Text size={11} color="#9a6700">{String(blocked)}</Text></Box>}
        <Text size={11} color={palette.muted}>{loaded ? `${agents.length} agent${agents.length === 1 ? "" : "s"}` : "connecting…"}</Text>
        <Inbox unread={props.unread} onInbox={props.onInbox} />
        <HeaderButton label="?" onPress={props.onHelp} />
        <FoldButton folded={false} onFold={props.onFold} />
      </Box>

      <Group
        y={top}
        width={sidebarWidth}
        height={listHeight}
        clip
        onWheel={(event) => {
          if (event.orientation !== "vertical") return;
          setScroll((current) => Math.max(0, Math.min(maxScroll, current + event.delta * 2)));
        }}
      >
        <Group y={-offset}>
          {rows.map((row, index) => (
            <TabRow key={rowKey(row)} row={row} y={index * rowHeight} {...props} hover={hover} setHover={setHover} />
          ))}
        </Group>
        {loaded && rows.length === 0 && !error && (
          <Text x={8} y={8} width={sidebarWidth - 16} size={11.5} color={palette.muted} lineHeight={1.4}>
            No herdr sessions yet. Run `herdr` in a terminal to start one.
          </Text>
        )}
      </Group>

      {error ? (
        <Box x={0} y={output.height - 56} width={sidebarWidth - 1} height={56} paddingX={8}
             fill="#fff8c5" alignItems="center">
          <Text size={11} color="#7d4e00" width={sidebarWidth - 17} maxLines={3}>{error}</Text>
        </Box>
      ) : null}
    </UiScreen>
  );
}

type TabRowProps = SidebarProps & {
  row: Row;
  y: number;
  hover: string | null;
  setHover: (key: string | null) => void;
};

function TabRow({ row, y, selected, collapsed, hover, setHover, onSelect, onToggle, onStart, onMenu }: TabRowProps) {
  const key = rowKey(row);
  const hovered = hover === key;
  const pointAt = usePointAt();
  const width = sidebarWidth - 1;
  const pointer = { onPointerEnter: () => setHover(key), onPointerLeave: () => setHover(null), cursor: "pointer" as const };
  /** Right-click opens the menu wherever the row is pressed; any other press does the row's own thing. */
  const press = (target: MenuTarget | null, primary: () => void) =>
    (event: Parameters<typeof isMenuPress>[0]) => (target && isMenuPress(event) ? onMenu(target, pointAt(event)) : primary());
  const more = (target: MenuTarget) => hovered && <MoreButton onPress={(at) => onMenu(target, at)} />;

  if (row.kind === "heading") {
    return (
      <Box x={0} y={y} width={width} height={rowHeight} paddingX={8} alignItems="flex-end" paddingBottom={4}>
        <Text size={10} weight="bold" color={palette.muted}>{row.label.toUpperCase()}</Text>
      </Box>
    );
  }

  if (row.kind === "window") {
    const tab: TabKey = `w:${row.window.id}`;
    const target: MenuTarget = { kind: "window", window: row.window };
    const chosen = selected === tab;
    return (
      <Box x={0} y={y} width={width} height={rowHeight} paddingX={8} gap={6} alignItems="center"
           fill={rowFill(chosen, hovered)} {...pointer} onPointerDown={press(target, () => onSelect(tab))}>
        {chosen && <SelectedBar height={rowHeight} />}
        <Rect width={6} height={6} fill="#8c959f" />
        <Text size={12} color={palette.ink} weight={chosen ? "bold" : "normal"} maxLines={1} flexShrink={1}>
          {row.window.title || row.window.appId || `window ${row.window.id}`}
        </Text>
        <Spacer />
        {more(target)}
      </Box>
    );
  }

  if (row.kind === "session") {
    const { session } = row;
    const open = !collapsed[key];
    const target: MenuTarget = { kind: "session", session };
    return (
      <Box x={0} y={y} width={width} height={rowHeight} paddingX={6} gap={5} alignItems="center"
           fill={rowFill(false, hovered)} {...pointer}
           onPointerDown={press(target, () => (session.running ? onToggle(key) : onStart(session)))}>
        <Text size={10} color={palette.muted}>{session.running ? (open ? "▾" : "▸") : "○"}</Text>
        <Text size={10.5} weight="bold" color={session.running ? palette.muted : palette.faint}>
          {session.name.toUpperCase()}
        </Text>
        <Spacer />
        {session.error && <Text size={11} color="#cf222e">!</Text>}
        {!session.running && !hovered && <Text size={11} color={palette.faint}>stopped · click starts</Text>}
        {more(target)}
      </Box>
    );
  }

  if (row.kind === "workspace") {
    const { session, workspace } = row;
    const open = !collapsed[key];
    const target: MenuTarget = { kind: "workspace", session, workspace };
    return (
      <Box x={indent} y={y} width={width - indent} height={rowHeight} paddingX={6} gap={5} alignItems="center"
           fill={rowFill(false, hovered)} {...pointer} onPointerDown={press(target, () => onToggle(key))}>
        <Text size={10} color={palette.muted}>{open ? "▾" : "▸"}</Text>
        <Text size={12} weight="bold" color={palette.ink} maxLines={1} flexShrink={1}>{workspace.label}</Text>
        <Spacer />
        {hovered ? more(target) : workspace.agent_status !== "unknown" && <Dot status={workspace.agent_status} size={6} />}
      </Box>
    );
  }

  // Tabs and panes: leaves hang off the guide line of their parent.
  const depth = row.kind === "tab" ? 2 : 3;
  const left = 2 + depth * indent;
  const single = row.kind === "tab" && row.panes.length === 1;
  const pane = row.kind === "pane" ? row.pane : single ? row.panes[0] : undefined;
  const tab: TabKey | null = pane ? paneKey(row.session.name, pane.pane_id) : null;
  const chosen = tab !== null && selected === tab;
  const agent = pane ? agentOf(row.session, pane) : undefined;
  const status = row.kind === "tab" ? row.tab.agent_status : row.pane.agent_status;
  const named = row.kind === "tab" && !/^\d+$/.test(row.tab.label);
  const title = row.kind === "tab"
    ? (named ? row.tab.label : pane ? paneName(pane, agent) : `tab ${row.tab.number}`)
    : paneName(row.pane, agent);
  const kind = agent?.display_agent || agent?.agent;
  const target: MenuTarget | null = pane ? { kind: "pane", session: row.session, pane } : null;
  const select = () => {
    if (tab) onSelect(tab);
    else if (row.kind === "tab" && row.panes[0]) onSelect(paneKey(row.session.name, row.panes[0].pane_id));
  };

  return (
    <Group y={y}>
      <Rect x={left - 6} y={0} width={1} height={row.last ? rowHeight / 2 : rowHeight} fill={palette.guide} />
      <Rect x={left - 6} y={rowHeight / 2} width={5} height={1} fill={palette.guide} />
      <Box x={left} y={0} width={sidebarWidth - left - 1} height={rowHeight} paddingX={6} gap={5}
           alignItems="center" fill={rowFill(chosen, hovered)} {...pointer} onPointerDown={press(target, select)}>
        {chosen && <SelectedBar height={rowHeight} />}
        <Dot status={status} size={6} />
        <Text size={12} color={status === "unknown" && !agent ? palette.muted : palette.ink}
              weight={chosen ? "bold" : "normal"} maxLines={1} flexShrink={1}>
          {title}
        </Text>
        <Spacer />
        {status === "blocked" && (
          <Box height={14} paddingX={4} fill="#9a6700" alignItems="center">
            <Text size={9.5} weight="bold" color="#ffffff">needs you</Text>
          </Box>
        )}
        {!hovered && status !== "blocked" && kind && kind !== title && <Text size={10} color={palette.muted}>{kind}</Text>}
        {!hovered && row.kind === "tab" && row.panes.length > 1 && (
          <Text size={10} color={palette.faint}>{`${row.panes.length} panes`}</Text>
        )}
        {target && more(target)}
      </Box>
    </Group>
  );
}
