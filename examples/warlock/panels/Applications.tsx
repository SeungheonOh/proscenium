import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Box, Text, type BoxProps, type TextProps } from "proscenium";
import {
  forgetLaunchNotice,
  launchEntry,
  launchNotice,
  refreshCatalog,
  searchCatalog,
  useCatalog,
  type CatalogEntry,
} from "../catalog.js";
import {
  columnWidth,
  PopupButton,
  PopupField,
  PopupFrame,
  Region,
  useFocus,
  usePopupWidth,
} from "../kit.js";
import { pinLimit, pinsFile, useStored } from "../storage.js";
import { alpha, themed, useWarlockTheme } from "../theme.js";
import { idleNotice, useWarlock } from "../WarlockProvider.js";
import { jumpReturnsToApplications } from "./Jump.js";

/** The search text, kept while the launcher is closed: it opens with what was last typed. */
let keptQuery = "";

/** The launcher's grid: six columns, this far apart. */
const columns = 6;
const gap = 6;
/** How many of the controls under Close and Refresh show at a time; more are paged. */
const pageSize = 8;
const queryLimit = 256;
/** A stored pin list holds no more than this many bytes of JSON. */
const pinBytes = 3000;
/**
 * The search field lets go of the keyboard a moment after any press that is
 * not on it, so focus sent back to it after a press waits this long.
 */
const refocusDelay = 80;

const none: readonly CatalogEntry[] = [];

/** LABEL as a control shows it: one too long to show is cut, with an ellipsis. */
function shown(label: string): string {
  if (label.length <= 512) return label;
  const cut = 511;
  const high = label.charCodeAt(cut - 1);
  // Not through the middle of a character that takes two units.
  return `${label.slice(0, high >= 0xd800 && high <= 0xdbff ? cut - 1 : cut)}…`;
}

/** One control of the grid: how many columns it spans, and itself at the width that comes to. */
interface Cell {
  id: string;
  span: 2 | 3 | 6;
  render: (width: number) => ReactNode;
}

/** CELLS in rows as a grid places them: each on the row of the one before while it still fits. */
function rowsOf(cells: readonly Cell[]): Cell[][] {
  const rows: Cell[][] = [];
  let used = columns;
  for (const cell of cells) {
    if (used + cell.span > columns) {
      rows.push([]);
      used = 0;
    }
    rows[rows.length - 1]!.push(cell);
    used += cell.span;
  }
  return rows;
}

type Focus = ReturnType<typeof useFocus>;

/** Gives the popup's focus to the panel, which renders the frame that holds it and so is outside it. */
function FocusTap({ into }: { into: RefObject<Focus | null> }) {
  into.current = useFocus();
  return null;
}

const useStyles = themed((theme) => {
  const clear = { width: 1, color: alpha(theme.palette.text, 0) };
  const hairline = { width: 1, color: theme.skin.hairline };
  return {
    caption: {
      ...theme.type.detail,
      weight: 600,
      color: theme.palette.textSecondary,
      maxLines: 1,
    } satisfies TextProps,
    /** Letter spacing of .06em, in the thousandths of a pixel text markup counts in. */
    tracking: Math.round(theme.rem(12) * 0.06 * 1024),
    row: { radius: 6 } satisfies BoxProps,
    detailed: { radius: 6, minHeight: theme.rem(56) } satisfies BoxProps,
    actions: { radius: 6, minHeight: theme.rem(56), border: hairline } satisfies BoxProps,
    chip: {
      radius: 6,
      minHeight: theme.rem(34),
      paddingX: 10,
      paddingY: 4,
      gap: 6,
      border: clear,
    } satisfies BoxProps,
    chipLabel: { size: theme.rem(12), lineHeight: 16 / 12 } satisfies TextProps,
    tile: {
      radius: 6,
      minHeight: theme.rem(84),
      paddingX: 8,
      paddingY: 10,
      border: hairline,
    } satisfies BoxProps,
    tileLabel: { size: theme.rem(13), weight: 600 } satisfies TextProps,
  };
});

/**
 * The Applications launcher: a search field over every installed application.
 * Results are tiles that open what they name; above them, the first result's
 * own actions and its pin, and the taskbar's pins to remove or reorder. Enter
 * in the field opens the first result shown.
 */
export function ApplicationsPanel() {
  const theme = useWarlockTheme();
  const styles = useStyles();
  const { closePopup, openPopup, popup, notify } = useWarlock();
  const catalog = useCatalog();
  const pins = useStored(pinsFile);
  const width = usePopupWidth();
  const focus = useRef<Focus | null>(null);
  const [query, setQuery] = useState(keptQuery);
  const [page, setPage] = useState(0);
  const [reading, setReading] = useState(true);
  // Nothing is listed until this opening has read the applications itself.
  const [listed, setListed] = useState(false);
  const [pinNotice, setPinNotice] = useState("");
  const work = useRef<{ reads: number; refocus: ReturnType<typeof setTimeout> | undefined }>({
    reads: 0,
    refocus: undefined,
  });

  /** Read the installed applications and the pins again. */
  const read = () => {
    const serial = ++work.current.reads;
    setReading(true);
    setPinNotice("");
    setPage(0);
    pinsFile.refresh();
    // How the last launch went is said until applications are read again.
    const forgotten = forgetLaunchNotice("launch", idleNotice);
    if (forgotten !== null) notify(forgotten);
    void refreshCatalog().then(() => {
      if (work.current.reads !== serial) return;
      setReading(false);
      setListed(true);
    });
  };

  useEffect(() => {
    read();
    return () => {
      work.current.reads = -1;
      clearTimeout(work.current.refocus);
    };
  }, []);

  const available = listed && !catalog.unavailable;
  const entries = available ? catalog.entries : none;
  const results = useMemo(() => searchCatalog(entries, query), [entries, query]);
  const first = results[0];
  const nameOf = (id: string) => entries.find((entry) => entry.id === id)?.name ?? id;

  const type = (text: string) => {
    // A query too long, or with characters no key types, is not taken.
    if (text.length > queryLimit || /[\u0000-\u001f\u007f]/.test(text)) return;
    keptQuery = text;
    setQuery(text);
    setPage(0);
  };

  const start = (entry: CatalogEntry) => {
    launchEntry(entry);
    notify(launchNotice("launch", "Launch submitted.", idleNotice));
    closePopup();
  };

  const openActions = (entry: CatalogEntry, anchor: { x: number; y: number } | null) => {
    jumpReturnsToApplications();
    openPopup({ mode: "jump", entry: entry.id }, { output: popup?.output, anchor });
  };

  /** Store PINS as the taskbar's; a list the taskbar cannot hold changes nothing. */
  const savePins = (next: readonly string[]) => {
    const fits =
      next.length <= pinLimit &&
      new Set(next).size === next.length &&
      Buffer.byteLength(JSON.stringify(next)) <= pinBytes;
    if (!fits) return;
    if (!pinsFile.save(next)) {
      setPinNotice("Pin change refused. Refresh applications and choose again.");
      return;
    }
    setPinNotice("");
    clearTimeout(work.current.refocus);
    work.current.refocus = setTimeout(() => focus.current?.focus("search"), refocusDelay);
  };
  const movePin = (index: number, by: 1 | -1) => {
    const next = [...pins];
    const [moved] = next.splice(index, 1);
    next.splice(index + by, 0, moved!);
    savePins(next);
  };

  // What pages: the first result's actions and pin, three controls for each pin, then every result.
  const prefix: Cell[] = [];
  if (first) {
    prefix.push({
      id: `jump:${first.id}`,
      span: 6,
      render: (width) => (
        <PopupButton
          key="jump"
          id={`jump:${first.id}`}
          variant="tile"
          glyph="actions"
          label={shown(`Actions for ${first.name}`)}
          detail="Application actions and recent files"
          width={width}
          style={styles.actions}
          onPress={() => openActions(first, null)}
        />
      ),
    });
    if (!pins.includes(first.id))
      prefix.push({
        id: `pin:${first.id}`,
        span: 6,
        render: (width) => (
          <PopupButton
            key="pin"
            id={`pin:${first.id}`}
            label={shown(`Pin ${first.name}`)}
            detail="Add to taskbar"
            width={width}
            style={styles.detailed}
            onPress={() => savePins([...pins, first.id])}
          />
        ),
      });
  }
  if (available)
    pins.forEach((id, index) => {
      const name = nameOf(id);
      const chip = (
        key: string,
        glyph: "unpin" | "arrowLeft" | "arrowRight",
        label: string,
        enabled: boolean,
        onPress: () => void,
      ): Cell => ({
        id: `${key}:${id}`,
        span: 2,
        render: (width) => (
          <PopupButton
            key={`${key}:${id}`}
            id={`${key}:${id}`}
            variant="tile"
            glyph={glyph}
            glyphSize={16}
            label={shown(label)}
            width={width}
            style={styles.chip}
            labelStyle={styles.chipLabel}
            disabled={!enabled}
            onPress={onPress}
          />
        ),
      });
      prefix.push(
        chip("unpin", "unpin", `Unpin ${name}`, true, () =>
          savePins(pins.filter((pin) => pin !== id)),
        ),
        chip("pin-left", "arrowLeft", `Move ${name} left`, index > 0, () => movePin(index, -1)),
        chip("pin-right", "arrowRight", `Move ${name} right`, index < pins.length - 1, () =>
          movePin(index, 1),
        ),
      );
    });

  const total = prefix.length + results.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(page, pages - 1);
  const offset = current * pageSize;
  const leading = prefix.slice(offset, offset + pageSize);
  const from = Math.max(0, offset - prefix.length);
  const tiles = results.slice(from, from + pageSize - leading.length);

  /** Show the next page, or the one before. */
  const turn = (by: 1 | -1) => {
    const target = current + by;
    if (target < 0 || target >= pages) return;
    setPage(target);
    // The button used keeps focus until its end is reached, where the other takes it.
    if (by > 0 && target === pages - 1) focus.current?.focus("page-previous");
    else if (by < 0 && target === 0) focus.current?.focus("page-next");
  };

  const cells: Cell[] = [
    {
      id: "label",
      span: 6,
      render: (width) => (
        <Box key="label" width={width}>
          <Text style={styles.caption} width={width} markup>
            {`<span letter_spacing="${styles.tracking}">SEARCH APPLICATIONS</span>`}
          </Text>
        </Box>
      ),
    },
    {
      id: "search",
      span: 6,
      render: (width) => (
        <PopupField
          key="search"
          id="search"
          pill
          glyph="search"
          value={query}
          placeholder="Search applications"
          width={width}
          marginBottom={6}
          onChangeText={type}
          // The first result, whichever page shows: with a few pins its tile is pages away.
          onSubmit={() => {
            if (results[0]) start(results[0]);
          }}
          onEscape={closePopup}
        />
      ),
    },
    {
      id: "close",
      span: 3,
      render: (width) => (
        <PopupButton
          key="close"
          id="close"
          glyph="close"
          label="Close applications"
          width={width}
          style={styles.row}
          onPress={closePopup}
        />
      ),
    },
    {
      id: "refresh",
      span: 3,
      render: (width) => (
        <PopupButton
          key="refresh"
          id="refresh"
          glyph="refresh"
          label="Refresh"
          width={width}
          style={styles.row}
          onPress={read}
        />
      ),
    },
  ];
  if (pages > 1)
    cells.push(
      {
        id: "page-range",
        span: 6,
        render: (width) => (
          <PopupButton
            key="page-range"
            id="page-range"
            label={`Items ${offset + 1}–${Math.min(total, offset + pageSize)} of ${total}`}
            detail={`${results.length} matching applications · ${pins.length} pinned`}
            width={width}
            style={styles.detailed}
            disabled
          />
        ),
      },
      {
        id: "page-previous",
        span: 3,
        render: (width) => (
          <PopupButton
            key="page-previous"
            id="page-previous"
            label="Previous page"
            width={width}
            style={styles.row}
            disabled={current === 0}
            onPress={() => turn(-1)}
          />
        ),
      },
      {
        id: "page-next",
        span: 3,
        render: (width) => (
          <PopupButton
            key="page-next"
            id="page-next"
            label="Next page"
            width={width}
            style={styles.row}
            disabled={current === pages - 1}
            onPress={() => turn(1)}
          />
        ),
      },
    );
  cells.push(...leading);
  for (const entry of tiles)
    cells.push({
      id: `entry:${entry.id}`,
      span: 2,
      render: (width) => (
        <PopupButton
          key={`entry:${entry.id}`}
          id={`entry:${entry.id}`}
          variant="tile"
          stacked
          glyph="open"
          glyphColor={theme.palette.brandText}
          label={shown(`Open ${entry.name}`)}
          width={width}
          style={styles.tile}
          labelStyle={styles.tileLabel}
          onPress={() => start(entry)}
          onContext={(event) =>
            openActions(entry, event ? { x: event.screenX, y: event.screenY } : null)
          }
        />
      ),
    });

  const status =
    pinNotice !== ""
      ? pinNotice
      : reading
        ? "Loading applications…"
        : catalog.unavailable
          ? "Application list unavailable. Refresh to try again."
          : results.length === 0
            ? "No matching applications. Change your search or Refresh."
            : query.trim() === ""
              ? "Type to search applications."
              : "Choose a matching application.";

  return (
    <PopupFrame
      title="Applications"
      hideTitle
      status={status}
      initial="search"
      arrows="none"
      onEscape={closePopup}
      // The Menu key, or Shift+F10, on a result opens that application's own actions.
      onKey={(event) => {
        if (event.key !== "Menu" && !(event.key === "F10" && event.modifiers.includes("shift")))
          return false;
        const entry = tiles.find(
          (candidate) => `entry:${candidate.id}` === focus.current?.focused(),
        );
        if (entry) openActions(entry, null);
        return true;
      }}
      list={{ gap }}
    >
      <FocusTap into={focus} />
      {rowsOf(cells).map((row) => (
        <Region key={row[0]!.id} flexDirection="row" gap={gap}>
          {row.map((cell) => cell.render(columnWidth(width, columns, gap, cell.span)))}
        </Region>
      ))}
    </PopupFrame>
  );
}
