// Page runtime for <Web> modules, bundled into the page itself.
//
//   import { send } from "proscenium/page";
//   export default function Panel({ count }: { count: number }) {
//     return <button onClick={() => send("increment")}>{count}</button>;
//   }

import { type ComponentType, createElement, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

interface Bridge {
  postMessage(name: string, value: unknown): void;
}

let props: Record<string, unknown> = {};
const listeners = new Set<() => void>();

addEventListener("proscenium-message", (event) => {
  const { name, value } = (event as CustomEvent<{ name: string; value: unknown }>).detail;
  if (name !== "props") return;
  props = (value ?? {}) as Record<string, unknown>;
  for (const listener of listeners) listener();
});

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Deliver NAME and VALUE to the <Web> node's onMessage in the world. */
export function send(name: string, value: unknown = null): void {
  (globalThis as { proscenium?: Bridge }).proscenium?.postMessage("stage", { name, value });
}

/** Render PAGE with the props the world passes to its <Web> node. */
export function mount(Page: ComponentType<Record<string, unknown>>): void {
  function Host() {
    return createElement(Page, useSyncExternalStore(subscribe, () => props));
  }
  createRoot(document.getElementById("root")!).render(createElement(Host));
}
