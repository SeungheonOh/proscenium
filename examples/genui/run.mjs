#!/usr/bin/env node
// Runs a TypeScript program of the generated UI examples, such as the assistant,
// a demo or an app: `node examples/genui/run.mjs FILE.ts [ARGS…]`. It bundles
// FILE with the SDK's esbuild into .build/ beside this file, leaving npm packages
// to load from examples/node_modules, and runs it with ARGS as its own. FILE may
// be anywhere (an app in the person's apps folder): "proscenium-app" is the app
// library beside this file.

import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2];
if (!file) {
  console.error("Usage: run.mjs FILE.ts [ARGS…]");
  process.exit(2);
}
const { default: esbuild } = await import(pathToFileURL(join(here, "../../sdk/node_modules/esbuild/lib/main.js")).href);
const entry = resolve(file);
const out = join(here, ".build", `${basename(entry, extname(entry))}-${process.pid}.mjs`);
mkdirSync(dirname(out), { recursive: true });
// Bundles of programs that are gone, killed before they could remove their own.
for (const name of readdirSync(dirname(out))) {
  const pid = Number(/-(\d+)\.mjs$/.exec(name)?.[1]);
  if (!pid || pid === process.pid) continue;
  try {
    process.kill(pid, 0);
  } catch {
    rmSync(join(dirname(out), name), { force: true });
  }
}
await esbuild.build({
  entryPoints: [entry], outfile: out, bundle: true, platform: "node", format: "esm", target: "node22",
  packages: "external", sourcemap: "inline", logLevel: "warning",
  plugins: [{
    name: "proscenium-app",
    setup(build) {
      build.onResolve({ filter: /^proscenium-app$/ }, () => ({ path: join(here, "app.ts") }));
    },
  }],
});
await esbuild.stop();
process.on("exit", () => rmSync(out, { force: true }));
// Killed politely, the program still cleans up after itself.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => process.exit(128 + ({ SIGTERM: 15, SIGINT: 2, SIGHUP: 1 })[signal]));
}
// Errors name the lines of FILE, not of its bundle.
process.setSourceMapsEnabled(true);
// The program sees its own arguments where a script's are.
process.argv.splice(1, 1);
// A program that fails as it starts ends, even one that keeps itself running past
// later errors (an app does): whoever started it hears that it failed.
try {
  await import(pathToFileURL(out).href);
} catch (error) {
  console.error(error);
  process.exit(1);
}
