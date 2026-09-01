/*
 * main.js — Electron main process.
 * Owns: the window, the filesystem, and every child process.
 * The renderer never touches disk or spawns anything directly.
 */

'use strict';

const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const builder = require('./shared/ffmpeg-builder');
const { validateProject, PROJECT_VERSION } = require('./shared/project-schema');
const saveState = require('./shared/save-state');
const mediaCache = require('./shared/media-cache');
const { matrixNameFromTags } = require('./src/chroma-math');

let win = null;
let currentExport = null;

// --------------------------------------------------------------------------
// Save state
// --------------------------------------------------------------------------

/*
 * Three pieces of state, and it is worth being precise about who owns what.
 *
 * The renderer owns the project. Main never holds a copy, because a copy is a
 * copy that can be stale, and the one moment it would be read — saving on the
 * way out of a close dialog — is exactly the moment being a few hundred
 * milliseconds behind would silently write the wrong file. So when main needs
 * the project it asks the renderer for it.
 *
 * Main owns the current file path and mirrors the dirty flag, because both are
 * needed by things only main can do: the window title, and a close handler
 * that has to decide before any renderer round-trip whether to interrupt.
 */
let currentPath = null;
let isDirty = false;
// Only used for the title before a project has a file, and in the close
// dialog's "Save changes to X?" — so it is a label, not state anything reads.
let projectName = 'untitled';

// Set once the close guard has run and allowed the close, so the second pass
// through the 'close' handler falls straight through instead of asking again.
let allowClose = false;
// Cmd+Q sets this. Without it, the re-close after the dialog would close the
// window and leave the app running on macOS — a quit that quietly became a
// close, which looks exactly like the app ignoring the shortcut.
let quitting = false;
// Resolver for a save that main asked the renderer to perform.
let pendingSave = null;

// --------------------------------------------------------------------------
// Locating ffmpeg
// --------------------------------------------------------------------------

/**
 * Look for ffmpeg on PATH first, then the usual install locations.
 * Returns the binary name/path or null.
 */
function findBinary(names) {
  const extra = [
    '/usr/local/bin', '/usr/bin', '/opt/homebrew/bin', '/snap/bin',
    'C:\\ffmpeg\\bin', 'C:\\Program Files\\ffmpeg\\bin'
  ];
  const dirs = (process.env.PATH || '').split(path.delimiter).concat(extra);
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];

  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = path.join(dir, name + ext);
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
          return candidate;
        } catch { /* keep looking */ }
      }
    }
  }
  return null;
}

const FFMPEG = findBinary(['ffmpeg']);
const FFPROBE = findBinary(['ffprobe']);

// --------------------------------------------------------------------------
// Window
// --------------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#12161C',
    title: saveState.titleFor({}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.on('close', onWindowClose);
  win.on('closed', () => { win = null; });
  applyWindowTitle();
  return win;
}

/**
 * The window title is the only place the app says which file you are editing
 * and whether it is saved, so it is recomputed from one function rather than
 * poked at from the four places that can change either.
 */
function applyWindowTitle() {
  if (!win || win.isDestroyed()) return;
  win.setTitle(saveState.titleFor({ filePath: currentPath, projectName, dirty: isDirty }));
  if (process.platform === 'darwin') {
    // The proxy icon and the dot in the close button. Mac users read the
    // close button for this before they read the title.
    win.setDocumentEdited(isDirty);
    win.setRepresentedFilename(currentPath || '');
  }
}

// --------------------------------------------------------------------------
// The close guard
// --------------------------------------------------------------------------

/*
 * Electron's 'close' event is synchronous and the dialog is not, which is the
 * whole difficulty. preventDefault() has to happen now, before any await, or
 * the window is already gone by the time the user is asked; and the close then
 * has to be started again by hand once the answer arrives, through a flag that
 * makes the second pass fall through instead of asking twice.
 *
 * Getting either half wrong has a distinctive failure: no preventDefault and
 * the prompt appears over a window that is already closing, no second close
 * and the window can never be shut at all.
 */
function onWindowClose(e) {
  if (allowClose) return;

  if (!isDirty) {
    // A clean exit must not leave an autosave behind. That file existing is
    // what makes the next launch ask about recovery, and a recovery prompt
    // after an ordinary quit is the thing that gets the whole feature turned
    // off — so "there is nothing to recover" is stated by deleting it here
    // rather than worked out later.
    clearAutosave();
    return;
  }

  e.preventDefault();
  resolveDirtyClose().then(allowed => {
    if (!allowed) {
      // Cancel means cancel, including for a Cmd+Q that got us here: leaving
      // `quitting` set would make the next ordinary window close quit the app.
      quitting = false;
      return;
    }
    // Save, Don't Save and "it was already clean" all mean the work is
    // resolved, so the autosave has nothing left to offer. Don't Save
    // especially: restoring what the user just chose to throw away is the
    // single most annoying thing a recovery feature can do.
    clearAutosave();
    allowClose = true;
    if (quitting) app.quit(); else win.close();
  });
}

/**
 * Ask, and act on the answer. Resolves true if the close may go ahead.
 */
async function resolveDirtyClose() {
  const { response } = await dialog.showMessageBox(
    win, saveState.closeDialogOptions({ projectName })
  );
  const choice = saveState.closeChoice(response);

  if (choice === 'cancel') return false;
  if (choice === 'discard') return true;

  // Save. The project lives in the renderer, so the renderer does the saving
  // and reports back — including reporting that the user cancelled the Save
  // dialog, which has to abort the close rather than fall through it.
  const result = await requestRendererSave();
  return Boolean(result && result.ok);
}

/**
 * Ask the renderer to save and wait for it to say how that went.
 *
 * The timeout is not defensive decoration. Without it a renderer that has
 * hung leaves a window that cannot be closed by any means, and the failure
 * resolves to "not saved", which cancels the close — so the worst case is a
 * window that stays open, never one that takes unsaved work with it.
 */
function requestRendererSave(timeoutMs = 30000) {
  if (!win || win.isDestroyed()) return Promise.resolve({ ok: false });
  return new Promise(resolve => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      pendingSave = null;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, timedOut: true }), timeoutMs);
    pendingSave = finish;
    win.webContents.send('menu:command', { command: 'save', reply: true });
  });
}

ipcMain.on('project:save-finished', (_e, result) => {
  if (pendingSave) pendingSave(result || { ok: false });
});

/**
 * The renderer's own guard, for New and Open — the two other ways to walk away
 * from unsaved work. Same dialog, same three answers; the renderer acts on the
 * string rather than main driving it, because unlike a close there is nothing
 * for main to abort.
 */
ipcMain.handle('project:confirm-discard', async () => {
  if (!isDirty) return 'discard';
  const { response } = await dialog.showMessageBox(
    win, saveState.closeDialogOptions({ projectName })
  );
  return saveState.closeChoice(response);
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(buildAppMenu());
  // Read before the window: see readAutosaveForRestore for why the order here
  // is load-bearing rather than arbitrary.
  const pending = readAutosaveForRestore();
  createWindow();
  if (pending) offerRestore(pending);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Cmd+Q and any other app-level quit. Recorded rather than acted on: the
// window's own close handler is the one place that knows whether there is
// anything to ask about, and it needs to know which of the two it is
// finishing once the answer comes back.
app.on('before-quit', () => { quitting = true; });

app.on('window-all-closed', () => {
  // Belt and braces. The close handler above already clears this on every
  // route out; this catches a window destroyed some way that never ran it.
  clearAutosave();
  if (process.platform !== 'darwin') app.quit();
});

// --------------------------------------------------------------------------
// Application menu
// --------------------------------------------------------------------------

/*
 * Setting an application menu replaces Electron's default one wholesale, and
 * the default is where cut/copy/paste come from. Without the roles below,
 * every text field in the app — the caption editor above all — silently loses
 * clipboard support on macOS, where those shortcuts are the menu's to deliver
 * and nothing in the page provides them. So the Edit menu carries the standard
 * roles alongside the app's own Undo and Redo, and `appMenu` restores the
 * About/Hide/Quit block that would otherwise vanish with it.
 *
 * Undo and Redo are wired to the app's history, not to the `undo`/`redo`
 * roles. Those roles undo typing inside the focused text field; this app's
 * undo is project-level, and the two are not interchangeable — a user who
 * splits a clip and presses Cmd+Z expects the split back, not their last
 * keystroke in a caption box.
 */
function buildAppMenu() {
  const mac = process.platform === 'darwin';
  const send = (command) => () => {
    if (win && !win.isDestroyed()) win.webContents.send('menu:command', { command });
  };

  /*
   * `registerAccelerator: false` displays the shortcut without claiming it, so
   * on Windows and Linux app.js's keydown listener stays the single handler
   * for undo — the same one the tests drive. macOS ignores the option (the
   * system menu owns key equivalents there), so on that platform the menu is
   * the handler instead. Either way exactly one of the two paths runs; the
   * guard in dirty-state.js is what makes that true rather than assumed.
   */
  const historyItem = (label, command, accelerator) => ({
    label, accelerator, registerAccelerator: mac, click: send(command)
  });

  return Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New', accelerator: 'CmdOrCtrl+N', click: send('new') },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: send('open') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: send('save-as') },
        ...(mac ? [] : [{ type: 'separator' }, { role: 'quit' }])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        historyItem('Undo', 'undo', 'CmdOrCtrl+Z'),
        historyItem('Redo', 'redo', mac ? 'Shift+Cmd+Z' : 'Ctrl+Y'),
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(mac
          ? [{ role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' }]
          : [{ role: 'delete' }, { type: 'separator' }, { role: 'selectAll' }])
      ]
    },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
                { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
                { type: 'separator' }, { role: 'togglefullscreen' }]
    },
    { role: 'windowMenu' }
  ]);
}

// --------------------------------------------------------------------------
// Autosave and crash recovery
// --------------------------------------------------------------------------

/*
 * userData rather than a dotfile beside the project: there may be no project
 * file yet — which is the case with the most to lose — and a directory the OS
 * already gives us is not one the user has to be told about or clean up.
 */
const autosavePath = () => path.join(app.getPath('userData'), saveState.AUTOSAVE_FILENAME);

/**
 * Written through a temp file and renamed. The event this exists for is the
 * app dying, and dying midway through an fs.writeFileSync leaves a truncated
 * autosave — a recovery file that cannot be recovered from. rename is atomic
 * within a directory, so the real path only ever holds a whole record.
 */
function writeAutosave(project) {
  const target = autosavePath();
  const tmp = `${target}.tmp`;
  const record = saveState.autosaveRecord({ project, filePath: currentPath, savedAt: Date.now() });
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(record), 'utf8');
    fs.renameSync(tmp, target);
  } catch {
    // An autosave that cannot be written is not worth interrupting anyone
    // over — the project is still safe in memory, and the user has not asked
    // for anything. The next tick tries again.
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function clearAutosave() {
  try { fs.unlinkSync(autosavePath()); } catch {}
}

/**
 * Read the autosave and decide whether it is worth offering.
 *
 * Called before the window exists, and that is not incidental. The moment the
 * renderer boots it reports a clean project, and main deletes the autosave on
 * hearing that — so a read scheduled any later is a race against the app's own
 * tidying up. Doing it first makes the ordering a property of the code rather
 * than of how quickly a page happens to load.
 *
 * @returns {{record: object, reason: string}|null}
 */
function readAutosaveForRestore() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(autosavePath(), 'utf8'));
  } catch {
    return null; // No autosave, or one we cannot read. Either way, nothing to offer.
  }

  const read = saveState.readAutosaveRecord(parsed);
  if (!read.ok) { clearAutosave(); return null; }
  const record = read.record;

  let fileMtimeMs = null;
  if (record.filePath) {
    try { fileMtimeMs = fs.statSync(record.filePath).mtimeMs; } catch { fileMtimeMs = null; }
  }

  const verdict = saveState.shouldOfferRestore({ record, fileMtimeMs });
  if (!verdict.offer) { clearAutosave(); return null; }
  return { record, reason: verdict.reason };
}

/** Ask, once the page it would be restored into actually exists. */
function offerRestore({ record, reason }) {
  win.webContents.once('did-finish-load', async () => {
    if (!win || win.isDestroyed()) return;
    const { response } = await dialog.showMessageBox(
      win, saveState.restoreDialogOptions({ reason, filePath: record.filePath })
    );
    if (saveState.restoreChoice(response) !== 'restore') { clearAutosave(); return; }
    if (!win || win.isDestroyed()) return;

    currentPath = record.filePath;
    // Recovered work is unsaved work, whatever it was recovered from.
    isDirty = true;
    applyWindowTitle();
    win.webContents.send('project:restore', { project: record.project, filePath: record.filePath });
  });
}

ipcMain.on('project:autosave', (_e, project) => {
  if (project) writeAutosave(project);
});

/**
 * The renderer's running report on the project: whether it differs from the
 * file, and what it is called. Both feed the title; the dirty half also feeds
 * the close guard, which is why it is pushed on every change rather than
 * asked for at close time, when the renderer might be busy.
 */
ipcMain.on('project:state', (_e, { dirty, name } = {}) => {
  isDirty = Boolean(dirty);
  if (typeof name === 'string') projectName = name;
  // Clean means the file on disk already has everything. Nothing to recover.
  if (!isDirty) clearAutosave();
  applyWindowTitle();
});

// --------------------------------------------------------------------------
// Environment check
// --------------------------------------------------------------------------

ipcMain.handle('env:check', async () => {
  const whisper = findBinary(['whisper-cli', 'whisper', 'main']);
  return {
    ffmpeg: FFMPEG,
    ffprobe: FFPROBE,
    whisper,
    platform: process.platform
  };
});

// --------------------------------------------------------------------------
// Importing media
// --------------------------------------------------------------------------

ipcMain.handle('media:pick', async (_e, kind) => {
  const filters = kind === 'audio'
    ? [{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'] }]
    : [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'] },
       { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }];

  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters
  });
  if (res.canceled) return [];
  return res.filePaths;
});

/**
 * ffprobe tells us duration, dimensions, and crucially whether an audio
 * stream exists. Guessing that from the extension is how you end up with a
 * silent export and no idea why.
 *
 * It also tells us the video stream's colour tags, which key-preview.js needs
 * to reconstruct the same YUV ffmpeg would key against — see the "Frame RGB
 * <-> YUV" section of chroma-math.js for why. `color_space` is ffprobe's name
 * for matrix coefficients (the thing that actually matters here); primaries
 * and transfer describe gamut and gamma, which chroma-math.js does not model,
 * so they are not requested.
 */
ipcMain.handle('media:probe', async (_e, filePath) => {
  if (!FFPROBE) throw new Error('ffprobe not found. Install ffmpeg first.');
  const args = [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-show_entries', 'stream=codec_type,width,height,r_frame_rate,color_space,color_primaries,color_range',
    '-of', 'json',
    filePath
  ];

  const json = await new Promise((resolve, reject) => {
    execFile(FFPROBE, args, { maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    });
  });

  const streams = json.streams || [];
  const v = streams.find(s => s.codec_type === 'video');
  const a = streams.find(s => s.codec_type === 'audio');
  let fps = 30;
  if (v && v.r_frame_rate) {
    const [n, d] = v.r_frame_rate.split('/').map(Number);
    if (d) fps = n / d;
  }

  return {
    path: filePath,
    name: path.basename(filePath),
    duration: Number(json.format?.duration) || 0,
    width: v?.width || 0,
    height: v?.height || 0,
    fps,
    hasVideo: Boolean(v),
    hasAudio: Boolean(a),
    colorMatrix: matrixNameFromTags({
      colorSpace: v?.color_space,
      colorPrimaries: v?.color_primaries,
      colorRange: v?.color_range
    })
  };
});

/**
 * Grab a single frame as a PNG data URL.
 * Used by the key-colour eyedropper: a real green screen is never exactly
 * #00FF00, and guessing the colour is the most common reason a key silently
 * does nothing. Sampling the actual pixel removes the guess.
 */
ipcMain.handle('media:frame', async (_e, { filePath, atSec }) => {
  if (!FFMPEG) throw new Error('ffmpeg not found.');
  const tmp = path.join(os.tmpdir(), `cutroom-frame-${Date.now()}.png`);
  await new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, [
      '-y', '-ss', String(atSec || 0), '-i', filePath,
      '-frames:v', '1', '-vf', 'scale=480:-1', tmp
    ]);
    p.on('close', c => (c === 0 ? resolve() : reject(new Error('Could not grab frame'))));
    p.on('error', reject);
  });
  const data = fs.readFileSync(tmp).toString('base64');
  try { fs.unlinkSync(tmp); } catch {}
  return `data:image/png;base64,${data}`;
});

// --------------------------------------------------------------------------
// Waveforms and thumbnails
// --------------------------------------------------------------------------

/*
 * Both caches live in userData, the same reasoning autosave's directory
 * comment gives: a directory the OS already provides beats one more thing
 * next to the project file that the user has to notice and clean up
 * themselves — and unlike a project file, a source clip may not have a
 * project of its own yet the first time its thumbnails are asked for.
 *
 * Entries are named after shared/media-cache.js's sourceCacheKey(filePath)
 * rather than the source's own filename, because two different folders can
 * each hold a `clip.mp4` and only the hash tells the caches apart.
 */
const waveformCacheDir = () => path.join(app.getPath('userData'), 'waveform-cache');
const thumbnailCacheDir = () => path.join(app.getPath('userData'), 'thumbnail-cache');

function readCache(dir, filePath, stat) {
  const target = path.join(dir, `${mediaCache.sourceCacheKey(filePath)}.json`);
  let record;
  try {
    record = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return null; // No entry, or one we cannot read. Either way, regenerate.
  }
  return mediaCache.isCacheFresh(record, stat) ? record : null;
}

/** Written through a temp file and renamed, same atomic-write idiom writeAutosave uses. */
function writeCache(dir, filePath, record) {
  const target = path.join(dir, `${mediaCache.sourceCacheKey(filePath)}.json`);
  const tmp = `${target}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(record), 'utf8');
    fs.renameSync(tmp, target);
  } catch {
    // A cache entry that fails to write just means the next request
    // regenerates it — not worth interrupting anyone over, same call
    // writeAutosave already makes about a failed autosave.
    try { fs.unlinkSync(tmp); } catch {}
  }
}

const WAVEFORM_SAMPLE_RATE = 8000;
const WAVEFORM_PEAKS_PER_SECOND = 100;
const THUMBNAIL_WIDTH = 120;

/**
 * Peak waveform data for the timeline: one [min, max] pair per 1/100s across
 * the WHOLE source file, not the clip's current trim — see
 * shared/media-cache.js's pcmToPeaks for why indexing it that way is what
 * lets a trimmed or re-widened clip redraw from this same array instead of
 * asking ffmpeg again. Cached to disk per source, and the renderer keeps its
 * own in-memory copy on top so scrolling or re-rendering the timeline never
 * reaches this handler for a source it already has.
 */
ipcMain.handle('media:waveform', async (_e, filePath) => {
  if (!FFMPEG) throw new Error('ffmpeg not found.');
  const stat = fs.statSync(filePath);
  const cached = readCache(waveformCacheDir(), filePath, stat);
  if (cached) return cached;

  const tmp = path.join(os.tmpdir(), `cutroom-wave-${Date.now()}.pcm`);
  try {
    await new Promise((resolve, reject) => {
      const args = mediaCache.waveformExtractArgs(filePath, tmp, { sampleRate: WAVEFORM_SAMPLE_RATE });
      const p = spawn(FFMPEG, args);
      p.on('close', c => (c === 0 ? resolve() : reject(new Error('Could not read audio for the waveform.'))));
      p.on('error', reject);
    });

    const peaks = mediaCache.pcmToPeaks(fs.readFileSync(tmp), {
      sampleRate: WAVEFORM_SAMPLE_RATE,
      peaksPerSecond: WAVEFORM_PEAKS_PER_SECOND
    });
    const record = { size: stat.size, mtimeMs: stat.mtimeMs, peaksPerSecond: WAVEFORM_PEAKS_PER_SECOND, peaks };
    writeCache(waveformCacheDir(), filePath, record);
    return record;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
});

/**
 * A filmstrip's worth of frames spread across the WHOLE source file, same
 * reasoning as the waveform above. shared/media-cache.js's
 * thumbnailTimestamps caps how many a feature-length source can ask for, and
 * thumbnailExtractArgs grabs all of them in one ffmpeg pass via `fps=`
 * rather than one process per frame — media:frame's single `-ss`-before-`-i`
 * shape (above) is right for the eyedropper's one arbitrary, exact
 * timestamp, but does not extend to "N frames, evenly spread" without N
 * separate processes, so this is a variant rather than a reuse of it.
 */
ipcMain.handle('media:thumbnails', async (_e, filePath) => {
  if (!FFMPEG) throw new Error('ffmpeg not found.');
  const stat = fs.statSync(filePath);
  const cached = readCache(thumbnailCacheDir(), filePath, stat);
  if (cached) return cached;

  let duration = 0;
  if (FFPROBE) {
    try {
      const json = await new Promise((resolve, reject) => {
        execFile(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', filePath],
          { maxBuffer: 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout))));
      });
      duration = Number(json.format?.duration) || 0;
    } catch { /* Probe failed; fall through with duration 0 -> a single frame at 0. */ }
  }

  const timestamps = mediaCache.thumbnailTimestamps(duration);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutroom-thumbs-'));
  try {
    const pattern = path.join(tmpDir, 'thumb-%03d.png');
    const args = mediaCache.thumbnailExtractArgs(filePath, pattern, {
      count: timestamps.length,
      durationSec: duration,
      width: THUMBNAIL_WIDTH
    });
    await new Promise((resolve, reject) => {
      const p = spawn(FFMPEG, args);
      p.on('close', c => (c === 0 ? resolve() : reject(new Error('Could not grab thumbnail frames.'))));
      p.on('error', reject);
    });

    // ffmpeg numbers frames in the order it emitted them, which is playback
    // order for `fps=` — so a sorted directory listing lines back up with
    // `timestamps` position for position.
    const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.png')).sort();
    const frames = files.map((f, i) => ({
      atSec: timestamps[i] ?? timestamps[timestamps.length - 1],
      dataUrl: `data:image/png;base64,${fs.readFileSync(path.join(tmpDir, f)).toString('base64')}`
    }));

    const record = { size: stat.size, mtimeMs: stat.mtimeMs, width: THUMBNAIL_WIDTH, frames };
    writeCache(thumbnailCacheDir(), filePath, record);
    return record;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// --------------------------------------------------------------------------
// Export
// --------------------------------------------------------------------------

ipcMain.handle('export:preview-command', async (_e, project) => {
  const assPath = path.join(os.tmpdir(), 'cutroom-captions.ass');
  const { args, mode } = builder.buildExportCommand(project, '<output>.mp4', { assPath });
  return { mode, command: `ffmpeg ${args.map(quoteArg).join(' ')}` };
});

function quoteArg(a) {
  return /[\s'"();|&<>]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

ipcMain.handle('export:run', async (_e, { project, previewSeconds }) => {
  if (!FFMPEG) throw new Error('ffmpeg not found. Install ffmpeg and restart.');

  const defaultName = previewSeconds
    ? `${project.name || 'cutroom'}-preview.mp4`
    : `${project.name || 'cutroom'}.mp4`;

  const res = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('videos'), defaultName),
    filters: [{ name: 'MP4', extensions: ['mp4'] }]
  });
  if (res.canceled) return { canceled: true };

  // Captions get written to a temp .ass file that ffmpeg burns in.
  let assPath = null;
  if (project.captionsEnabled && (project.captions || []).length) {
    assPath = path.join(os.tmpdir(), `cutroom-${Date.now()}.ass`);
    fs.writeFileSync(assPath, builder.buildAssFile(project), 'utf8');
  }

  const { args, mode, duration } = builder.buildExportCommand(project, res.filePath, {
    assPath,
    previewSeconds,
    crf: project.crf ?? 20,
    preset: project.preset || 'medium'
  });

  return new Promise((resolve) => {
    const proc = spawn(FFMPEG, args);
    currentExport = proc;
    let log = '';

    proc.stderr.on('data', chunk => {
      const text = chunk.toString();
      log += text;
      if (log.length > 200000) log = log.slice(-100000);

      // ffmpeg reports progress as "time=00:00:04.20" on stderr.
      const m = text.match(/time=(\d+):(\d{2}):(\d{2})\.(\d{2})/);
      if (m && win) {
        const secs = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 100;
        win.webContents.send('export:progress', {
          percent: Math.min(100, Math.round((secs / duration) * 100)),
          seconds: secs
        });
      }
    });

    proc.on('error', err => {
      currentExport = null;
      resolve({ ok: false, error: err.message, log });
    });

    proc.on('close', code => {
      currentExport = null;
      if (assPath) { try { fs.unlinkSync(assPath); } catch {} }
      if (code === 0) {
        resolve({ ok: true, path: res.filePath, mode });
      } else {
        // The last few lines of ffmpeg stderr are where the real error is.
        const tail = log.trim().split('\n').slice(-12).join('\n');
        resolve({ ok: false, error: tail || `ffmpeg exited with code ${code}`, log });
      }
    });
  });
});

ipcMain.handle('export:cancel', async () => {
  if (currentExport) { currentExport.kill('SIGKILL'); currentExport = null; return true; }
  return false;
});

ipcMain.handle('shell:reveal', async (_e, filePath) => {
  shell.showItemInFolder(filePath);
});

// --------------------------------------------------------------------------
// Auto-captions
// --------------------------------------------------------------------------

/**
 * Transcription runs in two stages:
 *   1. ffmpeg pulls a 16kHz mono wav out of the timeline audio
 *   2. whisper turns that into an SRT we parse
 *
 * If whisper is not installed we say so plainly rather than failing silently.
 * Importing an .srt from anywhere else is always available as a fallback.
 *
 * Both whisper backends are asked for one SRT cue per WORD rather than
 * whisper's own natural sentence segmentation:
 *   - whisper.cpp: `-ml 1 -sow` (max segment length 1 character, forced to
 *     split only on word boundaries). `-ml 1` alone is not enough — without
 *     `-sow` whisper.cpp splits on raw BPE tokens, which are frequently
 *     sub-word pieces, so a segment can end mid-word. `-sow` restricts the
 *     split points to tokens that begin a new word, which is what actually
 *     gets one whole word per line. (Verified against whisper.cpp's own
 *     source — `should_split_on_word`/`whisper_wrap_segment` in
 *     src/whisper.cpp — not against a real binary; see the README.)
 *   - openai-whisper: `--word_timestamps True --max_words_per_line 1`. Also
 *     verified from source (whisper/utils.py's `SubtitlesWriter`): with no
 *     `--max_line_width` set, every word starts a new subtitle cue.
 * `groupWordsIntoCaptions` then re-assembles those one-word cues into
 * sentence/phrase-sized caption rows for the editor, keeping each word's own
 * timing on the row for real per-word karaoke.
 */
ipcMain.handle('captions:transcribe', async (_e, { sourcePath, language }) => {
  const whisper = findBinary(['whisper-cli', 'whisper']);
  if (!whisper) {
    return {
      ok: false,
      error: 'No local whisper found. Install whisper.cpp (brew install whisper-cpp) ' +
             'or openai-whisper (pip install -U openai-whisper), then restart Cutroom. ' +
             'You can also import an .srt file instead.'
    };
  }
  if (!FFMPEG) return { ok: false, error: 'ffmpeg not found.' };

  const tmpWav = path.join(os.tmpdir(), `cutroom-${Date.now()}.wav`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutroom-tx-'));

  try {
    // Whisper wants 16kHz mono PCM. Anything else and quality drops.
    await new Promise((resolve, reject) => {
      const p = spawn(FFMPEG, ['-y', '-i', sourcePath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', tmpWav]);
      p.on('close', c => (c === 0 ? resolve() : reject(new Error('Could not extract audio'))));
      p.on('error', reject);
    });

    const isCpp = /whisper-cli|whisper\.cpp/.test(whisper);
    const args = isCpp
      ? ['-f', tmpWav, '-osrt', '-of', path.join(tmpDir, 'out'), '-l', language || 'auto', '-ml', '1', '-sow']
      : [tmpWav, '--model', 'base', '--output_format', 'srt', '--output_dir', tmpDir,
         '--word_timestamps', 'True', '--max_words_per_line', '1',
         ...(language && language !== 'auto' ? ['--language', language] : [])];

    await new Promise((resolve, reject) => {
      const p = spawn(whisper, args);
      let err = '';
      p.stderr.on('data', d => { err += d.toString(); });
      p.on('close', c => (c === 0 ? resolve() : reject(new Error(err.slice(-400) || 'whisper failed'))));
      p.on('error', reject);
    });

    const srt = fs.readdirSync(tmpDir).find(f => f.endsWith('.srt'));
    if (!srt) return { ok: false, error: 'whisper ran but produced no .srt' };

    // One entry per word (see the comment above). Group them back into
    // caption-sized rows for the editor, carrying real per-word timing along
    // for the ASS writer's karaoke.
    const words = builder.parseSubtitles(fs.readFileSync(path.join(tmpDir, srt), 'utf8'));
    const captions = builder.groupWordsIntoCaptions(words);
    return { ok: true, captions };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    try { fs.unlinkSync(tmpWav); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

ipcMain.handle('captions:import', async () => {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Subtitles', extensions: ['srt', 'vtt'] }]
  });
  if (res.canceled) return null;
  const text = fs.readFileSync(res.filePaths[0], 'utf8');
  return builder.parseSubtitles(text);
});

// --------------------------------------------------------------------------
// Project save / open
// --------------------------------------------------------------------------

/**
 * Save and Save As are one handler, because the difference between them is a
 * single decision — whether to open a dialog — and splitting them would give
 * that decision two places to be made differently.
 *
 * Returns `{ok, path}`, `{canceled}` or `{ok: false, error}`. A plain path
 * would not do: the close guard has to be able to tell "saved" from "the user
 * backed out of the Save dialog", and those have opposite consequences.
 */
ipcMain.handle('project:save', async (_e, { project, saveAs } = {}) => {
  if (!project) return { ok: false, error: 'Nothing to save.' };

  const plan = saveState.savePlan({ filePath: currentPath, saveAs });
  let target = plan.path;

  if (plan.needsDialog) {
    const res = await dialog.showSaveDialog(win, {
      defaultPath: plan.path ||
        path.join(app.getPath('documents'), `${project.name || 'project'}.cutroom.json`),
      filters: [{ name: 'Cutroom project', extensions: ['json'] }]
    });
    if (res.canceled) return { canceled: true };
    target = res.filePath;
  }

  // The version rides on the file, not on the project in memory: it describes
  // the format on disk, and nothing in the editor should start reading it.
  const onDisk = { ...project, version: PROJECT_VERSION };
  try {
    fs.writeFileSync(target, JSON.stringify(onDisk, null, 2), 'utf8');
  } catch (err) {
    // A full disk or a read-only folder has to reach the user as a failure.
    // Reported as not-saved, so a save-on-close that hits this cancels the
    // close instead of quietly closing over the top of the failure.
    return { ok: false, error: `Could not save ${path.basename(target)}.`, detail: String(err.message || err) };
  }

  currentPath = target;
  isDirty = false;
  projectName = project.name || projectName;
  clearAutosave();
  applyWindowTitle();
  return { ok: true, path: target };
});

ipcMain.handle('project:open', async () => {
  const res = await dialog.showOpenDialog(win, {
    // Matches where project:save writes, so a saved project is where this
    // dialog opens by default rather than wherever the OS defaults to.
    defaultPath: app.getPath('documents'),
    properties: ['openFile'],
    filters: [{ name: 'Cutroom project', extensions: ['json'] }]
  });
  if (res.canceled) return null;

  const file = res.filePaths[0];
  const name = path.basename(file);

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    // A truncated or hand-edited file throws here rather than at the shape
    // check below. Letting it escape would cross IPC as a rejected promise
    // that the renderer's `await` never catches, which is the loudest possible
    // way to say nothing at all.
    return { ok: false, error: `${name} could not be read.`, detail: String(err.message || err) };
  }

  const check = validateProject(parsed);
  if (!check.ok) return { ok: false, error: check.error, detail: name };

  // Only now, once the file is known good: this is the path Save writes back
  // to, and pointing it at a file that was refused would be worse than having
  // no path at all.
  currentPath = file;
  isDirty = false;
  projectName = check.project.name || 'untitled';
  clearAutosave();
  applyWindowTitle();
  return { ok: true, project: check.project, filePath: file };
});

/**
 * New. The project the renderer is about to build has never been anywhere, so
 * the file it would be saved back to has to be forgotten here — otherwise the
 * first Save would write a brand new project over the last one.
 */
ipcMain.handle('project:new', async () => {
  currentPath = null;
  isDirty = false;
  projectName = 'untitled';
  clearAutosave();
  applyWindowTitle();
  return { ok: true };
});
