import { useEffect } from "react";
import { close, launch, Shortcut, useModifiers } from "proscenium";
import type { HandAction } from "../lib/hand.js";
import { terminal } from "../lib/settings.js";

interface SwitcherKeysProps {
  /** Whether the switcher is open. */
  open: boolean;
  /** The window in play, which Super+Q closes. */
  played: number | null;
  dispatch: (action: HandAction) => void;
}

/**
 * The switcher on Super+Tab over a hand of windows, and the keys for the window
 * in play. Letting go of Super plays the switcher's choice, as letting go of Alt
 * does, even when a quick tap let go before the switcher opened.
 */
export function SwitcherKeys({ open, played, dispatch }: SwitcherKeysProps) {
  const holding = useModifiers().includes("logo");
  useEffect(() => {
    if (open && !holding) dispatch({ type: "fold", play: true });
  }, [holding, open]);

  /** Opens the switcher, or moves its choice by STEP. */
  function step(by: number) {
    if (open) {
      dispatch({ type: "cycle", step: by });
    } else {
      dispatch({ type: "spread" });
      // Backwards from the start lands on the window played longest ago.
      if (by < 0) dispatch({ type: "cycle", step: -2 });
    }
  }

  return (
    <>
      <Shortcut keys="Super+Tab" repeat onPress={() => step(1)} />
      {/* Shift turns Tab into ISO_Left_Tab. */}
      <Shortcut keys="Super+Shift+ISO_Left_Tab" repeat onPress={() => step(-1)} />
      {open && (
        <>
          <Shortcut keys="Super+Right" repeat onPress={() => step(1)} />
          <Shortcut keys="Super+Left" repeat onPress={() => step(-1)} />
          <Shortcut keys="Right" repeat onPress={() => step(1)} />
          <Shortcut keys="Left" repeat onPress={() => step(-1)} />
          <Shortcut keys="Return" onPress={() => dispatch({ type: "fold", play: true })} />
          <Shortcut keys="Escape" onPress={() => dispatch({ type: "fold", play: false })} />
          <Shortcut keys="Super+Escape" onPress={() => dispatch({ type: "fold", play: false })} />
        </>
      )}
      <Shortcut keys="Super+Return" onPress={() => launch(terminal)} />
      <Shortcut keys="Super+Q" onPress={() => played !== null && close(played)} />
    </>
  );
}
