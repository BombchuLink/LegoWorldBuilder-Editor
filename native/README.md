# Native editor (in progress)

A native build of the level editor: the editor's own JavaScript, `wbcore.js` (game files,
levels, patches), `scene.js` (what the map looks like) and `edit.js` (the editing rules), runs in
[QuickJS](https://github.com/quickjs-ng/quickjs), a small embeddable JavaScript engine. A C++
front end with SDL3 and Dear ImGui draws it. The Electron/browser editor shares the same JS, so
both editors open, patch and save games identically and show the same map.

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
next to itself or up to three folders above it, so `build/worldbuilder-native` finds `editor/`. To
put the program anywhere else, copy `wbcore.js`, `scene.js`, `wb1monsters.js` and `native/js/`
beside it, keeping that layout, or point `WBE_EDITOR_DIR` at the editor folder. Copy
`native/fonts/` too for the editor's Fredoka font (else it uses DejaVu Sans).

### Windows

A 32-bit build for Windows 7 and later (it runs on 8, 10, 11 and under Wine too), cross-built on
Linux with MinGW-w64. SDL3 and zlib are built from source and everything is linked into the
program, so it needs no DLLs or runtime installers: it uses only Windows' own DLLs and its old
`msvcrt.dll`, and no Windows function newer than Windows 7.

    sudo apt install g++-mingw-w64-i686-posix      # Fedora: mingw32-gcc-c++, Arch: mingw-w64-gcc
    cmake -S . -B build-win -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_TOOLCHAIN_FILE=cmake/mingw-i686.cmake
    cmake --build build-win
    cmake --install build-win --prefix dist-win

`dist-win` then holds `worldbuilder-native.exe` (about 7 MB) with the JS and fonts beside it, ready
to zip. Try it with `wine dist-win/worldbuilder-native.exe`. On Windows the symbols Fredoka lacks
come from Segoe UI Symbol, and if the default Direct3D 11 renderer won't start (old drivers, virtual
machines, remote desktop) it falls back to Direct3D 9, OpenGL, then software drawing. File names
are UTF-8 throughout, so game folders with accented or other non-English names work.

Windows XP and Vista would need SDL2 instead of SDL3 (SDL3 starts at Windows 7).

## Running

    build/worldbuilder-native [Launcher.exe]

Everything the web editor has: the level list, the tools (Brush, Fill, Erase, Eyedropper, Select,
copy and paste, undo), the side panel's Palette, Tile, Level, Text and Game tabs, the problems
list, Edit game texts, Import .dcr and saving. The keys are the same (B F E I S, Ctrl+Z/Y/S/V,
Esc, Delete, L hides the level list, Space or right/middle drag pans, scroll zooms).

**Save Launcher.exe** writes over the open file (the first time keeping the original as
`Launcher.exe.orig`, as the desktop app does); **Save as…** picks another place. SDL's file dialog
can only start in a folder, not suggest a file name. Settings (grid, the last level, the patch
choices last saved) are kept in `~/.local/share/worldbuilder/editor/prefs.json`.

Environment variables:

| Variable | Effect |
|---|---|
| `WBE_RENDERER` | SDL renderer. The default (OpenGL here) measured best; `vulkan` busy-waits, and `opengles2`/`gpu` use about twice the memory. |
| `WBE_LEVEL=map2.8` | Opens that level first. |
| `WBE_ZOOM=1` | Fixed zoom instead of fitting. |
| `WBE_SWEEP=1` | Benchmark (see below). |
| `WBE_BENCH=<seconds>`, `WBE_SHOT=<file.bmp>` | Quit after that long, saving the last frame. |
| `WBE_DIALOG_ANSWER=<path>` | Answer every file dialog with that path (for tests). |

## Status

1. **Core: done.** `build/wbe-core <Launcher.exe> <resave|patch-on|patch-off|edit> [out.exe]`
   opens and saves a game the way the editor does (`js/driver.js`). `node test/compare.js <out dir>
   <Launcher.exe>...` runs the same steps in Node (V8, like Electron) and in QuickJS and checks the
   files they write are byte-identical. They are for both games, patched and unpatched, all four
   operations. `DETAIL=1` lists the slow steps.
2. **Map: done.** Level list, the map drawn from `scene.js`, pan, zoom, hover, grid and start view.
3. **Tools: done.** Their rules moved out of `app.js` into `edit.js`, which both editors use.
4. **Panels and saving: done.** The side panel is drawn by `js/editor.js` through a thin ImGui
   binding, styled after the web editor (its colours, rounded controls and the Fredoka font).

Not yet in the native map: the goal popup bubble.

## How it fits together

- `src/js_host.cpp`: QuickJS with what a browser would give `wbcore.js`: zlib (`WB_ZLIB`, which
  `wbcore.js` uses when present) and `TextEncoder`.
- `js/editor.js`: the native editor's JS side, its counterpart of `app.js`: the editor's state,
  the tools' mouse and key handling, undo, files and saving, and the panels. It hands the host the
  map (and what follows the mouse) as `scene.js` draw commands packed into a `Float64Array` and a
  string table, plus decoded sprites.
- `src/ui_bind.cpp`: the `UI` global (`UI.button`, `UI.combo`, `UI.swatch`…, a thin layer over
  Dear ImGui) that `editor.js` draws its panels with, and `NATIVE` (reading and saving files, file
  dialogs, preferences).
- `fonts/`: Fredoka Regular and SemiBold, as the web editor uses (SIL Open Font License, `OFL.txt`).
- `src/app.cpp`: the window. Sprites go into 1024×1024 atlas pages, so a map is a handful of draw
  calls. Frames are only drawn when something changes, so it uses no CPU when idle. It has its own
  copy of ImGui's SDL-renderer draw function: the stock one (1.92.9b) re-converts a draw list's whole
  vertex buffer for every draw call (3.6 ms a frame here, instead of 0.3), and forces smooth
  filtering, which blurred zoomed-in sprites.

## Benchmarks

Same machine (16 cores, RTX 5060), the same 860×1052 window, Launcher.exe with the map open. The
CPU tests are 240 frames each of hovering over tiles and of panning; CPU counts every process and
thread. Medians of 3 runs.

| World Builder 2 | Electron, before | Electron, now | Native |
|---|---|---|---|
| Memory (PSS) | 440 MB, 4 processes (+ ~85 MB launcher wrapper and sandbox helpers) | 267 MB, 2 processes (+ ~40 MB sandbox helpers) | **93 MB**, 1 process |
| Launch to map shown | 0.95 s | 0.64 s | 0.75 s |
| Hover, CPU per frame | 9.4 ms | 9.5 ms | **1.3 ms** |
| Pan, CPU per frame | 10.4 ms | 8.5 ms | **1.0 ms** |
| Pan frame rate | 60 fps | 144 fps | 60 fps (vsync) |
| CPU when idle | n/a | n/a | ~0 (6 ms in 4 s) |
| Size on disk | 288 MB (`node_modules`) | 288 MB | **2.3 MB** program + 0.7 MB JS |

World Builder 1: 413 MB → 235 MB (Electron) → 91 MB (native).

Measured from outside, including the sandbox helper processes and the npm launcher, Electron went
from 479 MB to 279 MB with the changes to `main.js` and `worldbuilder-editor`.
