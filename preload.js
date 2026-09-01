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

  // Timeline waveforms and thumbnails. Both cover the whole source file, not
  // one clip's trim, so the renderer only ever asks once per source — see
  // main.js's "Waveforms and thumbnails" section.
  getWaveform: (filePath) => ipcRenderer.invoke('media:waveform', filePath),
  getThumbnails: (filePath) => ipcRenderer.invoke('media:thumbnails', filePath),

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

  // `saveAs` is the whole difference between Save and Save As; main decides
  // what that means against the path it is holding.
  saveProject: (project, saveAs) => ipcRenderer.invoke('project:save', { project, saveAs }),
  openProject: () => ipcRenderer.invoke('project:open'),
  newProject: () => ipcRenderer.invoke('project:new'),

  // Save protection. The renderer owns the project and computes whether it
  // differs from the file; main owns the window, so it is main that has to be
  // told, rather than asked at the moment a close is already happening.
  reportProjectState: (state) => ipcRenderer.send('project:state', state),
  autosave: (project) => ipcRenderer.send('project:autosave', project),
  confirmDiscard: () => ipcRenderer.invoke('project:confirm-discard'),
  // How a save that main asked for reports back. Only sent for a save main
  // started, since it is main's close that is waiting on the answer.
  saveFinished: (result) => ipcRenderer.send('project:save-finished', result),

  // File and Edit menu items, and the restored project after a crash. One
  // channel each, both one-way: the menu is main's, the project is not.
  onMenuCommand: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('menu:command', handler);
    return () => ipcRenderer.removeListener('menu:command', handler);
  },
  onRestoreProject: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('project:restore', handler);
    return () => ipcRenderer.removeListener('project:restore', handler);
  },

  reveal: (filePath) => ipcRenderer.invoke('shell:reveal', filePath)
});
