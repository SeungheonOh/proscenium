import { useEffect } from "react";
import { usePersistentState } from "proscenium";

/**
 * Window ids bottom to top, and a function that raises some in a given order.
 * Focusing a window raises it, with the windows that go with it (its stack)
 * just under it in their own order.
 */
export function useStackingOrder(
  windows: readonly number[],
  focused: number | null,
  together: (window: number) => readonly number[] = (window) => [window],
): [number[], (ids: readonly number[]) => void] {
  const [stack, setStack] = usePersistentState<number[]>("canvas.stack", []);

  const raise = (ids: readonly number[]) =>
    setStack((order) => [...order.filter((id) => !ids.includes(id) && windows.includes(id)), ...ids]);

  useEffect(() => {
    if (focused === null) return;
    const companions = together(focused).filter((id) => id !== focused);
    setStack((order) => {
      if (order.at(-1) === focused && companions.every((id) => order.includes(id))) return order;
      const kept = order.filter((id) => companions.includes(id));
      const missing = companions.filter((id) => !order.includes(id));
      const lifted = [...kept, ...missing, focused];
      return [...order.filter((id) => !lifted.includes(id) && windows.includes(id)), ...lifted];
    });
  }, [focused]);

  return [[...windows].sort((a, b) => stack.indexOf(a) - stack.indexOf(b)), raise];
}
