#!/usr/bin/env bash
# Make one candidate the app icon everywhere: the PWA icons under app/icons
# and the desktop icon set under src-tauri/icons. Every icon file in the
# repo is output of this script; edit the SVG here, never the PNGs.
#
#   design/icons/build.sh caret        # or whirl, whirl-orange, loop
#
# Needs rsvg-convert (librsvg) and the Tauri CLI (cargo tauri). A commit of
# the result reaches the desktop shells through the next CI build and the
# updater, and the phone through the PWA manifest on its next install.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
name=${1:?usage: build.sh <candidate name, one of the SVGs in design/icons>}
src="$here/$name.svg"
[ -f "$src" ] || { echo "no such candidate: $src" >&2; exit 2; }

# The source the docs point at (architecture.md: app/icons/icon.svg).
cp "$src" "$root/app/icons/icon.svg"

# PWA icons. The rounded tile keeps transparent corners; the maskable one is
# full bleed with the glyph scaled into the safe zone (the inner 80 %), as
# the OS masks it to its own shape.
rsvg-convert -w 192 -h 192 "$src" > "$root/app/icons/icon-192.png"
rsvg-convert -w 512 -h 512 "$src" > "$root/app/icons/icon-512.png"
python3 - "$src" <<'EOF' | rsvg-convert -w 512 -h 512 > "$root/app/icons/icon-512-maskable.png"
import re, sys
svg = open(sys.argv[1], encoding="utf-8").read()
svg = re.sub(r'<rect id="tile"[^>]*/>',
             '<rect id="tile" x="0" y="0" width="512" height="512" fill="url(#bg)"/>', svg)
svg = re.sub(r'\s*<rect id="rim"[^>]*/>', '', svg)
svg = svg.replace('<g id="glyph">',
                  '<g id="glyph" transform="translate(256 256) scale(0.8) translate(-256 -256)">')
sys.stdout.write(svg)
EOF

# Desktop set: ico, icns and the PNG ladder. The CLI also writes Android
# and iOS sets, which the shell does not target.
(
  cd "$root/src-tauri"
  cargo tauri icon "$src" >/dev/null
  rm -rf icons/android icons/ios
)

echo "icon set built from $name"
