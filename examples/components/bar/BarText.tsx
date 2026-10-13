import { Box, Text, type TextProps } from "proscenium";
import { colors, font, motion } from "../../lib/theme.js";

/** One line of the bar's 13 px text, ellipsized when its Box leaves it too little room. */
export function BarText(props: TextProps) {
  return <Text maxLines={1} font={font} size={13} weight={500} color="#17171acc" {...props} />;
}

interface RollingTextProps extends TextProps {
  /** A new identity rolls the old text out and the new text in; new text under the same identity changes in place. */
  identity: string | number;
}

/** Bar text that rolls when its identity changes: the old line slides up while the new one rises in. */
export function RollingText({ identity, width, maxWidth, ...text }: RollingTextProps) {
  // The line's own Box puts it at y = 0, so the roll is relative to wherever the Box sits.
  return (
    <Box flexDirection="column" width={width} maxWidth={maxWidth}>
      <BarText
        key={identity}
        color={colors.ink}
        transition={motion.roll}
        initial={{ opacity: 0, y: 10 }}
        exit={{ opacity: 0, y: -10 }}
        {...text}
      />
    </Box>
  );
}
