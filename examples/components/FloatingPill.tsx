import type { ReactNode } from "react";
import { Box, scale, Screen, useOutputs } from "proscenium";
import { glassBorder, motion } from "../lib/theme.js";

const height = 48;

interface FloatingPillProps {
  shown: boolean;
  /** Laid out in a row; the pill sizes to it. */
  children: ReactNode;
}

/** A frosted pill that rises at the bottom of every output while shown. */
export function FloatingPill({ shown, children }: FloatingPillProps) {
  const outputs = useOutputs();
  return outputs.map((output) => (
    <Screen key={output.name} output={output.name}>
      <Box
        y={output.height - (shown ? 100 : 76)}
        width={output.width}
        justifyContent="center"
        opacity={shown ? 1 : 0}
        transition={motion.pop}
      >
        <Box
          flexDirection="row"
          alignItems="center"
          gap={14}
          height={height}
          paddingX={20}
          radius={height / 2}
          fill="#ffffffd9"
          blur={22}
          border={glassBorder}
          shadow={{ color: "#00000029", blur: 28, y: 10 }}
          transform={scale(shown ? 1 : 0.92)}
          transition={motion.pop}
        >
          {children}
        </Box>
      </Box>
    </Screen>
  ));
}
