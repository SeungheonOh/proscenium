import { Box, Mirror, Rect, Text } from "proscenium";
import { useTaskbarGroups } from "../groups.js";
import { columnWidth, PopupButton, PopupFrame, Region, usePopupWidth } from "../kit.js";
import { alpha, useWarlockTheme } from "../theme.js";
import { useWarlock } from "../WarlockProvider.js";

/** A window's picture in its card: the live window, fitted whole into a 16:9 well, with what it shows named in a pill. */
function Preview({
  window,
  width,
  minimized,
}: {
  window: number;
  width: number;
  minimized: boolean;
}) {
  const theme = useWarlockTheme();
  const { windows } = useWarlock();
  const info = windows.get(window);
  const height = Math.round((width * 9) / 16);
  const scale =
    info && info.width > 0 && info.height > 0
      ? Math.min(width / info.width, height / info.height)
      : 0;
  const shown = {
    width: Math.round((info?.width ?? 0) * scale),
    height: Math.round((info?.height ?? 0) * scale),
  };
  const state =
    scale === 0 ? "Preview unavailable" : minimized ? "Historical preview" : "Live preview";
  return (
    <Box
      width={width}
      height={height}
      radius={8}
      fill={theme.palette.surfaceRecessed}
      border={{ width: 1, color: theme.skin.hairline }}
      marginBottom={8}
      clip
    >
      {scale > 0 && (
        <Mirror
          window={window}
          position="absolute"
          x={Math.round((width - shown.width) / 2)}
          y={Math.round((height - shown.height) / 2)}
          width={shown.width}
          height={shown.height}
        />
      )}
      <Box
        position="absolute"
        x={6}
        y={height - 6 - theme.rem(18)}
        height={theme.rem(18)}
        paddingX={8}
        gap={5}
        radius={theme.rem(9)}
        alignItems="center"
        fill={alpha(theme.palette.canvas, 0.84)}
        border={{ width: 1, color: theme.skin.hairline }}
      >
        {state === "Live preview" && (
          <Rect width={6} height={6} radius={3} fill={theme.palette.brandText} />
        )}
        <Text
          font={theme.type.label.font}
          size={theme.rem(10)}
          weight={600}
          color={theme.palette.text}
          maxLines={1}
        >
          {state}
        </Text>
        {scale > 0 && (
          <Text
            font={theme.type.label.font}
            size={theme.rem(10)}
            weight={600}
            color={theme.palette.textSecondary}
            maxLines={1}
          >
            Client content
          </Text>
        )}
      </Box>
    </Box>
  );
}

/** The windows of one taskbar button, as cards with live pictures: choose one to switch to it. */
export function PickerPanel({ group }: { group: string }) {
  const { closePopup, status, record, label, activate, openPopup, popup } = useWarlock();
  const groups = useTaskbarGroups();
  const width = usePopupWidth();
  const members = groups.find((candidate) => candidate.key === group)?.windows ?? [];
  const columns = Math.max(1, Math.floor((width + 12) / 212));
  const card = columnWidth(width, columns, 12);

  return (
    <PopupFrame
      title="Choose a window"
      status={status ?? "Each window, live."}
      initial={members.length > 0 ? `window:${members[0]}` : "close"}
      onEscape={closePopup}
      list={{ gap: 12 }}
    >
      <PickerBody>
        <PopupButton
          id="close"
          variant="quiet"
          glyph="close"
          label="Close"
          alignSelf="flex-start"
          onPress={closePopup}
        />
        <Region flexDirection="row" flexWrap="wrap" gap={12}>
          {members.map((window) => {
            const entry = record(window);
            const minimized = entry?.minimized ?? false;
            const facts = [
              entry?.placement === "maximized" && "Maximized",
              entry?.onTop && "Always on top",
              minimized ? "Minimized" : "Open",
            ];
            return (
              <PopupButton
                key={window}
                id={`window:${window}`}
                variant="tile"
                width={card}
                flexDirection="column"
                alignItems="stretch"
                gap={0}
                radius={12}
                paddingX={8}
                paddingTop={8}
                paddingBottom={12}
                label={`${minimized ? "Restore" : "Activate"} ${label(window)}`}
                labelStyle={{ weight: 600 }}
                detail={facts.filter(Boolean).join(" • ")}
                leading={<Preview window={window} width={card - 18} minimized={minimized} />}
                onPress={() => {
                  closePopup();
                  activate(window);
                }}
                onContext={(event) =>
                  openPopup(
                    { mode: "menu", window },
                    {
                      output: popup?.output,
                      anchor: event ? { x: event.screenX, y: event.screenY } : null,
                    },
                  )
                }
              />
            );
          })}
        </Region>
      </PickerBody>
    </PopupFrame>
  );
}

function PickerBody({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
