// <Web>: a page rendered by Chromium inside the scene.
//
// A React module source is bundled for the browser with this package's React
// DOM and mounted by the page runtime (proscenium/page), which hands it the
// `props` given here and carries its send() calls back to `onMessage`. Saving
// the module rebuilds it and reloads only that page. URLs, HTML files and
// built app directories are shown as they are.

import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { BuildOptions } from "esbuild";
import { createElement, useEffect, useMemo, useSyncExternalStore } from "react";
import { bundle, describeFailure } from "./build.js";
import type { StageErrorEvent, StageEvent } from "./events.js";
import type { CursorProps, ElementProps, MotionProps, ShaderProps, ShapeProps } from "./props.js";
import { resolveAsset } from "./props.js";
import { SourceWatcher } from "./watch.js";

export interface WebProps extends ShapeProps, MotionProps, CursorProps, ShaderProps,
  ElementProps<WebProps> {
  /**
   * A React module (.tsx, .jsx, .ts, .js) whose default export renders the page,
   * an .html file, a built app directory, or a URL. Paths are relative to the
   * world file.
   */
  src: string;
  /** JSON-serializable props for the page's component; changes re-render it in place. */
  props?: unknown;
  /** Clicking the page gives it the keyboard; defaults to true. */
  focusable?: boolean;
  /**
   * Take the keyboard whenever the node appears (visible with nonzero opacity)
   * and give it back when hidden: a launcher can stay mounted and just fade in.
   */
  autoFocus?: boolean;
  /**
   * For a page whose drawing depends on where its node is, such as one drawing
   * the canvas it lies on: each frame the page marks with a number (tagFrames
   * from proscenium/page, 1 to 4095) shows where the node was while this was
   * that number, for its last few. A move and the page's redraw for it then
   * show up together, in one frame.
   */
  frameTag?: number;
  interactive?: boolean;
  /** A message the page sent with send(name, value). */
  onMessage?: (name: string, value: unknown) => void;
  onLoad?: () => void;
  onError?: (event: StageErrorEvent) => void;
}

const moduleSource = /\.(tsx|jsx|ts|js|mjs)$/i;
const pageAssets = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".woff", ".woff2", ".ttf",
                    ".otf", ".webm", ".mp4", ".ogg", ".mp3", ".wav", ".opus"];
const packageRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const page = `<!doctype html>
<html><head><meta charset="utf-8"><link rel="stylesheet" href="app.css">
<style>html,body{margin:0;height:100%;background:transparent;overflow:hidden}#root{height:100%}</style>
</head><body><div id="root"></div><script type="module" src="app.js"></script></body></html>
`;

interface BundleOptions {
  scratch: string;
  watch: boolean;
  development: boolean;
  log: (message: string) => void;
}

let options: BundleOptions | null = null;
const bundles = new Map<string, Bundle>();
let bundleCount = 0;

/** Called by the runtime before the world renders. */
export function configureWebBundles(next: BundleOptions): void {
  options = next;
}

export async function closeWebBundles(): Promise<void> {
  await Promise.all([...bundles.values()].map((bundle) => bundle.dispose()));
  bundles.clear();
}

/** One page module built into its own directory; the revision counts good builds. */
class Bundle {
  revision = 0;
  private users = 0;
  private options: BuildOptions | null = null;
  private disposed = false;
  private retire: NodeJS.Timeout | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly watcher = new SourceWatcher(() => void this.build());
  readonly directory: string;

  constructor(readonly module: string, private readonly config: BundleOptions) {
    // Unique per bundle: a retiring bundle's cleanup never touches its successor's files.
    const name = createHash("sha256").update(module).digest("hex").slice(0, 12);
    this.directory = join(config.scratch, `web-${name}-${++bundleCount}`);
    this.start().catch((error: unknown) =>
      config.log(`page ${module} could not start: ${error instanceof Error ? error.message : error}`));
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Keep the bundle while a node shows it, and briefly after, so a world reload reuses it. */
  hold(): () => void {
    this.users++;
    if (this.retire) clearTimeout(this.retire);
    this.retire = null;
    return () => {
      if (--this.users === 0) {
        this.retire = setTimeout(() => {
          bundles.delete(this.module);
          void this.dispose();
        }, 5000);
      }
    };
  }

  async dispose(): Promise<void> {
    if (this.retire) clearTimeout(this.retire);
    this.disposed = true;
    this.watcher.close();
    await rm(this.directory, { recursive: true, force: true });
  }

  private async start(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeFile(join(this.directory, "index.html"), page);
    // Pages without CSS still link app.css; an empty file avoids a failed request.
    await writeFile(join(this.directory, "app.css"), "");
    this.options = {
      stdin: {
        contents: `import { mount } from "proscenium/page";\n`
          + `import Page from ${JSON.stringify(this.module)};\nmount(Page);\n`,
        resolveDir: dirname(this.module),
        loader: "js",
      },
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "chrome120",
      jsx: "automatic",
      outfile: join(this.directory, "app.js"),
      sourcemap: "inline",
      minify: !this.config.development,
      metafile: true,
      logLevel: "silent",
      // The page's React and the page runtime come from this package.
      nodePaths: [join(packageRoot, "node_modules")],
      alias: { "proscenium/page": join(packageRoot, "dist", "page.js") },
      define: { "process.env.NODE_ENV": JSON.stringify(this.config.development ? "development" : "production") },
      // Images, fonts, video and audio are copied next to the page, which loads them by URL.
      loader: Object.fromEntries(pageAssets.map((extension) => [extension, "file"])),
      assetNames: "assets/[name]-[hash]",
    };
    await this.build();
  }

  private inputs: string[] = [];

  private async build(): Promise<void> {
    if (!this.options || this.disposed) return;
    try {
      const result = await bundle(this.options);
      this.inputs = Object.keys(result.metafile!.inputs);
      this.revision++;
      for (const listener of this.listeners) listener();
    } catch (error) {
      this.config.log(`page ${this.module} did not build; keeping the shown version.\n`
                      + await describeFailure(error));
    }
    if (this.config.watch && !this.disposed) this.watcher.track([this.module, ...this.inputs]);
  }
}

function bundleFor(module: string): Bundle {
  if (!options) throw new Error("<Web> with a module source needs the Stage runtime.");
  let bundle = bundles.get(module);
  if (!bundle) bundles.set(module, bundle = new Bundle(module, options));
  return bundle;
}

const noBundle = { subscribe: () => () => undefined };

/** The source to show for SRC and the revision that reloads it; null until a module first builds. */
function usePageSource(src: string): { src: string; revision?: number } | null {
  const module = !src.includes("://") && moduleSource.test(src) ? resolveAsset(src) : null;
  const bundle = module ? bundleFor(module) : null;
  const revision = useSyncExternalStore((bundle ?? noBundle).subscribe, () => bundle?.revision ?? 0);
  useEffect(() => bundle?.hold(), [bundle]);
  if (!bundle) return { src: src.includes("://") ? src : resolveAsset(src) };
  return revision > 0 ? { src: bundle.directory, revision } : null;
}

/** A page rendered by Chromium: React DOM, any web app, or a URL. */
export function Web({ src, props, onMessage, ...rest }: WebProps) {
  const source = usePageSource(src);
  const data = useMemo(() => (props === undefined ? undefined : JSON.stringify(props)), [props]);
  return createElement("web" as never, {
    ...rest,
    src: source?.src,
    revision: source?.revision,
    data,
    onMessage: onMessage && ((event: StageEvent) => {
      const { name, value } = JSON.parse((event as { payload: string }).payload) as
        { name: string; value: unknown };
      onMessage(name, value);
    }),
  });
}
