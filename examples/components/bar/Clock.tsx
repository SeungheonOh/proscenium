import { Box, Rect } from "proscenium";
import { useTime } from "../../lib/system/clock.js";
import { colors } from "../../lib/theme.js";
import { RollingText } from "./BarText.js";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dateFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
});

/** The date and time after a divider; each part rolls when it changes. */
export function Clock() {
  const now = useTime();
  const date = dateFormat.format(now);
  const time = timeFormat.format(now);
  // Fixed widths keep the bar still as the digits change.
  return (
    <Box flexDirection="row" alignItems="center" gap={6} marginLeft={8} marginRight={6}>
      <Rect width={1} height={14} marginRight={2} fill="#17171a1a" />
      <RollingText identity={date} width={96} align="end" color={colors.muted}>
        {date}
      </RollingText>
      <RollingText identity={time} width={70} align="end" weight={600}>
        {time}
      </RollingText>
    </Box>
  );
}
