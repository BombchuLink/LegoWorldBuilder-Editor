/* Bridge between the editor page and the desktop shell (main.js). Absent in a browser. */
"use strict";
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("native", {
  openFile: (opts) => ipcRenderer.invoke("open-file", opts),
  startFile: () => ipcRenderer.invoke("start-file"),
  saveFile: (opts) => ipcRenderer.invoke("save-file", opts),
  pathFor: (file) => webUtils.getPathForFile(file),
});
