# Changelog

## 1.1 (unreleased, in testing)

The editor is now a native program for Windows and Linux. The Electron desktop app and the browser
version (`index.html`) are gone.

- **Small and quick.** About 70 MB of memory instead of 280 MB (two processes and sandbox helpers),
  a 3.5 MB download, and hovering or scrolling the map costs about a quarter of the CPU. It uses no
  CPU while you're not doing anything.
- **Windows 7 and later**, as one 32-bit program with no DLLs or runtimes to install, and a
  self-contained **Linux** build (glibc 2.35 and later).
- The same editor otherwise: every tool, tab, patch and check from 1.0, the same files saved
  byte for byte, and the same look.
- **Save Launcher.exe** writes straight over the opened file (keeping the original as
  `Launcher.exe.orig` the first time, as before); **Save as…** writes a copy elsewhere.
- The window follows the display's scale (Windows' 125%, 150%…).
- Game folders with accented or other non-English names work.
- If the window stays black, `WorldBuilderEditor-software.bat` (Windows) or
  `WBE_RENDERER=software` (Linux) draws without the graphics card.
- A new icon.

## 1.0

The first release: an Electron desktop app and a browser version.
