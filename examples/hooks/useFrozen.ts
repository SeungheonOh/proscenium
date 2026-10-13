import { useEffect, useRef } from "react";

/** Returns `value`, or while `frozen` the value it had when it froze (its first value if it never thawed). */
export function useFrozen<T>(value: T, frozen: boolean): T {
  const kept = useRef(value);
  useEffect(() => {
    if (!frozen) kept.current = value;
  });
  return frozen ? kept.current : value;
}

/**
 * Returns `value`, or while it is null the last value it had, so a closing
 * surface keeps its content while it animates out.
 */
export function useRetained<T>(value: T | null): T | null {
  return useFrozen(value, value === null);
}
