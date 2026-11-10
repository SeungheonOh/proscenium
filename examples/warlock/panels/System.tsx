import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Box, Rect, Text, type BoxProps, type TextProps } from "proscenium";
import type { GlyphName } from "../glyphs.js";
import {
  columnWidth,
  Glyph,
  PopupButton,
  PopupFrame,
  Region,
  useFocus,
  usePopupWidth,
} from "../kit.js";
import {
  changeSystem,
  needsConfirmation,
  operationNames,
  readSystem,
  supported,
  volumePresets,
  type Capability,
  type Change,
  type Outcome,
  type SystemSnapshot,
} from "../system.js";
import { alpha, themed, useWarlockTheme } from "../theme.js";
import { useWarlock } from "../WarlockProvider.js";

const useStyles = themed((theme) => {
  const { palette, skin } = theme;
  const contrast = theme.theme === "high-contrast";
  return {
    quietLabel: { size: theme.rem(13) } satisfies TextProps,
    refreshDetail: { size: theme.rem(11) } satisfies TextProps,
    caption: { ...theme.type.caption, size: theme.rem(13), lineHeight: 1.4 } satisfies TextProps,
    tileLabel: { size: theme.rem(13), lineHeight: 1.3 } satisfies TextProps,
    // Narrow enough that the percent always takes the second line.
    presetLabel: {
      size: theme.rem(12),
      lineHeight: 1.3,
      maxWidth: theme.rem(75),
    } satisfies TextProps,
    /** A tile that cannot be used keeps its fill and edge. */
    tileIdle: { fill: skin.tile, border: { width: 1, color: skin.hairline } } satisfies BoxProps,
    card: {
      radius: 14,
      fill: contrast
        ? palette.surface
        : theme.glass
          ? alpha(palette.surfaceRaised, 0.92)
          : palette.surfaceRaised,
      border: { width: 1, color: skin.hairline },
    } satisfies BoxProps,
    consequence: { ...theme.type.label, size: theme.rem(15), lineHeight: 1.45 } satisfies TextProps,
    /** How much of the mark's colour an unlit bar keeps. */
    unlit: theme.theme === "night" ? 0.26 : 0.4,
  };
});

const capabilityNames: Record<Capability, string> = {
  yes: "available",
  challenge: "authorization required",
  no: "unavailable",
  na: "unavailable",
};

/** What the status line says of a change, after its operation's name. */
const outcomeNotices: Record<Outcome, string> = {
  committed: ": change observed.",
  submitted: ": request accepted by the native service.",
  refused: ": refused or no longer available. Refresh before choosing again.",
  unknown: ": not confirmed. Refresh only reads state; the request will not be repeated.",
};

interface Model {
  /** Null until the first read returns. */
  snapshot: SystemSnapshot | null;
  /** A change on its way, or one that never answered: either blocks further changes. */
  pending: "waiting" | "unconfirmed" | null;
  notice: string;
}

/** A volume preset's mark: four rising bars, as many lit as the preset has quarters. */
function LevelMark({ lit, color }: { lit: number; color: string }) {
  const theme = useWarlockTheme();
  const styles = useStyles();
  const side = theme.rem(22);
  const bar = Math.max(2, Math.round(side * 0.16));
  return (
    <Box width={side} height={side} flexShrink={0}>
      {[0.34, 0.52, 0.7, 0.88].map((share, index) => {
        const height = Math.round(side * share);
        return (
          <Rect
            key={share}
            position="absolute"
            x={Math.round((index * (side - bar)) / 3)}
            y={Math.round((side - height) * 0.85)}
            width={bar}
            height={height}
            fill={alpha(color, index < lit ? 1 : styles.unlit)}
          />
        );
      })}
    </Box>
  );
}

/** A group's heading: a hairline, then its glyph and what was read of it. */
function Caption({
  glyph,
  width,
  children,
}: {
  glyph: GlyphName;
  width: number;
  children: string;
}) {
  const theme = useWarlockTheme();
  const styles = useStyles();
  return (
    <Box flexDirection="column" width={width} marginTop={6}>
      <Rect height={1} fill={theme.skin.hairline} />
      <Box
        flexDirection="row"
        alignItems="center"
        gap={10}
        paddingTop={12}
        paddingX={4}
        paddingBottom={2}
      >
        <Glyph name={glyph} size={18} color={theme.palette.brandText} />
        <Text style={styles.caption} flexShrink={1}>
          {children}
        </Text>
      </Box>
    </Box>
  );
}

interface ConfirmationProps {
  change: Change;
  width: number;
  /** Whether the change can still be made. */
  ready: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/** The card that closes the list while a change waits to be confirmed: what is at stake, then Cancel and Confirm. */
function Confirmation({ change, width, ready, onCancel, onConfirm }: ConfirmationProps) {
  const theme = useWarlockTheme();
  const styles = useStyles();
  const focus = useFocus();
  const name = operationNames[change.operation];
  // Cancel has the keyboard as the card appears.
  useLayoutEffect(() => focus.focus("cancel"), []);
  // Focusing it again once the list has grown to hold the card scrolls all of it into view.
  const reveal = () =>
    queueMicrotask(() => {
      if (focus.focused() !== "cancel") return;
      focus.focus(null);
      focus.focus("cancel");
    });
  const cell = {
    stacked: true,
    flexGrow: 1,
    flexBasis: 0,
    minHeight: theme.rem(48),
    paddingX: 12,
    paddingY: 8,
    // One short of the card's, so a cell's fill and focus ring follow the card's corners.
    radius: 13,
  } as const;
  return (
    <Region
      flexDirection="column"
      width={width}
      marginTop={14}
      style={styles.card}
      onLayout={reveal}
    >
      <Box paddingX={18} paddingTop={16} paddingBottom={14}>
        <Text style={styles.consequence} flexShrink={1}>
          {`Confirm ${name}? Unsaved work or active connections may be affected.`}
        </Text>
      </Box>
      <Rect height={1} fill={theme.skin.hairline} />
      <Region flexDirection="row">
        <PopupButton
          id="cancel"
          label="Cancel system change"
          {...cell}
          onPress={() => {
            onCancel();
            focus.focus("close");
          }}
        />
        <Rect width={1} fill={theme.skin.hairline} />
        <PopupButton
          id="confirm"
          label={`Confirm ${name}`}
          labelStyle={{ weight: 600 }}
          {...cell}
          disabled={!ready}
          onPress={onConfirm}
        />
      </Region>
    </Region>
  );
}

/**
 * The system menu: the volume as five presets and Mute, networking on or off,
 * suspend, restart and shut down, and locking or leaving the session. Each
 * group shows what was read of it, or that it is unavailable. Changes that may
 * cost work are confirmed in a card at the end of the list.
 */
export function SystemPanel() {
  const theme = useWarlockTheme();
  const styles = useStyles();
  const { closePopup } = useWarlock();
  const width = usePopupWidth();
  const [model, setModel] = useState<Model>({
    snapshot: null,
    pending: null,
    notice: "Loading system state…",
  });
  const [reading, setReading] = useState(false);
  const [confirmation, setConfirmation] = useState<Change | null>(null);
  /** False once the menu has closed: what is still on its way then has nowhere to show. */
  const open = useRef(true);
  /** Counts reads, so only the latest one's answer is taken. */
  const reads = useRef(0);

  /** Read the state again; REFRESHED when Refresh asked, which also lets go of a change that never answered. */
  const read = (refreshed: boolean) => {
    const serial = ++reads.current;
    setReading(true);
    void readSystem().then(
      (snapshot) => {
        if (!open.current || serial !== reads.current) return;
        setReading(false);
        setModel((current) => {
          if (refreshed && current.pending === "unconfirmed")
            return {
              snapshot,
              pending: null,
              notice: "System state refreshed. The previous request will not be repeated.",
            };
          const notice = current.pending
            ? current.notice
            : "Current system state. Unavailable controls cannot be changed.";
          return { ...current, snapshot, notice };
        });
      },
      () => {
        if (!open.current || serial !== reads.current) return;
        setReading(false);
        setModel((current) => ({
          ...current,
          notice:
            "System controls unavailable. Refresh system state to read current capabilities. No change will be repeated.",
        }));
      },
    );
  };

  useEffect(() => {
    open.current = true;
    read(false);
    return () => {
      open.current = false;
    };
  }, []);

  const send = (change: Change) => {
    const from = model.snapshot;
    if (!from) return;
    const name = operationNames[change.operation];
    const settle = (outcome: Outcome, snapshot: SystemSnapshot) => {
      if (!open.current) return;
      setModel({
        snapshot,
        pending: outcome === "unknown" ? "unconfirmed" : null,
        notice: name + outcomeNotices[outcome],
      });
    };
    setModel((current) => ({
      ...current,
      pending: "waiting",
      notice: `${name}: waiting for native result…`,
    }));
    void changeSystem(from, change)
      .then(async (outcome) => settle(outcome, await readSystem()))
      .catch(() => settle("unknown", from));
  };

  const { snapshot } = model;
  const busy = reading || model.pending !== null || confirmation !== null;
  const status = reading
    ? "Reading native system state…"
    : confirmation
      ? "Confirm or cancel the requested system change."
      : model.notice;

  // Larger text gives the tiles more of the row.
  const scale = theme.textScale;
  const tileSpan = scale === 200 ? 3 : 2;
  const presetSpan = scale === 200 ? 3 : scale === 150 ? 2 : 1;
  const span = (columns: number) => columnWidth(width, 6, 6, columns);

  const tile = (change: Change, label: string, glyph: GlyphName | null, columns: number) => {
    const disabled = busy || snapshot === null || !supported(snapshot, change);
    const mark = disabled ? theme.palette.textSecondary : theme.palette.brandText;
    return (
      <PopupButton
        key={`${change.operation}:${change.value}`}
        id={`${change.operation}:${change.value}`}
        label={label}
        glyph={glyph ?? undefined}
        glyphSize={22}
        glyphColor={mark}
        leading={glyph === null ? <LevelMark lit={change.value / 25} color={mark} /> : undefined}
        stacked
        variant="tile"
        width={span(columns)}
        minHeight={theme.rem(68)}
        paddingX={glyph === null ? 4 : 6}
        paddingTop={10}
        paddingBottom={9}
        gap={6}
        radius={12}
        style={disabled ? styles.tileIdle : undefined}
        labelStyle={glyph === null ? styles.presetLabel : styles.tileLabel}
        disabled={disabled}
        onPress={() => (needsConfirmation(change) ? setConfirmation(change) : send(change))}
      />
    );
  };

  const quiet = {
    variant: "quiet",
    width: span(scale === 200 ? 6 : 3),
    minHeight: theme.rem(40),
    paddingX: 10,
    glyphSize: 18,
    labelStyle: styles.quietLabel,
  } as const;

  const rows = (current: SystemSnapshot) => {
    const { volume, network, power, session } = current;
    return (
      <>
        <Caption glyph="speaker" width={width}>
          {volume
            ? `Volume ${volume.percent}%; ${volume.muted ? "muted" : "unmuted"} · ${volume.label}`
            : "Volume unavailable"}
        </Caption>
        {volume &&
          volumePresets.map((percent) =>
            tile(
              { operation: "volume", value: percent },
              `Set volume ${percent}%`,
              null,
              presetSpan,
            ),
          )}
        {volume &&
          (volume.muted
            ? tile({ operation: "mute", value: 0 }, "Unmute", "speaker", presetSpan)
            : tile({ operation: "mute", value: 1 }, "Mute", "mute", presetSpan))}

        <Caption glyph="network" width={width}>
          {network
            ? `Network ${network.enabled ? "enabled" : "disabled"} · ${network.state}${network.permission === "no" ? "; changes unavailable" : ""}`
            : "Network unavailable"}
        </Caption>
        {network &&
          (network.enabled
            ? tile({ operation: "network", value: 0 }, "Disable networking", "network", tileSpan)
            : tile({ operation: "network", value: 1 }, "Enable networking", "network", tileSpan))}

        <Caption glyph="power" width={width}>
          {power
            ? `Power · suspend ${capabilityNames[power.suspend]}, restart ${capabilityNames[power.reboot]}, shutdown ${capabilityNames[power.poweroff]}`
            : "Power controls unavailable"}
        </Caption>
        {power && tile({ operation: "suspend", value: 0 }, "Suspend", "suspend", tileSpan)}
        {power && tile({ operation: "reboot", value: 0 }, "Restart", "restart", tileSpan)}
        {power && tile({ operation: "poweroff", value: 0 }, "Shut down", "power", tileSpan)}

        <Caption glyph="desktop" width={width}>
          {session
            ? `Session ${session.name} · ${session.state}; ${session.locked ? "locked" : "unlocked"}`
            : "Session controls unavailable"}
        </Caption>
        {session && tile({ operation: "lock", value: 0 }, "Lock session", "lock", tileSpan)}
        {session && tile({ operation: "logout", value: 0 }, "Log out", "logout", tileSpan)}
      </>
    );
  };

  return (
    <PopupFrame
      title="System"
      status={status}
      initial="close"
      onEscape={closePopup}
      list={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}
    >
      <PopupButton
        id="close"
        glyph="close"
        label="Close system menu"
        {...quiet}
        onPress={closePopup}
      />
      <PopupButton
        id="refresh"
        glyph="refresh"
        label="Refresh system state"
        detail="Read current state; never repeat a change"
        detailStyle={styles.refreshDetail}
        {...quiet}
        disabled={reading}
        onPress={() => {
          setConfirmation(null);
          read(true);
        }}
      />
      {snapshot && rows(snapshot)}
      {snapshot && confirmation && (
        <Confirmation
          change={confirmation}
          width={width}
          ready={!reading && model.pending === null && supported(snapshot, confirmation)}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => {
            setConfirmation(null);
            send(confirmation);
          }}
        />
      )}
    </PopupFrame>
  );
}
