import type { ReactNode } from "react";
import { Group, instant } from "proscenium";
import { bluelight, greyscale, inversion } from "./filters.js";
import { usePersona } from "./PersonaProvider.js";

/** Whatever the options menu chose drawn through its screen shader; it applies at once, as Hyprland's does. */
export function ScreenFilters({ children }: { children: ReactNode }) {
  const { filter } = usePersona();
  const use = (id: string, shader: typeof bluelight) => [{
    id, shader, area: "output" as const, uniforms: { amount: filter === id ? 1 : 0 }, transition: instant,
  }];
  return (
    <Group shaders={use("bluelight", bluelight)}>
      <Group shaders={use("greyscale", greyscale)}>
        <Group shaders={use("inversion", inversion)}>{children}</Group>
      </Group>
    </Group>
  );
}
