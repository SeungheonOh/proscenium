import { Box, Rect } from "proscenium";
import { TNote, onDark, SectionFrame, Tray } from "./common.js";

const four = ["#ff0040", "#ffd000", "#00c080", "#2040ff"];

export default function GradientsSection() {
  return (
    <SectionFrame title="Gradients: four stops, radial, low contrast" grow={400}>
      <Tray>
        <TNote>four stops, angle 0; the same at 45 on a pill; at 90 with positions</TNote>
        <Rect width={362} height={22} radius={6} fill={{ stops: four, angle: 0 }} />
        <Box flexDirection="row" gap={10}>
          <Rect width={118} height={32} radius={20} fill={{ stops: four, angle: 45 }} />
          <Rect width={118} height={32} radius={8} fill={{ stops: ["#ffffff", ["#2f6fed", 0.25], ["#17171a", 0.8]], angle: 90 }} />
          <Rect width={110} height={32} radius={[16, 4, 16, 4]} fill={{ stops: ["#ff9a3c", "#e0443e", "#6a1b9a"], angle: 90 }} />
        </Box>
        <TNote>radial: centred, off centre, with a falloff to transparent</TNote>
        <Box flexDirection="row" gap={10}>
          <Rect width={64} height={64} radius={32} fill={{ stops: ["#ffffff", "#2f6fed", "#10204a"], shape: "radial" }} />
          <Rect width={64} height={64} radius={12} fill={{ stops: ["#fff3b0", "#ff7a3c", "#7a1030"], shape: "radial", center: [0.3, 0.3] }} />
          <Box width={162} height={64} radius={12} fill={onDark.bg}>
            <Rect width={162} height={64} radius={12}
                  fill={{ stops: ["#ffffffcc", "#2f6fed55", "#2f6fed00"], shape: "radial", center: [0.5, 0.4] }} />
          </Box>
        </Box>
      </Tray>
      <Tray dark>
        <TNote color="#f2f2f599">low contrast greys, 362 px wide: no banding</TNote>
        <Rect width={362} height={30} radius={8} fill={{ stops: ["#303034", "#3c3c42"], angle: 0 }} />
        <Rect width={362} height={36} radius={8} fill={{ stops: ["#1d1d20", "#2a2a30"], angle: 90 }} />
        <Rect width={362} height={22} radius={8} fill={{ stops: ["#f2f2f2", "#ffffff"], angle: 0 }} />
      </Tray>
    </SectionFrame>
  );
}
