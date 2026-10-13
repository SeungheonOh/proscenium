import { useSyncExternalStore } from "react";
import { Source } from "./source.js";

const time = new Source(new Date(), (source) => {
  let timer: NodeJS.Timeout;
  const tick = () => {
    source.set(new Date());
    // One wakeup just after each minute starts, when a clock's text changes.
    timer = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
  };
  tick();
  return () => clearTimeout(timer);
});

/** The current time, updated at the start of every minute. */
export function useTime(): Date {
  return useSyncExternalStore(time.subscribe, time.read);
}
