import type { ReactNode } from "react";
import { Group, Shortcut, tween, usePersistentState } from "proscenium";
import { crt, magnifier, warmth } from "../lib/effects.js";

const fade = tween(0.6, "ease-in-out");

/** The shortcuts that turn each effect on and off. */
export interface ScreenEffectKeys {
  nightLight: string;
  retro: string;
  lens: string;
}

const defaultKeys: ScreenEffectKeys = { nightLight: "Super+N", retro: "Super+R", lens: "Super+Z" };

/**
 * Whole-screen effects, each on a shortcut (a world whose keys clash moves them with `keys`):
 *
 *   Super+N   night light: warm colors for the evening
 *   Super+R   retro: an old CRT
 *   Super+Z   a magnifying lens under the pointer
 *
 * Each fades in and out; one that is off costs nothing, as an effect at amount 0
 * is skipped.
 */
export function ScreenEffects({ children, keys }: { children: ReactNode; keys?: Partial<ScreenEffectKeys> }) {
  const bound = { ...defaultKeys, ...keys };
  const [nightLight, setNightLight] = usePersistentState("nightLight", false);
  const [retro, setRetro] = usePersistentState("retro", false);
  const [lens, setLens] = usePersistentState("magnifier", false);
  return (
    <>
      <Shortcut keys={bound.nightLight} onPress={() => setNightLight((on) => !on)} />
      <Shortcut keys={bound.retro} onPress={() => setRetro((on) => !on)} />
      <Shortcut keys={bound.lens} onPress={() => setLens((on) => !on)} />
      <Group
        shaders={[{
          id: "lens",
          shader: magnifier,
          area: "output",
          uniforms: { amount: lens ? 1 : 0, reach: 150, zoom: 2 },
          transition: fade,
        }]}
      >
        <Group shaders={[{ id: "crt", shader: crt, area: "output", uniforms: { amount: retro ? 1 : 0 }, transition: fade }]}>
          <Group
            shaders={[{
              id: "warmth",
              shader: warmth,
              area: "output",
              uniforms: { amount: nightLight ? 1 : 0 },
              transition: fade,
            }]}
          >
            {children}
          </Group>
        </Group>
      </Group>
    </>
  );
}
