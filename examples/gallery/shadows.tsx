import { Box, Text } from "proscenium";
import { useTheme } from "proscenium/ui";
import { accent, TNote, SectionFrame, Tray } from "./common.js";

const white = "#ffffff";

export default function ShadowsSection() {
  const { font } = useTheme();
  const tag = (text: string) => <Text font={font} size={10} weight={650} color="#17171a">{text}</Text>;
  const centered = { alignItems: "center", justifyContent: "center" } as const;
  return (
    <SectionFrame title="Shadows: pairs, inset, negative spread" grow={260}>
      <Tray gap={10}>
        <TNote>single, ambient + key pair, negative spread</TNote>
        <Box flexDirection="row" gap={14} paddingBottom={6}>
          <Box width={78} height={50} radius={10} fill={white} {...centered}
               shadow={{ color: "#00000040", blur: 16, y: 8 }}>{tag("single")}</Box>
          <Box width={78} height={50} radius={10} fill={white} {...centered}
               shadow={[{ color: "#00000014", blur: 3, y: 1 }, { color: "#00000026", blur: 16, y: 8, spread: -4 }]}>{tag("pair")}</Box>
          <Box width={78} height={50} radius={10} fill={white} {...centered}
               shadow={{ color: "#00000066", blur: 16, y: 14, spread: -8 }}>{tag("spread -8")}</Box>
          <Box width={78} height={50} radius={25} fill={accent} {...centered}
               shadow={{ color: "#2f6fed99", blur: 14, y: 6 }}><Text font={font} size={10} weight={650} color={white}>colored</Text></Box>
        </Box>
      </Tray>
      <Tray gap={10}>
        <TNote>inset: pressed well, input field, inner glow, bevel</TNote>
        <Box flexDirection="row" gap={14}>
          <Box width={78} height={50} radius={10} fill="#dcdde2" {...centered}
               shadow={[{ color: "#00000040", blur: 6, y: 2, inset: true }]}>{tag("well")}</Box>
          <Box width={78} height={50} radius={8} fill={white} {...centered}
               shadow={[{ color: "#17171a33", blur: 0, spread: 1, inset: true }, { color: "#00000026", blur: 3, y: 1, inset: true }]}>{tag("field")}</Box>
          <Box width={78} height={50} radius={25} fill={accent} {...centered}
               shadow={{ color: "#ffffffaa", blur: 12, inset: true }}><Text font={font} size={10} weight={650} color={white}>glow</Text></Box>
          <Box width={78} height={50} radius={10} fill="#f4f5f8" {...centered}
               shadow={[{ color: "#ffffffcc", blur: 0, y: 1, inset: true }, { color: "#00000026", blur: 0, y: -1, inset: true }, { color: "#00000033", blur: 4, y: 2 }]}>{tag("bevel")}</Box>
        </Box>
      </Tray>
    </SectionFrame>
  );
}
