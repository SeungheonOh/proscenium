import { Box } from "proscenium";
import { Column, Divider, Row, useTheme } from "proscenium/ui";
import { Note, onLight, SectionFrame } from "./common.js";

const edge = { width: 1, color: onLight.ink } as const;

export default function HairlinesSection() {
  const { colors } = useTheme();
  return (
    <SectionFrame title="Hairlines, shared edges, small radii" grow={180}>
      <Row gap={14}>
        <Box flexDirection="row">
          {[0, 1, 2, 3, 4, 5].map((index) => <Box key={index} width={26} height={22} border={edge} fill={onLight.bg} />)}
        </Box>
        <Note>adjacent, edges shared</Note>
      </Row>
      <Row gap={8}>
        {[0, 2, 3, 4, 6, 9].map((radius) => <Box key={radius} width={30} height={22} radius={radius} border={edge} fill={onLight.bg} />)}
        <Note>radius 0 2 3 4 6 9</Note>
      </Row>
      <Row gap={8}>
        <Box width={150} height={22}>
          <Box position="absolute" x={0} y={0} width={22} height={22} border={edge} fill={onLight.bg} />
          <Box position="absolute" x={30.5} y={0.5} width={22} height={22} border={edge} fill={onLight.bg} />
          <Box position="absolute" x={61.25} y={0.25} width={22} height={22} border={edge} fill={onLight.bg} />
          <Box position="absolute" x={92} y={0} width={22.5} height={22.5} border={edge} fill={onLight.bg} />
        </Box>
        <Note>offsets .0 .5 .25, size .5</Note>
      </Row>
      <Row gap={10} alignSelf="stretch">
        <Column flexGrow={1} gap={4}>
          <Divider />
          <Box height={1} fill={colors.ink} />
          <Box height={2} fill={colors.line} />
        </Column>
        <Box flexDirection="row" height={34} gap={6}>
          <Divider vertical />
          <Box width={1} fill={colors.ink} />
          <Box width={2} fill={colors.line} />
        </Box>
        <Box width={44} height={30} radius={6} border={{ width: 1, color: colors.line }} />
        <Box width={44} height={30} radius={6} border={{ width: 2, color: colors.accent }} />
      </Row>
    </SectionFrame>
  );
}
