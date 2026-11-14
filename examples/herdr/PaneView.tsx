// The right side for a herdr pane: a header with where it lives (session ›
// workspace › tab), its agent and herdr's status for it, its directory and
// branch; the code viewer on the project that directory belongs to, with tabs
// for the windows attached to the pane; and the console beside it, a terminal
// attached to the pane itself (see herdr.tsx). The divider between the viewer
// and the console drags to resize them, and either can be folded away.

import { useEffect, useState } from "react";
import { dirname, resolve, sep } from "node:path";
import {
  Box,
  ease,
  Rect,
  Spacer,
  launch,
  Text,
  tween,
  useClipboard,
  useKeyboardGrab,
  usePersistentState,
  Web,
  type Rectangle,
  type Transition,
  type WindowInfo,
} from "proscenium";
import codeViewerPage from "../pages/code-viewer/index.tsx?url";
import { usePageChannel } from "./channel.js";
import { DismissButton, isMenuPress, usePointAt } from "./Ui.js";
import { branchOf, looks, paneName, projectRoot, sendToPane, type Agent, type Pane, type Session } from "./client.js";
import { listFiles, originalFile, readFile, readImage } from "./files.js";

export const headerHeight = 26;
/** The seam between parts: a hairline of the background. */
export const gap = 1;
/** The strip of tabs over the viewer: the code, then the windows attached to the pane. */
export const tabsHeight = 22;
const minShare = 0.18;

const ink = "#1f2328";
const muted = "#656d76";

export interface Selection {
  session: Session;
  pane: Pane;
  agent: Agent | undefined;
  workspaceLabel: string;
  tabLabel: string;
}

/** Which of the viewer and the console show, and the viewer's share of the width when both do. */
export interface Split {
  share: number;
  show: "both" | "viewer" | "console";
}

export const defaultSplit: Split = { share: 0.5, show: "both" };
export const clampShare = (share: number) => Math.min(1 - minShare, Math.max(minShare, share));

export interface PaneBoxes {
  header: Rectangle;
  /** The viewer slot, its tab strip included. */
  viewer: Rectangle;
  /** Below the tab strip: where the code viewer or an attached window goes. */
  content: Rectangle;
  console: Rectangle;
  divider: Rectangle;
}

/**
 * Where everything goes within AREA. A folded side keeps its size and slides
 * out past its edge, fading, so it comes back the way it went.
 */
export function paneBoxes(area: Rectangle, split: Split): PaneBoxes {
  const top = area.y + headerHeight + gap;
  const height = area.height - headerHeight - gap;
  const share = clampShare(split.share);
  let viewerWidth = Math.round((area.width - gap) * share);
  let consoleWidth = area.width - viewerWidth - gap;
  let viewerX = area.x;
  let consoleX = area.x + viewerWidth + gap;
  if (split.show === "viewer") {
    viewerWidth = area.width;
    consoleX = area.x + area.width + 24;
  } else if (split.show === "console") {
    consoleWidth = area.width;
    consoleX = area.x;
    viewerX = area.x - viewerWidth - 24;
  }
  const viewer = { x: viewerX, y: top, width: viewerWidth, height };
  return {
    header: { x: area.x, y: area.y, width: area.width, height: headerHeight },
    viewer,
    content: { x: viewerX, y: top + tabsHeight, width: viewerWidth, height: height - tabsHeight },
    console: { x: consoleX, y: top, width: consoleWidth, height },
    // Wider than the seam, so it is easy to grab.
    divider: { x: area.x + viewerWidth - 3, y: top, width: gap + 6, height },
  };
}

/** The pane's directory: where its foreground process is, else where it started. */
export function directoryOf(pane: Pane): string | null {
  return pane.foreground_cwd || pane.cwd;
}

/** The git project a pane works in, and its branch, looked up off the render path. */
export function useProject(directory: string | null): { root: string | null; branch: string | null } {
  const [project, setProject] = useState<{ directory: string | null; root: string | null; branch: string | null }>(
    { directory: null, root: null, branch: null });
  useEffect(() => {
    if (!directory) return;
    let current = true;
    void Promise.all([projectRoot(directory), branchOf(directory)]).then(([root, branch]) => {
      if (current) setProject({ directory, root, branch });
    });
    return () => {
      current = false;
    };
  }, [directory]);
  return project.directory === directory ? project : { root: null, branch: null };
}

interface HeaderProps {
  selection: Selection;
  branch: string | null;
  box: Rectangle;
  prompting: boolean;
  onPromptDone: () => void;
  show: Split["show"];
  onShow: (show: Split["show"]) => void;
}

export function PaneHeader({ selection, branch, box, prompting, onPromptDone, show, onShow }: HeaderProps) {
  const { session, pane, agent, workspaceLabel, tabLabel } = selection;
  const look = looks(pane.agent_status);
  const kind = agent?.display_agent || agent?.agent;
  const where = [session.name, workspaceLabel, tabLabel].join("  ›  ");
  const facts = [
    branch && `⎇ ${branch}`,
    directoryOf(pane),
    pane.pane_id,
  ].filter(Boolean).join("    ");

  // One row: where, who, status, facts; the prompt takes the facts' place.
  return (
    <Box {...box} paddingX={8} gap={8} alignItems="center" fill="#f6f8fa">
      <Text size={11} color={muted} maxLines={1} flexShrink={2}>{where}</Text>
      <Text size={12} weight="bold" color={ink} maxLines={1} flexShrink={1}>{paneName(pane, agent)}</Text>
      <Box height={16} paddingX={5} alignItems="center" gap={4} fill={`${look.color}26`}>
        <Rect width={5} height={5} fill={look.color} />
        <Text size={10} weight="bold" color={look.color}>{agent ? look.label : "shell"}</Text>
      </Box>
      {kind && <Text size={11} color={muted}>{kind}</Text>}
      {prompting ? (
        <PromptBar selection={selection} width={Math.max(160, box.width * 0.45)} onDone={onPromptDone} />
      ) : pane.agent_status === "blocked" ? (
        <Text size={11} color="#9a6700" maxLines={1} flexShrink={1}>waiting on you in the console</Text>
      ) : (
        <Text size={11} color={muted} maxLines={1} flexShrink={3}>{facts}</Text>
      )}
      <Spacer />
      <ShowSwitch show={show} onShow={onShow} />
    </Box>
  );
}

/** Code only, both, or console only. */
function ShowSwitch({ show, onShow }: { show: Split["show"]; onShow: (show: Split["show"]) => void }) {
  const [hover, setHover] = useState<string | null>(null);
  const options: { value: Split["show"]; label: string }[] = [
    { value: "viewer", label: "Code" },
    { value: "both", label: "Split" },
    { value: "console", label: "Console" },
  ];
  return (
    <Box height={18} gap={1} flexShrink={0}>
      {options.map(({ value, label }) => (
        <Box key={value} height={18} paddingX={6} alignItems="center" cursor="pointer"
             fill={show === value ? "#0969da1f" : hover === value ? "#0000000f" : "transparent"}
             transition={tween(0.15)}
             onPointerEnter={() => setHover(value)} onPointerLeave={() => setHover(null)}
             onPointerDown={() => onShow(value)}>
          <Text size={10.5} weight={show === value ? "bold" : "normal"} color={show === value ? ink : muted}>{label}</Text>
        </Box>
      ))}
    </Box>
  );
}

/**
 * A world-drawn text field: Enter prompts the pane's agent (`herdr agent
 * prompt`), or runs the text as a command in a pane without one (`herdr pane run`).
 */
function PromptBar({ selection, width, onDone }: { selection: Selection; width: number; onDone: () => void }) {
  const [text, setText] = useState("");
  const [state, setState] = useState<{ sending: boolean; error: string | null }>({ sending: false, error: null });
  const { session, pane, agent } = selection;

  useKeyboardGrab((event) => {
    if (!event.pressed || state.sending) return;
    if (event.key === "Escape") return onDone();
    if (event.key === "Return" || event.key === "KP_Enter") {
      if (!text.trim()) return onDone();
      setState({ sending: true, error: null });
      void sendToPane(session, pane.pane_id, text, Boolean(agent)).then((error) => {
        if (error) setState({ sending: false, error });
        else onDone();
      });
      return;
    }
    if (event.key === "BackSpace") {
      const word = event.modifiers.includes("control");
      setText((current) => (word ? current.replace(/\S*\s*$/, "") : current.slice(0, -1)));
      return;
    }
    if (event.text && event.text >= " ") setText((current) => current + event.text);
  });

  const hint = agent ? `Prompt ${paneName(pane, agent)}; Enter sends, Escape cancels` : "Run a command in this pane";
  return (
    <Box width={width} height={18} paddingX={6} alignItems="center" gap={6}
         fill="#ffffff" border={{ width: 1, color: state.error ? "#cf222e" : "#0969da" }}>
      <Text size={12} weight="bold" color="#0969da">{agent ? "›" : "$"}</Text>
      <Text size={12.5} color={text ? ink : muted} maxLines={1} flexShrink={1}>
        {state.sending ? "Sending…" : state.error ?? (text || hint)}
      </Text>
      {!state.sending && !state.error && (
        <Rect width={1.5} height={15} fill={ink}
              animate={{ opacity: [1, 0, 1], duration: 1, iterations: Infinity, ease: ease.steps(2) }} />
      )}
    </Box>
  );
}

const statusOrder = ["unknown", "idle", "working", "blocked", "done"];

/**
 * The code viewer page on the pane's project. The page asks for the tree and
 * files over the channel; `seq` moves with the pane's revision and its agent's
 * status, so the page looks again as the agent works and when it finishes.
 */
/** PATH (relative to ROOT; "" for ROOT itself) as an absolute path, or null when it would leave the project. */
function insideProject(root: string, path: string): string | null {
  const target = resolve(root, path);
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep) ? target : null;
}

/** A jump to a place in a file, from the finder; `seq` tells one jump from the next. */
export interface Jump {
  path: string;
  line?: number;
  column?: number;
  length?: number;
  seq: number;
}

export function CodeViewer({ pane, root, box, shown, transition, path, jump, onOpen, onFinder }: {
  pane: Pane;
  root: string | null;
  box: Rectangle;
  /** False while an attached window or the folded viewer hides it; it stays loaded. */
  shown: boolean;
  transition: Transition | undefined;
  /** The file shown, and the last jump the finder made into this project. */
  path: string | null;
  jump: Jump | null;
  onOpen: (path: string) => void;
  onFinder: (mode: "files" | "grep") => void;
}) {
  const channel = usePageChannel(async (action, args) => {
    // The page may still ask about the project it showed a moment ago; answer only for this one.
    if (!root || args.root !== root) throw new Error("stale request");
    const path = String(args.path ?? "");
    if (action === "list") return listFiles(root);
    if (action === "file") return readFile(root, path);
    if (action === "original") return originalFile(root, path);
    if (action === "image") return readImage(root, path);
    throw new Error(`unknown request ${action}`);
  });
  const [treeOpen, setTreeOpen] = usePersistentState("herdr.fileTree", true);
  const clipboard = useClipboard();

  return (
    <Web
      src={codeViewerPage}
      {...box}
      opacity={shown ? 1 : 0}
      interactive={shown}
      transition={transition}
      props={{
        root: root ?? "",
        title: root?.split("/").pop() ?? "",
        seq: pane.revision * 8 + statusOrder.indexOf(pane.agent_status),
        path,
        jump,
        treeOpen,
        reply: channel.reply,
      }}
      onMessage={(name, value) => {
        if (channel.onMessage(name, value)) return;
        if (name === "open" && root) onOpen(String(value));
        if (name === "tree") setTreeOpen(Boolean(value));
        if (name === "finder") onFinder(value === "grep" ? "grep" : "files");
        if (name === "external" && root) {
          const { path, reveal } = value as { path: string; reveal?: boolean };
          const target = insideProject(root, String(path));
          // Show in folder opens the folder holding it; anything else opens itself.
          if (target) launch(["xdg-open", reveal ? dirname(target) : target]);
        }
        if (name === "copy" && root) {
          const target = insideProject(root, String(value));
          if (target) clipboard.copy(target);
        }
      }}
    />
  );
}

/** Stands where a pane's console goes until its terminal maps. */
export function ConsolePlaceholder({ box, launching, shown, transition }: {
  box: Rectangle;
  launching: boolean;
  shown: boolean;
  transition: Transition | undefined;
}) {
  return (
    <Box {...box} fill="#ffffff"
         opacity={shown ? 1 : 0} transition={transition}
         justifyContent="center" alignItems="center">
      <Text size={11.5} color={muted}>{launching ? "Attaching to the pane…" : "Super+Return attaches a console here"}</Text>
    </Box>
  );
}

interface ViewerTabsProps {
  box: Rectangle;
  windows: readonly WindowInfo[];
  /** The attached window showing, or null for the code. */
  shown: number | null;
  opacity: number;
  transition: Transition | undefined;
  onShow: (window: number | null) => void;
  onDetach: (window: number) => void;
  /** A window tab's menu, asked for at a point in UI units. */
  onMenu: (window: number, at: { x: number; y: number }) => void;
}

/** The tabs over the viewer: the code, then each window attached to the pane, with a × that detaches it. */
export function ViewerTabs({ box, windows, shown, opacity, transition, onShow, onDetach, onMenu }: ViewerTabsProps) {
  const [hover, setHover] = useState<string | null>(null);
  const pointAt = usePointAt();
  const tabs: { key: string; window: number | null; label: string }[] = [
    { key: "code", window: null, label: "Code" },
    ...windows.map((window) => ({ key: `w${window.id}`, window: window.id, label: windowLabel(window) })),
  ];
  return (
    <Box x={box.x} y={box.y} width={box.width} height={tabsHeight - 1} gap={1} opacity={opacity} fill="#f6f8fa"
         transition={transition} interactive={opacity > 0}>
      {tabs.map((tab) => {
        const chosen = tab.window === shown;
        return (
          <Box key={tab.key} height={tabsHeight - 1} paddingX={8} gap={6} alignItems="center"
               cursor="pointer" flexShrink={tab.window === null ? 0 : 1}
               fill={chosen ? "#ffffff" : hover === tab.key ? "#0000000a" : "transparent"}
               onPointerEnter={() => setHover(tab.key)} onPointerLeave={() => setHover(null)}
               onPointerDown={(event) => (tab.window !== null && isMenuPress(event)
                 ? onMenu(tab.window, pointAt(event))
                 : onShow(tab.window))}>
            <Rect width={5} height={5}
                  fill={tab.window === null ? "#0969da" : "#656d76"} />
            <Text size={11} color={chosen ? ink : muted} weight={chosen ? "bold" : "normal"} maxLines={1} flexShrink={1}>
              {tab.label}
            </Text>
            {tab.window !== null && (
              <DismissButton visible={hover === tab.key || chosen} onPress={() => onDetach(tab.window!)} />
            )}
          </Box>
        );
      })}
      <Spacer />
      {windows.length === 0 && box.width > 440 && (
        <Text size={10.5} color="#8c959f" maxLines={1}>Super+A attaches a window here</Text>
      )}
    </Box>
  );
}

export function windowLabel(window: WindowInfo): string {
  const title = window.title || window.appId || `window ${window.id}`;
  return title.length > 40 ? `${title.slice(0, 39)}…` : title;
}
