# Native editor (in progress)

A native build of the level editor: the editor's own JavaScript, `wbcore.js` (game files,
levels, patches) and `scene.js` (what the map looks like), runs in
[QuickJS](https://github.com/quickjs-ng/quickjs), a small embeddable JavaScript engine. A C++
front end with SDL3 and Dear ImGui draws it. The Electron/browser editor shares the same JS, so
both editors open, patch and save games identically and show the same map.

## Building

You need:

| | Debian/Ubuntu | Arch | Fedora |
|---|---|---|---|
| C++20 compiler, CMake ≥ 3.20, Ninja, git | `build-essential cmake ninja-build git` | `base-devel cmake ninja git` | `gcc-c++ cmake ninja-build git` |
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
beside it, keeping that layout, or point `WBE_EDITOR_DIR` at the editor folder.

## Running

    build/worldbuilder-native [Launcher.exe]

- Pick a level on the left.
- Scroll to zoom at the mouse. Right or middle drag, or Space + left drag, pans.
- **Fit** fits the map to the window; the % button goes to 100%.
- **Grid** and **Start view** toggle the tile outlines and the game's first view.
- Hovering a tile shows what's there in the status bar.

Environment variables:

| Variable | Effect |
|---|---|
| `WBE_RENDERER` | SDL renderer. The default (OpenGL here) measured best; `vulkan` busy-waits, and `opengles2`/`gpu` use about twice the memory. |
| `WBE_LEVEL=map2.8` | Opens that level first. |
| `WBE_ZOOM=1` | Fixed zoom instead of fitting. |
| `WBE_SWEEP=1` | Benchmark (see below). |
| `WBE_BENCH=<seconds>`, `WBE_SHOT=<file.bmp>` | Quit after that long, saving the last frame. |

## Status

1. **Core: done.** `build/wbe-core <Launcher.exe> <resave|patch-on|patch-off|edit> [out.exe]`
   opens and saves a game the way the editor does (`js/driver.js`). `node test/compare.js <out dir>
   <Launcher.exe>...` runs the same steps in Node (V8, like Electron) and in QuickJS and checks the
   files they write are byte-identical. They are for both games, patched and unpatched, all four
   operations. `DETAIL=1` lists the slow steps.
2. **Map: done.** Level list, the map drawn from `scene.js`, pan, zoom, hover, grid and start view.
   It's a viewer so far: no editing.
3. Next: tools (brush, fill, erase, eyedropper, select, copy/paste, undo). Their rules live in
   `app.js` mixed with the page code, so like the map drawing they should move into shared JS first.
4. Then: the side panels (palette, Tile, Level, Text, Game), the patches tab and saving (the core
   for that is done and tested).

Not yet in the native map: the goal popup bubble, and the faded preview while dragging an object
(that's editing). Labels use DejaVu Sans Bold where the web editor uses Fredoka.

## How it fits together

- `src/js_host.cpp`: QuickJS with what a browser would give `wbcore.js`: zlib (`WB_ZLIB`, which
  `wbcore.js` uses when present) and `TextEncoder`.
- `js/editor.js`: the native editor's JS side. It opens a game, works out the patch state as the
  editor does, and returns a level's map as `scene.js` draw commands packed into a `Float64Array`
  and a string table, plus decoded sprites.
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
