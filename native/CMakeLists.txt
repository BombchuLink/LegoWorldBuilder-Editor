# Native WorldBuilder editor: the editor's own JS running in QuickJS, with an SDL3 + Dear ImGui front end.
#
# Linux (system SDL3 and zlib):
#   cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build build
# Windows 7 and later, 32-bit, cross-built on Linux with MinGW-w64 (SDL3 and zlib built from source
# and linked in, so the program needs no DLLs):
#   cmake -S . -B build-win -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_TOOLCHAIN_FILE=cmake/mingw-i686.cmake
#   cmake --build build-win && cmake --install build-win --prefix dist-win
cmake_minimum_required(VERSION 3.28)
project(worldbuilder_editor VERSION 1.1.0 LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include(FetchContent)

# A Linux build to hand out (WBE_BUNDLED_DEPS) runs on glibc 2.35 and later even when built on a
# newer system: see src/compat/glibc_compat.c
if(CMAKE_SYSTEM_NAME STREQUAL "Linux" AND CMAKE_SYSTEM_PROCESSOR MATCHES "x86_64|AMD64")
  set(WBE_CAN_COMPAT ON)
endif()
option(WBE_GLIBC_COMPAT "Keep a bundled Linux build to glibc 2.35" OFF)
if(WBE_GLIBC_COMPAT AND WBE_CAN_COMPAT)
  add_compile_options("SHELL:-include \"${CMAKE_CURRENT_SOURCE_DIR}/src/compat/glibc_compat.h\"")
endif()

if(WIN32)
  # Keep to what Windows 7 has, so nothing newer gets used by accident
  add_compile_definitions(_WIN32_WINNT=0x0601 WINVER=0x0601 UNICODE _UNICODE)
endif()

# SDL3 and zlib: the system's, or built from source and linked in statically (the default on Windows)
option(WBE_BUNDLED_DEPS "Build SDL3 and zlib from source and link them in" ${WIN32})

FetchContent_Declare(quickjs
  GIT_REPOSITORY https://github.com/quickjs-ng/quickjs.git
  GIT_TAG v0.17.0
  GIT_SHALLOW TRUE
  EXCLUDE_FROM_ALL)
set(QJS_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(QJS_BUILD_CLI_WITH_MIMALLOC OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(quickjs)

if(WBE_BUNDLED_DEPS)
  FetchContent_Declare(SDL3
    GIT_REPOSITORY https://github.com/libsdl-org/SDL.git
    GIT_TAG release-3.2.10
    GIT_SHALLOW TRUE
    EXCLUDE_FROM_ALL)
  set(SDL_SHARED OFF CACHE BOOL "" FORCE)
  set(SDL_STATIC ON CACHE BOOL "" FORCE)
  set(SDL_TEST_LIBRARY OFF CACHE BOOL "" FORCE)
  set(SDL_TESTS OFF CACHE BOOL "" FORCE)
  set(SDL_EXAMPLES OFF CACHE BOOL "" FORCE)
  FetchContent_MakeAvailable(SDL3)
  set(WBE_SDL SDL3::SDL3-static)

  # zlib's own CMake build renames its headers, so only its sources are used (SOURCE_SUBDIR: don't run it)
  FetchContent_Declare(zlib
    GIT_REPOSITORY https://github.com/madler/zlib.git
    GIT_TAG v1.3.1
    GIT_SHALLOW TRUE
    SOURCE_SUBDIR none)
  FetchContent_MakeAvailable(zlib)
  add_library(wbe_zlib STATIC)
  # (not its gz* file functions, which need a configure step and aren't used)
  foreach(f adler32 compress crc32 deflate inflate infback inftrees inffast trees uncompr zutil)
    target_sources(wbe_zlib PRIVATE ${zlib_SOURCE_DIR}/${f}.c)
  endforeach()
  target_include_directories(wbe_zlib PUBLIC ${zlib_SOURCE_DIR})
  set(WBE_ZLIB wbe_zlib)
else()
  find_package(ZLIB REQUIRED)
  find_package(SDL3 REQUIRED CONFIG)
  set(WBE_SDL SDL3::SDL3)
  set(WBE_ZLIB ZLIB::ZLIB)
endif()

FetchContent_Declare(imgui
  GIT_REPOSITORY https://github.com/ocornut/imgui.git
  GIT_TAG v1.92.9b
  GIT_SHALLOW TRUE
  EXCLUDE_FROM_ALL)
FetchContent_MakeAvailable(imgui)
add_library(imgui STATIC
  ${imgui_SOURCE_DIR}/imgui.cpp ${imgui_SOURCE_DIR}/imgui_draw.cpp ${imgui_SOURCE_DIR}/imgui_tables.cpp
  ${imgui_SOURCE_DIR}/imgui_widgets.cpp
  ${imgui_SOURCE_DIR}/backends/imgui_impl_sdl3.cpp ${imgui_SOURCE_DIR}/backends/imgui_impl_sdlrenderer3.cpp)
target_include_directories(imgui PUBLIC ${imgui_SOURCE_DIR} ${imgui_SOURCE_DIR}/backends)
target_link_libraries(imgui PUBLIC ${WBE_SDL})
if(WIN32)
  target_link_libraries(imgui PUBLIC imm32)  # ImGui's default Windows IME functions
endif()

# The JS the host runs lives in the editor folder (wbcore.js, scene.js, edit.js) and native/js
set(WBE_EDITOR_DIR "${CMAKE_CURRENT_SOURCE_DIR}/.." CACHE PATH "Folder holding wbcore.js")

add_library(wbe_host STATIC src/js_host.cpp)
if(WBE_GLIBC_COMPAT AND WBE_CAN_COMPAT)
  target_sources(wbe_host PRIVATE src/compat/glibc_compat.c)
endif()
target_include_directories(wbe_host PUBLIC src)
target_link_libraries(wbe_host PUBLIC qjs ${WBE_ZLIB})
target_compile_definitions(wbe_host PUBLIC WBE_EDITOR_DIR="${WBE_EDITOR_DIR}")

add_library(wbe_ui STATIC src/ui_bind.cpp ${imgui_SOURCE_DIR}/misc/cpp/imgui_stdlib.cpp)
target_include_directories(wbe_ui PUBLIC src ${imgui_SOURCE_DIR}/misc/cpp)
target_link_libraries(wbe_ui PUBLIC wbe_host imgui)
target_compile_definitions(wbe_ui PRIVATE WBE_VERSION="${PROJECT_VERSION_MAJOR}.${PROJECT_VERSION_MINOR}")

# Headless core, for checking QuickJS against Node's V8 on the same steps (test/compare.js)
add_executable(wbe-core src/cli.cpp)
target_link_libraries(wbe-core PRIVATE wbe_host)

# The editor itself: a windowed program on Windows (no console)
# (worldbuilder-editor on Linux, WorldBuilderEditor.exe on Windows)
add_executable(worldbuilder-native WIN32 src/app.cpp)
target_include_directories(worldbuilder-native PRIVATE res)
target_link_libraries(worldbuilder-native PRIVATE wbe_host wbe_ui imgui)
target_compile_definitions(worldbuilder-native PRIVATE WBE_VERSION="${PROJECT_VERSION_MAJOR}.${PROJECT_VERSION_MINOR}")
if(WIN32)
  configure_file(res/app.rc.in app.rc @ONLY)  # icon and version information
  target_sources(worldbuilder-native PRIVATE ${CMAKE_CURRENT_BINARY_DIR}/app.rc)
  set_target_properties(worldbuilder-native PROPERTIES OUTPUT_NAME WorldBuilderEditor)
else()
  set_target_properties(worldbuilder-native PROPERTIES OUTPUT_NAME worldbuilder-editor)
endif()

if(WBE_BUNDLED_DEPS AND UNIX)
  # A Linux build to hand out: the C++ runtime linked in too (glibc and the system's graphics
  # libraries, which SDL loads when it starts, still come from the system)
  foreach(t wbe-core worldbuilder-native)
    target_link_options(${t} PRIVATE -static-libstdc++ -static-libgcc $<$<CONFIG:Release,MinSizeRel>:-s>)
  endforeach()
endif()

if(MINGW)
  # The C++ and GCC runtimes and winpthreads linked in: the .exe needs nothing but Windows itself
  foreach(t wbe-core worldbuilder-native)
    target_link_options(${t} PRIVATE -static -static-libgcc -static-libstdc++ $<$<CONFIG:Release,MinSizeRel>:-s>)
  endforeach()
  # UNICODE: SDL's entry point is wWinMain, which MinGW only calls with -municode
  target_link_options(worldbuilder-native PRIVATE -municode)
endif()

# cmake --install <build> --prefix <dir>: the program, with the JS and fonts in "data" beside it
# (where it looks for them first), ready to zip up. release.sh adds the readme, licences and icon.
install(TARGETS worldbuilder-native RUNTIME DESTINATION .)
install(FILES ../wbcore.js ../scene.js ../edit.js ../wb1monsters.js DESTINATION data)
install(FILES js/editor.js DESTINATION data/native/js)
install(FILES fonts/Fredoka-Regular.ttf fonts/Fredoka-SemiBold.ttf fonts/OFL.txt DESTINATION data/native/fonts)
