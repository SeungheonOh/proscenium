import { Text, useCamera } from "proscenium";
import { BarText } from "../components/bar/BarText.js";
import { colors } from "../lib/theme.js";
import { strengths } from "./magnetism.js";
import { useArrangeSettings } from "./useArrange.js";

/** The bar's left side on the canvas: the zoom level, then guides and magnet mode. */
export function ZoomLabel() {
  const camera = useCamera();
  const [arrange] = useArrangeSettings();
  const percent = Math.round((camera?.zoom ?? 1) * 100);
  const strength = strengths.find((s) => s.value === arrange.strength)?.name ?? "";
  const modes: string[] = [];
  if (!arrange.snapping) modes.push("Guides off");
  if (arrange.magnet) modes.push(`Magnet ${strength}`);
  return (
    <BarText color={colors.muted}>
      Canvas · <Text weight={600} color={colors.ink}>{percent}%</Text>
      {modes.map((mode) => ` · ${mode}`).join("")}
    </BarText>
  );
}
