/** Stops the compositor the way its session manager would, which ends the session. */
export function quit(): void {
  const parent = Number(process.env.PROSCENIUM_PARENT) || process.ppid;
  process.kill(parent, "SIGTERM");
}
