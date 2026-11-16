import { Box, Rect, Text } from "proscenium";
import { Column, Label, Row, Surface, useTheme } from "proscenium/ui";
import { Busy, Note, onLight, SectionFrame } from "./common.js";

const width = 356;

export default function EffectsSection() {
  const { colors, font } = useTheme();
  return (
    <SectionFrame title="Gradients, glass, clip, group opacity" grow={320}>
      <Column gap={4}>
        <Rect width={width} height={20} radius={4} fill={{ from: "#2f6fed", to: "#e0443e", angle: 0 }} />
        <Rect width={width} height={16} radius={4} fill={{ from: "#303034", to: "#3c3c42", angle: 0 }} />
        <Rect width={width} height={16} radius={4} fill={{ from: "#f2f2f2", to: "#ffffff", angle: 0 }} border={{ width: 1, color: "#00000010" }} />
      </Column>
      <Box width={width} height={104}>
        <Busy width={width} height={104} />
        <Surface variant="glass" position="absolute" x={20} y={26} width={196} height={52} padding={10} gap={2} flexDirection="column">
          <Label variant="strong">Frosted glass</Label>
          <Label tone="muted">blur 22 over a busy picture</Label>
        </Surface>
        <Box position="absolute" x={240} y={30} width={96} height={48} radius={24} fill="#ffffff55" blur={10}
             border={{ width: 1, color: "#ffffff99" }} alignItems="center" justifyContent="center">
          <Text font={font} size={11} weight={650} color="#ffffff">blur 10</Text>
        </Box>
      </Box>
      <Row gap={14} alignItems="flex-start">
        <Box width={112} height={76} radius={20} clip fill={onLight.bg} border={{ width: 1, color: colors.line }}>
          <Box position="absolute" x={-14} y={-14} width={60} height={60} fill="#e0443e" />
          <Box position="absolute" x={70} y={46} width={70} height={50} fill="#2f6fed" />
          <Text position="absolute" x={6} y={28} font={font} size={11} weight={650} color={onLight.ink}>clip r20 text runs past the edge</Text>
          <Text position="absolute" x={62} y={56} font={font} size={11} weight={650} color="#ffffff">past the corner</Text>
        </Box>
        <Column gap={4} alignItems="center">
          <Box width={74} height={50} opacity={0.5} groupOpacity>
            <Rect position="absolute" x={0} y={0} width={46} height={40} radius={6} fill="#e0443e" />
            <Rect position="absolute" x={26} y={10} width={46} height={40} radius={6} fill="#2f6fed" />
          </Box>
          <Note>groupOpacity .5</Note>
        </Column>
        <Column gap={4} alignItems="center">
          <Box width={74} height={50}>
            <Rect position="absolute" x={0} y={0} width={46} height={40} radius={6} fill="#e0443e80" />
            <Rect position="absolute" x={26} y={10} width={46} height={40} radius={6} fill="#2f6fed80" />
          </Box>
          <Note>per child</Note>
        </Column>
      </Row>
    </SectionFrame>
  );
}
