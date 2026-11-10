import { useEffect, useRef, useState } from "react";
import { Box, Text, type BoxProps, type TextProps } from "proscenium";
import {
  acceptableDraft,
  collections,
  openTarget,
  readFiles,
  validTarget,
  type FilesSnapshot,
} from "../files.js";
import type { GlyphName } from "../glyphs.js";
import { columnWidth, Glyph, PopupButton, PopupField, PopupFrame, usePopupWidth } from "../kit.js";
import { alpha, themed, useWarlockTheme } from "../theme.js";
import { useWarlock } from "../WarlockProvider.js";

const useStyles = themed((theme) => {
  const { palette, skin } = theme;
  const edge = { width: 1, color: skin.hairline };
  // The sunken fill of the location pill and the path field.
  const well =
    theme.theme === "high-contrast"
      ? palette.surface
      : theme.glass
        ? alpha(palette.canvas, 0.62)
        : palette.surfaceRecessed;
  return {
    well,
    quietLabel: { size: theme.rem(13) } satisfies TextProps,
    smallDetail: { size: theme.rem(11) } satisfies TextProps,
    pill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      minHeight: theme.rem(40),
      paddingLeft: 12,
      paddingRight: 16,
      paddingY: 7,
      radius: theme.rem(20),
      fill: well,
      border: edge,
    } satisfies BoxProps,
    location: { ...theme.type.label, size: theme.rem(13), lineHeight: 1.45 } satisfies TextProps,
    tileLabel: { size: theme.rem(13) } satisfies TextProps,
    /** A tile that cannot be used keeps its fill and edge. */
    tileIdle: { fill: skin.tile, border: edge } satisfies BoxProps,
    fieldLabel: {
      ...theme.type.labelStrong,
      size: theme.rem(12),
      lineHeight: 16 / 12,
      color: palette.textSecondary,
    } satisfies TextProps,
  };
});

/**
 * The Files menu: where the file manager is now, Home and seven collections
 * as tiles, and a field for any other folder. Choosing one closes the menu
 * and shows the folder in the file manager; the taskbar says how that went.
 */
export function FilesPanel() {
  const theme = useWarlockTheme();
  const styles = useStyles();
  const { closePopup, notify } = useWarlock();
  const width = usePopupWidth();
  const [snapshot, setSnapshot] = useState<FilesSnapshot | null>(null);
  const [reading, setReading] = useState(false);
  const [notice, setNotice] = useState("Loading Files…");
  const [draft, setDraft] = useState("");
  const reads = useRef(0);

  const read = () => {
    const serial = ++reads.current;
    setReading(true);
    void readFiles().then(
      (next) => {
        if (serial !== reads.current) return;
        setReading(false);
        setSnapshot(next);
        setNotice(
          next.available ? "Choose a collection or folder." : "Installed Files unavailable",
        );
      },
      () => {
        if (serial !== reads.current) return;
        setReading(false);
        setNotice(
          "Files unavailable. Refresh Files state to read current access. No opening will be repeated.",
        );
      },
    );
  };

  useEffect(() => {
    read();
    return () => {
      // What is still being read is for a menu no longer there.
      reads.current++;
    };
  }, []);

  const ready = (target: string) => !reading && snapshot?.available === true && validTarget(target);

  /** Close the menu and show TARGET; the taskbar's status says whether it opened. */
  const open = (target: string) => {
    closePopup();
    void openTarget(target).then(
      (outcome) =>
        notify(
          outcome === "opened"
            ? "Files: requested location opened."
            : "Files: request refused. Refresh before choosing again.",
          4,
        ),
      () =>
        notify(
          "Files: opening not confirmed. Refresh only reads state; this request will not be repeated.",
          4,
        ),
    );
  };

  // Larger text gives the tiles, the field and its button more of the row.
  const large = theme.textScale >= 150;
  const span = (columns: number) => columnWidth(width, 12, 8, columns);

  const quiet = {
    variant: "quiet",
    width: span(theme.textScale === 200 ? 12 : 6),
    minHeight: theme.rem(40),
    paddingX: 10,
    glyphSize: 18,
    labelStyle: styles.quietLabel,
  } as const;

  const tile = (id: string, target: string, label: string, glyph: GlyphName) => {
    const disabled = !ready(target);
    return (
      <PopupButton
        key={id}
        id={id}
        label={label}
        glyph={glyph}
        glyphColor={theme.palette.brandText}
        stacked
        variant="tile"
        width={span(large ? 6 : 3)}
        minHeight={theme.rem(76)}
        paddingX={6}
        paddingTop={12}
        paddingBottom={10}
        radius={12}
        style={disabled ? styles.tileIdle : undefined}
        labelStyle={styles.tileLabel}
        disabled={disabled}
        onPress={() => open(target)}
      />
    );
  };

  const canOpen = ready(draft);
  return (
    <PopupFrame
      title="Files"
      status={reading ? "Reading Files state…" : notice}
      initial="close"
      onEscape={closePopup}
      list={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
    >
      <PopupButton
        id="close"
        glyph="close"
        label="Close Files menu"
        {...quiet}
        onPress={closePopup}
      />
      <PopupButton
        id="refresh"
        glyph="refresh"
        label="Refresh Files state"
        detail="Read location; never repeat an opening"
        detailStyle={styles.smallDetail}
        {...quiet}
        disabled={reading}
        onPress={read}
      />

      <Box style={styles.pill} width={width} marginTop={2} marginBottom={6}>
        <Glyph name="folder" size={18} color={theme.palette.brandText} />
        <Text style={styles.location} flexShrink={1}>
          {snapshot?.location
            ? `Current location: ${snapshot.location}`
            : "No Files window observed."}
        </Text>
      </Box>

      {tile("home", "home", "Home", "home")}
      {collections.map((collection) =>
        tile(
          `collection:${collection.id}`,
          `coll:${collection.id}`,
          collection.label,
          collection.glyph,
        ),
      )}

      <Box width={width} marginTop={8} marginBottom={-2} paddingX={2}>
        <Text style={styles.fieldLabel}>{"Folder path".toUpperCase()}</Text>
      </Box>
      <PopupField
        id="path"
        mono
        value={draft}
        onChangeText={(text) => {
          if (acceptableDraft(text)) setDraft(text);
        }}
        placeholder="/path/to/folder or ~/Documents"
        onEscape={closePopup}
        width={span(large ? 12 : 8)}
        height={theme.rem(48)}
        radius={12}
        paddingLeft={8}
        fill={styles.well}
      />
      <PopupButton
        id="open"
        variant="tile"
        glyph="folder"
        glyphColor={theme.palette.brandText}
        label="Open folder"
        detail="Open this path in Files"
        detailStyle={styles.smallDetail}
        width={span(large ? 12 : 4)}
        minHeight={theme.rem(48)}
        radius={12}
        style={canOpen ? undefined : styles.tileIdle}
        disabled={!canOpen}
        onPress={() => open(draft)}
      />
    </PopupFrame>
  );
}
