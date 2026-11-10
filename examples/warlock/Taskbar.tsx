/**
 * Warlock's taskbar, along the top of every output: a button for each pinned or
 * running application, then Applications, Task View and Switch windows, and at
 * the far end Notifications, Files, System and Settings and a chip saying what
 * the shell is doing.
 */

import { useRef, useState, type ReactNode } from "react";
import {
  Box,
  instant,
  Rect,
  Reserve,
  Screen,
  Spacer,
  Text,
  type OutputInfo,
  type StagePointerEvent,
} from "proscenium";
import type { GlyphName } from "./glyphs.js";
import { groupContext, groupPrimary, useTaskbarGroups, type TaskbarGroup } from "./groups.js";
import { Glyph } from "./kit.js";
import { useLiveNotificationCount } from "./notifications.js";
import { alpha, themed, useWarlockTheme } from "./theme.js";
import { useWarlock, type PopupMode } from "./WarlockProvider.js";

const leftButton = 272;
const rightButton = 273;
/** Below this width the utilities show their glyphs alone. */
const narrowWidth = 1180;

const useBarStyles = themed((theme) => {
  const { palette, skin } = theme;
  return {
    bar: {
      fill: theme.glass
        ? { from: alpha(palette.surfaceRaised, 0.74), to: alpha(palette.canvas, 0.7), angle: 180 }
        : palette.surface,
      blur: theme.glass ? 26 : undefined,
    },
    hairline: skin.hairline,
    label: { ...theme.type.labelStrong, maxLines: 1, align: "center" } as const,
    utility: { ...theme.type.label, maxLines: 1 } as const,
    chip: {
      fill: skin.tile,
      radius: 10,
      paddingX: 12,
      paddingY: 5,
      marginLeft: 4,
      marginRight: 10,
      alignSelf: "center",
      flexShrink: 0,
    } as const,
    chipText: {
      font: theme.type.detail.font,
      size: theme.rem(12),
      lineHeight: 1.35,
      color: palette.textSecondary,
      maxLines: 2,
    } as const,
  };
});

interface BarControlProps {
  onPress: () => void;
  onContext?: (event: StagePointerEvent) => void;
  /** The red wash of the application in use. */
  selected?: boolean;
  disabled?: boolean;
  width?: number;
  minWidth?: number;
  maxWidth?: number;
  paddingLeft: number;
  paddingRight: number;
  marginLeft?: number;
  children?: ReactNode;
}

/** A button of the bar: clear until the pointer or a press; a press on it never dismisses the popup. */
function BarControl({
  onPress,
  onContext,
  selected = false,
  disabled = false,
  children,
  ...box
}: BarControlProps) {
  const theme = useWarlockTheme();
  const { keepPopup } = useWarlock();
  const [hovered, setHovered] = useState(false);
  const [held, setHeld] = useState(false);
  const button = useRef(leftButton);
  const { skin, palette } = theme;
  const fill = disabled
    ? palette.surfaceRecessed
    : held
      ? selected
        ? skin.selectedPress
        : skin.press
      : hovered
        ? selected
          ? skin.selectedHover
          : skin.hover
        : selected
          ? skin.selected
          : alpha(palette.text, 0);
  return (
    <Box
      flexDirection="row"
      alignItems="center"
      justifyContent="center"
      alignSelf="stretch"
      flexShrink={0}
      radius={10}
      fill={fill}
      transition={instant}
      cursor={disabled ? "not-allowed" : "pointer"}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onPointerDown={(event) => {
        keepPopup();
        button.current = event.button ?? leftButton;
        if (!disabled) setHeld(true);
      }}
      onPointerUp={(event) => {
        if (!held) return;
        setHeld(false);
        const layout = event.currentTarget.layout;
        const over =
          layout !== null &&
          event.localX >= 0 &&
          event.localY >= 0 &&
          event.localX <= layout.width &&
          event.localY <= layout.height;
        if (!over) return;
        if (button.current === leftButton) onPress();
        else if (button.current === rightButton) onContext?.(event);
      }}
      {...box}
    >
      {children}
    </Box>
  );
}

function GroupButton({ group, output }: { group: TaskbarGroup; output: OutputInfo }) {
  const theme = useWarlockTheme();
  const styles = useBarStyles();
  const warlock = useWarlock();
  const { palette } = theme;
  const active = group.state === "active";
  const focusedHere =
    warlock.focusedRoot !== null && group.windows.includes(warlock.focusedRoot) && active;
  const pill =
    group.state === "none"
      ? null
      : active
        ? { width: 28, color: palette.brandText, opacity: 1 }
        : {
            width: 14,
            color: palette.textSecondary,
            opacity: group.state === "minimized" ? 0.55 : 1,
          };
  return (
    <BarControl
      selected={active}
      disabled={group.unavailable}
      minWidth={104}
      maxWidth={200}
      paddingLeft={16}
      paddingRight={16}
      onPress={() => groupPrimary(warlock, group, output.name)}
      onContext={(event) =>
        groupContext(warlock, group, {
          output: output.name,
          anchor: { x: event.screenX, y: theme.barHeight },
        })
      }
    >
      <Box
        flexDirection="column"
        alignItems="center"
        alignSelf="stretch"
        flexGrow={1}
        flexShrink={1}
      >
        <Rect
          width={24}
          height={3}
          radius={1.5}
          fill={focusedHere ? palette.text : alpha(palette.text, 0)}
          interactive={false}
        />
        <Box
          flexGrow={1}
          flexShrink={1}
          alignItems="center"
          justifyContent="center"
          alignSelf="stretch"
        >
          <Text
            style={styles.label}
            color={group.unavailable ? palette.textSecondary : palette.text}
            flexShrink={1}
            interactive={false}
          >
            {group.label}
          </Text>
        </Box>
        <Rect
          width={pill?.width ?? 14}
          height={3}
          radius={1.5}
          marginBottom={3}
          fill={pill?.color ?? alpha(palette.text, 0)}
          opacity={pill?.opacity ?? 1}
          interactive={false}
        />
      </Box>
    </BarControl>
  );
}

interface UtilityProps {
  label: string;
  glyph: GlyphName;
  /** Applications draws its mark in red, a little larger, and keeps its label when the bar is narrow. */
  start?: boolean;
  narrow: boolean;
  output: OutputInfo;
  mode: PopupMode | (() => void);
}

function Utility({ label, glyph, start = false, narrow, output, mode }: UtilityProps) {
  const theme = useWarlockTheme();
  const styles = useBarStyles();
  const { openPopup, popup, closePopup } = useWarlock();
  const collapsed = narrow && !start;
  return (
    <BarControl
      paddingLeft={collapsed ? 15 : 12}
      paddingRight={collapsed ? 15 : 14}
      marginLeft={start ? 10 : 0}
      onPress={() => {
        if (typeof mode === "function") return mode();
        // The button of the popup that is open puts it away.
        if (popup?.mode === mode.mode && popup.output === output.name) closePopup();
        else openPopup(mode, { output: output.name });
      }}
    >
      <Glyph
        name={glyph}
        size={start ? 22 : 20}
        color={start ? theme.palette.brandText : theme.palette.text}
      />
      {!collapsed && (
        <Text style={styles.utility} marginLeft={8} interactive={false}>
          {label}
        </Text>
      )}
    </BarControl>
  );
}

function OutputBar({ output }: { output: OutputInfo }) {
  const theme = useWarlockTheme();
  const styles = useBarStyles();
  const { status, stepSwitcher, popup, closePopup } = useWarlock();
  const groups = useTaskbarGroups();
  const live = useLiveNotificationCount();
  const narrow = output.width <= narrowWidth;
  const height = theme.barHeight;
  const chipWidth = Math.min(Math.max(160, output.width * 0.22), 320);
  const shown = status !== "" && status !== "Ready";
  // The toolbar's room, what its controls need, and how far it is scrolled when they need more.
  const [view, setView] = useState(0);
  const [content, setContent] = useState(0);
  const [scroll, setScroll] = useState(0);
  const overflow = Math.max(0, Math.round(content - view));
  const scrolled = Math.min(scroll, overflow);
  return (
    <Screen output={output.name}>
      <Box x={0} y={0} width={output.width} height={height} flexDirection="row" style={styles.bar}>
        <Box
          flexGrow={1}
          flexShrink={1}
          clip
          onLayout={(layout) => setView(layout.width)}
          onWheel={
            overflow > 0
              ? (event) => {
                  // A wheel over a bar too full to show everything moves along it.
                  const notched = event.source === "wheel" || event.source === "wheel-tilt";
                  const step = notched
                    ? (event.discrete || Math.sign(event.delta)) * 80
                    : event.delta;
                  setScroll(Math.min(Math.max(scrolled + step, 0), overflow));
                }
              : undefined
          }
        >
          <Box
            position="absolute"
            x={-scrolled}
            y={0}
            height={height}
            minWidth={view}
            flexDirection="row"
            alignItems="center"
            paddingX={10}
            paddingY={7}
            gap={4}
            transition={instant}
            onLayout={(layout) => setContent(layout.width)}
          >
            {groups.map((group) => (
              <GroupButton key={group.key} group={group} output={output} />
            ))}
            {groups.length > 0 && (
              <Rect
                width={1}
                alignSelf="stretch"
                marginY={5}
                marginLeft={6}
                marginRight={-6}
                fill={styles.hairline}
                flexShrink={0}
              />
            )}
            <Utility
              label="Applications"
              glyph="warlock"
              start
              narrow={narrow}
              output={output}
              mode={{ mode: "applications" }}
            />
            <Utility
              label="Task View"
              glyph="taskView"
              narrow={narrow}
              output={output}
              mode={{ mode: "overview" }}
            />
            <Utility
              label="Switch windows"
              glyph="switcher"
              narrow={narrow}
              output={output}
              mode={() => (popup?.mode === "switcher" ? closePopup() : stepSwitcher(1, false))}
            />
            <Spacer />
            <Utility
              label={live > 0 ? `Notifications · ${live}` : "Notifications"}
              glyph="bell"
              narrow={narrow}
              output={output}
              mode={{ mode: "notifications" }}
            />
            <Utility
              label="Files"
              glyph="folder"
              narrow={narrow}
              output={output}
              mode={{ mode: "files" }}
            />
            <Utility
              label="System"
              glyph="power"
              narrow={narrow}
              output={output}
              mode={{ mode: "system" }}
            />
            <Utility
              label="Settings"
              glyph="gear"
              narrow={narrow}
              output={output}
              mode={{ mode: "settings" }}
            />
          </Box>
        </Box>
        {shown && (
          <Box style={styles.chip} maxWidth={chipWidth}>
            <Text style={styles.chipText} flexShrink={1}>
              {status}
            </Text>
          </Box>
        )}
      </Box>
      <Rect
        x={0}
        y={height - 1}
        width={output.width}
        height={1}
        fill={styles.hairline}
        interactive={false}
      />
    </Screen>
  );
}

/** A taskbar on every output, and the room it keeps clear of windows. */
export function Taskbar() {
  const { outputs } = useWarlock();
  const theme = useWarlockTheme();
  return (
    <>
      <Reserve top={theme.barHeight} />
      {outputs.map((output) => (
        <OutputBar key={output.name} output={output} />
      ))}
    </>
  );
}
