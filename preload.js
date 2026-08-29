/*
 * preload.js
 * The only channel between the UI and Node. Everything the renderer can do to
 * your machine is listed here, and nothing else is reachable. Keeping this
 * surface small is what makes contextIsolation worth having.
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('cutroom', {
  checkEnv: () => ipcRenderer.invoke('env:check'),

  pickMedia: (kind) => ipcRenderer.invoke('media:pick', kind),
  probe: (filePath) => ipcRenderer.invoke('media:probe', filePath),
  grabFrame: (filePath, atSec) => ipcRenderer.invoke('media:frame', { filePath, atSec }),

  // Drag-and-drop gives a File object, not a path. webUtils gets us the real
  // path on disk, which is what ffmpeg needs. It throws rather than returning
  // empty for anything that is not a real File — a dragged directory, or a
  // drag that came from a web page — so the catch is what keeps a stray drop
  // from breaking the handler.
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); }
    catch { return null; }
  },

  previewCommand: (project) => ipcRenderer.invoke('export:preview-command', project),
  runExport: (project, previewSeconds) =>
    ipcRenderer.invoke('export:run', { project, previewSeconds }),
  cancelExport: () => ipcRenderer.invoke('export:cancel'),
  onExportProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('export:progress', handler);
    return () => ipcRenderer.removeListener('export:progress', handler);
  },

  transcribe: (sourcePath, language) =>
    ipcRenderer.invoke('captions:transcribe', { sourcePath, language }),
  importCaptions: () => ipcRenderer.invoke('captions:import'),

  saveProject: (project) => ipcRenderer.invoke('project:save', project),
  openProject: () => ipcRenderer.invoke('project:open'),
  reveal: (filePath) => ipcRenderer.invoke('shell:reveal', filePath)
});
