#!/usr/bin/env bash
# Build the release archives in dist/ (or the folder given):
#   WorldBuilderEditor-<version>-windows.zip       32-bit, Windows 7 and later, no DLLs
#   WorldBuilderEditor-<version>-linux-x86_64.tar.gz  self-contained, glibc 2.35 and later
# Needs what README.md lists for both builds (MinGW-w64 for Windows) and python3.
set -euo pipefail
cd "$(dirname "$0")"
here=$PWD
ver=$(sed -n 's/^project(worldbuilder_editor VERSION \([0-9]*\.[0-9]*\).*/\1/p' CMakeLists.txt)
out=$(realpath -m "${1:-dist}")
mkdir -p "$out"
echo "== WorldBuilder Level Editor $ver -> $out"

cmake -S . -B build-linux -G Ninja -DCMAKE_BUILD_TYPE=Release -DWBE_BUNDLED_DEPS=ON -DWBE_GLIBC_COMPAT=ON >/dev/null
cmake --build build-linux
cmake -S . -B build-win -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_TOOLCHAIN_FILE=cmake/mingw-i686.cmake >/dev/null
cmake --build build-win

# ---- checks: what the programs need from the systems they run on
glibc=$(objdump -T build-linux/worldbuilder-editor | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1)
libs=$(objdump -p build-linux/worldbuilder-editor | awk '/NEEDED/{print $2}' | sort | tr '\n' ' ')
echo "Linux: needs $glibc; links $libs"
[ "$(printf '%s\n' "$glibc" GLIBC_2.35 | sort -V | tail -1)" = GLIBC_2.35 ] || { echo "Linux build needs a newer glibc than 2.35" >&2; exit 1; }
for l in $libs; do case $l in libc.so.6|libm.so.6|ld-linux-x86-64.so.2) ;; *) echo "Linux build links $l" >&2; exit 1 ;; esac; done
dlls=$(i686-w64-mingw32-objdump -p build-win/WorldBuilderEditor.exe | awk '/DLL Name/{print toupper($3)}' | sort | tr '\n' ' ')
echo "Windows: imports $dlls"
for d in $dlls; do
  case $d in ADVAPI32.DLL|GDI32.DLL|IMM32.DLL|KERNEL32.DLL|MSVCRT.DLL|OLE32.DLL|OLEAUT32.DLL|SETUPAPI.DLL|SHELL32.DLL|USER32.DLL|VERSION.DLL|WINMM.DLL) ;;
    *) echo "Windows build imports $d, which isn't part of Windows 7" >&2; exit 1 ;; esac
done

# ---- the folders
licenses() {  # <dir> <build dir>
  local d="$1/licenses" b="$2/_deps"
  mkdir -p "$d"
  cp "$b/sdl3-src/LICENSE.txt" "$d/SDL3.txt"
  cp "$b/imgui-src/LICENSE.txt" "$d/Dear ImGui.txt"
  cp "$b/quickjs-src/LICENSE" "$d/QuickJS-ng.txt"
  cp "$b/zlib-src/LICENSE" "$d/zlib.txt"
  cp fonts/OFL.txt "$d/Fredoka (SIL Open Font License).txt"
  cp LICENSE "$1/LICENSE.txt"  # the editor's own (MIT-0)
}
stage() {  # <name> <build dir>
  local d="$out/$1"
  rm -rf "$d"
  cmake --install "$2" --prefix "$d" >/dev/null
  sed "s/@VERSION@/$ver/" release/README.txt > "$d/README.txt"
  cp res/icon-256.png "$d/data/icon.png"
  licenses "$d" "$2"
}

lin="WorldBuilderEditor-$ver-linux-x86_64"
stage "$lin" build-linux
cp release/install.sh "$out/$lin/"

win="WorldBuilderEditor-$ver-windows"
stage "$win" build-win
cp "release/WorldBuilderEditor-software.bat" "$out/$win/"
cp /usr/share/doc/mingw-w64-common/copyright "$out/$win/licenses/MinGW-w64 runtime.txt"
# Windows readers expect CRLF line ends in text files
find "$out/$win" -name '*.txt' -exec sed -i 's/\r\{0,1\}$/\r/' {} +

# ---- the archives
rm -f "$out/$lin.tar.gz" "$out/$win.zip"
tar -C "$out" --owner=0 --group=0 -czf "$out/$lin.tar.gz" "$lin"
python3 - "$out" "$win" <<'PY'
import os, sys, zipfile
out, name = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(os.path.join(out, name + ".zip"), "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for root, _, files in os.walk(os.path.join(out, name)):
        for f in sorted(files):
            p = os.path.join(root, f)
            z.write(p, os.path.relpath(p, out))
PY
(cd "$out" && sha256sum "$lin.tar.gz" "$win.zip" > "SHA256SUMS-$ver.txt")
ls -la "$out"
