import { useEffect, useState } from "react";
import { Box, Rect, Text, type BoxProps, type TextProps } from "proscenium";
import {
  columnWidth,
  Glyph,
  Hairline,
  PopupButton,
  PopupFrame,
  Region,
  useFocus,
  usePopupBox,
  usePopupWidth,
} from "../kit.js";
import { alpha, fonts, themed, useWarlockTheme } from "../theme.js";
import { useWarlock } from "../WarlockProvider.js";

/** The workspaces a window can always be moved to. */
const firstWorkspaces = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

const useStyles = themed((theme) => {
  const { palette, skin } = theme;
  const edge = (color: string) => ({ width: 1, color });
  return {
    // Room at the start for the check of the pressed filter.
    chip: {
      minHeight: theme.rem(36),
      paddingLeft: 11 + theme.rem(21),
      paddingRight: 14,
      paddingY: 5,
    } satisfies BoxProps,
    chipEdge: { border: edge(alpha(palette.text, 0.16)) } satisfies BoxProps,
    chipLabel: { size: theme.rem(13), weight: 600 } satisfies TextProps,
    chipDetail: {
      font: theme.type.label.font,
      size: theme.rem(11),
      weight: 600,
      color: palette.textSecondary,
      marginLeft: 8,
      maxLines: 1,
    } satisfies TextProps,
    pressedEdge: { border: edge(alpha(palette.brandText, 0.45)) } satisfies BoxProps,

    panel: {
      flexDirection: "column",
      padding: 8,
      paddingBottom: 10,
      gap: 8,
      radius: 14,
      fill: { from: alpha(palette.text, 0.055), to: alpha(palette.text, 0.025), angle: 90 },
      border: edge(skin.hairline),
    } satisfies BoxProps,
    panelPressed: { border: edge(alpha(palette.brandText, 0.35)) } satisfies BoxProps,

    header: {
      minHeight: theme.rem(44),
      paddingLeft: 10,
      paddingRight: 28,
      paddingY: 8,
      flexWrap: "wrap",
      rowGap: 3,
    } satisfies BoxProps,
    headerLabel: { font: fonts.display, size: theme.rem(15), weight: 600 } satisfies TextProps,
    pill: {
      height: theme.rem(18),
      paddingX: 8,
      radius: theme.rem(9),
      alignItems: "center",
      fill: alpha(palette.brandText, 0.14),
    } satisfies BoxProps,
    pillText: {
      font: theme.type.label.font,
      size: theme.rem(11),
      weight: 600,
      color: palette.brandText,
      maxLines: 1,
    } satisfies TextProps,

    go: { border: edge(alpha(palette.borderEssential, 0.7)) } satisfies BoxProps,
    goLabel: { size: theme.rem(13), weight: 600 } satisfies TextProps,

    // What shows round and under a card: the footer's fill, and the edge of card and footer as one.
    tray: {
      radius: 10,
      fill: alpha(palette.surfaceRecessed, 0.72),
      border: edge(skin.hairline),
      shadow: theme.shadows.card,
    } satisfies BoxProps,
    card: {
      flexDirection: "column",
      alignItems: "stretch",
      gap: 3,
      minHeight: theme.rem(56),
      paddingX: 10,
      paddingTop: 9,
      paddingBottom: 10,
      // Under the pointer only a card's edge changes.
      fill: alpha(palette.surfaceRaised, 0.92),
    } satisfies BoxProps,
    cardTitle: { ...theme.type.labelStrong } satisfies TextProps,
    cardDetail: { ...theme.type.detail } satisfies TextProps,
    move: {
      minHeight: theme.rem(36),
      paddingX: 10,
      paddingTop: 4,
      paddingBottom: 5,
      gap: 8,
    } satisfies BoxProps,
    moveLabel: { size: theme.rem(12), weight: 600 } satisfies TextProps,

    destination: {
      flexDirection: "column",
      alignItems: "flex-start",
      justifyContent: "center",
      gap: 8,
      minHeight: theme.rem(80),
      paddingX: 14,
      paddingY: 12,
      radius: 12,
    } satisfies BoxProps,
    destinationLabel: { weight: 600 } satisfies TextProps,
  };
});

/**
 * Task View: every workspace with its windows. Choosing a window shows its
 * workspace and brings the window forward; a workspace's heading narrows the
 * list to it; a window's Move button swaps the list for the workspaces the
 * window can be sent to.
 */
export function TaskViewPanel() {
  const { workspaces, activeWorkspace, roots, record, closePopup } = useWarlock();
  const [filter, setFilter] = useState<number | null>(null);
  const [transfer, setTransfer] = useState<number | null>(null);
  const [returnTo, setReturnTo] = useState<string | null>(null);
  const [, setRead] = useState(0);

  const pressed = filter !== null && workspaces.includes(filter) ? filter : null;
  const listed = roots.filter((window) => record(window) !== undefined);
  const moving =
    transfer !== null && listed.includes(transfer) && !record(transfer)?.onTop ? transfer : null;

  /** Back from choosing a workspace to the windows, with the keyboard on CONTROL. */
  const leaveTransfer = (control: string) => {
    setTransfer(null);
    setReturnTo(control);
  };
  // A window that closes while its move is being chosen leaves nothing to move.
  useEffect(() => {
    if (transfer !== null && moving === null)
      leaveTransfer(pressed !== null ? `workspace:${pressed}` : "all");
  }, [transfer, moving]);

  const status =
    listed.length === 0
      ? "No windows to show. Close Task View to return."
      : pressed !== null && !listed.some((window) => record(window)?.workspace === pressed)
        ? "This workspace has no windows. Go to its desktop, browse another workspace or close Task View."
        : "Choose a window to reveal its workspace, or browse another workspace.";

  return (
    <PopupFrame
      title="Task View"
      status={status}
      arrows="none"
      initial={`workspace:${activeWorkspace}`}
      onEscape={moving !== null ? () => leaveTransfer(`move:${moving}`) : closePopup}
      list={{ gap: 0 }}
    >
      {moving !== null ? (
        <Transfer window={moving} onCancel={() => leaveTransfer(`move:${moving}`)} />
      ) : (
        <Overview
          windows={listed}
          pressed={pressed}
          onFilter={setFilter}
          onMove={setTransfer}
          returnTo={returnTo}
          onReturned={() => setReturnTo(null)}
          // Everything shown is read as it is drawn, so reading again is drawing again.
          onRefresh={() => setRead((count) => count + 1)}
        />
      )}
    </PopupFrame>
  );
}

interface OverviewProps {
  /** The windows to list, oldest first. */
  windows: readonly number[];
  /** The workspace the list is narrowed to, or null for all windows. */
  pressed: number | null;
  onFilter: (workspace: number | null) => void;
  onMove: (window: number) => void;
  /** The control to give the keyboard, coming back from a move. */
  returnTo: string | null;
  onReturned: () => void;
  onRefresh: () => void;
}

/** The workspaces side by side when there are two or three and the popup has the room, else one under another. */
function Overview({
  windows,
  pressed,
  onFilter,
  onMove,
  returnTo,
  onReturned,
  onRefresh,
}: OverviewProps) {
  const theme = useWarlockTheme();
  const styles = useStyles();
  const { workspaces, closePopup } = useWarlock();
  const width = usePopupWidth();
  const popupWidth = usePopupBox()?.width ?? 0;
  const focus = useFocus();
  useEffect(() => {
    if (returnTo === null) return;
    focus.focus(returnTo);
    onReturned();
  }, [returnTo]);

  const count = workspaces.length;
  const columns =
    (count === 3 && popupWidth >= theme.rem(576)) || (count === 2 && popupWidth >= theme.rem(416));
  const all = pressed === null;

  const close = (
    <PopupButton
      id="close"
      variant="quiet"
      glyph="close"
      label="Close Task View"
      onPress={closePopup}
    />
  );
  const chip = (
    <PopupButton
      id="all"
      variant="tile"
      selected={all}
      glyph="grid"
      glyphSize={18}
      label="All windows"
      labelStyle={styles.chipLabel}
      style={[styles.chip, all ? styles.pressedEdge : styles.chipEdge]}
      onPress={() => onFilter(null)}
    >
      {all && <Text style={styles.chipDetail}>Selected</Text>}
      {all && <PressedBar />}
      {all && (
        <Box position="absolute" x={11} y={0} height="100%" alignItems="center">
          <Glyph name="check" size={16} color={theme.palette.brandText} />
        </Box>
      )}
    </PopupButton>
  );
  const refresh = (
    <PopupButton
      id="refresh"
      group={count + 1}
      variant="quiet"
      glyph="refresh"
      label="Refresh window status"
      detail="Observation only"
      alignSelf={columns ? "stretch" : undefined}
      marginTop={columns ? 20 : 14}
      onPress={onRefresh}
    />
  );
  const section = (workspace: number, index: number) => (
    <Workspace
      key={workspace}
      workspace={workspace}
      group={index + 1}
      level={columns}
      windows={windows}
      pressed={pressed}
      onFilter={onFilter}
      onMove={onMove}
    />
  );

  if (columns) {
    const column = columnWidth(width, count, 12);
    return (
      <>
        <Region
          flexDirection="row"
          justifyContent="space-between"
          alignItems="center"
          marginBottom={12}
        >
          {close}
          {chip}
        </Region>
        <Region flexDirection="row" gap={12}>
          {workspaces.map((workspace, index) => (
            <Region
              key={workspace}
              width={column}
              style={[styles.panel, workspace === pressed && styles.panelPressed]}
            >
              {section(workspace, index)}
            </Region>
          ))}
        </Region>
        {refresh}
      </>
    );
  }
  return (
    <Region flexDirection="column" gap={6}>
      {close}
      {chip}
      {workspaces.map((workspace, index) => [
        <Hairline key={`rule:${workspace}`} marginX={10} marginY={0} marginTop={8} />,
        section(workspace, index),
      ])}
      {refresh}
    </Region>
  );
}

interface WorkspaceProps {
  workspace: number;
  /** Its place in the focus order: a workspace's controls come before the next one's. */
  group: number;
  /** Side by side, every heading keeps room for the line under its name, so the columns' rows line up. */
  level: boolean;
  windows: readonly number[];
  pressed: number | null;
  onFilter: (workspace: number | null) => void;
  onMove: (window: number) => void;
}

/** One workspace: its heading, which narrows the list to it, then its windows, or a way to it while it is empty. */
function Workspace({
  workspace,
  group,
  level,
  windows,
  pressed,
  onFilter,
  onMove,
}: WorkspaceProps) {
  const theme = useWarlockTheme();
  const styles = useStyles();
  const { activeWorkspace, record, showWorkspace, closePopup, notify } = useWarlock();
  const active = workspace === activeWorkspace;
  const chosen = workspace === pressed;
  const here = windows.filter((window) => record(window)?.workspace === workspace);
  const detail = `${active ? "Active workspace" : ""}${chosen ? " • Selected" : ""}`;

  return (
    <>
      <PopupButton
        id={`workspace:${workspace}`}
        group={group}
        selected={chosen}
        glyph="desktop"
        glyphColor={theme.palette.brandText}
        label={`Workspace ${workspace}`}
        labelStyle={styles.headerLabel}
        style={[styles.header, chosen && styles.pressedEdge]}
        onPress={() => onFilter(workspace)}
      >
        {detail !== "" ? (
          <Box width="100%" paddingLeft={theme.rem(20) + 10}>
            <Box style={styles.pill}>
              <Text style={styles.pillText}>{detail}</Text>
            </Box>
          </Box>
        ) : (
          level && <Box width="100%" height={theme.rem(18)} />
        )}
        {chosen && <PressedBar />}
        {chosen && (
          <Box
            position="absolute"
            x={0}
            y={0}
            width="100%"
            paddingTop={9}
            paddingRight={12}
            justifyContent="flex-end"
          >
            <Glyph name="check" size={14} color={theme.palette.brandText} />
          </Box>
        )}
      </PopupButton>
      {here.length === 0 && !active && (
        <PopupButton
          id={`go:${workspace}`}
          group={group}
          variant="outline"
          glyph="go"
          label={`Go to workspace ${workspace}`}
          labelStyle={styles.goLabel}
          detail="Switch desktop"
          style={styles.go}
          onPress={() => {
            closePopup();
            showWorkspace(workspace);
            notify(`Workspace ${workspace}: now active.`, 4);
          }}
        />
      )}
      {(pressed === null || chosen) &&
        here.map((window) => (
          <WindowCard key={window} window={window} group={group} onMove={onMove} />
        ))}
    </>
  );
}

/** A window: choosing it shows its workspace and brings it forward. Under it, the way to move it elsewhere. */
function WindowCard({
  window,
  group,
  onMove,
}: {
  window: number;
  group: number;
  onMove: (window: number) => void;
}) {
  const theme = useWarlockTheme();
  const styles = useStyles();
  const { record, label, activate, closePopup } = useWarlock();
  const entry = record(window);
  if (!entry) return null;
  const title = label(window);
  return (
    <Region flexDirection="column">
      <Rect position="absolute" x={0} y={0} width="100%" height="100%" style={styles.tray} />
      <PopupButton
        id={`window:${window}`}
        group={group}
        variant="tile"
        style={styles.card}
        label={`Workspace ${entry.workspace} • ${entry.minimized ? "Minimized" : "Open"}`}
        labelStyle={styles.cardDetail}
        leading={
          <Box flexDirection="row" alignItems="flex-start" gap={8}>
            <Glyph
              name="window"
              size={15}
              color={theme.palette.brandText}
              marginTop={theme.rem(2.5)}
            />
            <Text style={styles.cardTitle} flexShrink={1}>
              {title}
            </Text>
          </Box>
        }
        onPress={() => {
          closePopup();
          activate(window);
        }}
      />
      <PopupButton
        id={`move:${window}`}
        group={group}
        variant="quiet"
        glyph="move"
        glyphSize={15}
        label={`Move ${title}…`}
        labelStyle={styles.moveLabel}
        style={styles.move}
        // A window kept on top shows on every workspace, so it has none to leave.
        disabled={entry.onTop}
        onPress={() => onMove(window)}
      />
    </Region>
  );
}

/** The bar at the leading edge of the filter that is pressed. */
function PressedBar() {
  const theme = useWarlockTheme();
  return (
    <Box
      position="absolute"
      x={0}
      y={0}
      width={3}
      height="100%"
      flexDirection="column"
      paddingY={7}
    >
      <Rect flexGrow={1} radius={1.5} fill={theme.palette.brandText} />
    </Box>
  );
}

/** Where to send a window: any of the first ten workspaces and any other in use, but the one it is on. */
function Transfer({ window, onCancel }: { window: number; onCancel: () => void }) {
  const theme = useWarlockTheme();
  const styles = useStyles();
  const { workspaces, record, transfer, closePopup } = useWarlock();
  const width = usePopupWidth();
  const focus = useFocus();
  useEffect(() => focus.focus("cancel-transfer"), []);

  const current = record(window)?.workspace;
  const destinations = [...new Set([...firstWorkspaces, ...workspaces])]
    .filter((workspace) => workspace !== current)
    .sort((a, b) => a - b);
  const columns = Math.max(1, Math.floor((width + 8) / (theme.rem(176) + 8)));
  const tile = columnWidth(width, columns, 8);

  return (
    <>
      <PopupButton
        id="cancel-transfer"
        variant="quiet"
        glyph="close"
        label="Cancel transfer"
        alignSelf="flex-start"
        marginBottom={8}
        onPress={onCancel}
      />
      <Region flexDirection="row" flexWrap="wrap" gap={8}>
        {destinations.map((workspace) => (
          <PopupButton
            key={workspace}
            id={`destination:${workspace}`}
            variant="tile"
            width={tile}
            style={styles.destination}
            glyph="desktop"
            glyphSize={24}
            glyphColor={theme.palette.brandText}
            label={`Move to workspace ${workspace}`}
            labelStyle={styles.destinationLabel}
            onPress={() => {
              closePopup();
              transfer(window, workspace);
            }}
          />
        ))}
      </Region>
    </>
  );
}
