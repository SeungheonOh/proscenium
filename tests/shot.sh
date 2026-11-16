#!/bin/sh
# Run a world headless and save screenshots of its first output as PNGs:
#
#   tests/shot.sh WORLD.tsx OUTDIR [DRIVE]
#
# Env: SIZE=1280x720, SCALE=1 (the output's scale), SHOT_AT="1500" (milliseconds
# after the world mounts, space separated: one PNG each, OUTDIR/shot-<ms>.png),
# RUN_FOR=seconds (default: the last shot plus two). DRIVE holds proscenium-drive
# commands (tests/drive.c) played while the world runs, so a shot can show a
# hover, a press or a scroll. The compositor's log lands in OUTDIR/log.
#
# build/env.sh, when there is one, is sourced first: it names the toolchain and
# the GL driver on machines where the compositor is built outside its dev shell.
set -u
root=$(cd "$(dirname "$0")/.." && pwd)
[ -f "$root/build/env.sh" ] && . "$root/build/env.sh"
world=$(realpath "$1")
out=$(mkdir -p "$2" && realpath "$2")
drive=${3:+$(realpath "$3")}
size=${SIZE:-1280x720}
shots=${SHOT_AT:-1500}
last=0
for at in $shots; do [ "$at" -gt "$last" ] && last=$at; done
seconds=${RUN_FOR:-$((last / 1000 + 3))}

# Unix socket paths are short, so the scratch directory lives right under /tmp.
scratch=$(mktemp -d /tmp/prosc-XXXXXX)
mkdir -p "$scratch/run" "$scratch/state" "$scratch/config"
chmod 700 "$scratch/run"
cat > "$scratch/world.tsx" <<EOF
import { useEffect } from "react";
import { writeFileSync } from "node:fs";
import { encodePng, screenshot } from "proscenium";
import World from "$world";

function Shots() {
  useEffect(() => {
    const timers = "$shots".split(" ").filter(Boolean).map((at) => setTimeout(async () => {
      try {
        writeFileSync("$out/shot-" + at + ".png", await encodePng(await screenshot()));
        console.error("shot " + at);
      } catch (error) {
        console.error("shot " + at + " failed: " + error);
      }
    }, Number(at)));
    return () => timers.forEach(clearTimeout);
  }, []);
  return null;
}

export default function Shot() {
  return <><World /><Shots /></>;
}
EOF

export XDG_RUNTIME_DIR="$scratch/run" XDG_STATE_HOME="$scratch/state" XDG_CONFIG_HOME="$scratch/config"
unset DISPLAY WAYLAND_DISPLAY
"$root/build/meson/proscenium" --headless --size "$size" ${SCALE:+--scale "$SCALE"} --no-xwayland \
    --run-for "$seconds" --once --script "$scratch/world.tsx" > "$out/log" 2>&1 &
compositor=$!
if [ -n "$drive" ]; then
    for _ in $(seq 50); do [ -S "$scratch/run/wayland-0" ] && break; sleep 0.1; done
    sleep 1
    WAYLAND_DISPLAY=wayland-0 "$root/build/meson/proscenium-drive" < "$drive"
fi
wait $compositor
status=$?
grep -E "shot |\[ERROR\]|rejected|Error" "$out/log" | grep -v "renderD129" | head -20
rm -rf "$scratch"
exit $status
