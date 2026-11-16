import { Box, Rect, Text } from "proscenium";
import { useTheme } from "proscenium/ui";
import { hsl, TNote, SectionFrame, Tray } from "./common.js";

const items = Array.from({ length: 16 }, (_, index) => index);
const width = 362, height = 128;

export default function ScrollerSection() {
  const { font } = useTheme();
  return (
    <SectionFrame title="Nested scrollers (wheel over them)" grow={330}>
      <Tray>
        <TNote>scroll="y" in a r22 card: rounded clip of scrolled rows, overlay thumb</TNote>
        <Box width={width} height={height} radius={22} clip fill="#ffffff" border={{ width: 1, color: "#17171a26" }} scroll="y">
          <Box position="absolute" x={0} y={0} width="100%" flexDirection="column">
            {items.map((index) => (
              <Box key={index} height={32} paddingX={18} flexDirection="row" alignItems="center" fill={hsl(index * 22, 0.7, 0.88)}>
                <Text font={font} size={12} weight={650} color="#17171a">Row {index + 1} on a tinted band</Text>
              </Box>
            ))}
          </Box>
          <Rect scrollThumb="y" position="absolute" x={width - 12} y={10} width={5} height={28} radius={2.5} fill="#17171a99" />
        </Box>
      </Tray>
      <Tray>
        <TNote>scroll="x" in a pill: wheel with shift</TNote>
        <Box width={width} height={64} radius={32} clip fill="#ffffff" border={{ width: 1, color: "#17171a26" }} scroll="x">
          <Box position="absolute" x={0} y={0} height="100%" flexDirection="row" alignItems="center" gap={8} paddingX={16}>
            {items.map((index) => (
              <Box key={index} width={44} height={36} radius={[18, 6, 18, 6]} fill={hsl(index * 22, 0.7, 0.55)} />
            ))}
          </Box>
          <Rect scrollThumb="x" position="absolute" x={22} y={64 - 10} width={28} height={4} radius={2} fill="#17171a99" />
        </Box>
      </Tray>
    </SectionFrame>
  );
}
