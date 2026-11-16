import { Box, Text } from "proscenium";
import { useTheme } from "proscenium/ui";

export const weights = [400, 500, 650, 700] as const;

/** Sample text at each of SIZES in each weight, in INK on BG. */
export function TypeGrid({ sizes, bg, ink, sample = "Agxy 01" }: { sizes: readonly number[]; bg: string; ink: string; sample?: string }) {
  const { font } = useTheme();
  return (
    <Box flexDirection="column" gap={2} padding={8} radius={8} fill={bg} border={{ width: 1, color: "#00000018" }}>
      {sizes.map((size) => (
        <Box key={size} flexDirection="row" alignItems="center">
          <Box width={20}><Text font={font} size={10} weight={500} color={ink} opacity={0.5}>{String(size)}</Text></Box>
          {weights.map((weight) => (
            <Box key={weight} width={84}><Text font={font} size={size} weight={weight} color={ink}>{sample}</Text></Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}
