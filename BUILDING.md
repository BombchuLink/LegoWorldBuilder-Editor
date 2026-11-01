# Building the editor

The editor's JavaScript in `js/`, `wbcore.js` (game files, levels, patches), `scene.js` (what the
map looks like), `edit.js` (the editing rules) and `editor.js` (the editor's state, tools and
panels), runs in [QuickJS](https://github.com/quickjs-ng/quickjs), a small embeddable JavaScript engine. A
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
