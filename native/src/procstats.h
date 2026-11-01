// CPU time and memory of this process, for the benchmarks (WBE_SWEEP, wbe-core's report).
// Linux and Windows; elsewhere they read 0.
#pragma once
#include <cstdlib>
#include <fstream>
#include <string>

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <psapi.h>
#elif defined(__linux__)
#include <sys/resource.h>
#include <time.h>
#endif

namespace wbe {

#if defined(_WIN32)
inline double filetime_ms(const FILETIME& f) { return (static_cast<unsigned long long>(f.dwHighDateTime) << 32 | f.dwLowDateTime) / 1e4; }
#endif

// CPU time used by the whole process (all threads), ms
inline double process_cpu_ms() {
#if defined(_WIN32)
  FILETIME c, e, k, u;
  return GetProcessTimes(GetCurrentProcess(), &c, &e, &k, &u) ? filetime_ms(k) + filetime_ms(u) : 0;
#elif defined(__linux__)
  rusage ru{};
  getrusage(RUSAGE_SELF, &ru);
  return (ru.ru_utime.tv_sec + ru.ru_stime.tv_sec) * 1e3 + (ru.ru_utime.tv_usec + ru.ru_stime.tv_usec) / 1e3;
#else
  return 0;
#endif
}

// CPU time used by the calling thread, ms
inline double thread_cpu_ms() {
#if defined(_WIN32)
  FILETIME c, e, k, u;
  return GetThreadTimes(GetCurrentThread(), &c, &e, &k, &u) ? filetime_ms(k) + filetime_ms(u) : 0;
#elif defined(__linux__)
  timespec t{};
  clock_gettime(CLOCK_THREAD_CPUTIME_ID, &t);
  return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
#else
  return 0;
#endif
}

// Memory in use now, kB: the proportional set size on Linux, the private bytes on Windows
inline long memory_kb() {
#if defined(_WIN32)
  PROCESS_MEMORY_COUNTERS_EX m{};
  m.cb = sizeof m;
  return K32GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&m), sizeof m) ? static_cast<long>(m.PrivateUsage / 1024) : 0;
#elif defined(__linux__)
  std::ifstream f("/proc/self/smaps_rollup");
  std::string line;
  while (std::getline(f, line)) if (line.rfind("Pss:", 0) == 0) return std::atol(line.c_str() + 4);
  return 0;
#else
  return 0;
#endif
}

// Most memory the process has held at once, MB (resident set on Linux, working set on Windows)
inline double peak_memory_mb() {
#if defined(_WIN32)
  PROCESS_MEMORY_COUNTERS m{};
  m.cb = sizeof m;
  return K32GetProcessMemoryInfo(GetCurrentProcess(), &m, sizeof m) ? m.PeakWorkingSetSize / 1048576.0 : 0;
#elif defined(__linux__)
  rusage ru{};
  getrusage(RUSAGE_SELF, &ru);
  return ru.ru_maxrss / 1024.0;
#else
  return 0;
#endif
}

}  // namespace wbe
