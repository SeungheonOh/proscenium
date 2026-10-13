import { useState } from "react";
import { Group, Rect, Screen, Shortcut } from "proscenium";
import { centered } from "../lib/geometry.js";
import { motion } from "../lib/theme.js";
import { HyprWindow } from "./HyprWindow.js";
import { useHypr } from "./HyprProvider.js";

/** Stashed windows (Super+Shift+S) that drop down over everything on Super+S. */
export function Scratchpad() {
  const { state, dispatch, present, focused, focusOutput } = useHypr();
  const [open, setOpen] = useState(false);
  const stashed = state.scratchpad.filter((id) => present.has(id));

  function toggleFocusedWindow() {
    if (focused !== null) dispatch({ type: "toggleScratchpad", window: focused });
  }

  return (
    <>
      <Shortcut keys="Super+S" onPress={() => setOpen((current) => !current)} />
      <Shortcut keys="Super+Shift+S" onPress={toggleFocusedWindow} />

      {focusOutput && (
        <Screen output={focusOutput.name}>
          <Rect
            width={focusOutput.width}
            height={focusOutput.height}
            fill="#00000066"
            blur={18}
            opacity={open ? 1 : 0}
            transition={motion.slide}
          />
          <Group y={open ? 0 : -focusOutput.height} transition={motion.slide}>
            {stashed.map((id, index) => {
              const box = centered(focusOutput.workArea, 0.7);
              const cascade = (index - (stashed.length - 1) / 2) * 36;
              return (
                <HyprWindow
                  key={id}
                  id={id}
                  floating
                  box={{ ...box, x: box.x + cascade, y: box.y + cascade }}
                />
              );
            })}
          </Group>
        </Screen>
      )}
    </>
  );
}
