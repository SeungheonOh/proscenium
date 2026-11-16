import { Box, Text, scale, translate, tween } from "proscenium";
import { useTheme } from "proscenium/ui";
import { TNote, SectionFrame, Tray } from "./common.js";

const quick = tween(0.12);

export default function StatesSection() {
  const { font } = useTheme();
  const centered = { alignItems: "center", justifyContent: "center" } as const;
  const label = (text: string, color: string, group = false, hover?: string) => (
    <Text font={font} size={10} weight={650} color={color} states={group ? { group: true, hover: { color: hover! } } : undefined}>{text}</Text>
  );
  return (
    <SectionFrame title="Raw states (hover, press, Tab)" grow={250}>
      <Tray>
        <TNote>fill; fill+border+shadow+scale; stateGroup; tab ring</TNote>
        <Box flexDirection="row" gap={10} paddingY={4}>
          <Box width={78} height={52} radius={10} fill="#2a2d34" transition={quick} {...centered}
               states={{ hover: { fill: "#3b5bdb" }, pressed: { fill: "#2b46a6" } }}>
            {label("fill", "#ffffff")}
          </Box>
          <Box width={78} height={52} radius={10} fill="#ffffff" transition={quick} {...centered}
               border={{ width: 1, color: "#17171a26" }} shadow={{ color: "#00000014", blur: 3, y: 1 }}
               states={{ hover: { border: { width: 1, color: "#2f6fed" }, shadow: { color: "#00000040", blur: 14, y: 6 }, transform: [scale(1.05)] },
                         pressed: { transform: [scale(0.95)], shadow: { color: "#00000014", blur: 2, y: 0 } } }}>
            {label("all four", "#17171a")}
          </Box>
          <Box width={78} height={52} radius={10} fill="#ffffff" transition={quick} stateGroup {...centered}
               border={{ width: 1, color: "#17171a26" }}
               states={{ hover: { fill: "#2f6fed", border: { width: 1, color: "#2f6fed" } }, pressed: { fill: "#2457c4" } }}>
            {label("group", "#17171a", true, "#ffffff")}
          </Box>
          <Box width={78} height={52} radius={10} fill="#17171a" transition={quick} tabIndex={0} {...centered}
               border={{ width: 2, color: "#00000000" }}
               states={{ focusVisible: { border: { width: 2, color: "#ffd43b" } }, hover: { fill: "#2a2d34" } }}>
            {label("tab", "#ffffff")}
          </Box>
        </Box>
        <TNote>click focus ring; press dip; hover lift</TNote>
        <Box flexDirection="row" gap={10} paddingY={4}>
          <Box width={78} height={52} radius={10} fill="#ffffff" transition={quick} tabIndex={0} {...centered}
               border={{ width: 2, color: "#17171a26" }} states={{ focus: { border: { width: 2, color: "#2f6fed" } } }}>
            {label("focus", "#17171a")}
          </Box>
          <Box width={78} height={52} radius={10} fill="#e0443e" transition={quick} {...centered}
               states={{ pressed: { transform: [scale(0.9)], opacity: 0.7 } }}>
            {label("press", "#ffffff")}
          </Box>
          <Box width={78} height={52} radius={10} fill="#ffffff" transition={quick} {...centered}
               shadow={{ color: "#00000000", blur: 0 }}
               states={{ hover: { shadow: { color: "#00000055", blur: 18, y: 10, spread: -4 }, transform: [translate(0, -3)] } }}>
            {label("lift", "#17171a")}
          </Box>
        </Box>
      </Tray>
    </SectionFrame>
  );
}
