// The assistant's chat, drawn by the world: its replies as Markdown, its tools
// as they run, and the interfaces it makes, live inside the messages that made
// them. Drag one out by its title bar to keep it elsewhere; its message keeps a
// note of where it went, with a way to bring it back. An app it writes is a
// program of its own, outside the chat: its message keeps a chip saying whether
// it runs, to stop it or start it again.

import { memo, useContext, useEffect, useRef, useState } from "react";
import { Box, Rect, Text, translate, usePersistentState, type AnimatedValues, type Transition } from "proscenium";
import { MarkdownView } from "proscenium/genui";
import { Icon, IconButton, Label, makeStyles, Pressable, ScrollView, StyleSheet, Surface, TextField,
  type ScrollViewHandle } from "proscenium/ui";
import alertIcon from "./icons/alert.svg";
import appIcon from "./icons/app.svg";
import checkIcon from "./icons/check.svg";
import closeIcon from "./icons/close.svg";
import plusIcon from "./icons/plus.svg";
import sendIcon from "./icons/send.svg";
import sparkleIcon from "./icons/sparkle.svg";
import stopIcon from "./icons/stop.svg";
import toolIcon from "./icons/tool.svg";
import type { AppStatus, ChatSnapshot, HostSurface, UIHost } from "./host.js";
import type { ChatMessage, ChatPart, Mode } from "./protocol.js";
import { GrabContext, SurfaceCard } from "./SurfaceCard.js";
import type { Area } from "./Surfaces.js";

const suggestions = [
  "A 25-minute focus timer in the corner",
  "What's using my disk? Show it as a chart",
  "A checklist for packing for a weekend trip",
];

const modeNames: Record<Mode, string> = {
  inline: "in the chat", floating: "on the screen", overlay: "pinned over everything", dock: "docked",
  canvas: "on the canvas", dialog: "as a dialog",
};

const useStyles = makeStyles(({ colors, type, radii, motion, breathe }) => {
  // What a new message or part pushes about moves on the layout spring, as inside interfaces.
  const moves: Transition = { default: motion.pop, x: motion.layout, y: motion.layout, width: motion.layout,
                              height: motion.layout };
  const textMoves: Transition = { default: motion.pop, x: motion.layout, y: motion.layout };
  // Rows in the stream (a suggestion, a moved interface, an app) share one inset.
  const row = { flexDirection: "row", alignItems: "center", paddingX: 12, paddingY: 9, radius: radii.md,
                border: { width: 1, color: colors.line }, alignSelf: "stretch", transition: moves } as const;
  return {
    ...StyleSheet.create({
      panel: { flexDirection: "column", radius: radii.lg, clip: true },
      // Words and marks line up with the messages: 14 in from each side, the × included.
      header: { flexDirection: "row", alignItems: "center", gap: 8, height: 48, paddingLeft: 14, paddingRight: 7,
                alignSelf: "stretch" },
      rule: { height: 1, fill: colors.line, alignSelf: "stretch" },
      content: { paddingX: 14, paddingY: 14, gap: 14 },
      composer: { flexDirection: "row", alignItems: "flex-end", gap: 8, paddingX: 14, paddingY: 12, alignSelf: "stretch" },
      // As tall as a one-line field, so the two sit level.
      send: { width: 32, height: 32, radius: 16, alignItems: "center", justifyContent: "center", transition: motion.pop },
      user: { maxWidth: "86%", paddingX: 12, paddingY: 8, radius: 14, fill: colors.accent, flexDirection: "column",
              transition: moves },
      userText: { ...type.body, color: colors.onAccent },
      message: { flexDirection: "column", alignSelf: "stretch", transition: moves },
      assistant: { flexDirection: "column", gap: 8, alignSelf: "stretch", transition: moves },
      // Centred by layout, which keeps it on whole pixels; Pango centring could blur it.
      event: { ...type.caption, color: colors.faint, alignSelf: "center", transition: textMoves },
      tool: { flexDirection: "row", alignItems: "center", gap: 6, height: 26, paddingX: 10, radius: 13,
              fill: colors.hover, alignSelf: "flex-start", maxWidth: "100%", transition: moves },
      toolLabel: { ...type.caption, color: colors.muted, flexShrink: 1, maxLines: 1 },
      toolCommand: { font: "Noto Sans Mono, monospace", size: 12, color: colors.muted, flexShrink: 1, maxLines: 1 },
      thinking: { ...type.body, color: colors.faint, italic: true, maxLines: 2, transition: textMoves },
      description: { ...type.body, color: colors.muted },
      moved: { ...row, gap: 8 },
      app: { ...row, gap: 10 },
      appMark: { width: 28, height: 28, radius: radii.sm, alignItems: "center", justifyContent: "center",
                 fill: colors.accentSoft },
      appWords: { flexDirection: "column", gap: 2, flexGrow: 1, flexShrink: 1 },
      // Small buttons whose words line up with the row's edge, their hover reaching past it.
      appButtons: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 0, marginRight: -8 },
      chipButton: { height: 26, paddingX: 8, radius: radii.sm, flexDirection: "row", alignItems: "center",
                    transition: motion.pop },
      suggestion: { ...row },
      dot: { width: 6, height: 6, radius: 3, fill: colors.faint },
      typing: { flexDirection: "row", gap: 5, height: 14, alignItems: "center", alignSelf: "flex-start", transition: moves },
      status: { ...type.caption, color: colors.muted, paddingX: 14, paddingTop: 6 },
      title: { ...type.title, color: colors.ink },
    }),
    colors,
    motion,
    breathe,
  };
});

/** A message or part that arrives while the chat is open rises into place. */
const rises: AnimatedValues = { opacity: 0, transform: translate(0, 6) };
const appears: AnimatedValues = { opacity: 0 };

export interface ChatPanelProps {
  host: UIHost;
  chat: ChatSnapshot;
  surfaces: readonly HostSurface[];
  /** The apps running now. */
  apps: readonly AppStatus[];
  area: Area;
  onClose: () => void;
}

/** The chat beside the screen's right edge. */
export function ChatPanel({ host, chat, surfaces, apps, area, onClose }: ChatPanelProps) {
  const styles = useStyles();
  // Kept with the chat's open state, so it survives putting the chat away and reloads.
  const [draft, setDraft] = usePersistentState("genui.draft", "");
  const [waiting, setWaiting] = useState<string | null>(null);
  const scroll = useRef<ScrollViewHandle>(null);

  // A message typed before the assistant connected goes once it does.
  useEffect(() => {
    if (chat.connected && waiting !== null) {
      host.prompt(waiting);
      setWaiting(null);
    }
  }, [chat.connected, waiting]);

  const send = (text: string) => {
    const words = text.trim();
    if (!words) return;
    if (chat.connected) host.prompt(words);
    else setWaiting(words);
    setDraft("");
    scroll.current?.scrollToEnd();
  };

  const messages = waiting === null ? chat.messages
    : [...chat.messages, { id: "waiting", role: "user", parts: [{ type: "text", text: waiting }] } satisfies ChatMessage];
  const status = !chat.connected ? "Starting the assistant…" : chat.error ? chat.error : null;
  // What was here when the chat opened is simply there; what comes after rises into place.
  const atOpen = useRef<Set<string> | null>(null);
  atOpen.current ??= new Set(messages.map((message) => message.id));
  // One place for the typing dots, at the end, kept while the assistant works: they fade
  // while a reply or a running tool shows it is under way, rather than come and go.
  const last = messages.at(-1);
  const lastPart = last?.role === "assistant" ? last.parts.at(-1) : undefined;
  const waitingOnIt = last?.role !== "assistant" || (last.streaming === true
    && (!lastPart || ((lastPart.type === "tool" || lastPart.type === "app") && lastPart.status !== "running")));
  return (
    <Surface variant="card" style={styles.panel} fill={styles.colors.raised} x={area.x} y={area.y} width={area.width}
             height={area.height} transition={styles.motion.slide}>
      <Box style={styles.header}>
        <Icon src={sparkleIcon} size={16} tone="accent" />
        {/* The model's name is part of the title's line, so the two share a baseline. */}
        <Text style={styles.title} flexGrow={1} flexShrink={1} maxLines={1}>
          Assistant
          {chat.model && <Text size={13} weight={500} color={styles.colors.faint}>{`  ${chat.model}`}</Text>}
        </Text>
        <IconButton icon={plusIcon} size={30} iconSize={16} onPress={() => host.resetChat()} />
        <IconButton icon={closeIcon} size={30} iconSize={16} onPress={onClose} />
      </Box>
      <Rect style={styles.rule} />
      <ScrollView ref={scroll} flexGrow={1} flexShrink={1} stickToEnd contentStyle={styles.content}>
        {messages.length === 0 && <Welcome onPick={send} />}
        {messages.map((message) => (
          <MessageView key={message.id} message={message} surfaces={surfaces} apps={apps} host={host}
                       rises={!atOpen.current!.has(message.id)} />
        ))}
        {chat.busy && <Typing shown={waitingOnIt} />}
      </ScrollView>
      {status && <Text style={styles.status} maxLines={2} width="100%" initial={appears} exit={appears}>{status}</Text>}
      <Rect style={styles.rule} />
      <Box style={styles.composer}>
        <TextField value={draft} onChangeText={setDraft} onSubmit={send} multiline autoFocus
                   placeholder="Ask for anything, or for an interface" style={{ flexGrow: 1, flexShrink: 1 }} />
        {chat.busy
          ? <Pressable onPress={() => host.abort()}
                       style={({ hovered }) => [styles.send, { fill: hovered ? styles.colors.controlHover : styles.colors.control }]}>
              <Icon src={stopIcon} size={14} />
            </Pressable>
          : <Pressable onPress={() => send(draft)} disabled={!draft.trim()}
                       style={({ hovered }) => [styles.send, {
                         fill: !draft.trim() ? styles.colors.control : hovered ? styles.colors.accentHover : styles.colors.accent }]}>
              <Icon src={sendIcon} size={16} tone="onAccent" />
            </Pressable>}
      </Box>
    </Surface>
  );
}

function Welcome({ onPick }: { onPick: (text: string) => void }) {
  const styles = useStyles();
  return (
    <Box flexDirection="column" gap={8} alignSelf="stretch" exit={appears}>
      <Label variant="title">What can I make you?</Label>
      <Text style={styles.description} maxLines={3} width="100%">
        Ask a question, or for an interface: it appears here, and you can drag it out onto the screen, an edge, a corner or the canvas.
      </Text>
      <Box flexDirection="column" gap={8} alignSelf="stretch" paddingTop={6}>
        {suggestions.map((suggestion) => (
          <Pressable key={suggestion} onPress={() => onPick(suggestion)}
                     style={({ hovered, pressed }) => [styles.suggestion, { fill: pressed ? styles.colors.press : hovered ? styles.colors.hover : styles.colors.clear }]}>
            <Label tone="soft">{suggestion}</Label>
          </Pressable>
        ))}
      </Box>
    </Box>
  );
}

/** One message; it renders again only when it, or the interfaces, change. */
const MessageView = memo(function MessageView({ message, surfaces, apps, host, rises: arrives }: {
  message: ChatMessage; surfaces: readonly HostSurface[]; apps: readonly AppStatus[]; host: UIHost;
  /** It came while the chat was open, so it rises into place. */
  rises: boolean;
}) {
  const styles = useStyles();
  const initial = arrives ? rises : undefined;
  if (message.role === "user") {
    const words = message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
    return (
      <Box flexDirection="row" justifyContent="flex-end" alignSelf="stretch" transition={styles.message.transition}
           initial={initial}>
        <Box style={styles.user}>
          <Text style={styles.userText}>{words}</Text>
        </Box>
      </Box>
    );
  }
  if (message.role === "event") {
    const words = message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
    return <Text style={styles.event} initial={initial}>{words}</Text>;
  }
  const last = message.parts.at(-1);
  return (
    <Box style={styles.assistant} initial={initial}>
      {message.parts.map((part, index) => (
        <PartView key={part.type === "text" || part.type === "thinking" ? index : `${part.type}:${part.id}`} part={part}
                  live={message.streaming === true && part === last} surfaces={surfaces} apps={apps} host={host}
                  rises={message.streaming === true} />
      ))}
      {message.error && <Label tone="danger" maxLines={4} width="100%" initial={appears}>{message.error}</Label>}
    </Box>
  );
});

function PartView({ part, live, surfaces, apps, host, rises: arrives }: {
  part: ChatPart; live: boolean; surfaces: readonly HostSurface[]; apps: readonly AppStatus[]; host: UIHost;
  /** Its message is still coming, so a part new in it fades in. */
  rises: boolean;
}) {
  const styles = useStyles();
  const dragging = useContext(GrabContext)?.dragging ?? null;
  const initial = arrives ? appears : undefined;
  switch (part.type) {
    case "text":
      return part.text.trim() ? <MarkdownView text={part.text} initial={initial} transition={styles.message.transition} /> : null;
    case "thinking":
      return live ? <Text style={styles.thinking} width="100%" initial={appears} exit={appears}>
        {lastLine(part.text) || "Thinking…"}</Text> : null;
    case "app":
      if (part.status === "done" && part.name) return <AppChip name={part.name} title={part.title ?? part.name} apps={apps} host={host} />;
      // While it is written, or when it failed, it is a tool like the others.
      return <ToolPill label={part.label} status={part.status} initial={initial} />;
    case "tool":
      return <ToolPill label={part.label} status={part.status} initial={initial} />;
    case "ui": {
      const entry = surfaces.find((surface) => surface.agent && surface.id === part.id);
      if (!entry) return null;
      if (entry.mode === "inline") {
        // No identity to hand over: a place on the screen means nothing in the scrolling chat, so a
        // card brought back fades in here as it fades out there.
        return <SurfaceCard key={entry.placed} entry={entry} chrome="slim" width="100%" dimmed={dragging === entry.key}
                            frame={{ initial: appears, exit: appears }} />;
      }
      return (
        <Box style={styles.moved} initial={appears}>
          <Label tone="muted" flexShrink={1} flexGrow={1} maxLines={2}>{`${entry.title ?? entry.id} is ${modeNames[entry.mode]}`}</Label>
          <Box style={styles.appButtons}>
            <ChipButton label="Bring back" onPress={() => host.place(entry.key, "inline")} />
          </Box>
        </Box>
      );
    }
  }
}

function ToolPill({ label, status, initial }: { label: string; status: "running" | "done" | "error"; initial?: AnimatedValues }) {
  const styles = useStyles();
  // A command reads as one, in the face code is shown in.
  const command = label.startsWith("$ ");
  return (
    <Box style={styles.tool} initial={initial}>
      <Icon src={status === "error" ? alertIcon : status === "done" ? checkIcon : toolIcon} size={14}
            tone={status === "error" ? "danger" : "muted"} animate={status === "running" ? styles.breathe : undefined} />
      <Text style={command ? styles.toolCommand : styles.toolLabel}>{label}</Text>
    </Box>
  );
}

/** An app the assistant wrote or started: whether it runs, and a way to stop it or start it again. */
function AppChip({ name, title, apps, host }: { name: string; title: string; apps: readonly AppStatus[]; host: UIHost }) {
  const styles = useStyles();
  const running = apps.find((app) => app.name === name);
  const state = !running ? "Stopped" : running.interfaces ? `Running · ${running.interfaces} open` : "Running in the background";
  return (
    <Box style={styles.app}>
      <Box style={styles.appMark}>
        <Icon src={appIcon} size={16} tone="accent" />
      </Box>
      <Box style={styles.appWords}>
        <Label variant="strong" maxLines={1}>{title}</Label>
        <Label tone="muted" maxLines={1}>{`App · ${state}`}</Label>
      </Box>
      <Box style={styles.appButtons}>
        {/* Running with nothing open (a timer counting with its card closed): it can show itself again. */}
        {running && !running.interfaces && <ChipButton label="Open" onPress={() => host.startApp(name)} />}
        <ChipButton label={running ? "Stop" : "Start"} onPress={() => (running ? host.stopApp(name) : host.startApp(name))} />
      </Box>
    </Box>
  );
}

function ChipButton({ label, onPress }: { label: string; onPress: () => void }) {
  const styles = useStyles();
  return (
    <Pressable onPress={onPress} flexShrink={0}
               style={({ hovered, pressed }) => [styles.chipButton, {
                 fill: pressed ? styles.colors.accentSoftPress : hovered ? styles.colors.accentSoft : styles.colors.clear }]}>
      {({ hovered }) => <Label tone={hovered ? "accent" : "soft"} variant="strong" transition={styles.motion.pop}>{label}</Label>}
    </Pressable>
  );
}

/** Three dots that breathe, one after another, while the assistant works; faded while what it does shows already. */
function Typing({ shown }: { shown: boolean }) {
  const styles = useStyles();
  return (
    <Box style={styles.typing} opacity={shown ? 1 : 0} initial={appears} exit={appears}>
      {[0, 1, 2].map((index) => (
        <Rect key={index} style={styles.dot} animate={{ ...styles.breathe, delay: index * 0.18 }} />
      ))}
    </Box>
  );
}

function lastLine(text: string): string {
  const lines = text.trim().split("\n").filter((line) => line.trim());
  return (lines.at(-1) ?? "").replace(/^[#*\s]+/, "").replace(/\*\*/g, "").slice(0, 160);
}
