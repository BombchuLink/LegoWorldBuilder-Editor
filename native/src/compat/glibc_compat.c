/* Functions glibc only gained in 2.36–2.38, defined here so a Linux release build doesn't need a
 * newer glibc than 2.35 (Ubuntu 22.04, Debian 12, Mint 21). The libraries built with this program
 * call them because the build system has them: the C23 versions of strtol and scanf (which only
 * differ in reading "0b" binary numbers, which nothing here does), strlcpy and friends, arc4random.
 * Built without _GNU_SOURCE, so the plain names below are glibc's long-standing versions. */
#undef _GNU_SOURCE
#define _DEFAULT_SOURCE 1
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/random.h>
#include <wchar.h>

long __isoc23_strtol(const char* s, char** end, int base) { return strtol(s, end, base); }
long long __isoc23_strtoll(const char* s, char** end, int base) { return strtoll(s, end, base); }
unsigned long __isoc23_strtoul(const char* s, char** end, int base) { return strtoul(s, end, base); }
unsigned long long __isoc23_strtoull(const char* s, char** end, int base) { return strtoull(s, end, base); }
long __isoc23_wcstol(const wchar_t* s, wchar_t** end, int base) { return wcstol(s, end, base); }
int __isoc23_vsscanf(const char* s, const char* fmt, va_list ap) { return vsscanf(s, fmt, ap); }
int __isoc23_sscanf(const char* s, const char* fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  int r = vsscanf(s, fmt, ap);
  va_end(ap);
  return r;
}
int __isoc23_fscanf(FILE* f, const char* fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  int r = vfscanf(f, fmt, ap);
  va_end(ap);
  return r;
}

size_t strlcpy(char* dst, const char* src, size_t size) {
  size_t n = strlen(src);
  if (size) {
    size_t k = n < size - 1 ? n : size - 1;
    memcpy(dst, src, k);
    dst[k] = 0;
  }
  return n;
}
size_t strlcat(char* dst, const char* src, size_t size) {
  size_t d = strnlen(dst, size);
  return d == size ? size + strlen(src) : d + strlcpy(dst + d, src, size - d);
}
size_t wcslcpy(wchar_t* dst, const wchar_t* src, size_t size) {
  size_t n = wcslen(src);
  if (size) {
    size_t k = n < size - 1 ? n : size - 1;
    wmemcpy(dst, src, k);
    dst[k] = 0;
  }
  return n;
}
size_t wcslcat(wchar_t* dst, const wchar_t* src, size_t size) {
  size_t d = wcsnlen(dst, size);
  return d == size ? size + wcslen(src) : d + wcslcpy(dst + d, src, size - d);
}

uint32_t arc4random(void) {
  uint32_t v = 0;
  while (getrandom(&v, sizeof v, 0) != (ssize_t)sizeof v) {}
  return v;
}
void arc4random_buf(void* buf, size_t n) {
  unsigned char* p = buf;
  while (n) {
    ssize_t r = getrandom(p, n, 0);
    if (r > 0) { p += r; n -= (size_t)r; }
  }
}
uint32_t arc4random_uniform(uint32_t bound) {
  if (bound < 2) return 0;
  uint32_t min = -bound % bound, v;
  do v = arc4random(); while (v < min);
  return v % bound;
}
