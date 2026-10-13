// Director runtime: bundles a world module with esbuild, renders its default
// export, and hot-reloads it whenever one of its source files changes.
//
// The bundle imports React and proscenium from this runtime's own copies,
// so every reload shares one session, one store and one React root. A reload
// remounts the world; nodes with the same identity (windows, cameras and
// layoutIds) animate from where they are to where the new code puts them.
// A world that fails to render falls back to the last version that worked.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BuildOptions } from "esbuild";
import { Component, type ComponentType, createElement, Fragment, type ReactNode } from "react";
import { Window } from "./components.js";
import { useWindows } from "./hooks.js";
import { setAssetBase } from "./props.js";
import { Session } from "./session.js";
import { bundle, describeFailure, stopBuilds } from "./build.js";
import { SourceWatcher } from "./watch.js";
import { closeWebBundles, configureWebBundles } from "./web.js";

export interface RunOptions {
  /** World module whose default export is the root component. */
  entry: string;
  /** Compositor socket; defaults to $PROSCENIUM_SOCKET. */
  socket?: string;
  /** Rebuild and reload when sources change (default true). */
  watch?: boolean;
}

interface GuardProps {
  fallback: ReactNode;
  onError: (error: unknown) => void;
  onMount?: () => void;
  children?: ReactNode;
}

class Guard extends Component<GuardProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    this.props.onError(error);
  }

  override componentDidMount() {
    if (!this.state.failed) this.props.onMount?.();
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Last resort when no version of the world renders: keep every window reachable. */
function SafeMode() {
  const windows = useWindows();
  return createElement(Fragment, null, windows.map((window, index) =>
    createElement(Window, { key: window.id, window: window.id, x: 48 + 32 * (index % 8),
                            y: 48 + 32 * (index % 8), originX: 0, originY: 0 })));
}

function log(message: string): void {
  console.error(`[stage] ${message}`);
}

const imageFiles = /\.(png|jpe?g|webp|gif|svg|avif|bmp|ico|tiff?)$/i;

const shared: Record<string, string> = {
  react: import.meta.resolve("react"),
  "react/jsx-runtime": import.meta.resolve("react/jsx-runtime"),
  "proscenium": new URL("./index.js", import.meta.url).href,
};

export async function run(options: RunOptions): Promise<void> {
  const socket = options.socket ?? process.env.PROSCENIUM_SOCKET;
  if (!socket) throw new Error("No compositor socket: pass --socket or set PROSCENIUM_SOCKET.");
  const entry = resolve(options.entry);
  setAssetBase(dirname(entry));
  const parent = process.env.PROSCENIUM_PARENT;
  const session = new Session({
    socket, parentPid: parent ? Number(parent) : undefined, onRejected: () => void shutdown(),
  });
  const scratch = await mkdtemp(join(tmpdir(), "proscenium-"));
  const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  session.store.persistTo(join(stateHome, "proscenium", `${basename(entry, extname(entry))}.json`));
  configureWebBundles({ scratch, watch: options.watch ?? true,
                        development: process.env.NODE_ENV === "development", log });
  let generation = 0;
  let working: ComponentType | null = null;

  const report = (error: unknown) =>
    log(`${basename(entry)} failed: ${error instanceof Error ? error.stack ?? error.message : error}`);

  async function load(code: string) {
    const version = ++generation;
    const file = join(scratch, `world-${version}.mjs`);
    await writeFile(file, code);
    try {
      const World = (await import(pathToFileURL(file).href) as { default?: unknown }).default;
      if (typeof World !== "function") throw new TypeError("the module has no default component export");
      const previous = working;
      const fallback: ReactNode = previous
        ? createElement(Guard, { fallback: createElement(SafeMode), onError: report },
                        createElement(previous))
        : createElement(SafeMode);
      session.render(createElement(Guard, {
        key: version, fallback, onError: report,
        onMount: () => { working = World as ComponentType; },
      }, createElement(World as ComponentType)));
      log(`loaded ${basename(entry)}${version > 1 ? ` (reload ${version - 1})` : ""}`);
    } catch (error) {
      report(error);
    } finally {
      // Node keeps the evaluated module; the file is only needed to import it.
      await rm(file, { force: true });
    }
  }

  const buildOptions: BuildOptions = {
    entryPoints: [entry],
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "node",
    target: "node22",
    jsx: "automatic",
    sourcemap: "inline",
    outfile: join(scratch, "world.mjs"),
    logLevel: "silent",
    plugins: [{
      name: "stage-runtime",
      setup(build) {
        build.onResolve({ filter: /^(react|react\/jsx-runtime|proscenium)$/ },
                        (args) => ({ path: shared[args.path]!, external: true }));
        // `import photo from "./photo.jpg"` and `import page from "./page.tsx?url"`
        // yield the file's absolute path, for <Image src> and <Web src>. Images
        // are watched, so editing one reloads the world; pages reload themselves.
        build.onResolve({ filter: /\?url$/ }, (args) => ({
          path: resolve(args.resolveDir, args.path.slice(0, -"?url".length)), namespace: "stage-url",
        }));
        build.onLoad({ filter: /.*/, namespace: "stage-url" }, (args) => ({
          contents: `export default ${JSON.stringify(args.path)};`, loader: "js",
        }));
        build.onLoad({ filter: imageFiles }, (args) => ({
          contents: `export default ${JSON.stringify(args.path)};`, loader: "js",
        }));
      },
    }],
  };

  const watcher = new SourceWatcher(() => void build());
  let inputs = [entry];
  async function build() {
    try {
      const result = await bundle(buildOptions);
      inputs = Object.keys(result.metafile!.inputs);
      await load(result.outputFiles![0]!.text);
    } catch (error) {
      log(`${basename(entry)} did not build; keeping the running version.\n${await describeFailure(error)}`);
    }
    // After a failure the last good inputs and the entry stay watched.
    if (options.watch ?? true) watcher.track([...new Set([entry, ...inputs])]);
  }

  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    // Unmounting first lets the world's effects stop what they started.
    session.stop();
    session.store.flushPersistent();
    watcher.close();
    await closeWebBundles();
    await stopBuilds();
    await rm(scratch, { recursive: true, force: true });
    process.exit(0);
  }
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  session.start();
  await build();
}
