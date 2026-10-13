import type { CSSProperties } from "react";
import { send } from "proscenium/page";

/** Joins the class names that are set. */
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

/** Places an element in the staggered `.rise` entrance (see theme.css). */
export function stagger(index: number): CSSProperties {
  return { "--stagger": index } as CSSProperties;
}

/** A message from a page to its `<Web>` node in the world. */
export interface PageMessage {
  name: string;
  value?: unknown;
}

/** Sends a message to the page's `<Web>` node, whose `onMessage` receives it. */
export function sendMessage(message: PageMessage): void {
  send(message.name, message.value ?? null);
}
