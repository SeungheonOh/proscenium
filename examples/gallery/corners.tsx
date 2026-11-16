import { Box, Text } from "proscenium";
import { useTheme } from "proscenium/ui";
import { accent, danger, ink, TNote, SectionFrame, Tray } from "./common.js";

const white = "#ffffff";

export default function CornersSection() {
  const { font } = useTheme();
  const label = (text: string, color = white) => <Text font={font} size={10} weight={650} color={color}>{text}</Text>;
  const centered = { alignItems: "center", justifyContent: "center" } as const;
  return (
    <SectionFrame title="Corners, per-side and dashed borders" grow={290}>
      <Tray>
        <TNote>radius [tl, tr, br, bl]: tab, sheet, leaf, split pill, bubble</TNote>
        <Box flexDirection="row" gap={8} alignItems="flex-end">
          <Box width={58} height={32} radius={[12, 12, 0, 0]} fill={accent} {...centered}>{label("tab")}</Box>
          <Box width={58} height={32} radius={[0, 0, 12, 12]} fill={ink} {...centered}>{label("sheet")}</Box>
          <Box width={58} height={32} radius={[16, 2, 16, 2]} fill={danger} {...centered}>{label("leaf")}</Box>
          <Box flexDirection="row">
            <Box width={34} height={32} radius={[16, 0, 0, 16]} fill={accent} />
            <Box width={34} height={32} radius={[0, 16, 16, 0]} fill={ink} />
          </Box>
          <Box width={58} height={32} radius={[14, 14, 14, 2]} fill={accent} {...centered}>{label("bubble")}</Box>
        </Box>
      </Tray>
      <Tray>
        <TNote>border width [top, right, bottom, left]</TNote>
        <Box flexDirection="row" gap={10}>
          <Box width={56} height={36} fill={white} border={{ width: [0, 0, 2, 0], color: ink }} />
          <Box width={56} height={36} fill={white} border={{ width: [0, 0, 0, 4], color: accent }} />
          <Box width={56} height={36} fill={white} border={{ width: [1, 2, 3, 4], color: ink }} />
          <Box width={56} height={36} fill={white} radius={12} border={{ width: [1, 1, 1, 4], color: accent }} />
          <Box width={56} height={36} fill={white} radius={[12, 12, 0, 0]} border={{ width: [2, 2, 0, 2], color: ink }} />
        </Box>
      </Tray>
      <Tray>
        <TNote>dashed: 1, 2 and 3 wide, radius 0 / 10 / pill, dash 6</TNote>
        <Box flexDirection="row" gap={10}>
          <Box width={56} height={36} border={{ width: 1, color: ink, dash: true }} />
          <Box width={56} height={36} radius={10} border={{ width: 2, color: ink, dash: true }} />
          <Box width={56} height={36} radius={18} border={{ width: 2, color: accent, dash: true }} />
          <Box width={56} height={36} radius={4} border={{ width: 3, color: danger, dash: true }} />
          <Box width={56} height={36} radius={8} border={{ width: 2, color: ink, dash: 6 }} />
        </Box>
      </Tray>
    </SectionFrame>
  );
}
