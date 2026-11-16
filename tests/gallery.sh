#!/bin/sh
# Screenshot the UI gallery (examples/gallery.tsx) headless, and the browser reference
# (examples/gallery/reference.html) when Chromium is installed:
#
#   tests/gallery.sh OUTDIR
#
# Writes to OUTDIR, for each theme in THEMES (default "light dark") and each scale in
# SCALES (default "1"; the output is 1280x800 logical pixels, so 2560x1600 at 2):
#
#   gallery-THEME-Nx.png            the whole gallery, page 1 (the kit and older specimens)
#   gallery-THEME-Nx-p2.png         page 2 (boxes, shadows, gradients, text, states, scrollers)
#   gallery-THEME-Nx-NAME.png       after the drive script tests/gallery/NAME.drive: page 1 has
#                                   hover, press, scroll, type, slider; page 2 (a drive script
#                                   says "# page: 2") has states-hover, states-group, states-press, focus-tab,
#                                   focus-click, scroller, scroller-x. ONLY="hover scroller"
#                                   picks some, ONLY=none skips them
#   reference-THEME-Nx[-p2].png     the same in a browser, if Chromium is found
#   logs/gallery-THEME-Nx[-NAME].log  the compositor's log of each run (grep it for "check:",
#                                   which PROSCENIUM_CHECK=1 turns on: damage mismatches)
#
# GALLERY_SECTION=id (see examples/gallery/sections.tsx) shows one section enlarged. Pointer
# positions for the drive scripts are in tests/gallery/coords.env. Needs GPU device access.
set -u
root=$(cd "$(dirname "$0")/.." && pwd)
[ $# -ge 1 ] || { sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
out=$(mkdir -p "$1/logs" && realpath "$1")
themes=${THEMES:-"light dark"}
scales=${SCALES:-1}
drives=${ONLY:-"hover press scroll type slider states-hover states-group states-press focus-tab focus-click scroller scroller-x menu-open menu-keys ctx-menu ctx-corner select-open tooltip dialog focus-button focus-checkbox focus-switch focus-slider focus-segmented slider-keys field-type field-word field-menu field-select field-long field-mixed"}
[ "$drives" = none ] && drives=
. "$root/tests/gallery/coords.env"
work=$(mktemp -d /tmp/gallery-XXXXXX)
trap 'rm -rf "$work"' EXIT
written=

for scale in $scales; do
  # Fractional scales too: 1.5 gives 1920x1200.
  size=$(awk -v s="$scale" 'BEGIN { printf "%dx%d", 1280 * s + 0.5, 800 * s + 0.5 }')
  # Scale 1 passes no --scale, so this works with a compositor that lacks the flag.
  if [ "$scale" = 1 ]; then unset SCALE; else export SCALE=$scale; fi
  for theme in $themes; do
    export GALLERY_THEME=$theme
    tag="$theme-${scale}x"

    for page in 1 2 3; do
      suffix=; [ "$page" != 1 ] && suffix=-p$page
      GALLERY_PAGE=$page SIZE=$size SHOT_AT=2500 "$root/tests/shot.sh" "$root/examples/gallery.tsx" "$work/still" > "$work/still.out" 2>&1
      if [ -f "$work/still/shot-2500.png" ]; then
        mv "$work/still/shot-2500.png" "$out/gallery-$tag$suffix.png"; written="$written $out/gallery-$tag$suffix.png"
      else
        echo "no still for $tag page $page (see $work/still/log)"; cat "$work/still.out"
      fi
      cp "$work/still/log" "$out/logs/gallery-$tag$suffix.log" 2>/dev/null
      rm -rf "$work/still"
    done

    for name in $drives; do
      file="$root/tests/gallery/$name.drive"
      [ -f "$file" ] || { echo "no drive script $file"; continue; }
      # The script's variables come from coords.env; "# shot-at: MS" says when to shoot.
      eval "cat <<EOT
$(cat "$file")
EOT
" > "$work/$name.drive"
      at=$(sed -n 's/^# shot-at: *//p' "$file" | head -1)
      page=$(sed -n 's/^# page: *//p' "$file" | head -1)
      rm -rf "$work/$name"
      GALLERY_PAGE=${page:-1} SIZE=$size SHOT_AT=${at:-3000} "$root/tests/shot.sh" "$root/examples/gallery.tsx" "$work/$name" "$work/$name.drive" > "$work/$name.out" 2>&1
      if [ -f "$work/$name/shot-${at:-3000}.png" ]; then
        mv "$work/$name/shot-${at:-3000}.png" "$out/gallery-$tag-$name.png"; written="$written $out/gallery-$tag-$name.png"
      else
        echo "no shot for $tag $name"; cat "$work/$name.out"
      fi
      cp "$work/$name/log" "$out/logs/gallery-$tag-$name.log" 2>/dev/null
    done
  done
done

# The browser reference. A snap-packaged Chromium can only write under the home directory, so
# it shoots into the repository's (ignored) build directory first.
chrome=
for name in google-chrome chromium chromium-browser; do
  command -v "$name" > /dev/null 2>&1 && { chrome=$name; break; }
done
if [ -n "$chrome" ]; then
  shots="$root/build/gallery-reference"
  mkdir -p "$shots"
  for scale in $scales; do
    for theme in $themes; do
     for page in 1 2 3; do
      tag="$theme-${scale}x"; [ "$page" != 1 ] && tag="$tag-p$page"
      timeout 60 "$chrome" --headless=new --no-sandbox --disable-gpu --hide-scrollbars --disable-lcd-text \
          --force-device-scale-factor="$scale" --window-size=1280,800 --virtual-time-budget=3000 \
          --screenshot="$shots/reference-$tag.png" "file://$root/examples/gallery/reference.html?theme=$theme&page=$page" > /dev/null 2>&1
      if [ -f "$shots/reference-$tag.png" ]; then
        mv "$shots/reference-$tag.png" "$out/reference-$tag.png"; written="$written $out/reference-$tag.png"
      else
        echo "reference shot failed for $tag"
      fi
     done
    done
  done
else
  echo "no Chrome or Chromium found: skipping the browser reference"
fi

echo "wrote:"
for file in $written; do echo "  $file"; done
