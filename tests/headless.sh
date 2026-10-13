#!/bin/sh
# Run a world headless and drive it, comparing every frame with a full redraw:
#
#   tests/headless.sh WORLD.tsx DRIVE [SECONDS]
#
# DRIVE holds proscenium-drive commands (tests/drive.c). The session gets its
# own runtime, state and config directories and a private session bus, so its
# clients and the services they activate never reach the desktop it runs in.
# Screenshots land in the scratch directory, which the log line at the end names.
# Env: OUTPUTS=N for more outputs, XWAYLAND=1 to start X11 support.
set -u
root=$(cd "$(dirname "$0")/.." && pwd)
if [ -z "${PROSCENIUM_TEST_SCRATCH:-}" ]; then
    # Unix socket paths are short, so the scratch directory lives right under /tmp.
    scratch=$(mktemp -d /tmp/prosc-XXXXXX)
    mkdir -p "$scratch/run" "$scratch/state" "$scratch/config" "$scratch/pictures"
    chmod 700 "$scratch/run"
    export PROSCENIUM_TEST_SCRATCH="$scratch" XDG_RUNTIME_DIR="$scratch/run" XDG_STATE_HOME="$scratch/state"
    export XDG_CONFIG_HOME="$scratch/config" XDG_PICTURES_DIR="$scratch/pictures" WAYLAND_DISPLAY=wayland-0
    # Test pages run without Chromium's sandbox, which needs scripts/install-web-sandbox.
    printf '#!/bin/sh\nexec "%s" "$@" --no-sandbox\n' "$root/build/meson/web/proscenium-web-helper" > "$scratch/web-helper"
    chmod +x "$scratch/web-helper"
    export PROSCENIUM_WEB_HELPER="$scratch/web-helper"
    unset DISPLAY DBUS_SESSION_BUS_ADDRESS
    exec dbus-run-session -- "$0" "$@"
fi
scratch=$PROSCENIUM_TEST_SCRATCH
world=$(realpath "$1") drive=$(realpath "$2") seconds=${3:-30}
xwayland=--no-xwayland
[ "${XWAYLAND:-0}" = 1 ] && xwayland=
PROSCENIUM_CHECK=1 "$root/build/meson/proscenium" --headless --outputs "${OUTPUTS:-1}" $xwayland \
    --run-for "$seconds" --script "$world" > "$scratch/log" 2>&1 &
compositor=$!
for _ in $(seq 50); do [ -S "$scratch/run/wayland-0" ] && break; sleep 0.1; done
sleep 1.5
display=$(sed -n 's/.* DISPLAY=\(:[0-9]*\).*/\1/p' "$scratch/log" | head -1)
[ -n "$display" ] && export DISPLAY="$display"
"$root/build/meson/proscenium-drive" < "$drive"
status=$?
wait $compositor
status=$((status | $?))
grep "check:" "$scratch/log"
echo "log and screenshots: $scratch"
exit $status
