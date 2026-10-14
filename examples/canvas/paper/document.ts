/**
 * The paper's document, as the world keeps it: Excalidraw's elements, and a
 * PNG of each, which the world shows while the paper is put away. Both live in
 * $XDG_DATA_HOME/proscenium/paper, so drawings outlast the compositor.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { partLength, toBase64, type Loaded, type Packet, type Render, type SceneElement } from "./wire.js";

const directory = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "proscenium", "paper");
const documentFile = join(directory, "document.json");
const renderDirectory = join(directory, "renders");
/** How long the document waits after a change before it is written. */
const saveDelay = 1500;

/** An element's render on disk, where it lies on the canvas. */
export interface Drawing {
  id: string;
  version: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** The PNG's path. */
  src: string;
}

interface Saved {
  elements: SceneElement[];
  renders: Record<string, Omit<Drawing, "src" | "id">>;
  blank?: Record<string, number>;
}

const fileOf = (id: string, version: number) => join(renderDirectory, `${id}-${version}.png`);

/** Elements bottom first, by Excalidraw's fractional index, which compares as plain strings. */
function byIndex(a: SceneElement, b: SceneElement): number {
  const first = a.index ?? "";
  const second = b.index ?? "";
  return first < second ? -1 : first > second ? 1 : 0;
}

export class PaperDocument {
  private readonly elements = new Map<string, SceneElement>();
  private readonly renders = new Map<string, Drawing>();
  private readonly listeners = new Set<() => void>();
  /** Elements that draw nothing, at the version that was found to. */
  private readonly blank = new Map<string, number>();
  private drawings: readonly Drawing[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private closed = false;
  /** Renders being written, which are not yet in `renders`. */
  private readonly writing = new Set<string>();

  /** The document as last saved, or an empty one. */
  constructor() {
    let saved: Saved = { elements: [], renders: {} };
    try {
      saved = JSON.parse(readFileSync(documentFile, "utf8")) as Saved;
    } catch {
      // No document yet, or an unreadable one: start empty.
    }
    for (const element of saved.elements) this.elements.set(element.id, element);
    for (const [id, render] of Object.entries(saved.renders)) {
      if (this.elements.has(id)) this.renders.set(id, { ...render, id, src: fileOf(id, render.version) });
    }
    for (const [id, version] of Object.entries(saved.blank ?? {})) this.blank.set(id, version);
    this.order();
    void this.collect();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Every element's render, bottom first. */
  getDrawings = (): readonly Drawing[] => this.drawings;

  /** The document for a page, in base64 parts small enough for its props. */
  parts(): string[] {
    const rendered = Object.fromEntries([
      ...this.blank,
      ...[...this.renders.values()].map((render) => [render.id, render.version] as const),
    ]);
    const loaded: Loaded = { elements: [...this.elements.values()].sort(byIndex), rendered };
    const data = toBase64(JSON.stringify(loaded));
    const parts: string[] = [];
    for (let at = 0; at < data.length || parts.length === 0; at += partLength) {
      parts.push(data.slice(at, at + partLength));
    }
    return parts;
  }

  async apply(packet: Packet): Promise<void> {
    if (packet.type === "elements") {
      for (const element of packet.put) this.elements.set(element.id, element);
      for (const id of packet.drop) {
        this.elements.delete(id);
        this.forget(id);
      }
    } else {
      await this.draw(packet);
    }
    this.order();
  }

  /** A render that could not be shown: the page draws it again next time it is out. */
  lose(id: string, version: number): void {
    if (this.renders.get(id)?.version !== version) return;
    this.renders.delete(id);
    this.order();
  }

  /** Writes what is not yet written, at once; nothing changes the document after. */
  close(): void {
    if (this.timer) this.save(true);
    this.closed = true;
  }

  private async draw(render: Render): Promise<void> {
    const element = this.elements.get(render.id);
    // The element may have changed or gone since the page drew it.
    if (!element || element.version !== render.version) return;
    if (!render.png) {
      this.forget(render.id);
      this.blank.set(render.id, render.version);
      return;
    }
    const src = fileOf(render.id, render.version);
    this.writing.add(src);
    try {
      await mkdir(renderDirectory, { recursive: true });
      await writeFile(src, Buffer.from(render.png, "base64"));
    } finally {
      this.writing.delete(src);
    }
    if (this.closed || this.elements.get(render.id)?.version !== render.version) return;
    const { id, version, x, y, width, height } = render;
    const previous = this.renders.get(id);
    this.renders.set(id, { id, version, x, y, width, height, src });
    if (previous && previous.src !== src) void rm(previous.src, { force: true });
  }

  private forget(id: string): void {
    this.blank.delete(id);
    const render = this.renders.get(id);
    if (!render) return;
    this.renders.delete(id);
    void rm(render.src, { force: true });
  }

  /** Renders in element order, for the world, and a save soon after. */
  private order(): void {
    if (this.closed) return;
    const order = [...this.elements.values()].sort(byIndex);
    this.drawings = order.flatMap((element) => this.renders.get(element.id) ?? []);
    for (const listener of this.listeners) listener();
    this.timer ??= setTimeout(() => this.save(), saveDelay);
  }

  /**
   * Writes the document, off the director's thread unless NOW: a big document
   * takes a while to write. The last write before the world closes is the
   * synchronous one, and an earlier one still under way never replaces it.
   */
  private save(now = false): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const saved: Saved = {
      elements: [...this.elements.values()].sort(byIndex),
      renders: Object.fromEntries(
        [...this.renders.values()].map(({ id, src: _src, ...render }) => [id, render]),
      ),
      blank: Object.fromEntries(this.blank),
    };
    const text = JSON.stringify(saved);
    if (now) {
      try {
        mkdirSync(directory, { recursive: true });
        writeFileSync(`${documentFile}.tmp`, text);
        renameSync(`${documentFile}.tmp`, documentFile);
      } catch (error) {
        console.error(`paper: cannot save: ${error}`);
      }
      return;
    }
    this.saving = this.saving
      .then(async () => {
        await mkdir(directory, { recursive: true });
        await writeFile(`${documentFile}.saving`, text);
        if (!this.closed) await rename(`${documentFile}.saving`, documentFile);
      })
      .catch((error: unknown) => console.error(`paper: cannot save: ${error}`));
  }

  /** Removes renders no element shows, left by a crash between writes. */
  private async collect(): Promise<void> {
    const files = await readdir(renderDirectory).catch(() => []);
    for (const file of files) {
      const path = join(renderDirectory, file);
      const kept = this.writing.has(path) || [...this.renders.values()].some((render) => render.src === path);
      if (!kept) await rm(path, { force: true });
    }
  }
}

