'use strict';

/*
 * A jsdom harness for the integration tests, shared so there is one place that
 * knows how to boot the app and one place to fix when that changes.
 *
 * Not named *.test.js, so `node --test test/*.test.js` loads it as a module
 * rather than running it as a suite.
 */

const fs = require('node:fs');
const path = require('node:path');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch { /* handled by `opts` below */ }

// jsdom is a devDependency, so this normally runs. If someone has installed
// production deps only, skip rather than failing the whole suite.
const opts = JSDOM ? {} : { skip: 'jsdom not installed' };

const SRC = path.join(__dirname, '..', 'src');

/** A media item shaped like what main.js's ffprobe handler returns. */
function fakeMedia(name, duration = 10, colorMatrix = 'bt601') {
  return {
    path: `/tmp/${name}`,
    name,
    duration,
    width: 1920,
    height: 1080,
    fps: 30,
    hasVideo: true,
    hasAudio: true,
    // main.js always resolves a name — 'bt601' here stands for the untagged
    // case as much as a real BT.601 tag, matching matrixNameFromTags' default.
    colorMatrix
  };
}

/**
 * Boot the app in a DOM. Scripts are evaluated by hand, in the order the HTML
 * loads them, so the preload stub can be installed before app.js runs.
 */
function boot() {
  const raw = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');

  // Read the script list out of the page rather than repeating it here, so
  // adding a module to index.html cannot leave these tests booting a different
  // app from the one that ships.
  const scripts = [...raw.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);

  const html = raw
    // Scripts are injected manually below; let jsdom skip fetching them.
    .replace(/<script src=.*?<\/script>/g, '');

  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
  const win = dom.window;
  const doc = win.document;

  // jsdom has no layout and no pointer capture. Neither affects the code
  // paths under test, but both are called on the way through them.
  doc.elementFromPoint = () => null;
  win.HTMLElement.prototype.setPointerCapture = () => {};
  win.HTMLElement.prototype.releasePointerCapture = () => {};

  // jsdom has no WebGL either. Returning null is exactly what a real browser
  // without it does, and it is the case app.js has to degrade through — but
  // jsdom's own getContext logs a "not implemented" error on the way, so it is
  // replaced rather than left to complain. Selecting a clip below therefore
  // exercises the fallback to the plain <video> for real.
  win.HTMLCanvasElement.prototype.getContext = () => null;

  // Stand-in for preload.js. Only the calls the boot path makes need to work.
  win.cutroom = {
    checkEnv: async () => ({ ffmpeg: '/usr/bin/ffmpeg', ffprobe: null, whisper: null, platform: 'linux' }),
    previewCommand: async () => ({ mode: 'filter', command: 'ffmpeg ...' }),
    probe: async (p) => fakeMedia(path.basename(p)),
    grabFrame: async () => '',
    pickMedia: async () => [],
    runExport: async () => ({ canceled: true }),
    cancelExport: async () => {},
    onExportProgress: () => () => {},
    transcribe: async () => ({ ok: false, error: 'no whisper' }),
    importCaptions: async () => null,
    saveProject: async () => null,
    openProject: async () => null,
    reveal: () => {},
    pathForFile: () => null
  };

  // Injected as real <script> elements rather than eval'd: top-level `const`
  // in a classic script lands in the shared global scope, which is how
  // app.js reaches TEMPLATES and createHistory in the actual app.
  for (const file of scripts) {
    const el = doc.createElement('script');
    el.textContent = fs.readFileSync(path.join(SRC, file), 'utf8');
    doc.body.appendChild(el);
  }

  return { dom, win, doc };
}

/**
 * Get media into the bin. The app's state is private, so this goes through
 * the drop handler on `document` — the same path a real drag-and-drop takes.
 */
function seedBin(win, doc, names = ['a.mp4', 'b.mp4']) {
  const files = names.map(n => ({ name: n }));
  win.cutroom.pathForFile = (f) => `/tmp/${f.name}`;
  const ev = new win.Event('drop', { bubbles: true, cancelable: true });
  ev.dataTransfer = { files };
  doc.dispatchEvent(ev);
}

const flush = () => new Promise(r => setTimeout(r, 0));
const clipCount = (doc) => doc.querySelectorAll('#lanes .clip').length;

module.exports = { JSDOM, opts, SRC, fakeMedia, boot, seedBin, flush, clipCount };
