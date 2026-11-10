import { entryForApp, launchEntry, useCatalog } from "../catalog.js";
import { Hairline, PopupButton, PopupFrame } from "../kit.js";
import { useWarlockTheme } from "../theme.js";
import { useWarlock } from "../WarlockProvider.js";

/** Where a row's label starts when it has no glyph: under the labels of those that do. */
const indent = 42;

/**
 * A window's menu: Restore, Minimize, Always on top and Maximize, then snapping
 * and what its application offers. Choosing a row does it and closes the menu;
 * the first row closes the menu alone.
 */
export function WindowMenuPanel({ window }: { window: number }) {
  const theme = useWarlockTheme();
  const warlock = useWarlock();
  const {
    closePopup,
    record,
    windows,
    activate,
    minimize,
    restoreSize,
    maximize,
    setOnTop,
    setFullscreen,
    openPopup,
    popup,
  } = warlock;
  const { entries } = useCatalog();
  const entry = record(window);
  const info = windows.get(window);
  if (!entry || !info) return null;
  const application = entryForApp(entries, info.appId);
  const keep = { output: popup?.output, anchor: popup?.anchor ?? null };

  /** Do ACTION and close the menu. */
  const choose = (action: () => void) => () => {
    closePopup();
    action();
  };
  const state = [entry.placement === "maximized" && "Maximized", entry.onTop && "Always on top"]
    .filter(Boolean)
    .join(" • ");
  const canRestore = entry.minimized || entry.placement === "maximized";

  return (
    <PopupFrame
      title="Window actions"
      status="Window actions"
      arrows="menu"
      initial="restore"
      onEscape={closePopup}
    >
      <PopupButton id="close" glyph="close" label="Close" onPress={closePopup} />
      <Hairline />
      <PopupButton
        id="restore"
        label="Restore"
        paddingLeft={indent}
        disabled={!canRestore}
        onPress={choose(() => (entry.minimized ? activate(window) : restoreSize(window)))}
      >
        {state !== "" && <StateHint text={state} />}
      </PopupButton>
      <PopupButton
        id="minimize"
        label="Minimize"
        paddingLeft={indent}
        disabled={entry.minimized}
        onPress={choose(() => minimize(window))}
      />
      {entry.fullscreen && (
        <PopupButton
          id="exit-fullscreen"
          label="Exit fullscreen"
          paddingLeft={indent}
          onPress={choose(() => setFullscreen(window, false))}
        />
      )}
      <PopupButton
        id="on-top"
        label="Always on top"
        glyph={entry.onTop ? "check" : undefined}
        glyphColor={theme.palette.brandText}
        paddingLeft={entry.onTop ? undefined : indent}
        disabled={!entry.onTop && !warlock.canPin(window)}
        onPress={choose(() => setOnTop(window, !entry.onTop))}
      />
      <PopupButton
        id="maximize"
        label="Maximize"
        paddingLeft={indent}
        disabled={!warlock.canMaximize(window)}
        onPress={choose(() => maximize(window))}
      />
      {(warlock.canSnap(window) || application) && <Hairline />}
      {warlock.canSnap(window) && (
        <PopupButton
          id="snap"
          label="Snap window"
          paddingLeft={indent}
          onPress={() => openPopup({ mode: "snap", window }, keep)}
        />
      )}
      {application && (
        <PopupButton
          id="new-instance"
          glyph="newWindow"
          label="New instance"
          detail={application.name}
          onPress={choose(() => launchEntry(application))}
        />
      )}
      {application && (
        <PopupButton
          id="application-actions"
          glyph="actions"
          label="Application actions"
          detail="Declared actions and recent files"
          onPress={() => openPopup({ mode: "jump", entry: application.id }, keep)}
        />
      )}
    </PopupFrame>
  );
}

/** What state the window is in, at the row's end. */
function StateHint({ text }: { text: string }) {
  const theme = useWarlockTheme();
  return <PopupDetail text={text} size={theme.rem(12)} color={theme.palette.textSecondary} />;
}

import { Text } from "proscenium";

function PopupDetail({ text, size, color }: { text: string; size: number; color: string }) {
  return (
    <Text size={size} color={color} font="Inter, sans-serif" maxLines={1} flexShrink={0}>
      {text}
    </Text>
  );
}
