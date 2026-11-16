import { Box } from "proscenium";
import { onDark, SectionFrame } from "./common.js";
import { TypeGrid } from "./TypeGrid.js";

export default function TypeDarkSection() {
  return (
    <SectionFrame title="Text: light on dark" grow={132}>
      <Box>
        <TypeGrid sizes={[12, 14, 18]} bg={onDark.bg} ink={onDark.ink} />
      </Box>
    </SectionFrame>
  );
}
