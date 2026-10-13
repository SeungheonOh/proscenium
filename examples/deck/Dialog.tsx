import { memo } from "react";
import { scale, spring, Window, type WindowInfo } from "proscenium";
import type { Size } from "./layout.js";

const motion = spring({ duration: 0.35, bounce: 0.18 });

interface DialogProps {
  window: WindowInfo;
  /** The size of the card's window, whose middle the dialog sits on. */
  card: Size;
  /** On the card in play it takes input; elsewhere the pointer passes to the card. */
  active: boolean;
  onActivate: () => void;
}

/**
 * A dialog riding on its window's card: drawn inside the card's window at its own
 * size, in the middle, so it turns, scales, sways and pops with the card. It comes
 * up from a little smaller and fades away.
 */
export const Dialog = memo(function Dialog({ window, card, active, onActivate }: DialogProps) {
  return (
    <Window
      window={window.id}
      x={(card.width - window.width) / 2}
      y={(card.height - window.height) / 2}
      focusable={active}
      interactive={active}
      radius={10}
      shadow={{ color: "#000000a0", blur: 36, y: 12 }}
      initial={{ opacity: 0, transform: scale(0.92) }}
      exit={{ opacity: 0, transform: scale(0.92) }}
      transition={motion}
      onActivateRequest={onActivate}
    />
  );
});
