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

let tagCells: HTMLElement[] | null = null;

/**
 * Mark the frames this page shows from now on with TAG (1 to 4095), which a
 * `<Web frameTag={TAG}>` node waits for before it moves. Call it in the same
 * task that draws for the node's new place, after the drawing, so that the
 * frame with the number is the frame with the drawing. The mark is two cells of
 * 2 x 2 CSS pixels at the page's top left, which the compositor reads and never
 * shows.
 */
export function tagFrames(tag: number): void {
  if (!tagCells) {
    tagCells = [0, 2].map((left) => {
      const cell = document.createElement("div");
      cell.style.cssText = `position:fixed;left:${left}px;top:0;width:2px;height:2px;`
        + "z-index:2147483647;pointer-events:none";
      document.body.append(cell);
      return cell;
    });
  }
  const digits = [(tag >> 8) & 15, (tag >> 4) & 15, tag & 15];
  const color = (values: number[]) => `rgb(${values.map((digit) => digit * 16 + 8).join(",")})`;
  tagCells[0]!.style.background = color(digits);
  tagCells[1]!.style.background = color(digits.map((digit) => 15 - digit));
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
