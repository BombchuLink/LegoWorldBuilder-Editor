# Native WorldBuilder editor: the editor's own wbcore.js running in QuickJS, with a C++ front end.
#   cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build build
cmake_minimum_required(VERSION 3.20)
project(worldbuilder_native C CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include(FetchContent)
FetchContent_Declare(quickjs
  GIT_REPOSITORY https://github.com/quickjs-ng/quickjs.git
  GIT_TAG v0.17.0
  GIT_SHALLOW TRUE)
set(QJS_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(QJS_BUILD_CLI_WITH_MIMALLOC OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(quickjs)
find_package(ZLIB REQUIRED)
find_package(SDL3 REQUIRED CONFIG)

FetchContent_Declare(imgui
  GIT_REPOSITORY https://github.com/ocornut/imgui.git
  GIT_TAG v1.92.9b
  GIT_SHALLOW TRUE)
FetchContent_MakeAvailable(imgui)
add_library(imgui STATIC
  ${imgui_SOURCE_DIR}/imgui.cpp ${imgui_SOURCE_DIR}/imgui_draw.cpp ${imgui_SOURCE_DIR}/imgui_tables.cpp
  ${imgui_SOURCE_DIR}/imgui_widgets.cpp
  ${imgui_SOURCE_DIR}/backends/imgui_impl_sdl3.cpp ${imgui_SOURCE_DIR}/backends/imgui_impl_sdlrenderer3.cpp)
target_include_directories(imgui PUBLIC ${imgui_SOURCE_DIR} ${imgui_SOURCE_DIR}/backends)
target_link_libraries(imgui PUBLIC SDL3::SDL3)

# The JS the host runs lives in the editor folder, shared with the Electron/web version
set(WBE_EDITOR_DIR "${CMAKE_CURRENT_SOURCE_DIR}/.." CACHE PATH "Folder holding wbcore.js")

add_library(wbe_host STATIC src/js_host.cpp)
target_include_directories(wbe_host PUBLIC src)
target_link_libraries(wbe_host PUBLIC qjs ZLIB::ZLIB)
target_compile_definitions(wbe_host PUBLIC WBE_EDITOR_DIR="${WBE_EDITOR_DIR}")

# Stage 1: headless core, for checking the QuickJS build against the Electron editor
add_executable(wbe-core src/cli.cpp)
target_link_libraries(wbe-core PRIVATE wbe_host)

# The editor itself (stage 2: levels and the map, with pan and zoom)
add_executable(worldbuilder-native src/app.cpp)
target_link_libraries(worldbuilder-native PRIVATE wbe_host imgui)
