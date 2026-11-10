import { useEffect, useLayoutEffect, useState } from "react";
import { Box, Rect, Text, type TextProps } from "proscenium";
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
  appearanceFile,
  motionFile,
  shortcutRoutes,
  shortcutsFile,
  useStored,
  type MotionOverride,
  type ShortcutChoice,
  type ShortcutRoute,
  type StoredFile,
} from "../storage.js";
import { alpha, themed, useWarlockTheme, type TextScale, type ThemeName } from "../theme.js";
import { useWarlock } from "../WarlockProvider.js";
import {
  Chevron,
  Joined,
  Plate,
  PlateButton,
  Radio,
  Switch,
  type Four,
  type PlateFills,
} from "./settings-parts.js";
import { previewColors, ThemePreview } from "./settings-preview.js";

const helpTexts = [
  [
    "Keyboard navigation",
    "Tab and Shift+Tab move focus. Arrows move through lists; Home/End reach endpoints. Enter chooses; Escape closes.",
  ],
  [
    "Keeping your preferences",
    "Save applies appearance preferences. Motion has its own Save. Dismissing help keeps unsaved edits.",
  ],
  [
    "When an action is not confirmed",
    "Pending is waiting; Refused did not proceed; Unknown is unconfirmed. Refresh reads state without repeating an action.",
  ],
] as const;

const motionChoices: readonly { id: string; override: MotionOverride; label: string }[] = [
  { id: "system", override: null, label: "Follow system" },
  { id: "reduced", override: "reduced", label: "Reduced motion" },
  { id: "full", override: "full", label: "Full motion" },
];

const themeChoices: readonly { name: ThemeName; label: string; glyph: GlyphName }[] = [
  { name: "night", label: "Night theme", glyph: "moon" },
  { name: "dawn", label: "Dawn theme", glyph: "sun" },
  { name: "high-contrast", label: "High contrast theme", glyph: "contrast" },
];

/** Each text size, and how big its segment draws the glyph, in pixels at 100%. */
const scaleChoices: readonly { scale: TextScale; glyph: number }[] = [
  { scale: 100, glyph: 14 },
  { scale: 125, glyph: 17 },
  { scale: 150, glyph: 20 },
  { scale: 200, glyph: 24 },
];

const shortcutNotices = {
  loaded: "",
  unsaved: "Unsaved shortcut choices. Existing bindings remain unchanged until you save.",
  remaining: "Stored choices changed. Confirm each remaining affected shortcut before saving.",
  changed:
    "Stored choices changed. Your draft is preserved. Confirm each affected shortcut before saving.",
  preserved: "Your unsaved shortcut choices are preserved. Check availability before saving.",
  saved: "Shortcut choices saved and active. Existing bindings were preserved.",
  refused:
    "Shortcut choices refused. Bindings or stored choices changed; refresh and choose again.",
};

/** The list is this many pixels wide, at 100%, before grouped choices stop sharing a row. */
const narrowBelow = 416;

const useStyles = themed((theme) => {
  const { palette, skin } = theme;
  const dawn = theme.theme === "dawn";
  const contrast = theme.theme === "high-contrast";
  const card = contrast
    ? palette.surface
    : dawn
      ? alpha(palette.surfaceRaised, 0.72)
      : alpha(palette.text, 0.05);
  const strong = contrast ? skin.hover : dawn ? palette.surfaceRaised : alpha(palette.text, 0.08);
  const on = contrast ? alpha(palette.text, 0.22) : alpha(palette.actionFill, dawn ? 0.1 : 0.24);
  const onHover = contrast
    ? alpha(palette.text, 0.3)
    : alpha(palette.actionFill, dawn ? 0.16 : 0.32);
  const edge = contrast ? palette.borderEssential : alpha(palette.text, dawn ? 0.12 : 0.09);
  return {
    /** A card's fill and edge. */
    card,
    edge,
    /** The line between paragraphs of one card. */
    rule: contrast ? palette.windowEdgeUnfocused : alpha(palette.text, dawn ? 0.09 : 0.07),
    /** The edge of the chosen segment, and of a Save that cannot be used. */
    chosenEdge: contrast ? palette.brandText : alpha(palette.brandText, 0.55),
    disabledEdge: contrast ? palette.windowEdgeUnfocused : edge,
    /** A switch's track while off. */
    track: contrast ? palette.surface : alpha(palette.text, dawn ? 0.05 : 0.06),
    /** How a card fills at rest, under the pointer and under a press; and one that is the chosen of its group. */
    fills: { rest: card, hover: strong, press: skin.press } satisfies PlateFills,
    chosenFills: { rest: on, hover: onHover, press: onHover } satisfies PlateFills,
    strong: { weight: 600 } satisfies TextProps,
    state: { ...theme.type.status, lineHeight: 1.4 } satisfies TextProps,
    stateOn: { color: palette.text } satisfies TextProps,
    caption: theme.type.detail,
    helpTitle: {
      ...theme.type.labelStrong,
      size: theme.rem(13),
      lineHeight: 1.4,
    } satisfies TextProps,
    helpBody: { ...theme.type.detail, lineHeight: 1.45 } satisfies TextProps,
    notice: { ...theme.type.status, lineHeight: 1.45 } satisfies TextProps,
    routeTitle: theme.type.labelStrong,
    chord: {
      ...theme.type.code,
      size: theme.rem(12),
      lineHeight: 1.5,
      color: palette.textSecondary,
    } satisfies TextProps,
    chosen: { color: palette.brandText, weight: 600 } satisfies TextProps,
    segmentLabel: { size: theme.rem(13), weight: 500 } satisfies TextProps,
    segmentDetail: {
      size: theme.rem(11),
      weight: 600,
      color: palette.brandText,
    } satisfies TextProps,
    cardLabel: { size: theme.rem(13), weight: 600 } satisfies TextProps,
  };
});

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

interface DraftNotices {
  loaded: string;
  unsaved: string;
  saved: string;
  refused: string;
}

/**
 * A stored value and the draft of it this panel edits: nothing is stored until
 * `save`, and `refresh` reads the file again and drops the draft.
 */
function useDraft<V>(file: StoredFile<V>, notices: DraftNotices) {
  const stored = useStored(file);
  const [draft, setDraft] = useState(stored);
  const [notice, setNotice] = useState(notices.loaded);
  // Settings opened again reads what is stored now.
  useLayoutEffect(() => setDraft(file.refresh()), [file]);
  const changed = !same(draft, stored);
  return {
    stored,
    draft,
    notice,
    changed,
    edit: (value: V) => {
      setDraft(value);
      setNotice(notices.unsaved);
    },
    /** Store the draft; true if it was stored. */
    save: () => {
      const saved = changed && file.save(draft);
      if (changed) setNotice(saved ? notices.saved : notices.refused);
      return saved;
    },
    refresh: () => {
      setDraft(file.refresh());
      setNotice(notices.loaded);
    },
  };
}

/**
 * Settings: appearance, motion and which chords open three of the shell's
 * menus. Each of the three is edited as a draft with its own Save and Refresh;
 * nothing changes until its Save.
 */
export function SettingsPanel() {
  const theme = useWarlockTheme();
  const styles = useStyles();
  const { palette, rem } = theme;
  const { closePopup, motion } = useWarlock();
  const width = usePopupWidth();
  const narrow = width < rem(narrowBelow);
  const [help, setHelp] = useState(false);

  const appearance = useDraft(appearanceFile, {
    loaded: "",
    unsaved: "Unsaved changes. Save to apply.",
    saved: "Settings saved.",
    refused: "Settings change refused. Refresh, then choose again.",
  });
  const motionChoice = useDraft(motionFile, {
    loaded: "",
    unsaved: "Unsaved motion preference. Save to apply.",
    saved: "Motion preference saved.",
    refused: "Motion preference refused. Refresh, then choose again.",
  });

  const storedShortcuts = useStored(shortcutsFile);
  const [shortcuts, setShortcuts] = useState(storedShortcuts);
  const [shortcutNotice, setShortcutNotice] = useState(shortcutNotices.loaded);
  /** Routes whose stored choice changed under a draft: each must be chosen again before a save. */
  const [conflicts, setConflicts] = useState<readonly ShortcutRoute[]>([]);
  useLayoutEffect(() => setShortcuts(shortcutsFile.refresh()), []);
  const shortcutsReady =
    conflicts.length === 0 && shortcutRoutes.every(({ route }) => shortcuts[route] !== "undecided");
  const shortcutsChanged = !same(shortcuts, storedShortcuts);

  const chooseShortcut = (route: ShortcutRoute, choice: ShortcutChoice) => {
    const remaining = conflicts.filter((other) => other !== route);
    setShortcuts({ ...shortcuts, [route]: choice });
    setConflicts(remaining);
    setShortcutNotice(remaining.length === 0 ? shortcutNotices.unsaved : shortcutNotices.remaining);
  };
  /** Read the stored choices again. A draft is kept; a route stored differently since must be confirmed. */
  const refreshShortcuts = () => {
    const before = storedShortcuts;
    const now = shortcutsFile.refresh();
    if (conflicts.length === 0 && same(before, shortcuts)) {
      setShortcuts(now);
      setShortcutNotice(shortcutNotices.loaded);
      return;
    }
    const affected = shortcutRoutes
      .map(({ route }) => route)
      .filter(
        (route) =>
          shortcuts[route] !== now[route] &&
          (conflicts.includes(route) || before[route] !== now[route]),
      );
    setConflicts(affected);
    setShortcutNotice(affected.length > 0 ? shortcutNotices.changed : shortcutNotices.preserved);
  };

  const motionName = motionChoices.find((choice) => choice.override === motionChoice.stored)!.label;
  const motionState = `${motion === "reduced" ? "Reduced motion: instant transitions" : "Full motion"} · ${motionName}`;

  const themeCard = columnWidth(width, 12, 8, 4);
  const cardIndent = 6 + rem(18) + rem(8);
  const badge = rem(20);
  const row = { paddingLeft: 15, paddingRight: 17 } as const;
  // Where text under a row's label starts: past the row's padding, a glyph and the kit's gap after it.
  const underLabel = row.paddingLeft + rem(20) + 10;

  return (
    <PopupFrame
      title="Settings"
      status={
        [appearance.notice, shortcutNotice].filter(Boolean).join(" · ") ||
        "Appearance, motion and shortcuts. Each saves on its own."
      }
      initial="close"
      onEscape={closePopup}
      list={{ gap: 0 }}
    >
      <KeepFocusInView />
      <PopupButton
        id="close"
        glyph="close"
        label="Close settings"
        alignSelf="flex-start"
        paddingLeft={11}
        paddingRight={5}
        onPress={closePopup}
      />

      <Joined flexDirection="column" marginTop={6}>
        <PlateButton
          id="help"
          glyph="help"
          label={help ? "Dismiss help" : "Show help"}
          labelStyle={styles.strong}
          fills={styles.fills}
          plate={{ edge: styles.edge, corners: help ? [10, 10, 0, 0] : 10 }}
          minHeight={rem(52)}
          {...row}
          paddingY={9}
          onPress={() => setHelp(!help)}
        >
          <Text style={styles.caption} marginX={2} maxLines={1}>
            {help ? "Expanded" : "Collapsed"}
          </Text>
          <Chevron up={help} />
        </PlateButton>
        {help &&
          helpTexts.map(([title, body], index) => {
            const last = index === helpTexts.length - 1;
            return (
              <Plate
                key={title}
                look={{
                  fill: styles.card,
                  edge: styles.edge,
                  corners: last ? [0, 0, 10, 10] : 0,
                  sides: [0, 1, 1, 1],
                }}
                flexDirection="column"
                paddingLeft={underLabel}
                paddingRight={row.paddingRight}
                paddingTop={10}
                paddingBottom={last ? 15 : 11}
              >
                {index > 0 && (
                  <Rect
                    position="absolute"
                    x={1}
                    y={0}
                    width={width - 2}
                    height={1}
                    fill={styles.rule}
                  />
                )}
                <Text style={styles.helpTitle}>{title}</Text>
                <Text style={styles.helpBody} marginTop={2}>
                  {body}
                </Text>
              </Plate>
            );
          })}
      </Joined>

      <SwitchRow
        id="effects-off"
        glyph="sparkle"
        label="Disable soft effects"
        on={appearance.draft.effectsOff}
        marginTop={20}
        onPress={() =>
          appearance.edit({ ...appearance.draft, effectsOff: !appearance.draft.effectsOff })
        }
      />
      <SwitchRow
        id="reduced-transparency"
        glyph="layers"
        label="Reduce transparency"
        on={appearance.draft.reducedTransparency}
        marginTop={4}
        onPress={() =>
          appearance.edit({
            ...appearance.draft,
            reducedTransparency: !appearance.draft.reducedTransparency,
          })
        }
      />

      {/* What motion is in effect: it says, and does nothing. */}
      <PopupButton
        id="motion"
        glyph="motion"
        label={motionState}
        detail={motionChoice.notice || undefined}
        labelStyle={styles.strong}
        disabled
        marginTop={20}
        paddingLeft={15}
        paddingRight={13}
        minHeight={rem(56)}
        style={{ fill: alpha(palette.text, 0) }}
      />
      <Segments
        marginTop={6}
        narrow={narrow}
        options={motionChoices.map(({ id, override, label }) => ({
          id: `motion:${id}`,
          label,
          chosen: motionChoice.draft === override,
          onPress: () => motionChoice.edit(override),
        }))}
      />
      <SaveGroup
        id="motion:save"
        label="Save motion preference"
        caption="Apply and keep across restart"
        enabled={motionChoice.changed}
        next="motion:refresh"
        onSave={motionChoice.save}
      />
      <PopupButton
        id="motion:refresh"
        glyph="refresh"
        label="Refresh motion preference"
        detail="Read stored preference; no write is repeated"
        minHeight={rem(56)}
        marginTop={6}
        onPress={motionChoice.refresh}
      />

      <Region flexDirection={narrow ? "column" : "row"} gap={narrow ? 20 : 8} marginTop={20}>
        {themeChoices.map(({ name, label, glyph }, index) => {
          const chosen = appearance.draft.theme === name;
          // The last card takes what whole pixels leave of the row.
          const card = narrow ? width : index < 2 ? themeCard : width - 2 * (themeCard + 8);
          return (
            <PlateButton
              key={name}
              id={`theme:${name}`}
              label={label}
              detail={chosen ? "Selected" : undefined}
              selected={chosen}
              fills={chosen ? styles.chosenFills : styles.fills}
              plate={{
                edge: chosen ? palette.brandText : styles.edge,
                corners: 12,
                sides: chosen ? 2 : 1,
              }}
              place={{ width: card }}
              flexDirection="column"
              alignItems="stretch"
              justifyContent="flex-start"
              gap={8}
              paddingX={7}
              paddingTop={7}
              paddingBottom={11}
              radius={12}
              labelStyle={{ ...styles.cardLabel, marginLeft: cardIndent }}
              detailStyle={{ ...styles.chosen, marginLeft: cardIndent }}
              leading={
                <>
                  <ThemePreview name={name} width={card - 14} />
                  {/* Beside the first line of the name, which starts past it. */}
                  <Glyph
                    name={glyph}
                    size={18}
                    position="absolute"
                    x={7 + 6}
                    y={7 + rem(68) + 8 + (styles.cardLabel.size * (20 / 14) - rem(18)) / 2}
                  />
                </>
              }
              over={
                chosen
                  ? (size) => (
                      <Box
                        position="absolute"
                        x={size.width - 12 - badge}
                        y={12}
                        width={badge}
                        height={badge}
                        radius={badge / 2}
                        alignItems="center"
                        justifyContent="center"
                        fill={palette.actionFill}
                        interactive={false}
                      >
                        {/* The check is cut out of the badge: it shows the picture under it. */}
                        <Glyph name="check" size={16} color={previewColors(name).canvas} />
                      </Box>
                    )
                  : undefined
              }
              onPress={() => appearance.edit({ ...appearance.draft, theme: name })}
            />
          );
        })}
      </Region>
      <Segments
        marginTop={8}
        narrow={narrow}
        options={scaleChoices.map(({ scale, glyph }) => ({
          id: `scale:${scale}`,
          label: `Text size ${scale}%`,
          chosen: appearance.draft.textScale === scale,
          glyph,
          onPress: () => appearance.edit({ ...appearance.draft, textScale: scale }),
        }))}
      />
      <SaveGroup
        id="save"
        label="Save settings"
        caption="Apply and keep across restart"
        enabled={appearance.changed}
        next="refresh"
        onSave={appearance.save}
      />
      <PopupButton
        id="refresh"
        glyph="refresh"
        label="Refresh settings"
        detail="Read stored values; discard unsaved changes"
        minHeight={rem(56)}
        marginTop={6}
        onPress={appearance.refresh}
      />

      <Box marginTop={22} paddingX={4} paddingBottom={2}>
        <Text style={styles.notice} flexShrink={1}>
          {shortcutNotice}
        </Text>
      </Box>
      {shortcutRoutes.map(({ route, label, chord, alternate }) => {
        const active = storedShortcuts[route];
        const state =
          active === "keep"
            ? "existing shortcut preserved"
            : active === "alternate"
              ? alternate
              : chord;
        const choice = (kind: ShortcutChoice, text: string) => (
          <PlateButton
            id={`shortcuts:${route}:${kind}`}
            label={text}
            detail={shortcuts[route] === kind ? "Selected" : undefined}
            detailStyle={styles.chosen}
            leading={<Radio chosen={shortcuts[route] === kind} />}
            fills={styles.fills}
            plate={{ edge: styles.edge, corners: 0, sides: [0, 1, 0, 1] }}
            {...row}
            paddingY={6}
            radius={0}
            minHeight={shortcuts[route] === kind ? rem(56) : undefined}
            onPress={() => chooseShortcut(route, kind)}
          />
        );
        /** The chord a choice binds and whether it is free, under the choice; the last closes the card. */
        const availability = (text: string, last: boolean) => (
          <Plate
            look={{
              fill: styles.card,
              edge: styles.edge,
              corners: last ? [0, 0, 10, 10] : 0,
              sides: last ? [0, 1, 1, 1] : [0, 1, 0, 1],
            }}
            paddingLeft={underLabel}
            paddingRight={row.paddingRight}
            paddingBottom={last ? 13 : 8}
            // A line and a half tall, the chord in the middle of it: clear of the ring round the choice above.
            minHeight={rem(18) + (last ? 13 : 8)}
            alignItems="center"
          >
            <Text style={styles.chord} flexShrink={1}>
              {text}
            </Text>
          </Plate>
        );
        return (
          <Joined key={route} flexDirection="column" marginTop={10}>
            <Plate
              look={{
                fill: styles.card,
                edge: styles.edge,
                corners: [10, 10, 0, 0],
                sides: [1, 1, 0, 1],
              }}
              paddingX={17}
              paddingTop={13}
              paddingBottom={6}
            >
              <Text style={styles.routeTitle} flexShrink={1}>
                {`${label}: ${state}`}
              </Text>
            </Plate>
            {choice("keep", `Keep existing shortcut for ${label}`)}
            {choice("default", `Use ${label} default`)}
            {availability(`${chord} · Available`, false)}
            {choice("alternate", `Use ${label} alternative`)}
            {availability(`${alternate} · Available`, true)}
          </Joined>
        );
      })}
      <SaveGroup
        id="shortcuts:save"
        label="Save shortcut choices"
        caption="Apply only the free chosen chords; preserve existing bindings"
        enabled={shortcutsReady && shortcutsChanged}
        next="shortcuts:refresh"
        onSave={() => {
          const stored = shortcutsFile.save(shortcuts);
          setShortcutNotice(stored ? shortcutNotices.saved : shortcutNotices.refused);
          return stored;
        }}
      />
      <PopupButton
        id="shortcuts:refresh"
        glyph="refresh"
        label="Refresh shortcut choices"
        detail="Read stored choices and live bindings without repeating an action"
        minHeight={rem(56)}
        marginTop={6}
        onPress={refreshShortcuts}
      />
    </PopupFrame>
  );
}

/** Another text size lays the list out anew: once it has, this brings the focused control back into view. */
function KeepFocusInView() {
  const { textScale } = useWarlockTheme();
  const focus = useFocus();
  useEffect(() => {
    const again = setTimeout(() => {
      const focused = focus.focused();
      if (focused === null) return;
      focus.focus(null);
      focus.focus(focused);
    }, 50);
    return () => clearTimeout(again);
  }, [textScale]);
  return null;
}

interface SwitchRowProps {
  id: string;
  glyph: GlyphName;
  label: string;
  on: boolean;
  marginTop: number;
  onPress: () => void;
}

/** A setting that is on or off: its name, which it is, and a switch showing it. The whole row flips it. */
function SwitchRow({ id, glyph, label, on, marginTop, onPress }: SwitchRowProps) {
  const theme = useWarlockTheme();
  const styles = useStyles();
  return (
    <PlateButton
      id={id}
      glyph={glyph}
      label={label}
      fills={styles.fills}
      plate={{ edge: styles.edge }}
      place={{ marginTop }}
      minHeight={theme.rem(56)}
      paddingLeft={15}
      paddingRight={17}
      paddingY={9}
      onPress={onPress}
    >
      <Text style={[styles.state, on && styles.stateOn]} marginX={2} maxLines={1}>
        {on ? "On" : "Off"}
      </Text>
      <Switch on={on} track={styles.track} />
    </PlateButton>
  );
}

interface SegmentOption {
  id: string;
  label: string;
  chosen: boolean;
  /** The size of the text-size glyph over the label, in pixels at 100%; none without it. */
  glyph?: number;
  onPress: () => void;
}

/** Choices of one thing side by side as one control, the chosen one tinted with a pill under its label. */
function Segments({
  options,
  marginTop,
  narrow,
}: {
  options: readonly SegmentOption[];
  marginTop: number;
  narrow: boolean;
}) {
  const theme = useWarlockTheme();
  const styles = useStyles();
  const width = usePopupWidth();
  const between = 2;
  // As Warlock's grid has it: each but the last reaches to its neighbour, so the last is a little narrower.
  const reaching = columnWidth(width, 12, 8, 12 / options.length) + 8 - between;
  const final = width - (options.length - 1) * (reaching + between);
  return (
    <Joined
      flexDirection={narrow ? "column" : "row"}
      gap={narrow ? marginTop : between}
      marginTop={marginTop}
    >
      {options.map((option, index) => {
        const first = index === 0;
        const last = index === options.length - 1;
        const corners: Four = narrow
          ? [10, 10, 10, 10]
          : [first ? 10 : 4, last ? 10 : 4, last ? 10 : 4, first ? 10 : 4];
        return (
          <PlateButton
            key={option.id}
            id={option.id}
            label={option.label}
            detail={option.chosen ? "Selected" : undefined}
            selected={option.chosen}
            stacked
            fills={option.chosen ? styles.chosenFills : styles.fills}
            plate={{ edge: option.chosen ? styles.chosenEdge : styles.edge, corners }}
            place={narrow ? undefined : { width: last ? final : reaching }}
            minHeight={theme.rem(56)}
            gap={6}
            paddingX={5}
            paddingTop={9}
            paddingBottom={13}
            radius={narrow ? 10 : 4}
            labelStyle={styles.segmentLabel}
            detailStyle={styles.segmentDetail}
            leading={
              option.glyph !== undefined && (
                // Every size's glyph stands on one line, so the labels under them line up.
                <Box height={theme.rem(24)} alignItems="flex-end" justifyContent="center">
                  <Glyph name="textSize" size={option.glyph} />
                </Box>
              )
            }
            over={
              option.chosen
                ? (size) => (
                    <Rect
                      position="absolute"
                      x={(size.width - 18) / 2}
                      y={size.height - 5 - 3}
                      width={18}
                      height={3}
                      radius={1.5}
                      fill={theme.palette.brandText}
                      interactive={false}
                    />
                  )
                : undefined
            }
            onPress={option.onPress}
          />
        );
      })}
    </Joined>
  );
}

interface SaveGroupProps {
  id: string;
  label: string;
  caption: string;
  enabled: boolean;
  /** The control the keyboard goes on from once this has saved and can no longer be used: the draft's Refresh. */
  next: string;
  /** Store the draft; true if it was stored. */
  onSave: () => boolean;
}

/** A draft's Save: the panel's red action while there is something to save, with what it does under it. */
function SaveGroup({ id, label, caption, enabled, next, onSave }: SaveGroupProps) {
  const theme = useWarlockTheme();
  const focus = useFocus();
  const styles = useStyles();
  const width = usePopupWidth();
  const { palette } = theme;
  // The kit's label takes the free space of its button; these take a thousand times more, which centres glyph and label.
  const spacer = <Box flexGrow={1000} />;
  return (
    <Region flexDirection="column" marginTop={14}>
      <PopupButton
        id={id}
        variant="primary"
        glyph="save"
        label={label}
        disabled={!enabled}
        alignSelf="flex-start"
        minWidth={Math.min(width, theme.rem(208))}
        maxWidth={width}
        minHeight={theme.rem(40)}
        paddingLeft={17}
        paddingRight={19}
        paddingY={8}
        // Room for the mark a Save that cannot be used shows, so its label stays put when it can.
        labelStyle={{ weight: 600, marginRight: enabled ? 8 + theme.rem(12) : 0 }}
        style={
          enabled
            ? { border: { width: 0 } }
            : { fill: styles.card, border: { width: 1, color: styles.disabledEdge } }
        }
        shadow={
          enabled && theme.effects === "full"
            ? { color: alpha(palette.actionFill, 0.3), blur: 8, y: 2 }
            : undefined
        }
        leading={spacer}
        onPress={() => {
          if (onSave()) focus.focus(next);
        }}
      >
        {spacer}
      </PopupButton>
      <Text style={styles.caption} marginTop={6} marginX={6}>
        {caption}
      </Text>
    </Region>
  );
}
