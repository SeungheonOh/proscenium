import { Screen, spring, Window } from "proscenium";
import { useDeck } from "./DeckProvider.js";
import { Dialog } from "./Dialog.js";

const motion = spring({ duration: 0.4, bounce: 0.1 });

/**
 * The window in play once it asks for the whole screen: over the bar and the
 * table, until it asks back or another card comes into play. It takes over the
 * card's node, so it grows from where the card lay.
 */
export function Fullscreen() {
  const { output, windows, dialogs, fullscreen, setFullscreen, show } = useDeck();
  if (fullscreen === null || !output || !windows.has(fullscreen)) return null;
  const size = { width: output.width, height: output.height };
  return (
    <Screen output={output.name}>
      <Window
        window={fullscreen}
        width={size.width}
        height={size.height}
        fullscreen
        transition={motion}
        onFullscreenRequest={({ value }) => setFullscreen(fullscreen, Boolean(value))}
      >
        {(dialogs.get(fullscreen) ?? []).map((dialog) => (
          <Dialog
            key={dialog}
            window={windows.get(dialog)!}
            card={size}
            active
            onActivate={() => show(dialog)}
          />
        ))}
      </Window>
    </Screen>
  );
}
