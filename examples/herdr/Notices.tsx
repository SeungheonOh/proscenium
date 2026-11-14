// Notifications. Every moment worth knowing goes into a history: an agent
// asking for you (blocked), one finishing its work, a hidden window asking to
// be shown. Each new one also shows as a banner at the top right for a while;
// a question stays there until it is answered or you go to it. The center, a
// drawer on the right (Super+Shift+N, or the inbox in the sidebar's header),
// keeps them all: what still needs you first, then the rest, newest first,
// read or not. Clicking one goes to it; Super+N goes to the most pressing.

import { useEffect, useRef, useState } from "react";
import { Box, Group, Rect, Spacer, spring, Text, type Rectangle } from "proscenium";
import { UiScreen } from "./UiScale.js";
import { looks, paneName, type AgentStatus, type Session } from "./client.js";
import { paneKey, type TabKey } from "./Sidebar.js";

export interface Notice {
  id: number;
  /** What going to the notice selects. */
  target: TabKey;
  /** An attached window to bring up in its pane's viewer. */
  window?: number;
  kind: "blocked" | "done" | "window";
  title: string;
  detail: string;
  at: number;
  read: boolean;
  /** A question since answered, or a pane since gone. */
  resolved: boolean;
  /** Still showing as a banner. */
  banner: boolean;
}

const bannerFor = 8_000;
const keep = 100;
const bannerWidth = 300;
const bannerHeight = 40;
const centerWidth = 340;
const rowHeight = 46;
const slide = spring({ duration: 0.3, bounce: 0.08 });

let nextId = 1;

/** Whether NOTICE still asks something of you. */
const pressing = (notice: Notice) => notice.kind === "blocked" && !notice.resolved;

export function useNotices(sessions: readonly Session[], loaded: boolean, current: TabKey | null) {
  const [notices, setNotices] = useState<Notice[]>([]);
  const last = useRef<Map<TabKey, AgentStatus> | null>(null);

  // herdr's agents, watched for the moments worth a notice; the first look only learns what is there.
  useEffect(() => {
    if (!loaded) return;
    const statuses = new Map<TabKey, AgentStatus>();
    const raised: Notice[] = [];
    for (const session of sessions) {
      for (const pane of session.snapshot?.panes ?? []) {
        const key = paneKey(session.name, pane.pane_id);
        const status = pane.agent_status;
        statuses.set(key, status);
        const before = last.current?.get(key);
        if (!last.current || before === status) continue;
        const agent = session.snapshot!.agents.find((candidate) => candidate.pane_id === pane.pane_id);
        const title = paneName(pane, agent);
        const workspace = session.snapshot!.workspaces.find((w) => w.workspace_id === pane.workspace_id)?.label;
        const detail = `${session.name} · ${workspace ?? pane.workspace_id}`;
        const base = { id: nextId++, target: key, detail, at: Date.now(), resolved: false };
        const here = key === current;
        if (status === "blocked") {
          raised.push({ ...base, kind: "blocked", title: `${title} needs you`, read: false, banner: true });
        } else if (status === "done" && before === "working") {
          raised.push({ ...base, kind: "done", title: `${title} finished`, read: here, banner: !here });
        }
      }
    }
    last.current = statuses;
    setNotices((shown) => {
      let changed = raised.length > 0;
      const updated = shown.map((notice) => {
        if (notice.resolved || notice.kind === "window") return notice;
        // A question answered, or a pane gone, is settled; its banner goes.
        const settled = !statuses.has(notice.target)
          || (notice.kind === "blocked" && statuses.get(notice.target) !== "blocked");
        if (!settled) return notice;
        changed = true;
        return { ...notice, resolved: true, banner: false };
      });
      return changed ? [...raised, ...updated].slice(0, keep) : shown;
    });
  }, [sessions, loaded]);

  // Going somewhere reads what it raised and takes down its banners.
  useEffect(() => {
    if (current) markRead(current);
  }, [current]);

  // Banners other than open questions come down on their own.
  useEffect(() => {
    const timed = notices.filter((notice) => notice.banner && !pressing(notice));
    if (!timed.length) return;
    const due = Math.min(...timed.map((notice) => notice.at + bannerFor)) - Date.now();
    const timer = setTimeout(() => {
      setNotices((shown) => shown.map((notice) =>
        notice.banner && !pressing(notice) && notice.at + bannerFor <= Date.now() ? { ...notice, banner: false } : notice));
    }, Math.max(0, due) + 50);
    return () => clearTimeout(timer);
  }, [notices]);

  function markRead(target: TabKey) {
    setNotices((shown) => shown.some((notice) => notice.target === target && (!notice.read || notice.banner))
      ? shown.map((notice) => notice.target === target ? { ...notice, read: true, banner: false } : notice)
      : shown);
  }

  const unread = notices.filter((notice) => !notice.read).length;
  return {
    notices,
    banners: notices.filter((notice) => notice.banner),
    unread,
    /** The most pressing: open questions first, then unread, newest first among equals. */
    top: [...notices]
      .filter((notice) => pressing(notice) || !notice.read)
      .sort((a, b) => Number(pressing(b)) - Number(pressing(a)) || b.at - a.at)[0] ?? null,
    raise: (notice: Pick<Notice, "target" | "window" | "kind" | "title" | "detail">) =>
      setNotices((shown) => [{ ...notice, id: nextId++, at: Date.now(), read: false, resolved: false, banner: true },
                             ...shown].slice(0, keep)),
    markRead,
    markAllRead: () => setNotices((shown) => shown.map((notice) => ({ ...notice, read: true, banner: false }))),
    dismiss: (id: number) => setNotices((shown) => shown.filter((notice) => notice.id !== id)),
    /** Clears all but the questions still open. */
    clear: () => setNotices((shown) => shown.filter(pressing)),
    hideBanners: () => setNotices((shown) => shown.some((notice) => notice.banner)
      ? shown.map((notice) => ({ ...notice, banner: false })) : shown),
  };
}

const colors: Record<Notice["kind"], string> = {
  blocked: looks("blocked").color,
  done: looks("done").color,
  window: "#0969da",
};

function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

interface BannersProps {
  output: string;
  /** The area they stack in the top right of, in the output's coordinates. */
  area: Rectangle;
  notices: readonly Notice[];
  onGo: (notice: Notice) => void;
  onDismiss: (id: number) => void;
}

/** The newest notices, at the top right, until they time out, are read, or are answered. */
export function Banners({ output, area, notices, onGo, onDismiss }: BannersProps) {
  const [hover, setHover] = useState<number | null>(null);
  const x = area.x + area.width - bannerWidth;
  return (
    <UiScreen output={output}>
      {notices.slice(0, 4).map((notice, index) => {
        const color = colors[notice.kind];
        return (
          <Box key={notice.id} x={x} y={area.y + index * (bannerHeight + 1)}
               width={bannerWidth} height={bannerHeight} paddingRight={6} gap={8} alignItems="center"
               fill={hover === notice.id ? "#f6f8fa" : "#ffffff"} border={{ width: 1, color: "#d0d7de" }}
               cursor="pointer" transition={slide}
               initial={{ opacity: 0, x: x + 40 }} exit={{ opacity: 0, x: x + 40 }}
               onPointerEnter={() => setHover(notice.id)} onPointerLeave={() => setHover(null)}
               onPointerDown={() => onGo(notice)}>
            <Rect width={3} height={bannerHeight} fill={color} />
            <Box flexDirection="column" gap={1} flexShrink={1}>
              <Text size={12} weight="bold" color="#1f2328" maxLines={1} width={bannerWidth - 40}>{notice.title}</Text>
              <Text size={10.5} color="#656d76" maxLines={1} width={bannerWidth - 40}>{notice.detail}</Text>
            </Box>
            <Spacer />
            <Box width={16} height={16} justifyContent="center" alignItems="center"
                 fill={hover === notice.id ? "#0000000f" : "transparent"}
                 onPointerDown={(event) => { event.stopPropagation(); onDismiss(notice.id); }}>
              <Text size={12} color="#656d76">×</Text>
            </Box>
          </Box>
        );
      })}
    </UiScreen>
  );
}

interface CenterProps {
  output: string;
  /** The area it slides in at the right edge of, in the output's coordinates. */
  area: Rectangle;
  open: boolean;
  notices: readonly Notice[];
  onGo: (notice: Notice) => void;
  onDismiss: (id: number) => void;
  onMarkAllRead: () => void;
  onClear: () => void;
  onClose: () => void;
}

/** The notification center: a drawer of everything noticed, what still needs you first. */
export function NotificationCenter({ output, area, open, notices, onGo, onDismiss, onMarkAllRead, onClear, onClose }: CenterProps) {
  const [hover, setHover] = useState<string | null>(null);
  const [scroll, setScroll] = useState(0);
  const [now, setNow] = useState(Date.now());

  // Times stay current while it shows.
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [open]);

  const needing = notices.filter(pressing);
  const rest = notices.filter((notice) => !pressing(notice));
  type Row = { kind: "head"; label: string } | { kind: "notice"; notice: Notice };
  const rows: Row[] = [
    ...(needing.length ? [{ kind: "head", label: `Needs you · ${needing.length}` } as Row] : []),
    ...needing.map((notice) => ({ kind: "notice", notice }) as Row),
    ...(rest.length ? [{ kind: "head", label: "Earlier" } as Row] : []),
    ...rest.map((notice) => ({ kind: "notice", notice }) as Row),
  ];
  const headHeight = 22;
  const top = 26;
  const listHeight = area.height - top;
  let y = 0;
  const placed = rows.map((row) => {
    const at = y;
    y += row.kind === "head" ? headHeight : rowHeight;
    return { row, y: at };
  });
  const maxScroll = Math.max(0, y - listHeight);
  const offset = Math.min(scroll, maxScroll);
  const x = open ? area.x + area.width - centerWidth : area.x + area.width + 8;

  const button = (key: string, label: string, onPress: () => void) => (
    <Box key={key} height={18} paddingX={6} alignItems="center" cursor="pointer"
         fill={hover === key ? "#0000000f" : "transparent"}
         onPointerEnter={() => setHover(key)} onPointerLeave={() => setHover(null)}
         onPointerDown={onPress}>
      <Text size={10.5} color="#656d76">{label}</Text>
    </Box>
  );

  return (
    <UiScreen output={output}>
      <Group x={x} y={area.y} width={centerWidth} height={area.height} transition={slide}
             opacity={open ? 1 : 0} interactive={open}>
        <Rect width={centerWidth} height={area.height} fill="#ffffff" />
        <Rect width={1} height={area.height} fill="#d0d7de" />
        <Box x={1} y={0} width={centerWidth - 1} height={top} paddingX={8} gap={2} alignItems="center" fill="#f6f8fa">
          <Text size={12} weight="bold" color="#1f2328">Notifications</Text>
          <Spacer />
          {button("read", "Mark read", onMarkAllRead)}
          {button("clear", "Clear", onClear)}
          {button("close", "×", onClose)}
        </Box>
        <Rect x={1} y={top - 1} width={centerWidth - 1} height={1} fill="#d0d7de" />
        <Group x={1} y={top} width={centerWidth - 1} height={listHeight} clip
               onWheel={(event) => {
                 if (event.orientation !== "vertical") return;
                 setScroll((current) => Math.max(0, Math.min(maxScroll, current + event.delta * 2)));
               }}>
          <Group y={-offset}>
            {placed.map(({ row, y }) => {
              if (row.kind === "head") {
                return (
                  <Box key={`h:${row.label}`} y={y} width={centerWidth - 1} height={headHeight} paddingX={8}
                       alignItems="flex-end" paddingBottom={3}>
                    <Text size={10} weight="bold" color="#656d76">{row.label.toUpperCase()}</Text>
                  </Box>
                );
              }
              const { notice } = row;
              const key = `n:${notice.id}`;
              const dim = notice.resolved || notice.read;
              return (
                <Box key={key} y={y} width={centerWidth - 1} height={rowHeight} paddingRight={6} gap={8}
                     alignItems="center" cursor="pointer"
                     fill={hover === key ? "#f6f8fa" : notice.read ? "transparent" : "#0969da0a"}
                     onPointerEnter={() => setHover(key)} onPointerLeave={() => setHover(null)}
                     onPointerDown={() => onGo(notice)}>
                  <Rect width={3} height={rowHeight - 1} fill={dim ? "#d0d7de" : colors[notice.kind]} />
                  <Box flexDirection="column" gap={2} flexShrink={1}>
                    <Text size={12} weight={notice.read ? "normal" : "bold"} color={notice.resolved ? "#656d76" : "#1f2328"}
                          maxLines={1} width={centerWidth - 80}>
                      {notice.resolved && notice.kind === "blocked" ? `${notice.title} · answered` : notice.title}
                    </Text>
                    <Text size={10.5} color="#656d76" maxLines={1} width={centerWidth - 80}>{notice.detail}</Text>
                  </Box>
                  <Spacer />
                  <Text size={10.5} color="#8c959f">{ago(notice.at, now)}</Text>
                  <Box width={14} height={14} justifyContent="center" alignItems="center"
                       opacity={hover === key ? 1 : 0}
                       onPointerDown={(event) => { event.stopPropagation(); onDismiss(notice.id); }}>
                    <Text size={12} color="#656d76">×</Text>
                  </Box>
                  <Rect x={0} y={rowHeight - 1} width={centerWidth - 1} height={1} fill="#eaeef2" position="absolute" />
                </Box>
              );
            })}
          </Group>
          {rows.length === 0 && (
            <Text x={8} y={12} width={centerWidth - 16} size={11.5} color="#656d76">
              Nothing yet. Agents asking for you or finishing show up here.
            </Text>
          )}
        </Group>
      </Group>
    </UiScreen>
  );
}
