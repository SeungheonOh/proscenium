// The generated UI protocol: programs ask the world for interfaces over a Unix
// socket and own them, with no Wayland surface, buffer or toolkit of their own.
// Each message is one JSON object on a line. See docs/GENUI.md.
//
// The socket is $PROSCENIUM_UI_SOCKET, else $XDG_RUNTIME_DIR/proscenium-ui.sock.
// A program's interfaces close when its connection does.

import type { JsonPatch, Spec } from "proscenium/genui";

export const protocolVersion = 1;

/**
 * Where an interface lives:
 * - inline: in the assistant's chat, inside the message that made it (the assistant's only);
 * - floating: a card on the screen, moved by its title;
 * - overlay: a bare card pinned to a corner or edge of the screen, over everything;
 * - dock: a panel along the left or right edge, which windows keep clear of;
 * - canvas: a card in the world, which pans and zooms with the windows;
 * - dialog: a card in the middle of the screen over a dimmed backdrop, until it is answered.
 */
export type Mode = "inline" | "floating" | "overlay" | "dock" | "canvas" | "dialog";
export const modes: readonly Mode[] = ["inline", "floating", "overlay", "dock", "canvas", "dialog"];

export type Anchor = "top-left" | "top" | "top-right" | "left" | "center" | "right" | "bottom-left" | "bottom"
  | "bottom-right";

/** Where in its mode: x and y for floating (screen) and canvas (world) cards, an anchor for overlays, a side for docks. */
export interface Place {
  x?: number;
  y?: number;
  anchor?: Anchor;
  side?: "left" | "right";
}

export type ChatPart =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; id: string; name: string; label: string; status: "running" | "done" | "error"; detail?: string }
  /** An interface made in this message, by its id. */
  | { type: "ui"; id: string };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "event";
  parts: ChatPart[];
  /** Still being written. */
  streaming?: boolean;
  error?: string;
}

/** What a program sends. Requests with `request` get an answer carrying it. */
export type ClientMessage =
  | { op: "hello"; name: string; agent?: boolean }
  | { op: "open"; id: string; mode?: Mode; place?: Place; title?: string; width?: number; theme?: "light" | "dark";
      spec?: Partial<Spec>; patches?: JsonPatch[]; message?: string; request?: number }
  | { op: "patch"; id: string; patches: JsonPatch[]; request?: number }
  | { op: "state"; id: string; set: Record<string, unknown> }
  | { op: "update"; id: string; title?: string; width?: number; theme?: "light" | "dark" }
  | { op: "place"; id: string; mode: Mode; place?: Place }
  | { op: "close"; id: string }
  | { op: "get"; id: string; request: number }
  | { op: "catalog"; request: number }
  // The assistant's own: the chat it keeps.
  | { op: "chat"; messages: ChatMessage[] }
  | { op: "message"; message: ChatMessage }
  | { op: "status"; busy: boolean; model?: string; error?: string | null };

/** What the world sends a program. */
export type HostMessage =
  | { type: "welcome"; protocol: number; modes: readonly Mode[]; screen: { width: number; height: number } }
  | { type: "action"; id: string; action: string; params: Record<string, unknown>; state: Record<string, unknown> }
  /** The person changed an interface's state: what it is now. */
  | { type: "state"; id: string; state: Record<string, unknown> }
  /** The person moved an interface. */
  | { type: "placed"; id: string; mode: Mode; place: Place }
  | { type: "closed"; id: string; by: "person" | "program" }
  | { type: "result"; request: number; ok: boolean; problems?: string[]; error?: string;
      spec?: Spec; mode?: Mode; place?: Place; prompt?: string; components?: string[] }
  | { type: "error"; message: string }
  // To the assistant.
  | { type: "prompt"; text: string }
  | { type: "abort" }
  | { type: "reset" };

/** The socket a world listens on and programs connect to. */
export function socketPath(): string {
  return process.env.PROSCENIUM_UI_SOCKET
    || `${process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`}/proscenium-ui.sock`;
}
