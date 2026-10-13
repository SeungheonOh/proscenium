/**
 * Shelf: windows as books on a bookshelf.
 *
 *   Click a spine                  take the book down and open it; the open one goes back
 *   Super+Tab, Super+Shift+Tab     browse the shelf, most recently read first; let go of Super to open
 *   Left / Right, Return, Escape   move along the shelf while browsing, open, or stop browsing
 *   Super+Return / Super+Q         terminal / close the open book
 *   Super+D                        application launcher
 *
 * The open window lies over the reading area. The others stand on a plank below,
 * spine out, in 3D: each is a box whose cover is the live window, with a cloth
 * spine lettered with its title, a back cover and the top edge of its pages.
 * Books left of the middle show a sliver of their live cover, the rest their
 * backs, and only faces turned toward the eye are drawn. A book under the
 * pointer comes a little way off the shelf; opening one swings it out round its
 * spine as it grows, and closing a window lets its book fall.
 */

import { Background } from "proscenium";
import { Desktop } from "./components/Desktop.js";
import { Launcher } from "./components/Launcher.js";
import { ScreenEffects } from "./components/ScreenEffects.js";
import { Books } from "./shelf/Books.js";
import { Keybindings } from "./shelf/Keybindings.js";
import { ShelfLabel } from "./shelf/ShelfLabel.js";
import { ShelfProvider, useShelf } from "./shelf/ShelfProvider.js";

function ShelfLauncher() {
  const { output } = useShelf();
  return <Launcher output={output} />;
}

export default function ShelfWorld() {
  return (
    <ScreenEffects>
      <ShelfProvider>
        {/* A dark, warm study wall. */}
        <Background fill="#1e1611" />
        <Books />
        <Desktop barStart={ShelfLabel} />
        <ShelfLauncher />
        <Keybindings />
      </ShelfProvider>
    </ScreenEffects>
  );
}
