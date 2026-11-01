# Cross-build for 32-bit Windows (7 and later) with MinGW-w64 on Linux.
#   Debian/Ubuntu: apt install g++-mingw-w64-i686-posix    Fedora: mingw32-gcc-c++    Arch: mingw-w64-gcc
# The "posix" thread flavour gives std::thread/std::mutex on every Windows version.
set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR x86)
set(MINGW_PREFIX i686-w64-mingw32)

# Debian names the posix-thread compilers <prefix>-gcc-posix; other distributions just <prefix>-gcc
find_program(CMAKE_C_COMPILER NAMES ${MINGW_PREFIX}-gcc-posix ${MINGW_PREFIX}-gcc REQUIRED)
find_program(CMAKE_CXX_COMPILER NAMES ${MINGW_PREFIX}-g++-posix ${MINGW_PREFIX}-g++ REQUIRED)
find_program(CMAKE_RC_COMPILER NAMES ${MINGW_PREFIX}-windres REQUIRED)

set(CMAKE_FIND_ROOT_PATH /usr/${MINGW_PREFIX})
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
