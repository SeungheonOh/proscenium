// esbuild for the runtime's bundles, running only while something builds.
// Its service process keeps waking up even when idle, so a director that is
// not rebuilding anything stops it and starts a fresh one on the next edit.

import * as esbuild from "esbuild";

let active = 0;
let idle: NodeJS.Timeout | null = null;

/** Build with OPTIONS, rejecting with esbuild's failure like esbuild.build. */
export async function bundle(options: esbuild.BuildOptions): Promise<esbuild.BuildResult> {
  active++;
  if (idle) clearTimeout(idle);
  idle = null;
  try {
    return await esbuild.build(options);
  } finally {
    // A burst of edits shares one service; it stops a moment after the last build.
    if (--active === 0) idle = setTimeout(() => { idle = null; void esbuild.stop(); }, 1000);
  }
}

/** Readable text for a failed bundle(). */
export async function describeFailure(error: unknown): Promise<string> {
  const errors = (error as esbuild.BuildFailure).errors;
  return errors ? (await esbuild.formatMessages(errors, { kind: "error" })).join("") : String(error);
}

export async function stopBuilds(): Promise<void> {
  if (idle) clearTimeout(idle);
  idle = null;
  await esbuild.stop();
}
