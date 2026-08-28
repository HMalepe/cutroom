/*
 * main.js — Electron main process.
 * Owns: the window, the filesystem, and every child process.
 * The renderer never touches disk or spawns anything directly.
 */

'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const builder = require('./shared/ffmpeg-builder');

let win = null;
let currentExport = null;

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
    title: 'Cutroom',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
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
 */
ipcMain.handle('media:probe', async (_e, filePath) => {
  if (!FFPROBE) throw new Error('ffprobe not found. Install ffmpeg first.');
  const args = [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-show_entries', 'stream=codec_type,width,height,r_frame_rate',
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
    hasAudio: Boolean(a)
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
      ? ['-f', tmpWav, '-osrt', '-of', path.join(tmpDir, 'out'), '-l', language || 'auto']
      : [tmpWav, '--model', 'base', '--output_format', 'srt', '--output_dir', tmpDir,
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

    const captions = builder.parseSubtitles(fs.readFileSync(path.join(tmpDir, srt), 'utf8'));
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

ipcMain.handle('project:save', async (_e, project) => {
  const res = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('documents'), `${project.name || 'project'}.cutroom.json`),
    filters: [{ name: 'Cutroom project', extensions: ['json'] }]
  });
  if (res.canceled) return null;
  fs.writeFileSync(res.filePath, JSON.stringify(project, null, 2), 'utf8');
  return res.filePath;
});

ipcMain.handle('project:open', async () => {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Cutroom project', extensions: ['json'] }]
  });
  if (res.canceled) return null;
  return JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8'));
});
