'use strict';

/*
 * Shared plumbing for test/electron/*.test.js, split out once a second file
 * needed it — mirrors test/dom-harness.js's role for the jsdom tier. Not
 * named *.test.js, so `node --test test/electron/*.test.js` loads it as a
 * module rather than running it as a suite.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * The path.txt + dist/<name> check electron/index.js itself does — read
 * directly rather than through `require('electron')`, because that call
 * downloads the binary on demand if it is missing, which is exactly the
 * surprise a "skip cleanly" check must not cause.
 */
function electronBinaryPath() {
  let pkgDir;
  try {
    pkgDir = path.dirname(require.resolve('electron/package.json'));
  } catch {
    return null; // electron is not even an installed dependency here.
  }
  const pathFile = path.join(pkgDir, 'path.txt');
  if (!fs.existsSync(pathFile)) return null;
  const exeName = fs.readFileSync(pathFile, 'utf8').trim();
  const full = path.join(pkgDir, 'dist', exeName);
  return fs.existsSync(full) ? full : null;
}

const ELECTRON_PATH = electronBinaryPath();
// Linux has no display server by default; macOS and Windows always have one.
// This is the same headless-CI reality xvfb-run exists to paper over.
const HAS_DISPLAY = process.platform !== 'linux' ||
  Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

const electronSkipReason = !ELECTRON_PATH
  ? 'Electron binary not downloaded (ELECTRON_SKIP_BINARY_DOWNLOAD, or never installed)'
  : !HAS_DISPLAY
    ? 'no DISPLAY to render into'
    : null;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Poll fn() until it returns truthy, or throw once ms have passed. */
async function waitFor(fn, { timeout = 5000, interval = 50, message = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`);
    await sleep(interval);
  }
}

/**
 * A fresh app per test, with its own userData dir, so autosave files and
 * dirty state from one test can never leak into the next. --no-sandbox
 * because this and most CI containers run Chromium as root, where the
 * sandbox's setuid helper cannot work — the same accommodation headless
 * Electron-in-CI setups make everywhere.
 *
 * `initScript`, when given, is registered on the app's BrowserContext
 * (`app.context().addInitScript(...)`) before `firstWindow()` is ever
 * awaited — the one ordering that has a chance of landing before the main
 * window's first navigation finishes, since by the time a caller has a
 * `page` to call `page.addInitScript` on, that page may already have run
 * its first script. Needed for a test that has to patch something (WebGL
 * context creation, say) before app.js's own boot-time code gets to run
 * for the first time — see test/electron/caption-preview.test.js's
 * no-WebGL-fallback case, where a mid-session patch would be a no-op.
 */
async function launchApp(extraArgs = [], { userDataDir, initScript } = {}) {
  // A caller re-launching against the same dir (to prove a disk cache — the
  // waveform/thumbnail cache, or a real autosave recovery file — survives a
  // fresh process) passes one in; everyone else gets a clean one per launch.
  if (!userDataDir) userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutroom-electron-test-'));
  const app = await electron.launch({
    executablePath: ELECTRON_PATH,
    args: [
      REPO_ROOT, `--user-data-dir=${userDataDir}`, '--no-sandbox',
      // Xvfb has no real GPU behind it. Without this the GPU process can
      // hang trying to initialize hardware acceleration that was never
      // there, stalling the window before it ever finishes loading — this
      // tier does not test rendering output (see README), only that the app
      // boots and its main-process wiring behaves, so software compositing
      // is fine.
      '--disable-gpu',
      ...extraArgs
    ]
  });
  if (initScript) await app.context().addInitScript(initScript);
  const page = await app.firstWindow();
  return { app, page, userDataDir };
}

/**
 * A regressed close guard can leave the main process genuinely stuck inside
 * a real, unanswered dialog.showMessageBox — exactly the failure this file
 * exists to catch — and a graceful app.close() waits on that main process.
 * Bounded so a real bug fails this file promptly instead of hanging the job
 * until CI's own outer timeout eventually kills it.
 */
async function closeApp(app) {
  try {
    await Promise.race([
      app.close(),
      sleep(5000).then(() => { throw new Error('app.close() timed out'); })
    ]);
  } catch {
    try { app.process().kill('SIGKILL'); } catch { /* already gone */ }
  }
}

module.exports = { REPO_ROOT, ELECTRON_PATH, HAS_DISPLAY, electronSkipReason, sleep, waitFor, launchApp, closeApp };
