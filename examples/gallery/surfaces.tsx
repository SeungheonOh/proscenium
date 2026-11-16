import { Box } from "proscenium";
import { Label, Row, Surface, useTheme } from "proscenium/ui";
import { Note, SectionFrame } from "./common.js";

const radiiList = [0, 2, 4, 6, 9, 14, 22];

export default function SurfacesSection() {
  const { colors, shadows } = useTheme();
  const names = ["pill", "card", "float", "knob"] as const;
  return (
    <SectionFrame title="Surfaces: radii, shadows, variants" grow={200}>
      <Row gap={8}>
        {radiiList.map((radius) => <Box key={radius} width={36} height={36} radius={radius} fill={colors.accent} />)}
        <Note>radii</Note>
      </Row>
      <Row gap={12} paddingY={6}>
        {names.map((name) => (
          <Box key={name} width={62} height={44} radius={9} fill={colors.card} shadow={shadows[name]}
               alignItems="center" justifyContent="center">
            <Label variant="caption">{name}</Label>
          </Box>
        ))}
      </Row>
      <Row gap={10}>
        {(["glass", "card", "ink", "accent"] as const).map((variant) => (
          <Surface key={variant} variant={variant} width={78} height={46} alignItems="center" justifyContent="center">
            <Label variant="strong" tone={variant === "ink" ? "inverse" : variant === "accent" ? "onAccent" : "ink"}>{variant}</Label>
          </Surface>
        ))}
      </Row>
    </SectionFrame>
  );
}
