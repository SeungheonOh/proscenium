import { useCallback, useEffect, useRef, useState } from "react";

/** A value that clears itself `duration` milliseconds after it was last shown. */
export function useFlash<T>(duration: number): [T | null, (value: T) => void] {
  const [value, setValue] = useState<T | null>(null);
  const timer = useRef<NodeJS.Timeout>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const show = useCallback(
    (next: T) => {
      setValue(next);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setValue(null), duration);
    },
    [duration],
  );

  return [value, show];
}
