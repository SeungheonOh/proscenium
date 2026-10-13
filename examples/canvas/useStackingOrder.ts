import { useEffect } from "react";
import { usePersistentState } from "proscenium";

/** Window ids bottom to top; focusing a window raises it. */
export function useStackingOrder(windows: readonly number[], focused: number | null): number[] {
  const [stack, setStack] = usePersistentState<number[]>("canvas.stack", []);

  useEffect(() => {
    if (focused === null) return;
    setStack((order) =>
      order.at(-1) === focused
        ? order
        : [...order.filter((id) => id !== focused && windows.includes(id)), focused],
    );
  }, [focused]);

  return [...windows].sort((a, b) => stack.indexOf(a) - stack.indexOf(b));
}
