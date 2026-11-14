/**
 * A desktop for herdr (herdr.dev), the terminal workspace manager for coding
 * agents. The left of the screen is herdr as tree tabs: every herdr session on
 * this machine, its workspaces, their tabs, and the panes of a split tab, each
 * with herdr's status for the agent in it (working, blocked, done, idle).
 * Selecting a tab shows it on the right: a header with where it lives and what
 * its agent is doing, a code viewer on its project (the git repository its
 * directory belongs to), and its console: a terminal attached straight to that
 * herdr pane (`herdr terminal attach`), so typing there types into the agent.
 * Ctrl+B Q in a console detaches it. Other windows get tabs of their own.
 *
 * How everything behaves (herdr/Ui.tsx has the pieces):
 *
 *   - Clicking a row does the obvious thing: select a pane or window, fold a
 *     workspace or session, start a stopped session, open a file, go to a
 *     notification. Right-clicking anything, or its ⋯, opens its menu: all
 *     else it can do, with the shortcut for each.
 *   - × only takes something out of view (dismiss a notification, detach a
 *     window). Destroying (closing a pane, a workspace, a window) is only in
 *     menus, and asks once in place before it happens.
 *   - One transient thing at a time: a menu, the finder, the notification
 *     center, the prompt or the shortcut sheet. Its shortcut toggles it;
 *     Escape closes it.
 *   - Super+key does a thing, Super+Shift+key its counterpart: O finds a file
 *     and Shift+O searches, N goes to what needs you and Shift+N lists it all,
 *     A attaches a window and Shift+A detaches it, T opens a tab and Shift+T a
 *     workspace. Super+/ shows every shortcut, from the `shortcuts` table below
 *     that also binds them.
 *   - What an action has to say shows as a toast at the bottom; the sidebar
 *     shows only herdr's own trouble.
 *
 * Any window, a browser say, can be attached to a pane: it then shows as a tab
 * over the pane's code viewer instead of a tab of its own. Notifications
 * (herdr/Notices.tsx) say when an agent asks for you or finishes, and
 * when a hidden window asks to be shown.
 *
 * The world follows herdr through its socket API (herdr/client.ts): stopped
 * sessions show greyed, and clicking one starts its server.
 */

import { useEffect, useRef, useState } from "react";
import {
  Camera,
  close,
  focus,
  launch,
  Rect,
  Reserve,
  Shortcut,
  spring,
  Text,
  useCompositorInstance,
  useFocusedWindow,
  useOutputs,
  usePersistentState,
  useWindows,
  Window,
  type Rectangle,
  type WindowInfo,
} from "proscenium";
import { Launcher } from "./components/Launcher.js";
import { Screenshots } from "./components/Screenshots.js";
import { closePane, closeWorkspace, herdr, newTab, newWorkspace, paneName, sessionArgs, startSession, useHerdr, type Session } from "./herdr/client.js";
import { isDirectory, expandHome } from "./herdr/files.js";
import { FinderOverlay, type FinderMode, type FinderTarget } from "./herdr/Finder.js";
import { stepScale, toScreen, UiScaleProvider, UiScreen } from "./herdr/UiScale.js";
import { Banners, NotificationCenter, useNotices, type Notice } from "./herdr/Notices.js";
import {
  clampShare,
  CodeViewer,
  ConsolePlaceholder,
  defaultSplit,
  directoryOf,
  gap,
  PaneHeader,
  paneBoxes,
  useProject,
  ViewerTabs,
  windowLabel,
  type Jump,
  type Selection,
  type Split,
} from "./herdr/PaneView.js";
import { orderedPanes, paneKey, railWidth, Sidebar, sidebarWidth, type MenuTarget, type TabKey } from "./herdr/Sidebar.js";
import { HelpSheet, Menu, ToastView, type KeyHelp, type MenuItem, type MenuSpec, type Toast } from "./herdr/Ui.js";

const consolePrefix = "herdr.console/";
const terminal = "foot";
/** The consoles in the world's light palette (GitHub Light's), whatever foot.ini says. */
const lightTerminal = Object.entries({
  background: "ffffff", foreground: "1f2328", "selection-background": "b6e3ff", "selection-foreground": "1f2328",
  regular0: "24292f", regular1: "cf222e", regular2: "116329", regular3: "4d2d00",
  regular4: "0969da", regular5: "8250df", regular6: "1b7c83", regular7: "6e7781",
  bright0: "57606a", bright1: "a40e26", bright2: "1a7f37", bright3: "633c01",
  bright4: "218bff", bright5: "a475f9", bright6: "3192aa", bright7: "8c959f",
}).flatMap(([key, value]) => ["-o", `colors.${key}=${value}`]).concat(["-o", "main.initial-color-theme=1", "-o", "csd.preferred=none"]);
const move = spring({ duration: 0.32, bounce: 0.08 });
/** A console launch not mapped by then has failed; selecting the pane again tries again. */
const launchPatience = 8000;

/** The pane a console window is attached to, as the key of its tab. */
function consoleKey(window: WindowInfo): TabKey | null {
  if (!window.appId.startsWith(consolePrefix)) return null;
  const [session, pane] = window.appId.slice(consolePrefix.length).split("/");
  return session && pane ? paneKey(session, pane) : null;
}

const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/**
 * A terminal attached to the selected pane. herdr lets one client attach to a
 * pane at a time; if another holds it, the console asks before taking it over.
 */
function openConsole({ session, pane, agent }: Selection) {
  const herdrArgs = [herdr, ...sessionArgs(session)].map(quote).join(" ");
  const id = quote(pane.terminal_id);
  const script = [
    `e=$(mktemp)`,
    `${herdrArgs} terminal attach ${id} 2>"$e"; s=$?`,
    `if grep -q "already has an attached client" "$e"; then`,
    `  rm -f "$e"; printf '\\n%s\\n' "This pane is attached in another client. Enter takes it over; Ctrl+C closes."`,
    `  read _ && exec ${herdrArgs} terminal attach --takeover ${id}`,
    `fi`,
    `[ "$s" = 0 ] || { cat "$e"; printf '\\n%s' "The console could not attach. Enter closes."; read _; }`,
    `rm -f "$e"`,
  ].join("\n");
  launch([
    terminal,
    ...lightTerminal,
    "--app-id", `${consolePrefix}${session.name}/${pane.pane_id}`,
    "--title", `herdr · ${agent?.name || agent?.agent || pane.pane_id}`,
    ...(directoryOf(pane) ? ["--working-directory", directoryOf(pane)!] : []),
    "sh", "-c", script,
  ]);
}

/** The selection a tab key names, looked up in herdr's live state. */
function resolve(sessions: readonly Session[], key: TabKey | null): Selection | null {
  if (!key?.startsWith("p:")) return null;
  const [name, paneId] = key.slice(2).split("|");
  const session = sessions.find((candidate) => candidate.name === name);
  const snapshot = session?.snapshot;
  const pane = snapshot?.panes.find((candidate) => candidate.pane_id === paneId);
  if (!session || !snapshot || !pane) return null;
  const tab = snapshot.tabs.find((candidate) => candidate.tab_id === pane.tab_id);
  return {
    session,
    pane,
    agent: snapshot.agents.find((agent) => agent.pane_id === pane.pane_id),
    workspaceLabel: snapshot.workspaces.find((w) => w.workspace_id === pane.workspace_id)?.label ?? pane.workspace_id,
    tabLabel: tab ? (/^\d+$/.test(tab.label) ? `tab ${tab.number}` : tab.label) : pane.tab_id,
  };
}

/** Windows attached to panes, for one compositor run: window ids start over with it. */
interface Attachments {
  instance: string | null;
  /** Each pane's attached windows, in the order of their tabs. */
  panes: Record<string, number[]>;
  /** The window each pane's viewer shows; none (or a gone one) shows the code. */
  shown: Record<string, number | null>;
}

const noAttachments: Attachments = { instance: null, panes: {}, shown: {} };

/** The one transient thing showing, if any. */
type Overlay =
  | { kind: "finder"; mode: FinderMode; opened: number }
  | { kind: "center" }
  | { kind: "prompt" }
  | { kind: "help" }
  | { kind: "menu"; menu: MenuSpec };

export default function HerdrWorld() {
  const output = useOutputs()[0];
  const windows = useWindows();
  const focused = useFocusedWindow();
  const instance = useCompositorInstance();
  const state = useHerdr();
  const [selected, setSelected] = usePersistentState<TabKey | null>("herdr.selected", null);
  const [collapsed, setCollapsed] = usePersistentState<Record<string, boolean>>("herdr.collapsed", {});
  const [folded, setFolded] = usePersistentState("herdr.sidebarFolded", false);
  const [split, setSplit] = usePersistentState<Split>("herdr.split", defaultSplit);
  const [uiScale, setUiScale] = usePersistentState("herdr.uiScale", 1);
  const [lastPane, setLastPane] = usePersistentState<TabKey | null>("herdr.lastPane", null);
  const [stored, setAttachments] = usePersistentState<Attachments>("herdr.attached", noAttachments);
  // While the divider is dragged, the share it is at; the layout follows it without easing.
  const [dragShare, setDragShare] = useState<number | null>(null);
  const [chosen, setChosen] = usePersistentState<Record<string, string>>("herdr.files", {});
  const [recent, setRecent] = usePersistentState<Record<string, string[]>>("herdr.recent", {});
  const [jump, setJump] = useState<(Jump & { root: string }) | null>(null);
  // One transient thing at a time: opening one closes the others, and Escape closes it.
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  // Consoles this compositor launched and when, so selecting a pane again opens no second.
  const launched = useRef(new Map<TabKey, number>());
  const known = useRef(new Set<number>());

  const attachments = stored.instance === instance ? stored : { ...noAttachments, instance };
  const liveIds = new Set(windows.map((window) => window.id));
  const owner = new Map<number, TabKey>();
  for (const [pane, ids] of Object.entries(attachments.panes)) {
    for (const id of ids) if (liveIds.has(id)) owner.set(id, pane as TabKey);
  }

  // Consoles by the pane they attach to (the newest wins), and the other windows.
  const consoles = new Map<TabKey, WindowInfo>();
  const others: WindowInfo[] = [];
  for (const window of windows) {
    const key = consoleKey(window);
    if (key) consoles.set(key, window);
    else if (window.parent === null && !owner.has(window.id)) others.push(window);
  }

  const order: TabKey[] = [...orderedPanes(state.sessions, collapsed), ...others.map((w) => `w:${w.id}` as const)];
  const live = (key: TabKey) =>
    key.startsWith("w:")
      ? liveIds.has(Number(key.slice(2))) && !owner.has(Number(key.slice(2)))
      : !state.loaded || Boolean(resolve(state.sessions, key));
  // A selection that went away (a closed pane, a stopped session) falls back to the first tab.
  const current: TabKey | null = selected && live(selected) ? selected : (order[0] ?? null);
  const selection = resolve(state.sessions, current);
  const windowTab = current?.startsWith("w:") ? Number(current.slice(2)) : null;
  const project = useProject(selection ? directoryOf(selection.pane) : null);
  const attachedHere = selection && current
    ? windows.filter((window) => owner.get(window.id) === current)
    : [];
  const shownWindow = current && attachedHere.some((w) => w.id === attachments.shown[current])
    ? attachments.shown[current]! : null;
  const layout: Split = dragShare === null ? split : { show: "both", share: dragShare };
  const flow = dragShare === null ? move : undefined;

  const notices = useNotices(state.sessions, state.loaded, current);
  const finder = overlay?.kind === "finder" ? overlay : null;
  const center = overlay?.kind === "center";
  const prompting = overlay?.kind === "prompt";

  /** Opens KIND, or closes it if it is what shows: each overlay's shortcut toggles it. */
  function toggle(next: Overlay) {
    setOverlay(overlay?.kind === next.kind && (next.kind !== "finder" || (overlay as typeof next).mode === next.mode)
      ? null : next);
  }

  /** What an action has to say, at the bottom for a few seconds. */
  function say(text: string, tone: Toast["tone"] = "info") {
    setToast({ id: Date.now(), text, tone });
  }

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.tone === "error" ? 6000 : 2500);
    return () => clearTimeout(timer);
  }, [toast]);

  function updateAttachments(change: (current: Attachments) => Attachments) {
    setAttachments(change(attachments));
  }

  /** Attaches WINDOW to PANE as the tab its viewer shows, and goes there. */
  function attach(window: number, pane: TabKey | null) {
    if (!pane || !resolve(state.sessions, pane)) {
      say("Select a pane first: a window attaches to the last pane you were on.", "error");
      return;
    }
    updateAttachments((now) => {
      const panes: Record<string, number[]> = {};
      for (const [key, ids] of Object.entries(now.panes)) {
        const kept = ids.filter((id) => id !== window && liveIds.has(id));
        if (kept.length) panes[key] = kept;
      }
      panes[pane] = [...(panes[pane] ?? []), window];
      return { instance, panes, shown: { ...now.shown, [pane]: window } };
    });
    if (split.show === "console") setSplit({ ...split, show: "both" });
    setSelected(pane);
  }

  /** Gives WINDOW back a tab of its own, and shows it there. */
  function detach(window: number) {
    const pane = owner.get(window);
    if (!pane) return;
    updateAttachments((now) => ({
      instance,
      panes: { ...now.panes, [pane]: (now.panes[pane] ?? []).filter((id) => id !== window) },
      shown: { ...now.shown, [pane]: now.shown[pane] === window ? null : now.shown[pane] ?? null },
    }));
    setSelected(`w:${window}`);
  }

  function showInViewer(pane: TabKey, window: number | null) {
    updateAttachments((now) => ({ ...now, instance, shown: { ...now.shown, [pane]: window } }));
    if (split.show === "console") setSplit({ ...split, show: "both" });
    if (window !== null) focus(window);
  }

  function go(target: Notice) {
    if (target.window !== undefined && owner.has(target.window)) {
      const pane = owner.get(target.window)!;
      setSelected(pane);
      showInViewer(pane, target.window);
    } else {
      setSelected(target.target);
    }
    notices.markRead(target.target);
    setOverlay(null);
  }

  /** A window asking to be shown: shown at once if it is, else a notice. */
  function activationRequested(window: WindowInfo) {
    const pane = owner.get(window.id);
    const visible = windowTab === window.id || (pane === current && shownWindow === window.id && split.show !== "console");
    if (visible) {
      focus(window.id);
      return;
    }
    const target: TabKey = pane ?? `w:${window.id}`;
    notices.raise({
      target,
      window: pane ? window.id : undefined,
      kind: "window",
      title: `${windowLabel(window)} wants attention`,
      detail: pane ? `attached to ${resolve(state.sessions, pane)?.tabLabel ?? "a pane"}` : "its own tab",
    });
  }

  // Window ids start over with the compositor; so do the consoles it launched.
  useEffect(() => {
    launched.current.clear();
    known.current.clear();
  }, [instance]);

  useEffect(() => {
    if (selection && current && current !== lastPane) setLastPane(current);
  }, [current, Boolean(selection)]);

  // A newly mapped window that is not a console gets its own tab, shown at once.
  // The windows already there when the world starts are not new.
  const seeded = useRef<string | null>(null);
  useEffect(() => {
    if (!instance) return;
    if (seeded.current !== instance) {
      seeded.current = instance;
      for (const window of windows) known.current.add(window.id);
      return;
    }
    for (const window of windows) {
      if (known.current.has(window.id)) continue;
      known.current.add(window.id);
      const key = consoleKey(window);
      if (key) {
        launched.current.delete(key);
        if (key === current && split.show !== "viewer") focus(window.id);
      } else if (window.parent === null && instance) {
        setSelected(`w:${window.id}`);
      }
    }
  }, [windows, instance]);

  // Showing a pane attaches its console the first time, and gives the keyboard
  // to the console, or to the attached window when the console is folded away.
  useEffect(() => {
    if (overlay?.kind === "prompt") setOverlay(null);
    if (selection && current) {
      const console = consoles.get(current);
      const since = launched.current.get(current);
      if (split.show === "viewer" && shownWindow !== null) focus(shownWindow);
      else if (console) focus(console.id);
      if (!console && (since === undefined || Date.now() - since > launchPatience)) {
        launched.current.set(current, Date.now());
        openConsole(selection);
      }
    } else if (windowTab !== null) {
      focus(windowTab);
    }
  }, [current, selection?.pane.terminal_id]);

  /** Shows PATH of ROOT in the viewer, remembering it among the project's recent files. */
  function openFile(root: string, path: string) {
    setChosen({ ...chosen, [root]: path });
    setRecent({ ...recent, [root]: [path, ...(recent[root] ?? []).filter((other) => other !== path)].slice(0, 30) });
  }

  function openFinder(mode: FinderMode) {
    if (!selection && mode !== "workspace") {
      say("The finder searches a pane's project: select a pane first.", "error");
      return;
    }
    toggle({ kind: "finder", mode, opened: Date.now() });
  }

  function finderGo(target: FinderTarget) {
    setOverlay(null);
    if ("pane" in target) {
      setSelected(target.pane as TabKey);
      return;
    }
    if ("directory" in target) {
      void addWorkspace(target.directory);
      return;
    }
    const root = project.root;
    if (!root || !current) return;
    openFile(root, target.path);
    setJump({ ...target, root, seq: Date.now() });
    // The file shows in the viewer, which comes back if it was folded or behind a window.
    if (shownWindow !== null) showInViewer(current, null);
    if (split.show === "console") setSplit({ ...split, show: "both" });
  }

  const projects = state.sessions.flatMap((session) => (session.snapshot?.panes ?? [])
    .filter((pane) => paneKey(session.name, pane.pane_id) !== current)
    .map((pane) => ({
      key: paneKey(session.name, pane.pane_id),
      title: `${paneName(pane, session.snapshot!.agents.find((agent) => agent.pane_id === pane.pane_id))} · ${session.name}`,
      directory: directoryOf(pane) ?? "",
      status: pane.agent_status,
    })));

  function step(by: number) {
    if (!order.length) return;
    const index = current ? order.indexOf(current) : -1;
    setSelected(order[(index + by + order.length) % order.length]);
  }

  function show(next: Split["show"]) {
    setSplit({ ...split, show: next });
    if (!current) return;
    // The keyboard goes where there is still something to type into.
    const console = consoles.get(current);
    if (next === "viewer" && shownWindow !== null) focus(shownWindow);
    else if (next !== "viewer" && console) focus(console.id);
  }

  function rescale(next: number) {
    setUiScale(next);
    say(`UI ${Math.round(next * 100)}%`);
  }

  function nudge(by: number) {
    setSplit({ show: "both", share: clampShare(split.share + by) });
  }

  async function addTab(session: Session, workspace: string) {
    try {
      const pane = await newTab(session, workspace, selection ? directoryOf(selection.pane) : null);
      setSelected(paneKey(session.name, pane));
    } catch (error) {
      say((error as Error).message, "error");
    }
  }

  /** Opens DIRECTORY (as typed: "~" is home) as a new workspace, in the selected pane's session or the first running one. */
  async function addWorkspace(directory: string) {
    const session = selection?.session ?? state.sessions.find((candidate) => candidate.running);
    if (!session) {
      say("No herdr session is running: start one first.", "error");
      return;
    }
    if (!(await isDirectory(directory))) {
      say(`Not a directory: ${directory}`, "error");
      return;
    }
    const path = expandHome(directory).replace(/(.)\/+$/, "$1");
    try {
      const pane = await newWorkspace(session, path, path.split("/").pop() || path);
      setSelected(paneKey(session.name, pane));
    } catch (error) {
      say((error as Error).message, "error");
    }
  }

  /** Runs a herdr action, saying DONE when it worked and herdr's error when not. */
  function act(work: Promise<unknown>, done: string) {
    work.then(() => say(done), (error: Error) => say(error.message, "error"));
  }

  const paneLabel = (key: TabKey | null) => {
    const found = resolve(state.sessions, key);
    return found ? `${paneName(found.pane, found.agent)} · ${found.tabLabel}` : null;
  };

  /** A row's menu: everything it can do, the destructive asking first. */
  function menuFor(target: MenuTarget): Omit<MenuSpec, "x" | "y"> {
    const fold = (key: string): MenuItem => ({
      label: collapsed[key] ? "Expand" : "Collapse",
      onSelect: () => setCollapsed({ ...collapsed, [key]: !collapsed[key] }),
    });
    switch (target.kind) {
      case "session": {
        const { session } = target;
        return {
          title: `Session · ${session.name}`,
          items: session.running
            ? [{ label: "New workspace", keys: "Super+Shift+T", onSelect: () => openFinder("workspace") }, fold(`s:${session.name}`)]
            : [{ label: "Start", onSelect: () => startSession(session) }],
        };
      }
      case "workspace": {
        const { session, workspace } = target;
        const panes = session.snapshot?.panes.filter((pane) => pane.workspace_id === workspace.workspace_id).length ?? 0;
        return {
          title: `Workspace · ${workspace.label}`,
          items: [
            { label: "New tab", keys: "Super+T", onSelect: () => void addTab(session, workspace.workspace_id) },
            fold(`w:${session.name}|${workspace.workspace_id}`),
            "separator",
            {
              label: "Close workspace",
              confirm: `Close · ends ${panes} pane${panes === 1 ? "" : "s"}`,
              onSelect: () => act(closeWorkspace(session, workspace.workspace_id), `Closed ${workspace.label}`),
            },
          ],
        };
      }
      case "pane": {
        const { session, pane } = target;
        const key = paneKey(session.name, pane.pane_id);
        const agent = session.snapshot?.agents.find((candidate) => candidate.pane_id === pane.pane_id);
        const name = paneName(pane, agent);
        return {
          title: `Pane · ${name}`,
          items: [
            { label: "Show", onSelect: () => setSelected(key) },
            {
              label: agent ? "Prompt its agent" : "Run a command",
              keys: "Super+P",
              onSelect: () => { setSelected(key); setOverlay({ kind: "prompt" }); },
            },
            {
              label: "Reattach its console",
              keys: "Super+Return",
              onSelect: () => { const found = resolve(state.sessions, key); if (found) openConsole(found); },
            },
            "separator",
            { label: "Close pane", confirm: "Close · ends what runs in it", onSelect: () => act(closePane(session, pane.pane_id), `Closed ${name}`) },
          ],
        };
      }
      case "window": {
        const { window } = target;
        const attachedTo = owner.get(window.id) ?? null;
        const into = paneLabel(lastPane);
        return {
          title: `Window · ${windowLabel(window)}`,
          items: [
            {
              label: "Show",
              onSelect: () => (attachedTo ? (setSelected(attachedTo), showInViewer(attachedTo, window.id)) : setSelected(`w:${window.id}`)),
            },
            attachedTo
              ? { label: "Detach to its own tab", keys: "Super+Shift+A", onSelect: () => detach(window.id) }
              : { label: into ? `Attach to ${into}` : "Attach to a pane (select one first)", keys: "Super+A",
                  disabled: !into, onSelect: () => attach(window.id, lastPane) },
            "separator",
            { label: "Close window", confirm: "Close · the app may ask to save", onSelect: () => close(window.id) },
          ],
        };
      }
    }
  }

  function openMenu(target: MenuTarget, at: { x: number; y: number }) {
    setOverlay({ kind: "menu", menu: { ...menuFor(target), x: at.x, y: at.y } });
  }

  /** Every shortcut: what binds them, and what the help sheet lists. */
  const shortcuts: (KeyHelp & { bind: string[]; run: () => void })[] = [
    { group: "Move", keys: "Super+J", bind: ["Super+J", "Super+Down"], label: "Next pane or window", run: () => step(1) },
    { group: "Move", keys: "Super+K", bind: ["Super+K", "Super+Up"], label: "Previous pane or window", run: () => step(-1) },
    { group: "Move", keys: "Super+N", bind: ["Super+N"], label: "Go to what needs you most", run: () => notices.top && go(notices.top) },
    { group: "Find", keys: "Super+O", bind: ["Super+O"], label: "Find a file in the project", run: () => openFinder("files") },
    { group: "Find", keys: "Super+Shift+O", bind: ["Super+Shift+O"], label: "Search the project (ripgrep)", run: () => openFinder("grep") },
    { group: "Find", keys: "Super+Shift+N", bind: ["Super+Shift+N"], label: "Notification center", run: () => toggle({ kind: "center" }) },
    { group: "Find", keys: "Super+/", bind: ["Super+slash", "Super+question"], label: "These shortcuts", run: () => toggle({ kind: "help" }) },
    { group: "Panes", keys: "Super+P", bind: ["Super+P"], label: "Prompt the agent / run a command", run: () => selection && toggle({ kind: "prompt" }) },
    { group: "Panes", keys: "Super+Return", bind: ["Super+Return"], label: "Reattach the console", run: () => (selection ? openConsole(selection) : launch(terminal)) },
    { group: "Panes", keys: "Super+T", bind: ["Super+T"], label: "New tab in this workspace", run: () => selection && void addTab(selection.session, selection.pane.workspace_id) },
    { group: "Panes", keys: "Super+Shift+T", bind: ["Super+Shift+T"], label: "New workspace from a directory", run: () => openFinder("workspace") },
    { group: "Windows", keys: "Super+A", bind: ["Super+A"], label: "Attach this window to the last pane", run: () => (windowTab !== null ? attach(windowTab, lastPane) : say("Select a window's tab first, then Super+A.", "error")) },
    { group: "Windows", keys: "Super+Shift+A", bind: ["Super+Shift+A"], label: "Detach the window shown in the viewer", run: () => (shownWindow !== null ? detach(shownWindow) : say("No attached window is showing.", "error")) },
    { group: "Windows", keys: "Super+Q", bind: ["Super+Q"], label: "Close the focused window", run: () => focused !== null && close(focused) },
    { group: "Windows", keys: "Super+D", bind: [], label: "Launch an application", run: () => undefined },
    { group: "Layout", keys: "Super+B", bind: ["Super+B"], label: "Fold or unfold the sidebar", run: () => setFolded(!folded) },
    { group: "Layout", keys: "Super+[", bind: ["Super+bracketleft"], label: "Hide or show the code viewer", run: () => show(split.show === "console" ? "both" : "console") },
    { group: "Layout", keys: "Super+]", bind: ["Super+bracketright"], label: "Hide or show the console", run: () => show(split.show === "viewer" ? "both" : "viewer") },
    { group: "Layout", keys: "Super+← / →", bind: [], label: "More room for the console / viewer", run: () => undefined },
    { group: "Layout", keys: "Super+= / - / 0", bind: [], label: "Scale the UI up / down / to 100%", run: () => undefined },
    { group: "Other", keys: "Print / Shift+Print", bind: [], label: "Screenshot the screen / an area", run: () => undefined },
    { group: "Other", keys: "Escape", bind: [], label: "Close the menu, finder, center or help", run: () => undefined },
  ];
  // Keys bound here but listed above as one line.
  const extraBindings: [string, () => void][] = [
    ["Super+Left", () => nudge(-0.05)],
    ["Super+Right", () => nudge(0.05)],
    ...["Super+equal", "Super+plus", "Super+KP_Add"].map((key) => [key, () => rescale(stepScale(uiScale, 1))] as [string, () => void]),
    ...["Super+minus", "Super+KP_Subtract"].map((key) => [key, () => rescale(stepScale(uiScale, -1))] as [string, () => void]),
    ["Super+0", () => rescale(1)],
  ];

  if (!output) return null;
  // Edge to edge: the parts meet at hairline seams, with no margin around them.
  // The layout is in UI units, on the output; windows go where it puts them, in real pixels.
  const ui = uiScale;
  const view = { ...output, width: output.width / ui, height: output.height / ui };
  const area: Rectangle = {
    x: output.workArea.x / ui,
    y: output.workArea.y / ui,
    width: output.workArea.width / ui,
    height: output.workArea.height / ui,
  };
  const boxes = paneBoxes(area, layout);
  const real = (box: Rectangle) => toScreen(box, ui, output.x);
  const shownConsole = current ? consoles.get(current) : undefined;
  const launching = Boolean(current && launched.current.has(current));
  const viewerOut = layout.show === "console";
  const consoleOut = layout.show === "viewer";
  const divider = boxes.divider;

  return (
    <>
      {/* The camera is compositor state another world may have moved; this one wants world = screen. */}
      <Camera x={output.x + output.width / 2} y={output.height / 2} zoom={1} rotation={0} />
      <Reserve left={(folded ? railWidth : sidebarWidth) * ui} />
      <UiScaleProvider value={ui} transition={move}>
      <UiScreen output={output.name}>
        <Rect width={view.width} height={view.height} fill="#d0d7de" />
        {!current && (
          <Text x={area.x} y={area.y + area.height / 2 - 10} width={area.width} align="center"
                size={14} color="#656d76">
            {state.loaded ? "No herdr panes or windows yet" : "Asking herdr…"}
          </Text>
        )}
      </UiScreen>

      {selection && current && (
        <UiScreen output={output.name}>
          <PaneHeader selection={selection} branch={project.branch} box={boxes.header}
                      prompting={prompting} onPromptDone={() => setOverlay(null)}
                      show={layout.show} onShow={show} />
          <ViewerTabs box={boxes.viewer} windows={attachedHere} shown={shownWindow}
                      opacity={viewerOut ? 0 : 1} transition={flow}
                      onShow={(window) => showInViewer(current, window)} onDetach={detach}
                      onMenu={(window, at) => {
                        const found = windows.find((candidate) => candidate.id === window);
                        if (found) openMenu({ kind: "window", window: found }, at);
                      }} />
          <CodeViewer pane={selection.pane} root={project.root} box={boxes.content}
                      shown={!viewerOut && shownWindow === null} transition={flow}
                      path={project.root ? chosen[project.root] ?? null : null}
                      jump={jump && jump.root === project.root ? jump : null}
                      onOpen={(path) => project.root && openFile(project.root, path)}
                      onFinder={openFinder} />
          {!shownConsole && (
            <ConsolePlaceholder box={boxes.console} launching={launching} shown={!consoleOut} transition={flow} />
          )}
        </UiScreen>
      )}

      {windows.map((window) => {
        const isConsole = consoleKey(window) !== null;
        const pane = owner.get(window.id);
        if (window.parent !== null) {
          // A dialog shows centered over the area while its window does.
          const shown = windowTab === window.parent || shownConsole?.id === window.parent
            || (shownWindow === window.parent && !viewerOut);
          const whole = real(area);
          const width = Math.min(window.width || 640, whole.width);
          const height = Math.min(window.height || 480, whole.height);
          return (
            <Window key={window.id} window={window.id} visible={shown}
                    x={whole.x + (whole.width - width) / 2} y={whole.y + (whole.height - height) / 2}
                    border={{ width: 1, color: "#d0d7de" }} />
          );
        }
        const out = isConsole ? consoleOut : pane ? viewerOut : false;
        const visible = isConsole
          ? shownConsole?.id === window.id
          : pane ? pane === current && shownWindow === window.id : windowTab === window.id;
        return (
          <Window
            key={window.id}
            window={window.id}
            {...real(isConsole ? boxes.console : pane ? boxes.content : area)}
            visible={visible}
            opacity={out ? 0 : 1}
            interactive={!out}
            tiled
            border={focused === window.id ? { width: 1, color: "#0969da66" } : undefined}
            transition={flow ?? { opacity: move }}
            initial={{ opacity: 0 }}
            exit={{ opacity: 0 }}
            onActivateRequest={() => activationRequested(window)}
          />
        );
      })}

      {/* Over the windows: a client's own resize border reaches past its edge, onto the divider. */}
      {selection && current && (
        <UiScreen output={output.name}>
          {layout.show === "both" && (
            <>
              <Rect x={divider.x} y={divider.y} width={divider.width} height={divider.height} fill="#ffffff01"
                    cursor="ew-resize" draggable
                    onDrag={({ x }) => setDragShare(clampShare((x - area.x) / (area.width - gap)))}
                    onDragEnd={({ x }) => {
                      setSplit({ show: "both", share: clampShare((x - area.x) / (area.width - gap)) });
                      setDragShare(null);
                    }} />
              {dragShare !== null && (
                <Rect x={divider.x + 3} y={divider.y} width={1} height={divider.height}
                      interactive={false} fill="#0969da" />
              )}
            </>
          )}
        </UiScreen>
      )}

      <Sidebar
        output={view}
        sessions={state.sessions}
        windows={others}
        selected={current}
        collapsed={collapsed}
        error={state.error ?? state.sessions.find((s) => s.error)?.error ?? null}
        loaded={state.loaded}
        folded={folded}
        onFold={setFolded}
        onSelect={setSelected}
        onToggle={(key) => setCollapsed({ ...collapsed, [key]: !collapsed[key] })}
        onStart={(session) => startSession(session)}
        onMenu={openMenu}
        unread={notices.unread}
        onInbox={() => toggle({ kind: "center" })}
        onHelp={() => toggle({ kind: "help" })}
      />

      <FinderOverlay output={view} open={finder} root={project.root}
                     recent={project.root ? recent[project.root] ?? [] : []} projects={projects}
                     onGo={finderGo} onClose={() => setOverlay(null)} />

      {!center && (
        <Banners output={output.name} area={area} notices={notices.banners}
                 onGo={go} onDismiss={notices.dismiss} />
      )}
      <NotificationCenter output={output.name} area={area} open={center} notices={notices.notices}
                          onGo={go} onDismiss={notices.dismiss} onMarkAllRead={notices.markAllRead}
                          onClear={notices.clear} onClose={() => setOverlay(null)} />
      {(overlay?.kind === "menu" || overlay?.kind === "help" || toast) && (
        <UiScreen output={output.name}>
          {overlay?.kind === "menu" && (
            <Menu key={`${overlay.menu.title}|${overlay.menu.x}|${overlay.menu.y}`} menu={overlay.menu}
                  bounds={{ x: 0, y: 0, width: view.width, height: view.height }} onDone={() => setOverlay(null)} />
          )}
          {overlay?.kind === "help" && (
            <HelpSheet entries={shortcuts} bounds={{ x: 0, y: 0, width: view.width, height: view.height }}
                       onClose={() => setOverlay(null)} />
          )}
          {toast && <ToastView toast={toast} bounds={area} />}
        </UiScreen>
      )}
      </UiScaleProvider>

      {shortcuts.flatMap((entry) => entry.bind.map((keys) => <Shortcut key={keys} keys={keys} onPress={entry.run} />))}
      {extraBindings.map(([keys, run]) => <Shortcut key={keys} keys={keys} onPress={run} />)}
      {overlay && <Shortcut keys="Escape" onPress={() => setOverlay(null)} />}
      <Launcher output={output} />
      <Screenshots />
    </>
  );
}
