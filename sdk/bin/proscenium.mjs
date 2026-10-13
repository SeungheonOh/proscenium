#!/usr/bin/env node
// Direct the compositor with a TSX world: proscenium [--socket PATH] [--once] [--dev] WORLD.tsx
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    socket: { type: "string" },
    once: { type: "boolean", default: false },
    dev: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help || positionals.length !== 1) {
  console.error("Usage: proscenium [--socket PATH] [--once] [--dev] WORLD.tsx\n\n"
    + "  --socket PATH  Compositor socket (default: $PROSCENIUM_SOCKET)\n"
    + "  --once         Load WORLD once instead of reloading it on change\n"
    + "  --dev          Use React's development build for detailed errors, and\n"
    + "                 connect to React DevTools (`npx react-devtools`)");
  process.exit(values.help ? 0 : 2);
}

// React selects its build when first imported, so decide before loading it.
process.env.NODE_ENV ??= values.dev ? "development" : "production";
if (values.dev) await connectDevTools();
const { run } = await import("../dist/runtime.js");
await run({ entry: positionals[0], socket: values.socket, watch: !values.once });

/** Attach React DevTools' backend, which must load before React and expects a browser. */
async function connectDevTools() {
  globalThis.self ??= globalThis;
  globalThis.window ??= globalThis;
  try {
    const { default: devtools } = await import("react-devtools-core");
    devtools.initialize();
    devtools.connectToDevTools({ retryConnectionDelay: 1000 });
  } catch (error) {
    console.error(`[stage] React DevTools unavailable: ${error.message}`);
  }
}
