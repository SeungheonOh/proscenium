import { Box } from "proscenium";
import { Badge, Divider, Label, Row, ScrollView, useTheme } from "proscenium/ui";
import { SectionFrame } from "./common.js";

const rows = Array.from({ length: 24 }, (_, index) => index + 1);

export default function ScrollSection() {
  const { colors, radii } = useTheme();
  return (
    <SectionFrame title="ScrollView (wheel over it)" grow={100}>
      <ScrollView flexGrow={1} minHeight={0} radius={radii.md} fill={colors.card} border={{ width: 1, color: colors.cardLine }}>
        {rows.map((row) => (
          <Box key={row}>
            <Row height={30} paddingX={10} gap={8}>
              <Badge tone={row % 3 === 0 ? "danger" : "accent"} />
              <Label variant="strong">Row {row}</Label>
              <Box flexGrow={1} />
              <Label tone="muted">{`${String(row).padStart(2, "0")}:${String(row * 7 % 60).padStart(2, "0")}`}</Label>
            </Row>
            <Divider style={{ marginY: 0 }} />
          </Box>
        ))}
      </ScrollView>
    </SectionFrame>
  );
}
