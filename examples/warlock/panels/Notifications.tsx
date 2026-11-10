import { useState } from "react";
import { Box, Group, Rect, Text, type BoxProps, type TextProps } from "proscenium";
import { type GlyphName } from "../glyphs.js";
import {
  columnWidth,
  Glyph,
  PopupButton,
  PopupFrame,
  Region,
  ringShaders,
  useFocus,
  useFocusable,
  usePopupWidth,
  type PopupButtonProps,
} from "../kit.js";
import {
  dismissNotification,
  invokeNotificationAction,
  refreshNotifications,
  setCriticalInterruptions,
  setDoNotDisturb,
  useNotifications,
  type NotificationEntry,
  type Notifications,
} from "../notifications.js";
import { alpha, themed, useWarlockTheme } from "../theme.js";
import { useWarlock } from "../WarlockProvider.js";

/** A card's padding at its sides, and how far its action row stands in: 14px inside its 1px edge. */
const inset = 15;
const cardRadius = 12;
/** Room every label keeps at its end for the mark of a control that cannot be used. */
const cueReserve = 20;

/** OVER at AMOUNT (0..1) on BASE, both "#rrggbb": the opaque colour that gives. */
function mix(over: string, amount: number, base: string): string {
  const channel = (at: number) => {
    const from = parseInt(base.slice(at, at + 2), 16);
    const to = parseInt(over.slice(at, at + 2), 16);
    return Math.round(from + (to - from) * amount)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

/** TEXT with every run of white space, line breaks among it, as one space. */
function clean(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

const useStyles = themed((theme) => {
  const { palette, skin } = theme;
  const dawn = theme.theme === "dawn";
  const contrast = theme.theme === "high-contrast";
  const clear = alpha(palette.text, 0);
  const card = contrast
    ? palette.surface
    : dawn
      ? palette.surfaceRaised
      : mix(palette.text, 0.06, palette.surfaceRaised);
  const washed = (amount: number) => mix(palette.text, amount, palette.surface);
  const on = contrast ? washed(0.22) : alpha(palette.actionFill, dawn ? 0.12 : 0.28);
  const onHover = contrast ? washed(0.3) : alpha(palette.actionFill, dawn ? 0.18 : 0.36);
  const title = { ...theme.type.labelStrong } satisfies TextProps;
  const body = { ...theme.type.label, weight: 400 } satisfies TextProps;
  return {
    clear,
    card,
    cardHistory: contrast ? palette.surface : washed(dawn ? 0.035 : 0.025),
    edge: contrast ? palette.borderEssential : alpha(palette.text, dawn ? 0.12 : 0.09),
    edgeHistory: contrast ? palette.windowEdgeUnfocused : alpha(palette.text, dawn ? 0.08 : 0.06),
    /** The light along the top of a live card and of a tile. */
    sheen: contrast ? null : alpha(palette.text, 0.05),
    /** The shadow under a live card's actions. */
    depth: theme.glass ? { color: "#000000d9", blur: 18, y: 10, spread: -12 } : undefined,
    pill: [
      contrast ? palette.surface : mix(palette.text, dawn ? 0.05 : 0.09, card),
      contrast ? washed(0.22) : mix(palette.text, dawn ? 0.09 : 0.15, card),
      contrast ? washed(0.3) : mix(palette.text, dawn ? 0.13 : 0.2, card),
    ] as const,
    pillEdge: contrast ? palette.borderEssential : alpha(palette.text, 0.14),
    /** An action that can no longer be chosen. */
    pillSpentEdge: contrast ? palette.windowEdgeUnfocused : alpha(palette.text, 0.14),
    quiet: [clear, skin.hover, skin.press] as const,
    tile: [
      contrast
        ? palette.surface
        : dawn
          ? alpha(palette.surfaceRaised, 0.8)
          : alpha(palette.text, 0.05),
      skin.hover,
      skin.press,
    ] as const,
    tileOn: [on, onHover, onHover] as const,
    tileOnEdge: contrast ? palette.brandText : alpha(palette.brandText, 0.5),
    on,
    tileName: { weight: 600, lineHeight: 1.3 } satisfies TextProps,
    tileState: { size: theme.rem(12), lineHeight: 1.35, marginTop: 1 } satisfies TextProps,
    title,
    titleHistory: { ...title, color: palette.textSecondary } satisfies TextProps,
    body,
    bodyHistory: { ...body, color: palette.textSecondary } satisfies TextProps,
    lifecycle: theme.type.detail,
    badge: {
      font: theme.type.label.font,
      size: theme.rem(11),
      weight: 600,
      lineHeight: 1.45,
      color: palette.brandText,
    } satisfies TextProps,
    action: { size: theme.rem(13), weight: 600 } satisfies TextProps,
    dismiss: { size: theme.rem(13), weight: 500 } satisfies TextProps,
  };
});

interface ControlProps extends PopupButtonProps {
  /** Its fill at rest, under the pointer and under a press. */
  fills: readonly [string, string, string];
  edge: string;
  /** Its label's and glyph's colour at rest and under the pointer, when they differ. */
  inks?: readonly [string, string];
  /** How it takes its place in its row. */
  item?: BoxProps;
}

/** A popup button in fills of this panel's own, which the kit's kinds of button do not have. */
function Control({ fills, edge, inks, item, labelStyle, ...button }: ControlProps) {
  const [over, setOver] = useState(false);
  const [down, setDown] = useState(false);
  const ink = inks?.[over ? 1 : 0];
  return (
    <Region
      {...item}
      onPointerEnter={() => setOver(true)}
      onPointerLeave={() => setOver(false)}
      onPointerDown={() => setDown(true)}
      onPointerUp={() => setDown(false)}
    >
      <PopupButton
        flexGrow={1}
        flexShrink={1}
        glyphColor={ink}
        labelStyle={ink === undefined ? labelStyle : { ...labelStyle, color: ink }}
        {...button}
        style={{ fill: fills[down ? 2 : over ? 1 : 0], border: { width: 1, color: edge } }}
      />
    </Region>
  );
}

/** One of the two session choices: a tile that is pressed in while its choice is on. */
function Toggle(props: {
  id: string;
  glyph: GlyphName;
  label: string;
  detail: string;
  on: boolean;
  width: number;
  onPress: () => void;
}) {
  const theme = useWarlockTheme();
  const styles = useStyles();
  const { on, width } = props;
  return (
    <Control
      id={props.id}
      label={props.label}
      detail={props.detail}
      glyph={props.glyph}
      glyphSize={22}
      glyphColor={on ? theme.palette.brandText : undefined}
      selected={on}
      fills={on ? styles.tileOn : styles.tile}
      edge={on ? styles.tileOnEdge : styles.edge}
      item={{ width }}
      flexDirection="column"
      alignItems="stretch"
      justifyContent="flex-start"
      gap={12}
      minHeight={theme.rem(100)}
      // 14px 14px 12px inside its 1px edge.
      paddingLeft={15}
      paddingRight={15 + cueReserve}
      paddingTop={15}
      paddingBottom={13}
      radius={cardRadius}
      labelStyle={styles.tileName}
      detailStyle={on ? { ...styles.tileState, color: theme.palette.text } : styles.tileState}
      leading={
        styles.sheen && (
          <Rect
            position="absolute"
            x={cardRadius}
            y={1}
            width={width - 2 * cardRadius}
            height={1}
            fill={styles.sheen}
            interactive={false}
          />
        )
      }
      onPress={props.onPress}
    />
  );
}

/** An action the keyboard was on when its notification stopped being live: kept in place, and of no effect. */
interface KeptAction {
  /** Its control's name in the focus order, as when it could be chosen. */
  id: string;
  incarnation: number;
  label: string;
  dismiss: boolean;
}

function actionId(entry: NotificationEntry, key: string): string {
  return `notification:${entry.incarnation}:invoke:${key}`;
}

function dismissId(entry: NotificationEntry): string {
  return `notification:${entry.incarnation}:dismiss`;
}

/** Every control a live notification in ENTRIES has. */
function liveControls(entries: readonly NotificationEntry[]): KeptAction[] {
  return entries
    .filter((entry) => entry.state === "live")
    .flatMap((entry) => [
      ...entry.actions.map((action) => ({
        id: actionId(entry, action.key),
        incarnation: entry.incarnation,
        label: clean(action.label),
        dismiss: false,
      })),
      {
        id: dismissId(entry),
        incarnation: entry.incarnation,
        label: "Dismiss notification",
        dismiss: true,
      },
    ]);
}

/**
 * The kept action: it holds the focus it had and says why it does nothing,
 * until focus moves on (ONLEAVE).
 */
function SpentAction({
  action,
  state,
  onLeave,
}: {
  action: KeptAction;
  state: string;
  onLeave: () => void;
}) {
  const theme = useWarlockTheme();
  const styles = useStyles();
  const { focused, element, take } = useFocusable(action.id, {
    onFocus: (has) => !has && onLeave(),
  });
  const ink = theme.palette.textSecondary;
  const pill = !action.dismiss;
  return (
    <Box
      ref={element}
      flexDirection="column"
      justifyContent="center"
      alignItems={pill ? "center" : "flex-start"}
      flexGrow={1}
      flexShrink={1}
      gap={2}
      minHeight={theme.rem(56)}
      paddingLeft={12}
      paddingRight={pill ? 12 : cueReserve}
      paddingY={6}
      radius={pill ? theme.rem(28) : 10}
      fill={pill ? theme.palette.surfaceRecessed : styles.clear}
      border={{ width: 1, color: pill ? styles.pillSpentEdge : styles.clear }}
      shaders={ringShaders(theme, focused)}
    >
      <Box flexDirection="row" alignItems="center" gap={8}>
        {action.dismiss && <Glyph name="close" size={16} color={ink} />}
        <Text
          style={[theme.type.label, pill ? styles.action : styles.dismiss]}
          color={ink}
          flexShrink={1}
        >
          {action.label}
        </Text>
        <Glyph name="unavailable" size={12} color={ink} />
      </Box>
      <Text
        style={theme.type.detail}
        align={pill ? "center" : "start"}
      >{`${state} · Action unavailable`}</Text>
      <Group
        position="absolute"
        x={0}
        y={0}
        width="100%"
        height="100%"
        cursor="not-allowed"
        onPointerDown={take}
      />
    </Box>
  );
}

interface CardProps {
  entry: NotificationEntry;
  first: boolean;
  width: number;
  /** Whether its actions can be chosen now. */
  ready: boolean;
  kept: KeptAction | null;
  onLeaveKept: () => void;
}

/** One notification: who and what, its text, and while it is live what can be done about it. */
function Card({ entry, first, width, ready, kept, onLeaveKept }: CardProps) {
  const theme = useWarlockTheme();
  const styles = useStyles();
  const live = entry.state === "live";
  const body = clean(entry.body);
  const pillHeight = theme.rem(36);
  const spent = [
    theme.palette.surfaceRecessed,
    theme.palette.surfaceRecessed,
    theme.palette.surfaceRecessed,
  ] as const;
  return (
    <Region
      flexDirection="column"
      marginTop={first ? 16 : 8}
      radius={cardRadius}
      fill={live ? styles.card : styles.cardHistory}
      border={{ width: 1, color: live ? styles.edge : styles.edgeHistory }}
      shadow={live ? styles.depth : undefined}
    >
      {live && styles.sheen && (
        <Rect
          position="absolute"
          x={cardRadius}
          y={1}
          width={width - 2 * cardRadius}
          height={1}
          fill={styles.sheen}
          interactive={false}
        />
      )}
      <Box
        flexDirection="row"
        flexWrap="wrap"
        alignItems="center"
        columnGap={12}
        rowGap={2}
        paddingX={inset}
        paddingTop={12}
      >
        <Text
          style={live ? styles.title : styles.titleHistory}
          flexGrow={1}
          flexShrink={1}
          flexBasis={theme.rem(192)}
        >
          {clean(`${entry.app}: ${entry.summary}`)}
        </Text>
        {live ? (
          <Box paddingX={8} paddingY={1} radius={theme.rem(10)} fill={styles.on} flexShrink={0}>
            <Text style={styles.badge} maxLines={1}>
              LIVE
            </Text>
          </Box>
        ) : (
          <Text style={styles.lifecycle} flexShrink={0}>{`History · ${entry.state}`}</Text>
        )}
      </Box>
      {body !== "" && (
        <Box paddingX={inset} paddingTop={4}>
          <Text style={live ? styles.body : styles.bodyHistory} flexGrow={1} flexShrink={1}>
            {body}
          </Text>
        </Box>
      )}
      {live ? (
        <Region flexDirection="row" gap={8} paddingX={inset} paddingY={12}>
          {entry.actions.map((action) => (
            <Control
              key={action.key}
              id={actionId(entry, action.key)}
              label={clean(action.label)}
              stacked
              disabled={!ready}
              fills={ready ? styles.pill : spent}
              edge={styles.pillEdge}
              item={{ flexGrow: 1, flexShrink: 1, flexBasis: 0 }}
              minHeight={pillHeight}
              paddingY={6}
              radius={pillHeight / 2}
              labelStyle={styles.action}
              onPress={() => invokeNotificationAction(entry, action.key)}
            />
          ))}
          <Control
            id={dismissId(entry)}
            label="Dismiss notification"
            glyph="close"
            glyphSize={16}
            disabled={!ready}
            fills={ready ? styles.quiet : [styles.clear, styles.clear, styles.clear]}
            edge={styles.clear}
            inks={[
              theme.palette.textSecondary,
              ready ? theme.palette.text : theme.palette.textSecondary,
            ]}
            // Alone in its row it takes all of it; after actions, only what it needs.
            item={entry.actions.length === 0 ? { flexGrow: 1 } : { flexShrink: 0 }}
            minHeight={pillHeight}
            gap={8}
            paddingRight={cueReserve}
            labelStyle={styles.dismiss}
            onPress={() => dismissNotification(entry)}
          />
        </Region>
      ) : kept ? (
        <Region flexDirection="row" paddingX={inset} paddingY={12}>
          <SpentAction action={kept} state={entry.state} onLeave={onLeaveKept} />
        </Region>
      ) : (
        <Box height={14} />
      )}
    </Region>
  );
}

/** The panel's controls, in the order the keyboard goes through them. */
function Controls({ notifications }: { notifications: Notifications }) {
  const theme = useWarlockTheme();
  const { closePopup } = useWarlock();
  const focus = useFocus();
  const width = usePopupWidth();
  const { entries, ready, reading, doNotDisturb, criticalInterruptions } = notifications;

  // When the notifications change, an action that just stopped being live under the keyboard is kept.
  const [seen, setSeen] = useState(entries);
  const [kept, setKept] = useState<KeptAction | null>(null);
  if (seen !== entries) {
    setSeen(entries);
    const focused = focus.focused();
    const lost = liveControls(seen).find(
      (control) =>
        control.id === focused &&
        !entries.some(
          (entry) => entry.incarnation === control.incarnation && entry.state === "live",
        ),
    );
    if (lost) setKept(lost);
  }
  const release = () => setKept(null);
  const tile = columnWidth(width, 2, 8);
  const header = { minHeight: theme.rem(40), paddingLeft: 10 } as const;

  return (
    <>
      <Region flexDirection="row" gap={8}>
        <PopupButton
          id="close"
          glyph="close"
          label="Close notifications"
          {...header}
          paddingRight={12 + cueReserve}
          onPress={closePopup}
        />
        <PopupButton
          id="refresh"
          glyph="refresh"
          label="Refresh notifications"
          detail={
            reading ? "Reading current targets…" : "Read current targets; no action is repeated"
          }
          {...header}
          flexGrow={1}
          flexShrink={1}
          onPress={refreshNotifications}
        />
      </Region>
      <Region flexDirection="row" gap={8} marginTop={10}>
        <Toggle
          id="dnd"
          glyph="moon"
          label="Do not disturb for this session"
          detail={doNotDisturb ? "On · History still updates" : "Off"}
          on={doNotDisturb}
          width={tile}
          onPress={() => setDoNotDisturb(!doNotDisturb)}
        />
        <Toggle
          id="critical-interrupt"
          glyph="bell"
          label="Allow critical notification interruptions for this session"
          detail={
            criticalInterruptions
              ? "On · Only when Do not disturb is off"
              : "Off · New notifications are polite"
          }
          on={criticalInterruptions}
          width={tile}
          onPress={() => setCriticalInterruptions(!criticalInterruptions)}
        />
      </Region>
      {entries.map((entry, index) => (
        <Card
          key={entry.incarnation}
          entry={entry}
          first={index === 0}
          width={width}
          ready={ready}
          kept={
            kept && kept.incarnation === entry.incarnation && entry.state !== "live" ? kept : null
          }
          onLeaveKept={release}
        />
      ))}
      {kept && !entries.some((entry) => entry.incarnation === kept.incarnation) && (
        // Its notification is gone altogether, replaced or pushed out of history.
        <Region flexDirection="row" marginTop={8}>
          <SpentAction action={kept} state="unavailable" onLeave={release} />
        </Region>
      )}
    </>
  );
}

/**
 * Notifications: Do not disturb and the critical-interruption choice for this
 * session, then every notification the service holds, newest first. A live one
 * shows its producer's actions and Dismiss; the rest are history.
 */
export function NotificationsPanel() {
  const { closePopup } = useWarlock();
  const notifications = useNotifications();
  return (
    <PopupFrame
      title="Notifications"
      status={notifications.notice}
      initial="close"
      onEscape={closePopup}
      list={{ gap: 0 }}
    >
      <Controls notifications={notifications} />
    </PopupFrame>
  );
}
