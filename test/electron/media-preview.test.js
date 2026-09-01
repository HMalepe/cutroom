'use strict';

/*
 * Drives the real Electron binary with a real ffmpeg-generated source, to
 * prove the one thing nothing else in this suite can: that a waveform
 * canvas and a thumbnail filmstrip actually paint real, non-blank pixels.
 * test/media-preview-integration.test.js proves the wiring in jsdom with a
 * spy 2D context — but jsdom has no real canvas at all, so it cannot see
 * whether what reaches the screen is really drawn, and
 * test/media-cache-render.test.js proves ffmpeg accepts the extraction
 * commands and returns sane PCM/PNGs, but never through the app's own IPC
 * round trip or a real <canvas>. This file is the one place all three —
 * real ffmpeg, real IPC, real Canvas 2D — run together.
 *
 * Skips cleanly, layering test/electron/smoke.test.js's Electron/display
 * check with test/ffmpeg-render.test.js's ffmpeg probe: this feature has
 * nothing to show without both.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { electronSkipReason, waitFor, launchApp, closeApp } = require('./harness');

function probe(bin) {
  try {
    return spawnSync(bin, ['-version'], { encoding: 'utf8' }).status === 0;
  } catch { return false; }
}
const HAS_FFMPEG = probe('ffmpeg');

const skipReason = electronSkipReason || (HAS_FFMPEG ? null : 'ffmpeg not on PATH');
const opts = skipReason ? { skip: skipReason } : {};

let FIXTURE = null;
function fixture() {
  if (FIXTURE) return FIXTURE;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutroom-electron-media-'));
  const file = path.join(dir, 'fixture.mp4');
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x240:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file
  ], { encoding: 'utf8' });
  assert.equal(r.status, 0, `fixture generation failed:\n${r.stderr}`);
  FIXTURE = file;
  return file;
}

/**
 * Add the fixture through the real "Add Video" button and real media:pick /
 * media:probe IPC (stubbing only the native dialog, same technique
 * smoke.test.js uses for showMessageBox), then send it to Video 1.
 */
async function addAndPlaceFixture(app, page, src) {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, src);

  await page.click('#btnAddVideo');
  await waitFor(
    () => page.evaluate(() => document.querySelectorAll('#binList .bin-item').length > 0),
    { message: 'the fixture to appear in the bin' }
  );

  await page.click('#binList .bin-item');
  await page.click('#btnSendV1'); // video track: both waveform and thumbnail strip apply
}

test('a real clip paints real, non-blank waveform and thumbnail pixels', opts, async () => {
  const { app, page } = await launchApp();
  try {
    const src = fixture();
    await addAndPlaceFixture(app, page, src);

    // ensureWaveform/ensureThumbnails fire their IPC calls on this render and
    // redraw once each resolves — real ffmpeg extraction plus two IPC round
    // trips, not instantaneous, hence the generous timeout.
    const hasCanvas = await waitFor(
      () => page.evaluate(() => Boolean(document.querySelector('.clip-waveform'))),
      { timeout: 15000, message: 'a waveform canvas to appear' }
    );
    assert.equal(hasCanvas, true);

    const wavePainted = await waitFor(async () => page.evaluate(() => {
      const canvas = document.querySelector('.clip-waveform');
      if (!canvas.width || !canvas.height) return false;
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      // Bars are drawn with a non-zero alpha fill; a canvas nothing painted
      // into stays all-zero (transparent black) end to end.
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
      return false;
    }), { timeout: 15000, message: 'the waveform canvas to contain real painted pixels' });
    assert.equal(wavePainted, true, 'expected real, non-blank pixels in the waveform canvas');

    const framePainted = await waitFor(async () => page.evaluate(() => {
      const img = document.querySelector('.clip-thumb-frame');
      return Boolean(img && img.complete && img.naturalWidth > 0);
    }), { timeout: 15000, message: 'a thumbnail frame to decode' });
    assert.equal(framePainted, true, 'expected a real, decoded thumbnail frame image');
  } finally {
    await closeApp(app);
  }
});

test('the disk cache survives a fresh process: a second launch does not regenerate it', opts, async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutroom-electron-media-cache-'));
  const src = fixture();

  const first = await launchApp([], { userDataDir });
  try {
    await addAndPlaceFixture(first.app, first.page, src);
    await waitFor(
      () => first.page.evaluate(() => Boolean(document.querySelector('.clip-thumb-frame'))),
      { timeout: 15000, message: 'the first launch to finish generating both caches' }
    );
  } finally {
    await closeApp(first.app);
  }

  const waveDir = path.join(userDataDir, 'waveform-cache');
  const thumbDir = path.join(userDataDir, 'thumbnail-cache');
  const waveFile = path.join(waveDir, fs.readdirSync(waveDir)[0]);
  const thumbFile = path.join(thumbDir, fs.readdirSync(thumbDir)[0]);
  const waveMtimeBefore = fs.statSync(waveFile).mtimeMs;
  const thumbMtimeBefore = fs.statSync(thumbFile).mtimeMs;

  // A brand new process, same userData: readCache's isCacheFresh check
  // should hit before ffmpeg is ever spawned a second time. If it did not,
  // writeCache's tmp-then-rename would give the file a new mtime.
  const second = await launchApp([], { userDataDir });
  try {
    await addAndPlaceFixture(second.app, second.page, src);
    await waitFor(
      () => second.page.evaluate(() => Boolean(document.querySelector('.clip-thumb-frame'))),
      { timeout: 15000, message: 'the second launch to finish drawing from the cache' }
    );
  } finally {
    await closeApp(second.app);
  }

  assert.equal(fs.statSync(waveFile).mtimeMs, waveMtimeBefore, 'waveform cache file was rewritten on the second launch');
  assert.equal(fs.statSync(thumbFile).mtimeMs, thumbMtimeBefore, 'thumbnail cache file was rewritten on the second launch');
});
