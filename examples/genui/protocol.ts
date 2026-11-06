// The generated UI protocol: programs ask the world for interfaces over a Unix
// socket and own them, with no Wayland surface, buffer or toolkit of their own.
// Each message is one JSON object on a line. See docs/GENUI.md.
//
// The socket is $PROSCENIUM_UI_SOCKET, else $XDG_RUNTIME_DIR/proscenium-ui.sock.
// A program's interfaces close when its connection does.
//
// An app is a program kept in an apps folder, which the world starts, keeps
// running and starts again after a restart (apps.ts); app.ts is its library.

import { join } from "node:path";
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
  | { type: "ui"; id: string }
  /** An app written or started in this message (a tool call, by its id): once done, a chip to stop or start it. */
  | { type: "app"; id: string; name?: string; title?: string; label: string; status: "running" | "done" | "error" };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "event";
  parts: ChatPart[];
  /** Still being written. */
  streaming?: boolean;
  error?: string;
}

/** An app, as the world knows it: what it is, and whether it runs and shows anything. */
export interface AppInfo {
  name: string;
  title: string;
  description?: string;
  /** Shipped with Proscenium (examples/genui/apps), not the person's own. */
  builtin: boolean;
  /** Its folder. */
  dir: string;
  running: boolean;
  pid?: number;
  /** Its interfaces open now, with what is wrong with each spec. */
  interfaces: { id: string; title?: string; mode: Mode; problems: string[] }[];
  /** How its last run ended, once it has. */
  ended?: string;
}

/** What a program sends. Requests with `request` get an answer carrying it. */
export type ClientMessage =
  /** APP: the app this program is ($PROSCENIUM_APP, set by the world that started it). */
  | { op: "hello"; name: string; agent?: boolean; app?: string; pid?: number }
  | { op: "open"; id: string; mode?: Mode; place?: Place; title?: string; width?: number; theme?: "light" | "dark";
      spec?: Partial<Spec>; patches?: JsonPatch[]; message?: string; request?: number }
  | { op: "patch"; id: string; patches: JsonPatch[]; request?: number }
  | { op: "state"; id: string; set: Record<string, unknown> }
  /** `message: null` unlinks an interface from the chat message that made it (the assistant's). */
  | { op: "update"; id: string; title?: string; width?: number; theme?: "light" | "dark"; message?: string | null }
  | { op: "place"; id: string; mode: Mode; place?: Place }
  | { op: "close"; id: string }
  | { op: "get"; id: string; request: number }
  | { op: "catalog"; request: number }
  // Apps: list them, start one (again, with restart), stop one.
  | { op: "apps"; request: number }
  | { op: "launch"; app: string; restart?: boolean; request: number }
  | { op: "stop"; app: string; request: number }
  // The assistant's own: the chat it keeps.
  | { op: "chat"; messages: ChatMessage[] }
  | { op: "message"; message: ChatMessage }
  | { op: "status"; busy: boolean; model?: string; error?: string | null };

/** What the world sends a program. */
export type HostMessage =
  | { type: "welcome"; protocol: number; modes: readonly Mode[]; screen: { width: number; height: number } }
  /**
   * An element sent ACTION. STATE is the interface's then, which has the first
   * SEEN of the program's messages on this connection in it (later ones were on
   * their way).
   */
  | { type: "action"; id: string; action: string; params: Record<string, unknown>; state: Record<string, unknown>; seen?: number }
  /** The person changed an interface's state: what it is now, with SEEN as for an action. */
  | { type: "state"; id: string; state: Record<string, unknown>; seen?: number }
  /** The person moved an interface. */
  | { type: "placed"; id: string; mode: Mode; place: Place }
  | { type: "closed"; id: string; by: "person" | "program" }
  | { type: "result"; request: number; ok: boolean; problems?: string[]; error?: string;
      spec?: Spec; mode?: Mode; place?: Place; prompt?: string; components?: string[];
      apps?: AppInfo[]; app?: AppInfo; log?: string }
  /** To an app: something started it while it runs (the person asked for it again), so it shows itself. */
  | { type: "show" }
  /** A fatal error ends the connection for good: a newer assistant took the chat. */
  | { type: "error"; message: string; fatal?: boolean }
  // To the assistant.
  | { type: "prompt"; text: string }
  | { type: "abort" }
  | { type: "reset" };

/** The socket a world listens on and programs connect to. */
export function socketPath(): string {
  return process.env.PROSCENIUM_UI_SOCKET
    || `${process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`}/proscenium-ui.sock`;
}

/** The person's apps: $XDG_DATA_HOME/proscenium/apps/NAME, each a folder with main.ts and app.json. */
export function appsFolder(): string {
  return join(process.env.XDG_DATA_HOME || join(process.env.HOME || "/", ".local/share"), "proscenium", "apps");
}

/** What the world keeps of each app: its log, its data and where the person put its interfaces. */
export function appStateFolder(name?: string): string {
  const folder = join(process.env.XDG_STATE_HOME || join(process.env.HOME || "/", ".local/state"), "proscenium", "apps");
  return name ? join(folder, name) : folder;
}

/** App names are folder names: lower case letters, digits and dashes. */
export const appName = /^[a-z0-9][a-z0-9-]{0,39}$/;
