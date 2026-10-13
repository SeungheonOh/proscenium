import { Text, useCamera } from "proscenium";
import { BarText } from "../components/bar/BarText.js";
import { colors } from "../lib/theme.js";

/** The bar's left side on the canvas: the zoom level. */
export function ZoomLabel() {
  const camera = useCamera();
  const percent = Math.round((camera?.zoom ?? 1) * 100);
  return (
    <BarText color={colors.muted}>
      Canvas ·{" "}
      <Text weight={600} color={colors.ink}>
        {percent}%
      </Text>
    </BarText>
  );
}
