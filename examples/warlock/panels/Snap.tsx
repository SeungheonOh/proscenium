import { useState } from "react";
import { Box } from "proscenium";
import { columnWidth, PopupButton, PopupFrame, Region, usePopupWidth } from "../kit.js";
import { snapRegions, type SnapRegion } from "../state.js";
import { alpha, useWarlockTheme } from "../theme.js";
import { useWarlock } from "../WarlockProvider.js";

/**
 * The snap chooser: two small screens, one cut in halves and one in quarters.
 * Picking a region selects it; the button under them puts the window there.
 */
export function SnapPanel({ window }: { window: number }) {
  const theme = useWarlockTheme();
  const { closePopup, snap, canSnap, status, activate } = useWarlock();
  const width = usePopupWidth();
  const [selected, setSelected] = useState<SnapRegion>("left");
  const available = canSnap(window);
  const name = snapRegions.find((entry) => entry.region === selected)!.label;
  // Four columns of zones across the two screens, a gap between the screens.
  const zone = columnWidth(width - 14 - 28, 4, 6) - 7;
  const quarter = theme.rem(80);
  const half = 2 * quarter + 6;

  const zoneButton = (region: SnapRegion, height: number) => {
    const { label } = snapRegions.find((entry) => entry.region === region)!;
    const chosen = region === selected;
    return (
      <PopupButton
        key={region}
        id={`region:${region}`}
        label={label}
        detail={chosen ? "Selected" : undefined}
        stacked
        variant={chosen ? "primary" : "tile"}
        width={zone}
        height={height}
        radius={8}
        gap={0}
        paddingX={6}
        paddingY={10}
        style={
          chosen
            ? undefined
            : {
                fill: alpha(theme.palette.text, 0.09),
                border: { width: 1, color: alpha(theme.palette.text, 0.08) },
              }
        }
        shadow={
          chosen && theme.effects === "full"
            ? { color: alpha(theme.palette.actionFill, 0.38), blur: 10, y: 2 }
            : undefined
        }
        labelStyle={{ size: theme.rem(13), weight: 600, align: "center" }}
        detailStyle={{
          size: theme.rem(11),
          weight: 600,
          color: chosen ? theme.palette.onAction : theme.palette.textSecondary,
        }}
        disabled={!available}
        onPress={() => setSelected(region)}
      />
    );
  };
  const screen = {
    padding: 7,
    gap: 6,
    radius: 14,
    fill: alpha(theme.palette.canvas, 0.55),
    border: { width: 1, color: theme.skin.hairline },
  } as const;

  return (
    <PopupFrame
      title="Snap window"
      status={status}
      initial="close"
      onEscape={closePopup}
      list={{ gap: 0 }}
    >
      <PopupButton
        id="close"
        variant="quiet"
        glyph="close"
        label="Close"
        alignSelf="flex-start"
        marginBottom={12}
        onPress={closePopup}
      />
      <Region flexDirection="row" gap={28} paddingX={7}>
        <Region flexDirection="row" {...screen}>
          {zoneButton("left", half)}
          {zoneButton("right", half)}
        </Region>
        <Region flexDirection="column" {...screen}>
          <Region flexDirection="row" gap={6}>
            {zoneButton("top-left", quarter)}
            {zoneButton("top-right", quarter)}
          </Region>
          <Region flexDirection="row" gap={6}>
            {zoneButton("bottom-left", quarter)}
            {zoneButton("bottom-right", quarter)}
          </Region>
        </Region>
      </Region>
      <Box flexDirection="row" justifyContent="flex-end" marginTop={18} paddingX={14}>
        <PopupButton
          id="apply"
          variant="primary"
          glyph="snap"
          glyphSize={18}
          label={available ? `Snap to ${name.toLowerCase()}` : "Snapping unavailable"}
          minHeight={theme.rem(40)}
          paddingLeft={14}
          paddingRight={18}
          disabled={!available}
          shadow={
            available && theme.effects === "full"
              ? { color: alpha(theme.palette.actionFill, 0.32), blur: 14, y: 4 }
              : undefined
          }
          onPress={() => {
            closePopup();
            snap(window, selected);
            activate(window);
          }}
        />
      </Box>
    </PopupFrame>
  );
}
