/**
 * The Messages panel (Super+I): the shell's update loop as it runs, after
 * Elm's debugger. What comes in from the runtime (keys and presses, and the
 * compositor's news about windows) and the messages `update` takes flow
 * through a map of the loop; each message is listed as it comes, with what it
 * changed in the model, and the model's main fields light up as they change.
 * While it shows, the panel keeps its strip of the first output, and the
 * windows make room for it.
 */

import { useEffect, useRef, useState } from "react";
import {
  Box,
  Group,
  instant,
  Rect,
  Reserve,
  Screen,
  Shortcut,
  spring,
  Spacer,
  Text,
  useInput,
  useModifiers,
  usePersistentState,
  type StageInputEvent,
} from "proscenium";
import { post, sinceStart, useMessageLog, type Message, type MessageKind } from "./message-log.js";
import { alpha, themed, useWarlockTheme } from "./theme.js";
import { useWarlock } from "./WarlockProvider.js";

/** The panel's width, and its gap to the screen's edge. */
export const messagesWidth = 452;
const edge = 14;
const padding = 20;
const inner = messagesWidth - 2 * padding;

const kindTags: Record<MessageKind, string> = { input: "IN", sub: "SUB", msg: "MSG", cmd: "CMD" };

const useStyles = themed((theme) => {
  const { palette, skin } = theme;
  const code = theme.type.code;
  return {
    panel: {
      flexDirection: "column",
      padding,
      paddingBottom: 16,
      radius: 14,
      fill: theme.glass ? alpha(palette.surface, 0.86) : palette.surface,
      blur: theme.glass ? 30 : undefined,
      border: { width: 1, color: alpha(palette.borderEssential, 0.55) },
      shadow: theme.shadows.popup,
    } as const,
    kinds: {
      input: palette.warning,
      sub: palette.info,
      msg: palette.brandText,
      cmd: palette.positive,
    } as Record<MessageKind, string>,
    title: { ...theme.type.title, maxLines: 1 } as const,
    signature: { ...code, size: theme.rem(12), color: palette.textSecondary, maxLines: 1 } as const,
    pill: {
      position: "absolute",
      height: 30,
      radius: 8,
      fill: palette.surfaceRaised,
      border: { width: 1, color: alpha(palette.text, 0.14) },
      justifyContent: "center",
      alignItems: "center",
    } as const,
    pillText: { ...code, size: theme.rem(12), color: palette.text, maxLines: 1 } as const,
    wire: alpha(palette.text, 0.22),
    laneText: { ...code, size: theme.rem(10), color: palette.textSecondary, maxLines: 1 } as const,
    stat: {
      flexGrow: 1,
      flexBasis: 0,
      flexDirection: "column",
      paddingX: 10,
      paddingY: 7,
      radius: 8,
      fill: skin.tile,
    } as const,
    statValue: { ...code, size: theme.rem(15), weight: 600, color: palette.text, maxLines: 1 } as const,
    statLabel: { ...theme.type.caption, maxLines: 1 } as const,
    heading: { ...theme.type.caption, color: palette.textSecondary, maxLines: 1 } as const,
    time: { ...code, size: theme.rem(11), color: alpha(palette.textSecondary, 0.8), maxLines: 1 } as const,
    tag: {
      width: 36,
      height: 18,
      radius: 5,
      justifyContent: "center",
      alignItems: "center",
      flexShrink: 0,
      marginTop: 1,
    } as const,
    tagText: { ...code, size: theme.rem(9.5), weight: 700, maxLines: 1 } as const,
    line: { ...code, size: theme.rem(12.5), color: palette.text, maxLines: 1 } as const,
    change: { ...code, size: theme.rem(11.5), color: palette.textSecondary, maxLines: 1 } as const,
    rule: skin.hairline,
    fieldKey: { ...code, size: theme.rem(12), color: palette.textSecondary, maxLines: 1 } as const,
    fieldValue: { ...code, size: theme.rem(12), color: palette.text, maxLines: 1 } as const,
  };
});

/** "01:12.48": minutes, seconds and hundredths since the world started. */
function clock(at: number): string {
  const seconds = at / 1000;
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;
}

const modifierNames: Record<string, string> = {
  logo: "Super",
  super: "Super",
  ctrl: "Ctrl",
  control: "Ctrl",
  alt: "Alt",
  shift: "Shift",
};
const buttonNames: Record<number, string> = { 272: "Left", 273: "Right", 274: "Middle" };
const modifierKey = /^(Super|Alt|Control|Shift|Meta|Hyper|ISO_Level3)_[LR]$|^ISO_Level3_Shift$/;

/** Writes down the keys, presses and wheel turns the shell hears while the panel shows. */
function InputTap() {
  // The compositor's word on held modifiers can come after the key they modify, so a modifier
  // pressed counts as held at once, until the compositor next says what is held.
  const held = useModifiers();
  const modifiers = useRef(new Set<string>());
  useEffect(() => {
    modifiers.current = new Set(held.map((name) => modifierNames[name] ?? name));
  }, [held]);
  useInput((event: StageInputEvent) => {
    const order = ["Super", "Ctrl", "Alt", "Shift"];
    const chord = order.filter((name) => modifiers.current.has(name));
    if (event.kind === "key") {
      const modifier = event.key?.match(modifierKey)?.[1];
      if (modifier) {
        modifiers.current.add(modifier === "Control" ? "Ctrl" : modifier);
        return;
      }
      if (!event.key || modifierKey.test(event.key)) return;
      post("input", "Key", [...chord, event.key].join("+"));
    } else if (event.kind === "button")
      post("input", "Press", [...chord, buttonNames[event.button ?? 0] ?? String(event.button)].join("+"));
    else if (event.kind === "wheel") post("input", "Wheel", chord.join("+"));
    else post("input", "Gesture");
  });
  return null;
}

/** The map of the loop: Runtime, update, Model, view, with each message travelling it. */
function LoopMap({ recent, counts }: { recent: readonly Message[]; counts: Record<MessageKind, number> }) {
  const styles = useStyles();
  const pillWidth = 84;
  const step = (inner - pillWidth) / 3;
  const left = (index: number) => index * step;
  const middle = (index: number) => left(index) + pillWidth / 2;
  const lane = 50;
  const names = ["Runtime", "update", "Model", "view"];
  const hits = [
    counts.input + counts.sub + counts.cmd,
    counts.input + counts.sub + counts.msg + counts.cmd,
    counts.msg,
    counts.msg,
  ];
  const dot = 8;
  const route = (kind: MessageKind) => {
    switch (kind) {
      case "input":
      case "sub":
        return { x: [middle(0), middle(1)], y: [15, 15], duration: 0.42 };
      case "msg":
        return { x: [middle(1), middle(2), middle(3)], y: [15, 15, 15], duration: 0.62 };
      case "cmd":
        return {
          x: [middle(1), middle(1), middle(0), middle(0)],
          y: [15, lane, lane, 15],
          duration: 0.62,
        };
    }
  };
  return (
    <Group width={inner} height={lane + 4} marginTop={16}>
      {/* The wires: forward along the top, commands back along the lane below. */}
      <Rect x={middle(0)} y={14} width={middle(3) - middle(0)} height={2} fill={styles.wire} />
      <Rect x={middle(0) - 1} y={15} width={2} height={lane - 15} fill={styles.wire} />
      <Rect x={middle(1) - 1} y={15} width={2} height={lane - 15} fill={styles.wire} />
      <Rect x={middle(0)} y={lane - 1} width={middle(1) - middle(0)} height={2} fill={styles.wire} />
      <Text style={styles.laneText} x={middle(0) + 14} y={lane - 15}>
        Cmd
      </Text>
      {names.map((name, index) => (
        <Box key={name} style={styles.pill} x={left(index)} y={0} width={pillWidth}>
          <Rect
            position="absolute"
            x={0}
            y={0}
            width={pillWidth}
            height={30}
            radius={8}
            fill={alpha(styles.kinds.msg, 0.38)}
            opacity={0}
            animate={{ opacity: [0.95, 0], duration: 0.55, ease: "ease-out", key: hits[index] }}
          />
          <Text style={styles.pillText}>{name}</Text>
        </Box>
      ))}
      {recent.slice(0, 8).map((message) => {
        const path = route(message.kind);
        return (
          <Rect
            key={`${message.serial}.${message.repeat}`}
            x={path.x.at(-1)! - dot / 2}
            y={path.y.at(-1)! - dot / 2}
            width={dot}
            height={dot}
            radius={dot / 2}
            fill={styles.kinds[message.kind]}
            shadow={{ color: alpha(styles.kinds[message.kind], 0.8), blur: 10 }}
            opacity={0}
            animate={{
              x: path.x.map((x) => x - dot / 2),
              y: path.y.map((y) => y - dot / 2),
              opacity: [1, 1, 0.9, 0],
              duration: path.duration,
              ease: "ease-in-out",
            }}
          />
        );
      })}
    </Group>
  );
}

/** Messages a second over the last twenty seconds, in half-second bars. */
function Rate({ times, now }: { times: readonly number[]; now: number }) {
  const styles = useStyles();
  const bars = 40;
  const span = 500;
  const height = 30;
  const counts = new Array<number>(bars).fill(0);
  for (const at of times) {
    const age = Math.floor((now - at) / span);
    if (age >= 0 && age < bars) counts[bars - 1 - age]! += 1;
  }
  const most = Math.max(4, ...counts);
  const width = (inner - (bars - 1) * 2) / bars;
  return (
    <Group width={inner} height={height} marginTop={12}>
      {counts.map((count, index) => (
        <Rect
          key={index}
          x={index * (width + 2)}
          y={height - Math.max(2, (count / most) * height)}
          width={width}
          height={Math.max(2, (count / most) * height)}
          radius={1.5}
          fill={count > 0 ? alpha(styles.kinds.msg, 0.35 + 0.65 * (count / most)) : styles.wire}
        />
      ))}
    </Group>
  );
}

function Row({ message, newest }: { message: Message; newest: boolean }) {
  const styles = useStyles();
  const color = styles.kinds[message.kind];
  const { motion } = useWarlock();
  return (
    <Box
      flexDirection="row"
      gap={10}
      paddingX={8}
      paddingY={6}
      radius={8}
      fill={newest ? alpha(color, 0.1) : "#00000000"}
      initial={{ opacity: 0, x: 56 }}
      transition={motion === "full" ? spring({ duration: 0.38, bounce: 0.12 }) : instant}
    >
      <Text style={styles.time} width={62} marginTop={2} flexShrink={0}>
        {clock(message.at)}
      </Text>
      <Box style={styles.tag} fill={alpha(color, 0.16)}>
        <Text style={styles.tagText} color={color}>
          {kindTags[message.kind]}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} gap={2}>
        <Text style={styles.line}>
          <Text weight={700} color={message.kind === "msg" ? color : undefined}>
            {message.name}
          </Text>
          {message.detail ? ` ${message.detail}` : ""}
          {message.repeat > 1 ? <Text color={color}>{`  ×${message.repeat}`}</Text> : ""}
        </Text>
        {message.changes.slice(0, 3).map((change, index) => (
          <Text key={index} style={styles.change}>
            {change.path}
            {"  "}
            {change.from ? <Text color={alpha(styles.change.color, 0.7)}>{change.from}</Text> : ""}
            {change.from && change.to ? " → " : ""}
            {change.to ? <Text color={color}>{change.to}</Text> : ""}
          </Text>
        ))}
        {message.changes.length > 3 && (
          <Text style={styles.change}>{`…and ${message.changes.length - 3} more`}</Text>
        )}
      </Box>
    </Box>
  );
}

/** A field of the model, lit up for a moment when its value changes. */
function Field({ name, value }: { name: string; value: string }) {
  const styles = useStyles();
  const seen = useRef({ value, changes: 0 });
  if (seen.current.value !== value) seen.current = { value, changes: seen.current.changes + 1 };
  return (
    <Box flexDirection="row" paddingX={8} paddingY={3} radius={6}>
      <Rect
        position="absolute"
        x={0}
        y={0}
        width={inner}
        height={24}
        radius={6}
        fill={alpha(styles.kinds.msg, 0.22)}
        opacity={0}
        animate={
          seen.current.changes > 0
            ? { opacity: [1, 0], duration: 1.1, ease: "ease-out", key: seen.current.changes }
            : undefined
        }
      />
      <Text style={styles.fieldKey} width={96} flexShrink={0}>
        {name}
      </Text>
      <Text style={styles.fieldValue} flexShrink={1}>
        {value}
      </Text>
    </Box>
  );
}

function ModelView() {
  const { state, roots, focusedRoot, label, activeWorkspace, workspaces, popup } = useWarlock();
  const here = roots.map((id) => state.windows[id]).filter((record) => record !== undefined);
  const count = (placement: string) => here.filter((record) => record.placement === placement).length;
  const minimized = here.filter((record) => record.minimized).length;
  const parts = [
    `${count("tiled")} tiled`,
    count("snapped") ? `${count("snapped")} snapped` : "",
    count("maximized") ? `${count("maximized")} max` : "",
    count("floating") ? `${count("floating")} floating` : "",
    minimized ? `${minimized} minimized` : "",
  ].filter(Boolean);
  const name = (id: number) => {
    const text = label(id);
    return text.length > 18 ? `${text.slice(0, 17)}…` : text;
  };
  return (
    <>
      <Field name="focused" value={focusedRoot === null ? "Nothing" : `Just ${name(focusedRoot)}`} />
      <Field
        name="workspace"
        value={`${activeWorkspace}  of [${workspaces.join(", ")}]`}
      />
      <Field name="popup" value={popup ? `Just ${popup.mode}` : "Nothing"} />
      <Field name="windows" value={`${here.length}  ${parts.join(" · ")}`} />
      <Field
        name="history"
        value={`[${state.history
          .filter((id) => roots.includes(id))
          .slice(0, 3)
          .map(name)
          .join(", ")}${state.history.length > 3 ? ", …" : ""}]`}
      />
    </>
  );
}

function Panel({ height }: { height: number }) {
  const styles = useStyles();
  const log = useMessageLog();
  const [now, setNow] = useState(sinceStart);
  useEffect(() => {
    const timer = setInterval(() => setNow(sinceStart()), 250);
    return () => clearInterval(timer);
  }, []);
  const lastSecond = log.times.filter((at) => now - at < 1000).length;
  const live = log.recent[0] !== undefined && now - log.recent[0].at < 900;
  const modelHeight = 168;
  return (
    <Box style={styles.panel} width={messagesWidth} height={height}>
      <Box flexDirection="row" alignItems="center">
        <Text style={styles.title}>Messages</Text>
        <Spacer />
        <Rect
          width={8}
          height={8}
          radius={4}
          marginRight={8}
          fill={live ? styles.kinds.msg : styles.wire}
          shadow={live ? { color: styles.kinds.msg, blur: 10 } : undefined}
        />
        <Text style={styles.signature}>{`${lastSecond}/s`}</Text>
      </Box>
      <Text style={styles.signature} marginTop={4}>
        update : Msg → Model → ( Model, Cmd Msg )
      </Text>
      <LoopMap recent={log.recent} counts={log.counts} />
      <Box flexDirection="row" gap={6} marginTop={12}>
        {(["input", "sub", "msg", "cmd"] as const).map((kind) => (
          <Box key={kind} style={styles.stat}>
            <Text style={styles.statValue}>{String(log.counts[kind])}</Text>
            <Box flexDirection="row" alignItems="center" gap={6}>
              <Rect width={6} height={6} radius={3} fill={styles.kinds[kind]} />
              <Text style={styles.statLabel}>
                {{ input: "Input", sub: "Subs", msg: "Msgs", cmd: "Cmds" }[kind]}
              </Text>
            </Box>
          </Box>
        ))}
      </Box>
      <Rate times={log.times} now={now} />
      <Rect height={1} marginTop={14} fill={styles.rule} />
      <Group
        flexGrow={1}
        width={inner + 16}
        marginLeft={-8}
        clip
      >
        <Box flexDirection="column" width={inner + 16} paddingTop={8} gap={2}>
          {log.recent.slice(0, 20).map((message, index) => (
            <Row key={message.serial} message={message} newest={index === 0} />
          ))}
        </Box>
      </Group>
      <Rect
        height={1}
        fill={styles.rule}
        marginBottom={10}
      />
      <Box flexDirection="column" height={modelHeight - 40} gap={1}>
        <Text style={styles.heading} marginBottom={4} marginLeft={8}>
          Model
        </Text>
        <ModelView />
      </Box>
    </Box>
  );
}

/** The Messages panel on the first output, and Super+I to show or hide it. */
export function Messages() {
  const theme = useWarlockTheme();
  const { outputs, notify } = useWarlock();
  const [open, setOpen] = usePersistentState("warlock.messages", false);
  const output = outputs[0];
  return (
    <>
      <Shortcut
        keys="Super+I"
        onPress={() => {
          setOpen(!open);
          notify(open ? "Messages hidden." : "Messages: the update loop, live.", 3);
        }}
      />
      {open && output && (
        <>
          <InputTap />
          <Reserve output={output.name} right={messagesWidth + edge} />
          <Screen output={output.name}>
            <Group
              x={output.width - messagesWidth - edge}
              y={theme.barHeight + edge}
              initial={{ opacity: 0, x: output.width }}
              exit={{ opacity: 0, x: output.width }}
              transition={spring({ duration: 0.45, bounce: 0.08 })}
            >
              <Panel height={output.height - theme.barHeight - 2 * edge} />
            </Group>
          </Screen>
        </>
      )}
    </>
  );
}
