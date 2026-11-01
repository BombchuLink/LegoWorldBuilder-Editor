# The editor program

The editor's JavaScript, `wbcore.js` (game files, levels, patches), `scene.js` (what the map looks
like), `edit.js` (the editing rules) and `js/editor.js` (the editor's state, tools and panels),
runs in [QuickJS](https://github.com/quickjs-ng/quickjs), a small embeddable JavaScript engine. A
C++ front end with SDL3 and Dear ImGui draws it.

## Building

You need:

| | Debian/Ubuntu | Arch | Fedora |
|---|---|---|---|
| C++20 compiler, CMake ≥ 3.28, Ninja, git | `build-essential cmake ninja-build git` | `base-devel cmake ninja git` | `gcc-c++ cmake ninja-build git` |
| SDL3 ≥ 3.2 (development files) | `libsdl3-dev` | `sdl3` | `SDL3-devel` |
| zlib (development files) | `zlib1g-dev` | `zlib` | `zlib-devel` |
| A font (optional; else ImGui's built-in one) | `fonts-dejavu-core` | `ttf-dejavu` | `dejavu-sans-fonts` |

The first configure downloads QuickJS-ng v0.17.0 and Dear ImGui v1.92.9b, so it needs internet
access.

    cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
    cmake --build build

Running the program needs only SDL3, zlib and the standard C++ library (plus whatever SDL3 itself
links, such as X11/Wayland and audio libraries), and the editor's JS files. The program finds those
in a `data` folder beside itself (as a release has them), or next to itself or up to three folders
above it, so `build/worldbuilder-editor` finds `editor/`. `WBE_EDITOR_DIR` points it somewhere
else. `cmake --install build --prefix <dir>` lays out a folder that runs anywhere.

### Release archives

    ./release.sh [dist]

builds both of the below and packs them, with the readme (`release/README.txt`), the licences of
everything linked in and the icon, as `WorldBuilderEditor-<version>-linux-x86_64.tar.gz` and
`WorldBuilderEditor-<version>-windows.zip`, checking on the way that the Linux program needs no
newer glibc than 2.35 and no libraries but libc and libm, and that the Windows one only uses DLLs
Windows 7 has. The version comes from `project()` in `CMakeLists.txt`.

### Linux, self-contained

    cmake -S . -B build-linux -G Ninja -DCMAKE_BUILD_TYPE=Release -DWBE_BUNDLED_DEPS=ON -DWBE_GLIBC_COMPAT=ON
    cmake --build build-linux

SDL3 (3.2.10) and zlib are built from source and linked in, with the C++ runtime, so it runs on
systems without SDL3 packages. SDL still loads X11 or Wayland, and the sound and graphics libraries,
from the system when it starts; building it needs their development files (on Debian:
`libx11-dev libxext-dev libxrandr-dev libxcursor-dev libxi-dev libxss-dev libxtst-dev
libxkbcommon-dev libwayland-dev wayland-protocols libdecor-0-dev libegl-dev libgl-dev libdrm-dev
libgbm-dev libasound2-dev libpulse-dev libpipewire-0.3-dev libdbus-1-dev libudev-dev
libibus-1.0-dev`). `WBE_GLIBC_COMPAT` (`src/compat/`) keeps a program built on a new system
to glibc 2.35: it supplies the few functions newer glibcs added that the libraries pick up.

### Windows

A 32-bit build for Windows 7 and later (it runs on 8, 10, 11 and under Wine too), cross-built on
Linux with MinGW-w64. SDL3 and zlib are built from source and everything is linked into the
program, so it needs no DLLs or runtime installers: it uses only Windows' own DLLs and its old
`msvcrt.dll`, and no Windows function newer than Windows 7.

    sudo apt install g++-mingw-w64-i686-posix      # Fedora: mingw32-gcc-c++, Arch: mingw-w64-gcc
    cmake -S . -B build-win -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_TOOLCHAIN_FILE=cmake/mingw-i686.cmake
    cmake --build build-win
    cmake --install build-win --prefix dist-win

`dist-win` then holds `WorldBuilderEditor.exe` (about 7 MB, with its icon and version information)
and the `data` folder. Try it with `wine dist-win/WorldBuilderEditor.exe`. On Windows the symbols Fredoka lacks
come from Segoe UI Symbol, and if the default Direct3D 11 renderer won't start (old drivers, virtual
machines, remote desktop) it falls back to Direct3D 9, OpenGL, then software drawing. File names
are UTF-8 throughout, so game folders with accented or other non-English names work.

Windows XP and Vista would need SDL2 instead of SDL3 (SDL3 starts at Windows 7).

## Running

    build/worldbuilder-editor [Launcher.exe]

`release/README.txt` is the user's guide (tools, keys, saving, patches).

**Save Launcher.exe** writes over the open file (the first time keeping the original as
`Launcher.exe.orig`); **Save as…** picks another place. SDL's file dialog can only start in a
folder, not suggest a file name. Settings (grid, the last level, the patch choices last saved) are
kept in `prefs.json` in SDL's preference folder (`~/.local/share/worldbuilder/editor/`,
`%APPDATA%\worldbuilder\editor\`). The UI follows the display's scale.

Environment variables:

| Variable | Effect |
|---|---|
| `WBE_RENDERER` | SDL renderer (`software`, `opengl`, `direct3d11`, `direct3d`…). The default (OpenGL on Linux) measured best; `vulkan` busy-waits, and `opengles2`/`gpu` use about twice the memory. If the chosen or default one fails, it tries Direct3D 11, Direct3D 9, OpenGL, then software. |
| `WBE_LEVEL=map2.8` | Opens that level first. |
| `WBE_ZOOM=1` | Fixed zoom instead of fitting. |
| `WBE_SWEEP=1` | Benchmark (see below). |
| `WBE_BENCH=<seconds>`, `WBE_SHOT=<file.bmp>` | Quit after that long, saving the last frame. |
| `WBE_DIALOG_ANSWER=<path>` | Answer every file dialog with that path (for tests). |

## Testing

- `build/wbe-core <Launcher.exe> <resave|patch-on|patch-off|edit> [out.exe]` opens and saves a
  game the way the editor does (`js/driver.js`). `node test/compare.js <out dir> <Launcher.exe>...`
  runs the same steps in Node (V8) and in QuickJS and checks the files they write are
  byte-identical, for both games, patched and unpatched (`WBE_CORE=build-linux/wbe-core` checks a
  release build). `DETAIL=1` lists the slow steps.
- `WBE_SWEEP=1` (below) measures memory and CPU.
- The GUI can be driven with `xdotool`; `WBE_DIALOG_ANSWER` stands in for the file dialogs.

## How it fits together

- `src/js_host.cpp`: QuickJS with what a browser would give `wbcore.js`: zlib (`WB_ZLIB`, which
  `wbcore.js` uses when present) and `TextEncoder`; UTF-8 file paths on every system.
- `js/editor.js`: the editor's state,
  the tools' mouse and key handling, undo, files and saving, and the panels. It hands the host the
  map (and what follows the mouse) as `scene.js` draw commands packed into a `Float64Array` and a
  string table, plus decoded sprites.
- `src/ui_bind.cpp`: the `UI` global (`UI.button`, `UI.combo`, `UI.swatch`…, a thin layer over
  Dear ImGui) that `editor.js` draws its panels with, and `NATIVE` (reading and saving files, file
  dialogs, preferences).
- `fonts/`: Fredoka Regular and SemiBold (SIL Open Font License, `OFL.txt`).
- `res/`: the icon (`icon.svg`, and the files `make_icons.sh` makes from it) and the Windows
  version information.
- `src/app.cpp`: the window. Sprites go into 1024×1024 atlas pages, so a map is a handful of draw
  calls. Frames are only drawn when something changes, so it uses no CPU when idle. It has its own
  copy of ImGui's SDL-renderer draw function: the stock one (1.92.9b) re-converts a draw list's whole
  vertex buffer for every draw call (3.6 ms a frame here, instead of 0.3), and forces smooth
  filtering, which blurred zoomed-in sprites.

## Benchmarks

Same machine (16 cores, RTX 5060), Launcher.exe with the map open. The CPU tests are 240 frames
each of hovering over tiles and of panning; CPU counts every process and thread. The first three
columns are medians of 3 runs in an 860×1052 window, from before 1.1's side panel existed; the last
is one run of the finished editor (the window size wasn't pinned).

| World Builder 2 | 1.0 Electron | 1.0 Electron, slimmed | Native, map only | **1.1** |
|---|---|---|---|
| Memory (PSS) | 440 MB, 4 processes (+ ~85 MB helpers) | 267 MB, 2 processes (+ ~40 MB helpers) | 93 MB | **72 MB**, 1 process |
| Launch to map shown | 0.95 s | 0.64 s | 0.75 s | 0.79 s |
| Hover, CPU per frame | 9.4 ms | 9.5 ms | 1.3 ms | **2.45 ms** (the side panel is drawn every frame) |
| Pan, CPU per frame | 10.4 ms | 8.5 ms | 1.0 ms | **2.45 ms** |
| CPU when idle | n/a | n/a | ~0 | ~0 (6 ms in 4 s) |
| Size | 288 MB (`node_modules`) | 288 MB | 2.3 MB + 0.7 MB JS | 3.5 MB download (7 MB program, everything linked in) |
