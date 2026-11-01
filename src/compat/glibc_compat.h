/* Force-included into every file of a Linux release build (WBE_GLIBC_COMPAT): calls to functions
 * whose newest glibc version is newer than the release needs go to the older version instead, so
 * a program built on a new system still starts on older ones (see glibc_compat.c). */
#if defined(__linux__) && defined(__x86_64__)
__asm__(".symver fmod,fmod@GLIBC_2.2.5");
__asm__(".symver fmodf,fmodf@GLIBC_2.2.5");
#endif
