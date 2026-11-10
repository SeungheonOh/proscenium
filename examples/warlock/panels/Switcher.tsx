import { useEffect, useRef } from "react";
import { Box, Mirror, Rect, type BoxProps, type StageKeyEvent, type TextProps } from "proscenium";
import {
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
import { useWarlock, type Popup } from "../WarlockProvider.js";

type SwitcherPopup = Extract<Popup, { mode: "switcher" }>;

/** Room between a card's picture and what is above and below it. */
const pictureMargin = 8;

const useStyles = themed((theme) => {
  const { palette, skin } = theme;
  const glow = (amount: number, blur: number, y: number) =>
    theme.effects === "full" ? { color: alpha(palette.actionFill, amount), blur, y } : undefined;
  return {
    card: {
      flexDirection: "column",
      alignItems: "stretch",
      gap: 0,
      minHeight: theme.rem(176),
      paddingX: 14,
      paddingTop: 14,
      paddingBottom: 12,
      radius: 12,
    } satisfies BoxProps,
    // Under the pointer only a card's edge changes.
    resting: { fill: skin.tile } satisfies BoxProps,
    candidate: { shadow: theme.shadows.raised } satisfies BoxProps,
    plate: {
      width: theme.rem(44),
      height: theme.rem(44),
      radius: 11,
      alignItems: "center",
      justifyContent: "center",
      alignSelf: "flex-start",
      flexShrink: 0,
      fill: alpha(palette.text, 0.07),
      border: { width: 1, color: skin.hairline },
    } satisfies BoxProps,
    plateCandidate: {
      fill: palette.actionFill,
      border: { width: 1, color: alpha(palette.actionFill, 0) },
      shadow: glow(0.4, 8, 2),
    } satisfies BoxProps,
    title: {
      font: fonts.display,
      size: theme.rem(16),
      weight: 600,
      lineHeight: 1.3,
    } satisfies TextProps,
    state: { marginTop: 1 } satisfies TextProps,
    stateCandidate: { marginTop: 1, weight: 600, color: palette.brandText } satisfies TextProps,
    action: { paddingLeft: 12, paddingRight: 14 } satisfies BoxProps,
    actionLabel: { size: theme.rem(13), weight: 600 } satisfies TextProps,
    activateGlow: glow(0.32, 14, 4),
  };
});

/**
 * The Alt+Tab switcher: every window as a card, the most lately used first,
 * with the one that would be chosen marked. Opened by the chord it follows
 * the held Alt key; opened from the taskbar it stays until a window is chosen.
 */
export function SwitcherPanel() {
  const { popup } = useWarlock();
  if (popup?.mode !== "switcher") return null;
  return <Switcher popup={popup} />;
}

function Switcher({ popup }: { popup: SwitcherPopup }) {
  const theme = useWarlockTheme();
  const styles = useStyles();
  const { windows, closePopup, stepSwitcher, commitSwitcher } = useWarlock();
  const width = usePopupWidth();
  const wide = (usePopupBox()?.width ?? 0) >= theme.rem(480);
  const { chord, list, index } = popup;
  const pointed = list[index];
  const candidate = pointed !== undefined && windows.has(pointed) ? pointed : null;

  // The list is as it was when the switcher opened. A candidate that closes
  // gives way to the next window still there; a step that lands on a closed
  // window goes on the way it was going.
  const seen = useRef(index);
  useEffect(() => {
    const count = list.length;
    const backward =
      seen.current !== index && count > 2 && index === (seen.current - 1 + count) % count;
    seen.current = index;
    if (candidate === null) stepSwitcher(backward ? -1 : 1, chord);
  }, [index, candidate]);

  // Opened from the taskbar no modifier is held, so Tab and the arrows browse and Enter chooses.
  const key = (event: StageKeyEvent): boolean => {
    if (chord) return false;
    switch (event.key) {
      case "Tab":
        stepSwitcher(event.modifiers.includes("shift") ? -1 : 1, false);
        return true;
      case "Right":
        stepSwitcher(1, false);
        return true;
      case "ISO_Left_Tab":
      case "Left":
        stepSwitcher(-1, false);
        return true;
      case "Return":
      case "KP_Enter":
        if (!event.repeat) commitSwitcher();
        return true;
    }
    return false;
  };

  const cancel = (
    <PopupButton
      id="cancel"
      variant="quiet"
      glyph="close"
      glyphSize={18}
      label="Cancel window switcher"
      style={styles.action}
      onPress={closePopup}
    />
  );
  const previous = (
    <PopupButton
      id="previous"
      variant="outline"
      glyph="arrowLeft"
      glyphSize={18}
      label="Previous window"
      style={styles.action}
      labelStyle={styles.actionLabel}
      onPress={() => stepSwitcher(-1, chord)}
    />
  );
  const next = (
    <PopupButton
      id="next"
      variant="outline"
      glyph="arrowRight"
      glyphSize={18}
      label="Next window"
      style={styles.action}
      labelStyle={styles.actionLabel}
      onPress={() => stepSwitcher(1, chord)}
    />
  );
  const choose = (
    <PopupButton
      id="activate"
      variant="primary"
      glyph="check"
      glyphSize={18}
      label="Activate selected window"
      style={styles.action}
      labelStyle={styles.actionLabel}
      shadow={candidate !== null ? styles.activateGlow : undefined}
      disabled={candidate === null}
      onPress={() => commitSwitcher()}
    />
  );

  return (
    <PopupFrame
      title="Switch windows"
      status={
        chord
          ? "Alt+Tab: next window. Alt+Shift+Tab: previous. Release Alt: activate. Escape: cancel."
          : "Tab or Right: next window. Shift+Tab or Left: previous. Enter: activate. Escape: cancel."
      }
      initial={candidate !== null ? `card:${candidate}` : "cancel"}
      arrows="none"
      onEscape={closePopup}
      onKey={key}
      list={{ gap: 0 }}
    >
      <Cards list={list} candidate={candidate} width={width} />
      <Hairline marginX={0} marginY={14} />
      {wide ? (
        <>
          <Region flexDirection="row" alignItems="center" gap={8}>
            {cancel}
            <Box flexGrow={1} />
            {previous}
            {next}
          </Region>
          <Region flexDirection="row" justifyContent="flex-end" marginTop={8}>
            {choose}
          </Region>
        </>
      ) : (
        <Region flexDirection="column" gap={8}>
          {cancel}
          {previous}
          {next}
          {choose}
        </Region>
      )}
    </PopupFrame>
  );
}

/** The windows as cards, four to a row; the keyboard stays on the candidate's. */
function Cards({
  list,
  candidate,
  width,
}: {
  list: readonly number[];
  candidate: number | null;
  width: number;
}) {
  const theme = useWarlockTheme();
  const styles = useStyles();
  const { windows, record, label, commitSwitcher } = useWarlock();
  const focus = useFocus();
  useEffect(() => {
    if (candidate !== null) focus.focus(`card:${candidate}`);
  }, [candidate]);

  const card = Math.min(width, Math.max(theme.rem(120), Math.floor((width - 30) / 4)));
  // What a card of the least height has free between its plate and a title of one line.
  const picture = {
    width: card - 28,
    height: Math.max(0, theme.rem(176 - 44 - 21 - 16) - 14 - 12 - 3 - 2 * pictureMargin),
  };

  return (
    <Region flexDirection="row" flexWrap="wrap" justifyContent="center" gap={10}>
      {list.map((window, index) => {
        if (!windows.has(window)) return null;
        const chosen = window === candidate;
        return (
          <PopupButton
            key={window}
            id={`card:${window}`}
            variant="tile"
            selected={chosen}
            width={card}
            style={[styles.card, chosen ? styles.candidate : styles.resting]}
            label={label(window)}
            labelStyle={styles.title}
            detail={chosen ? "Selected" : record(window)?.minimized ? "Minimized" : "Open"}
            detailStyle={chosen ? styles.stateCandidate : styles.state}
            leading={
              <Box flexDirection="column" flexGrow={1000} flexShrink={0}>
                <Box style={[styles.plate, chosen && styles.plateCandidate]}>
                  <Glyph
                    name="window"
                    size={24}
                    color={chosen ? theme.palette.onAction : theme.palette.brandText}
                  />
                </Box>
                <Thumbnail window={window} {...picture} />
              </Box>
            }
            onPress={() => commitSwitcher(index)}
          >
            {chosen && <Brackets />}
          </PopupButton>
        );
      })}
    </Region>
  );
}

/** The window itself, live and whole, as large as the room in its card allows. */
function Thumbnail({ window, width, height }: { window: number; width: number; height: number }) {
  const theme = useWarlockTheme();
  const { windows } = useWarlock();
  const info = windows.get(window);
  const scale =
    info && info.width > 0 && info.height > 0 && width > 0 && height > 0
      ? Math.min(width / info.width, height / info.height)
      : 0;
  return (
    <Box flexGrow={1} minHeight={height} marginY={pictureMargin} alignItems="center">
      {info && scale > 0 && (
        <Mirror
          window={window}
          width={Math.max(1, Math.round(info.width * scale))}
          height={Math.max(1, Math.round(info.height * scale))}
          radius={3}
          border={{ width: 1, color: theme.skin.hairline }}
        />
      )}
    </Box>
  );
}

const arm = 14;
const stroke = 2;

/** The four corner marks of the card that would be chosen. */
function Brackets() {
  const theme = useWarlockTheme();
  const corner = (right: boolean, bottom: boolean) => (
    <Box width={arm} height={arm}>
      <Rect
        position="absolute"
        x={0}
        y={bottom ? arm - stroke : 0}
        width={arm}
        height={stroke}
        fill={theme.palette.brandText}
      />
      <Rect
        position="absolute"
        x={right ? arm - stroke : 0}
        y={0}
        width={stroke}
        height={arm}
        fill={theme.palette.brandText}
      />
    </Box>
  );
  return (
    <Box
      position="absolute"
      x={0}
      y={0}
      width="100%"
      height="100%"
      padding={6}
      flexDirection="column"
      justifyContent="space-between"
    >
      <Box flexDirection="row" justifyContent="space-between">
        {corner(false, false)}
        {corner(true, false)}
      </Box>
      <Box flexDirection="row" justifyContent="space-between">
        {corner(false, true)}
        {corner(true, true)}
      </Box>
    </Box>
  );
}
