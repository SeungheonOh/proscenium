import { Box } from "proscenium";
import { Note, onLight, SectionFrame } from "./common.js";
import { TypeGrid, weights } from "./TypeGrid.js";

export default function TypeSection() {
  return (
    <SectionFrame title="Text: sizes x weights, dark on light" grow={210}>
      <Box flexDirection="row" paddingLeft={28} gap={0}>
        {weights.map((weight) => <Box key={weight} width={84}><Note>{String(weight)}</Note></Box>)}
      </Box>
      <TypeGrid sizes={[10, 12, 13, 14, 16, 20]} bg={onLight.bg} ink={onLight.ink} />
    </SectionFrame>
  );
}
