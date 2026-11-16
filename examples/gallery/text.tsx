import { Box, Text } from "proscenium";
import { useTheme } from "proscenium/ui";
import { TNote, onLight, SectionFrame, Tray } from "./common.js";

const numbers = ["1,111.11", "8,888.88", "1,234.56", "0.00"];

export default function TextSection() {
  const { font } = useTheme();
  const ink = onLight.ink;
  return (
    <SectionFrame title="Text: figures, spacing, decoration" grow={354}>
      <Tray gap={6}>
        <TNote>proportional (pnum) against tabularNumbers, right aligned</TNote>
        <Box flexDirection="row" gap={24}>
          {[false, true].map((tabular) => (
            <Box key={String(tabular)} flexDirection="column" gap={2} width={110}>
              {numbers.map((n) => (
                <Text key={n} font={font} size={15} weight={600} color={ink} width={110} align="end" tabularNumbers={tabular} features={tabular ? undefined : { pnum: true }}>{n}</Text>
              ))}
            </Box>
          ))}
          <Box flexDirection="column" gap={2} justifyContent="center">
            <TNote>left: proportional</TNote>
            <TNote>right: tabular</TNote>
          </Box>
        </Box>
      </Tray>
      <Tray gap={4}>
        <TNote>letterSpacing -1, 0, 2 (caps 12 / 650 at 2)</TNote>
        {[-1, 0, 2].map((spacing) => (
          <Text key={spacing} font={font} size={14} weight={500} color={ink} letterSpacing={spacing}>Spacing and rhythm 2468</Text>
        ))}
        <Text font={font} size={12} weight={650} color={ink} letterSpacing={2}>TRACKED CAPITALS</Text>
      </Tray>
      <Tray gap={4}>
        <TNote>decoration</TNote>
        <Box flexDirection="row" gap={18}>
          <Text font={font} size={14} weight={500} color={ink} decoration="underline">underline</Text>
          <Text font={font} size={14} weight={500} color={ink} decoration="line-through">line-through</Text>
          <Text font={font} size={14} weight={500} color={ink} decoration="underline line-through">both</Text>
        </Box>
      </Tray>
    </SectionFrame>
  );
}
