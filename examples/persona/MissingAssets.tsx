import { Box, Screen, Text, useOutputs } from "proscenium";
import { palette } from "./config.js";

/** Says how to fetch the art, on every output, until it is there. */
export function MissingAssets() {
  return useOutputs().map((output) => (
    <Screen key={output.name} output={output.name}>
      <Box x={output.width / 2 - 260} y={output.height / 2 - 40} width={520} padding={20} radius={12}
           fill={`${palette.background}e6`} border={{ width: 2, color: palette.color5 }}>
        <Text size={15} color={palette.foreground} width={480} align="center">
          The Persona world draws on Persona-Quickshell's art. Fetch it with scripts/fetch-persona, then save
          the world to reload it.
        </Text>
      </Box>
    </Screen>
  ));
}
