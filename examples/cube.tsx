/**
 * Cube: four workspaces on the sides of a cube, after Compiz.
 *
 *   Super+Left / Super+Right        turn the cube a face; Super+wheel or a three-finger swipe too
 *   Super+1..4                      turn the shortest way to a face
 *   Super+Shift+Left / Right        carry the focused window round with the turn
 *   Super+Shift+1..4                send the focused window to a face
 *   Super+Return / Super+Q          terminal / close the focused window
 *   Super+D                         application launcher
 *   Super+drag                      move a window
 *
 * Windows tile on each face and stay live as the cube turns: it steps back,
 * swings round in perspective and comes forward again, faces darkening as they
 * turn from the light. At rest the face in front lies flat on the screen and the
 * others are not drawn, so the cube costs what a flat desktop does. Focus follows
 * the mouse; a face that comes round gives focus back to its last window.
 */

import { Desktop } from "./components/Desktop.js";
import { Launcher } from "./components/Launcher.js";
import { ScreenEffects } from "./components/ScreenEffects.js";
import { Cube } from "./cube/Cube.js";
import { CubeProvider, useCube } from "./cube/CubeProvider.js";
import { FacePills } from "./cube/FacePills.js";
import { Keybindings } from "./cube/Keybindings.js";

function CubeLauncher() {
  const { output } = useCube();
  return <Launcher output={output} />;
}

export default function CubeWorld() {
  return (
    <ScreenEffects>
      <CubeProvider>
        <Cube />
        <Desktop barStart={FacePills} />
        <CubeLauncher />
        <Keybindings />
      </CubeProvider>
    </ScreenEffects>
  );
}
