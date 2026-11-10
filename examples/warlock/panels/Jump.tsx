import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Rect, Text, type BoxProps, type TextProps } from "proscenium";
import {
  catalogEntry,
  forgetLaunchNotice,
  launchEntry,
  launchNotice,
  refreshCatalog,
  useCatalog,
  type CatalogAction,
} from "../catalog.js";
import type { GlyphName } from "../glyphs.js";
import { columnWidth, Glyph, PopupButton, PopupFrame, Region, usePopupWidth } from "../kit.js";
import { recentFiles, type RecentFile, type RecentFiles } from "../recent.js";
import { alpha, themed, useWarlockTheme } from "../theme.js";
import { idleNotice, useWarlock } from "../WarlockProvider.js";

/** Whether the popup about to open takes the launcher's place, and so gives it back on closing. */
let fromApplications = false;

/** Say that the Application actions popup about to open was asked for in Applications: closing it returns there. */
export function jumpReturnsToApplications(): void {
  fromApplications = true;
}

/** The gap between rows, and between the two controls of the top row. */
const gap = 4;

const useStyles = themed((theme) => ({
  top: { minHeight: theme.rem(40), paddingX: 10, flexGrow: 1 } satisfies BoxProps,
  topLabel: { size: theme.rem(13) } satisfies TextProps,
  topDetail: { size: theme.rem(11) } satisfies TextProps,
  title: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingTop: 12,
    paddingX: 4,
    paddingBottom: 2,
  } satisfies BoxProps,
  titleText: { ...theme.type.labelStrong, lineHeight: 1.4, flexShrink: 1 } satisfies TextProps,
  row: {
    minHeight: theme.rem(52),
    paddingLeft: 10,
    paddingRight: 14,
    paddingY: 7,
    gap: 12,
  } satisfies BoxProps,
  rowLabel: { weight: 600 } satisfies TextProps,
  well: {
    width: theme.rem(36),
    height: theme.rem(36),
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    radius: 10,
    fill: alpha(theme.palette.brandText, 0.11),
    border: {
      width: 1,
      color:
        theme.theme === "high-contrast"
          ? theme.palette.borderEssential
          : alpha(theme.palette.brandText, 0.22),
    },
  } satisfies BoxProps,
  note: {
    ...theme.type.label,
    weight: 400,
    color: theme.palette.textSecondary,
    flexShrink: 1,
  } satisfies TextProps,
}));

/** One thing the application can be asked to do: its glyph in a tinted well, a name and what kind of thing it is. */
function ActionRow({
  id,
  glyph,
  label,
  detail,
  onPress,
}: {
  id: string;
  glyph: GlyphName;
  label: string;
  detail: string;
  onPress: () => void;
}) {
  const theme = useWarlockTheme();
  const styles = useStyles();
  return (
    <PopupButton
      id={id}
      label={label}
      detail={detail}
      style={styles.row}
      labelStyle={styles.rowLabel}
      leading={
        <Box style={styles.well}>
          <Glyph name={glyph} color={theme.palette.brandText} />
        </Box>
      }
      onPress={onPress}
    />
  );
}

/**
 * What one application offers besides opening: a new instance, the actions its
 * desktop entry declares and the files it opened lately. Choosing an action
 * or a file starts it and leaves the list open; a new instance closes it.
 */
export function JumpPanel({ entry }: { entry: string }) {
  const theme = useWarlockTheme();
  const styles = useStyles();
  const { closePopup, openPopup, popup, notify } = useWarlock();
  const { entries } = useCatalog();
  const width = usePopupWidth();
  const application = entries.find((candidate) => candidate.id === entry);
  // Null until the application's files have been read once.
  const [recent, setRecent] = useState<RecentFiles | null>(null);
  const [reading, setReading] = useState(true);
  // How the action last chosen went: the status line says it until actions are read again.
  const [outcome, setOutcome] = useState("");
  const [back] = useState(fromApplications);
  const latest = useRef({ reads: 0, outcome });
  latest.current.outcome = outcome;

  /** Read the application's entry and its files again; QUIETLY leaves the status line as it is. */
  const read = useCallback(
    async (quietly: boolean) => {
      const serial = ++latest.current.reads;
      if (!quietly) {
        setReading(true);
        setOutcome("");
      }
      await refreshCatalog();
      const current = catalogEntry(entry);
      const files = current ? await recentFiles(current) : { files: [], unavailable: false };
      // A later read, or the popup closing, makes this one stale.
      if (latest.current.reads !== serial) return;
      setRecent(files);
      setReading(false);
    },
    [entry],
  );

  useEffect(() => {
    fromApplications = false;
    const forgotten = forgetLaunchNotice("action", idleNotice);
    if (forgotten !== null) notify(forgotten);
    void read(false);
    return () => {
      latest.current.reads = -1;
      // With the list closed, the taskbar goes on saying how the last action went.
      if (latest.current.outcome !== "")
        notify(launchNotice("action", latest.current.outcome, idleNotice));
    };
  }, []);

  const close = () => {
    if (back) openPopup({ mode: "applications" }, { output: popup?.output });
    else closePopup();
  };

  /** Start one of the application's own actions, or the application with a file; the list stays. */
  const choose = (options: { action: CatalogAction } | { file: string }) => {
    if (!application) return;
    launchEntry(application, options);
    setOutcome("Application action: submitted to the native launcher.");
    void read(true);
  };

  const status = reading
    ? "Reading application actions…"
    : outcome !== ""
      ? outcome
      : !application
        ? "Application unavailable."
        : recent?.unavailable
          ? "Recent items unavailable."
          : "Choose an application action or recent file.";

  const actions = recent && application ? application.actions : [];
  const files: readonly RecentFile[] = recent && application ? recent.files : [];
  // At the largest text the two controls of the top row each take a row.
  const stacked = theme.textScale === 200;
  const half = stacked ? width : columnWidth(width, 2, gap);

  return (
    <PopupFrame
      title="Application actions"
      status={status}
      initial="close"
      onEscape={close}
      list={{ gap }}
    >
      <Region flexDirection={stacked ? "column" : "row"} gap={gap}>
        <PopupButton
          id="close"
          glyph="close"
          glyphSize={18}
          label="Close application actions"
          width={half}
          style={styles.top}
          labelStyle={styles.topLabel}
          onPress={close}
        />
        <PopupButton
          id="refresh"
          glyph="refresh"
          glyphSize={18}
          label="Refresh application actions"
          detail="Read actions; never repeat a request"
          width={half}
          style={styles.top}
          labelStyle={styles.topLabel}
          detailStyle={styles.topDetail}
          onPress={() => void read(false)}
        />
      </Region>
      <Box flexDirection="column" marginTop={8} marginBottom={4}>
        <Rect height={1} fill={theme.skin.hairline} />
        <Box style={styles.title}>
          <Glyph name="actions" size={18} color={theme.palette.brandText} />
          <Text style={styles.titleText}>
            {recent === null ? "Application actions" : `Actions for ${application?.name ?? entry}`}
          </Text>
        </Box>
      </Box>
      {application && (
        <ActionRow
          id="new-instance"
          glyph="newWindow"
          label="New instance"
          detail={application.name}
          onPress={() => {
            launchEntry(application);
            notify(launchNotice("launch", "Launch submitted.", idleNotice));
            closePopup();
          }}
        />
      )}
      {actions.map((action) => (
        <ActionRow
          key={action.id}
          id={`action:desktop:${action.id}`}
          glyph="open"
          label={action.name}
          detail="Application action"
          onPress={() => choose({ action })}
        />
      ))}
      {/* Files come under a line of their own: 5px, the line, 7px. */}
      {files.length > 0 && (
        <Rect
          height={1}
          marginX={8}
          marginTop={5 - gap}
          marginBottom={7 - gap}
          fill={theme.skin.hairline}
        />
      )}
      {files.map((file) => (
        <ActionRow
          key={file.id}
          id={`action:recent:${file.id}`}
          glyph="recent"
          label={`Open ${file.title}`}
          detail="Recent file"
          onPress={() => choose({ file: file.path })}
        />
      ))}
      {!reading && actions.length === 0 && files.length === 0 && (
        <Box marginTop={16} marginX={12} marginBottom={2}>
          <Text style={styles.note}>No supported actions or recent files.</Text>
        </Box>
      )}
    </PopupFrame>
  );
}
