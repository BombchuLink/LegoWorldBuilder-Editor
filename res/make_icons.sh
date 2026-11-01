#!/bin/sh
# Rebuild the icons from icon.svg (needs ImageMagick with SVG support, and python3)
set -e
cd "$(dirname "$0")"
t=$(mktemp -d)
convert -background none -density 384 icon.svg -resize 256x256 -depth 8 icon-256.png
for s in 16 24 32 48 64 128; do convert icon-256.png -resize ${s}x${s} -depth 8 "$t/$s.png"; done
convert "$t/16.png" "$t/24.png" "$t/32.png" "$t/48.png" "$t/64.png" "$t/128.png" icon-256.png icon.ico
convert icon-256.png -resize 64x64 -depth 8 "rgba:$t/64.rgba"
convert icon-256.png -resize 128x128 -depth 8 "rgba:$t/128.rgba"
python3 - "$t" <<'PY'
import sys
def arr(name, size):
    d = open(f"{sys.argv[1]}/{size}.rgba", "rb").read()
    rows = [", ".join(str(b) for b in d[i:i + 32]) for i in range(0, len(d), 32)]
    return f"static const unsigned char {name}[{size} * {size} * 4] = {{\n" + ",\n".join(rows) + "};\n"
open("icon_rgba.h", "w").write("// res/icon-256.png as RGBA (made by res/make_icons.sh): 64x64 for the window icon, 128x128 for the welcome screen\n#pragma once\n"
                               + arr("kIconRgba", 64) + arr("kIconRgba128", 128))
PY
rm -r "$t"
