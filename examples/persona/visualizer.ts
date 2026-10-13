// The audio spectrum the wallpaper draws as hills behind the train's windows,
// from cava (github.com/karlstav/cava) when it is installed, as the original's
// cava plugin did. It runs only while something reads it.

import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useSyncExternalStore } from "react";
import { follow, Source } from "../lib/system/source.js";

const config = `[general]
bars = 50
framerate = 60
sleep_timer = 1
[output]
method = raw
raw_target = /dev/stdout
data_format = ascii
ascii_max_range = 1000
bar_delimiter = 59
frame_delimiter = 10
`;

/** Bar heights in 0..1, or null without cava. */
const spectrum = new Source<number[] | null>(null, (source) => {
  const path = join(tmpdir(), `proscenium-cava-${process.pid}.conf`);
  writeFileSync(path, config);
  const stop = follow("cava", ["-p", path], (line) => {
    const bars = line.split(";").filter(Boolean).map((value) => Number(value) / 1000);
    if (bars.length > 1) source.set(bars);
  }, () => source.set(null));
  return () => {
    stop();
    rmSync(path, { force: true });
    source.set(null);
  };
});

const idle = () => () => undefined;
const none = () => null;

/** The spectrum while ACTIVE, else null. */
export function useSpectrum(active: boolean): number[] | null {
  return useSyncExternalStore(active ? spectrum.subscribe : idle, active ? spectrum.read : none);
}
