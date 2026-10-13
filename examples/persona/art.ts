// Cover art as a file the compositor can load: a player's own file as it is,
// a web address downloaded once into the runtime directory.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { useEffect, useState } from "react";

const directory = join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), "proscenium-persona-art");
const downloads = new Map<string, Promise<string | null>>();

function download(url: string): Promise<string | null> {
  let pending = downloads.get(url);
  if (!pending) {
    pending = (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) return null;
        const path = join(directory, createHash("sha256").update(url).digest("hex").slice(0, 16));
        await mkdir(directory, { recursive: true });
        await writeFile(path, Buffer.from(await response.arrayBuffer()));
        return path;
      } catch {
        return null;
      }
    })();
    downloads.set(url, pending);
  }
  return pending;
}

/** The file for ART, a file:// or https:// URL; null while it downloads, or without art. */
export function useArt(art: string): string | null {
  const local = art.startsWith("file://") ? fileURLToPath(art) : null;
  const [fetched, setFetched] = useState<{ url: string; path: string | null } | null>(null);
  useEffect(() => {
    if (!art.startsWith("https://")) return;
    let current = true;
    void download(art).then((path) => current && setFetched({ url: art, path }));
    return () => {
      current = false;
    };
  }, [art]);
  return local ?? (fetched?.url === art ? fetched.path : null);
}
