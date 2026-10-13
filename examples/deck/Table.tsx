import { Group, Screen, useOutputs } from "proscenium";
import { useDeck } from "./DeckProvider.js";
import { paintSwirl } from "./shaders.js";

/**
 * The table under the cards: a swirl of paint. It turns only while the switcher is
 * open; closed, its clock holds and it is drawn once, so a still desktop costs nothing.
 * It is opaque, so nothing beneath it is drawn.
 */
export function Table() {
  const outputs = useOutputs();
  const { spread } = useDeck();
  return outputs.map((output) => (
    <Screen key={output.name} output={output.name}>
      <Group
        width={output.width}
        height={output.height}
        shaders={[{ id: "swirl", shader: paintSwirl, time: spread }]}
      />
    </Screen>
  ));
}
