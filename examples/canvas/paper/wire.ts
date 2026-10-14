/**
 * What the canvas world and its paper page (page/index.tsx) say to each other.
 * Props carry what is small and changes often. Anything long travels as
 * numbered chunks, never more than a window ahead of what the other side has
 * confirmed: a page's message holds under 8 KB, and its props about 60 KB.
 */

/** An Excalidraw element, which the world keeps without looking inside. */
export interface SceneElement {
  id: string;
  version: number;
  /** Excalidraw's fractional index: elements sort by it, bottom first. */
  index?: string | null;
  isDeleted?: boolean;
  [key: string]: unknown;
}

export const tools = [
  "selection",
  "freedraw",
  "rectangle",
  "ellipse",
  "diamond",
  "arrow",
  "line",
  "text",
  "eraser",
] as const;
export type Tool = (typeof tools)[number];

export interface Style {
  stroke: string;
  background: string;
  width: number;
}

/**
 * Where the page lies on the canvas: its top-left corner, and the zoom it draws
 * at. `tag` numbers the place (1 to 4095); the page marks the frames it draws
 * there with it, and its node waits for them before it moves.
 */
export interface Placement {
  x: number;
  y: number;
  zoom: number;
  tag: number;
}

export interface PaperProps {
  placement: Placement;
  /** New each time the world starts; the page says hello to each, as a new world knows nothing yet. */
  session: string;
  /**
   * The document as the world has it, one part at a time after each hello: a
   * page that has none takes it, and one that has its own sends what differs.
   */
  load: { part: number; parts: number; data: string } | null;
  /** How many chunks the world has taken, in order. */
  received: number;
  /** The toolbar's pick; `serial` counts picks, so the same tool can be picked again. */
  tool: { type: Tool; serial: number };
  /** New elements take this; a new `serial` gives it to the selection too. */
  style: Style & { serial: number };
  /** Raised to ask for every render still owed, then a "flushed" with it. */
  flush: number;
}

/** The document as the world sends it to a page: elements, and the version each render shows. */
export interface Loaded {
  elements: SceneElement[];
  rendered: Record<string, number>;
}

/** An element drawn on its own: a PNG of the canvas box x, y, width, height; no `png` when it draws nothing. */
export interface Render {
  id: string;
  version: number;
  x: number;
  y: number;
  width: number;
  height: number;
  png: string | null;
}

export type Packet =
  | { type: "elements"; put: SceneElement[]; drop: string[] }
  | ({ type: "render" } & Render);

export interface Chunk {
  serial: number;
  data: string;
  /** The last chunk of a packet. */
  end: boolean;
}

export type PaperMessage =
  /** The page met a new session and wants the document; chunk serials start over. */
  | { name: "hello"; value: { fresh: boolean } }
  /** Part `value` of the document arrived. */
  | { name: "loaded"; value: number }
  /** The page shows the document where it is placed. */
  | { name: "ready" }
  /** The page drew at placement `value` and marks its frames with it. */
  | { name: "placed"; value: number }
  | { name: "chunk"; value: Chunk }
  /** The wheel turned over the page: pan by screen pixels, or zoom by `factor` about the canvas point (x, y). */
  | { name: "wheel"; value: { dx: number; dy: number; factor: number; x: number; y: number } }
  /** Excalidraw wanted to look elsewhere, e.g. zooming to fit: the canvas point to center, at `zoom`. */
  | { name: "look"; value: { x: number; y: number; zoom: number } }
  /** The tool changed in the page, by its own keys. */
  | { name: "tool"; value: Tool }
  /** Every render asked for by flush `value` is on its way. */
  | { name: "flushed"; value: number };

/** Chunks a page sends ahead of the world's confirmation; the queue holds 32 messages. */
const chunkWindow = 16;
/** Bytes of a chunk's escaped data, leaving room in the 8 KB message for the rest. */
const chunkBytes = 7000;
/** Characters of a document part, which is base64 and so needs no escaping. */
export const partLength = 40000;

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(JSON.stringify(text)).length;

/** TEXT in pieces whose escaped UTF-8 fits a message, never parting a surrogate pair. */
function slices(text: string): string[] {
  const pieces: string[] = [];
  for (let at = 0; at < text.length; ) {
    let end = Math.min(text.length, at + chunkBytes);
    while (end - at > 1 && bytes(text.slice(at, end)) > chunkBytes) {
      end = at + Math.max(1, Math.floor((end - at) * 0.7));
    }
    const last = text.charCodeAt(end - 1);
    if (end < text.length && end - at > 1 && last >= 0xd800 && last < 0xdc00) end--;
    pieces.push(text.slice(at, end));
    at = end;
  }
  return pieces;
}

/** Base64 of UTF-8 TEXT, and back: the document crosses in props as base64 parts. */
export function toBase64(text: string): string {
  return bytesToBase64(encoder.encode(text));
}

export function bytesToBase64(data: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < data.length; at += 0x8000) {
    binary += String.fromCharCode(...data.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(base64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)));
}

/** The world's end: takes chunks in order and gives back whole packets. */
export class Inbox {
  received = 0;
  private pieces: string[] = [];

  /** Starts over, as a page that just started numbers its chunks from 1 again. */
  reset(): void {
    this.received = 0;
    this.pieces = [];
  }

  /** Takes CHUNK if it is the next one, returning the packet it completes. */
  take(chunk: Chunk): Packet | null {
    if (chunk.serial !== this.received + 1) return null;
    this.received = chunk.serial;
    this.pieces.push(chunk.data);
    if (!chunk.end) return null;
    const text = this.pieces.join("");
    this.pieces = [];
    return JSON.parse(text) as Packet;
  }
}

/** How long a page waits for the world to confirm chunks before sending them again. */
const resendAfter = 1000;

/** The page's end: numbers chunks and keeps them until the world confirms them. */
export class Outbox {
  private queue: Chunk[] = [];
  private serial = 0;
  private sent = 0;
  private confirmed = 0;
  private lastProgress = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private waiting: (() => void)[] = [];

  constructor(private readonly send: (chunk: Chunk) => void) {}

  /** Forgets every chunk, for a world that starts counting again. */
  reset(): void {
    this.queue = [];
    this.serial = this.sent = this.confirmed = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const resolve of this.waiting.splice(0)) resolve();
  }

  push(packet: Packet): void {
    if (this.queue.length === 0) this.lastProgress = Date.now();
    const pieces = slices(JSON.stringify(packet));
    pieces.forEach((data, index) => {
      this.queue.push({ serial: ++this.serial, data, end: index === pieces.length - 1 });
    });
    this.pump();
  }

  /** Resolves once every chunk pushed so far has been confirmed. */
  drained(): Promise<void> {
    if (this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  /** The world has taken chunks up to RECEIVED. */
  confirm(received: number): void {
    if (received <= this.confirmed) return;
    this.confirmed = received;
    this.lastProgress = Date.now();
    this.queue = this.queue.filter((chunk) => chunk.serial > received);
    this.pump();
  }

  private pump(): void {
    this.sent = Math.max(this.sent, this.confirmed);
    for (const chunk of this.queue) {
      if (chunk.serial <= this.sent) continue;
      if (chunk.serial > this.confirmed + chunkWindow) break;
      this.send(chunk);
      this.sent = chunk.serial;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.queue.length === 0) {
      for (const resolve of this.waiting.splice(0)) resolve();
      return;
    }
    // A chunk the full queue dropped is sent again, with all after it.
    this.timer = setTimeout(() => {
      if (Date.now() - this.lastProgress >= resendAfter) this.sent = this.confirmed;
      this.pump();
    }, resendAfter);
  }
}
