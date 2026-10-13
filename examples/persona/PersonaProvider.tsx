import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { usePersistentState } from "proscenium";

/** The full-screen menus the drawer's blades open. */
export type MenuKind = "calendar" | "stats" | "options" | "power";
/** The screen shaders of the options menu. */
export type ScreenFilter = "bluelight" | "greyscale" | "inversion";

export interface Menu {
  kind: MenuKind;
  output: string;
  /** Counts openings, so opening a menu again replays its entrance. */
  serial: number;
}

export interface PersonaContextValue {
  menu: Menu | null;
  openMenu: (kind: MenuKind, output: string) => void;
  closeMenu: () => void;
  searching: boolean;
  setSearching: (update: (open: boolean) => boolean) => void;
  filter: ScreenFilter | null;
  setFilter: (filter: ScreenFilter | null) => void;
}

const PersonaContext = createContext<PersonaContextValue | null>(null);

export function usePersona(): PersonaContextValue {
  const value = useContext(PersonaContext);
  if (!value) throw new Error("usePersona must be used inside <PersonaProvider>.");
  return value;
}

/** The shell's own state: which menu is open, the search, and the screen filter. */
export function PersonaProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [searching, setSearching] = useState(false);
  const [filter, setFilter] = usePersistentState<ScreenFilter | null>("personaFilter", null);
  const openings = useRef(0);

  const openMenu = useCallback((kind: MenuKind, output: string) => {
    setMenu({ kind, output, serial: ++openings.current });
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);

  const value = useMemo(
    () => ({ menu, openMenu, closeMenu, searching, setSearching, filter, setFilter }),
    [menu, openMenu, closeMenu, searching, filter, setFilter],
  );
  return <PersonaContext.Provider value={value}>{children}</PersonaContext.Provider>;
}
