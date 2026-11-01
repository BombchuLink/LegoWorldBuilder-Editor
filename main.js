/* Desktop shell for the level editor: one window, native file dialogs, reads and writes files
 * on disk directly. Start it with ./worldbuilder-editor [game file]. */
"use strict";
const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");

/* Keep the footprint small: the editor only draws a 2D canvas, which Chromium's software
 * rasterizer handles as fast as the GPU (panning is smoother, in fact). Without GPU compositing
 * the GPU process, and with the network service in-process the network process, aren't started,
 * leaving two processes (this one and the page) instead of four: about 280 MB instead of 450.
 * WBE_GPU=1 brings the GPU back if a big zoomed-out map ever feels slow. */
if (!process.env.WBE_GPU) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("in-process-gpu");
}
app.commandLine.appendSwitch("enable-features", "NetworkServiceInProcess2");

const root = path.resolve(__dirname, "..");
const GAME_FILES = [{ name: "Game launcher", extensions: ["exe"] }];
const MOVIE_FILES = [{ name: "Shockwave movie", extensions: ["dcr"] }];
let win;

// A game file given on the command line opens at start (relative to where the editor was started)
const startFile = process.argv.slice(1).filter((a) => !a.startsWith("-"))
  .map((a) => path.resolve(process.env.WBE_CWD || process.cwd(), a))
  .find((p) => /\.exe$/i.test(p) && fs.existsSync(p) && fs.statSync(p).isFile());

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    title: "WorldBuilder Level Editor",
    backgroundColor: "#1b1f2a",
    autoHideMenuBar: true,
    // the preload only needs contextBridge, ipcRenderer and webUtils, which work sandboxed
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, spellcheck: false },
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, "index.html"));

  // The page blocks closing while there are unsaved changes; ask instead of silently refusing
  win.webContents.on("will-prevent-unload", (e) => {
    const r = dialog.showMessageBoxSync(win, {
      type: "warning", buttons: ["Quit without saving", "Cancel"], defaultId: 1, cancelId: 1,
      message: "You have unsaved changes.", detail: "Quit anyway and lose them?",
    });
    if (r === 0) e.preventDefault();
  });
  // Links (none today) open in the real browser, never inside the editor
  win.webContents.setWindowOpenHandler(({ url }) => { require("electron").shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
}

function readGameFile(p) {
  const data = fs.readFileSync(p);
  return { path: p, name: path.basename(p), data: new Uint8Array(data.buffer, data.byteOffset, data.length) };
}

// Default folder for dialogs: next to the open file, else the game folders beside the editor
const defaultDir = (near) => (near ? path.dirname(near) : root);

// dcr: pick a .dcr to import instead of a Launcher.exe
ipcMain.handle("open-file", async (_e, { near, dcr } = {}) => {
  const r = await dialog.showOpenDialog(win, {
    title: dcr ? "Import .dcr" : "Open Launcher.exe",
    defaultPath: defaultDir(near),
    filters: dcr ? MOVIE_FILES : GAME_FILES,
    properties: ["openFile"],
  });
  return r.canceled || !r.filePaths[0] ? null : readGameFile(r.filePaths[0]);
});

ipcMain.handle("start-file", () => (startFile ? readGameFile(startFile) : null));

// Ask where to save (suggesting `suggest`, usually the file that was opened), then write it.
// The first time a file is overwritten its original is kept as <file>.orig.
ipcMain.handle("save-file", async (_e, { suggest, name, ext, data }) => {
  const r = await dialog.showSaveDialog(win, {
    title: "Save " + name,
    defaultPath: suggest || path.join(root, name),
    filters: ext === "exe" ? [{ name: "Game launcher", extensions: ["exe"] }]
      : ext === "dcr" ? [{ name: "Shockwave movie", extensions: ["dcr"] }]
      : [{ name: "Text", extensions: [ext] }],
  });
  if (r.canceled || !r.filePath) return null;
  const p = r.filePath;
  let backup = null;
  if ((ext === "exe" || ext === "dcr") && fs.existsSync(p) && !fs.existsSync(p + ".orig")) {
    fs.copyFileSync(p, p + ".orig");
    backup = p + ".orig";
  }
  // write next to the target and rename, so a failed save never leaves a half-written game
  const tmp = p + ".saving";
  fs.writeFileSync(tmp, Buffer.from(data));
  if (fs.existsSync(p)) fs.chmodSync(tmp, fs.statSync(p).mode); // keep Launcher.exe executable
  fs.renameSync(tmp, p);
  return { path: p, name: path.basename(p), backup };
});

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
