'use strict';

/*
 * Drives the real app.js against the real index.html in a DOM, the same way
 * test/snapping-integration.test.js and test/key-preview.test.js do — proving
 * the wiring test/waveform-render.test.js and test/thumbnail-render.test.js
 * can't: that placing a clip on the timeline actually asks main for its
 * waveform/thumbnails through the stubbed IPC, draws what comes back, and —
 * the point of caching per source rather than per clip — that a burst of
 * re-renders or a second clip sharing the same file never asks twice.
 *
 * jsdom has no real canvas, so `HTMLCanvasElement.getContext` is replaced
 * here with a small spy recording its calls, proving drawWaveform actually
 * reaches ctx.fillRect with real data rather than only proving a canvas
 * element exists. Whether those fillRect calls land the right pixels on a
 * real screen is what test/electron/media-preview.test.js checks against a
 * real Electron canvas; this file cannot see pixels at all.
 *
 * dom-harness's default env:check stub already reports ffmpeg present, which
 * is what every test but the "no ffmpeg" one below relies on — only that one
 * overrides `window.cutroom.checkEnv` and re-runs `window.checkEnv()` (a
 * function *declaration*, so it — unlike `state`, a `const` — is reachable
 * as a property of the booted window) to pick the override up after boot.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { opts, boot, flush } = require('./dom-harness.js');

/** A 2D-context spy shared by every canvas — fine here, tests use one clip at a time. */
function installCanvasSpy(win) {
  const calls = { fillRect: [], clearRect: [] };
  win.HTMLCanvasElement.prototype.getContext = function () {
    return {
      fillStyle: '',
      fillRect: (...args) => calls.fillRect.push(args),
      clearRect: (...args) => calls.clearRect.push(args)
    };
  };
  return calls;
}

/** Send the bin item at `index` to `trackId`, the way clicking it and Send does. */
function sendItem(win, doc, index, trackId) {
  const items = doc.querySelectorAll('#binList .bin-item');
  items[index].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  doc.getElementById(`btnSend${trackId.toUpperCase()}`).click();
}

function dropOne(win, doc, name) {
  win.cutroom.pathForFile = () => `/tmp/${name}`;
  const ev = new win.Event('drop', { bubbles: true, cancelable: true });
  ev.dataTransfer = { files: [{ name }] };
  doc.dispatchEvent(ev);
}

const WAVE_RECORD = { size: 1, mtimeMs: 1, peaksPerSecond: 10, peaks: [-1, 1, -0.2, 0.2] };
const THUMB_RECORD = {
  size: 1, mtimeMs: 1, width: 120,
  frames: [{ atSec: 0, dataUrl: 'data:image/png;base64,AAA' }, { atSec: 2, dataUrl: 'data:image/png;base64,BBB' }]
};

test('placing a clip with audio fetches its waveform once and draws bars into a real 2D context', opts, async () => {
  const { win, doc } = boot();
  const calls = installCanvasSpy(win);
  let waveformRequests = 0;
  win.cutroom.getWaveform = async () => { waveformRequests++; return WAVE_RECORD; };
  win.cutroom.getThumbnails = async () => { throw new Error('no video fixture'); };

  await flush(); // let the boot-time env:check resolve before any clip exists
  dropOne(win, doc, 'song.mp3');
  await flush();
  sendItem(win, doc, 0, 'a1'); // an audio-track clip: waveform only, no thumbnails
  await flush();
  await flush(); // one more tick for the redraw ensureWaveform's .then() schedules

  const canvas = doc.querySelector('.clip-waveform');
  assert.ok(canvas, 'expected a waveform canvas on the audio clip');
  assert.equal(waveformRequests, 1, 'expected exactly one waveform IPC call');
  assert.ok(calls.fillRect.length > 0, 'expected drawWaveform to actually paint bars');
});

test('a burst of re-renders (zoom) never asks for the same source twice', opts, async () => {
  const { win, doc } = boot();
  installCanvasSpy(win);
  let waveformRequests = 0;
  win.cutroom.getWaveform = async () => { waveformRequests++; return WAVE_RECORD; };
  win.cutroom.getThumbnails = async () => { throw new Error('no video fixture'); };

  await flush();
  dropOne(win, doc, 'song.mp3');
  await flush();
  sendItem(win, doc, 0, 'a1');
  await flush();
  await flush();
  assert.equal(waveformRequests, 1);

  // Zoom fires renderTimeline(), which rebuilds every clip element from
  // scratch — exactly the re-render this feature has to survive without
  // re-invoking ffmpeg for a source it already has.
  for (let i = 0; i < 5; i++) doc.getElementById('btnZoomIn').click();
  await flush();

  assert.equal(waveformRequests, 1, 'zooming re-rendered the timeline but should not re-fetch a cached source');
});

test('two clips sharing one source file (a split) fetch it once between them', opts, async () => {
  const { win, doc } = boot();
  installCanvasSpy(win);
  let waveformRequests = 0;
  win.cutroom.getWaveform = async () => { waveformRequests++; return WAVE_RECORD; };
  win.cutroom.getThumbnails = async () => THUMB_RECORD;

  await flush();
  dropOne(win, doc, 'clip.mp4');
  await flush();
  sendItem(win, doc, 0, 'v1');
  await flush();
  await flush();
  assert.equal(waveformRequests, 1);

  // Select the clip, move the playhead inside it, and split — the way
  // clicking the clip then pressing 'S' does. Two clips now share one src.
  const clipEl = doc.querySelector('.track-lane[data-track-id="v1"] .clip');
  clipEl.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 5 }));
  doc.getElementById('tlScroll').dispatchEvent(new win.MouseEvent('pointerup', { bubbles: true, clientX: 5, clientY: 5 }));
  doc.getElementById('tlScroll').dispatchEvent(
    new win.MouseEvent('pointerdown', { bubbles: true, clientX: 200, clientY: 5 })
  );
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 's', bubbles: true }));
  await flush();
  await flush();

  const clipCount = doc.querySelectorAll('.track-lane[data-track-id="v1"] .clip').length;
  assert.equal(clipCount, 2, 'expected the split to produce two clips');
  assert.equal(waveformRequests, 1, 'both clips share one source file and should share one fetch');
});

test('thumbnails render as a filmstrip positioned by the clip\'s trim', opts, async () => {
  const { win, doc } = boot();
  installCanvasSpy(win);
  win.cutroom.getWaveform = async () => WAVE_RECORD;
  win.cutroom.getThumbnails = async () => THUMB_RECORD;

  await flush();
  dropOne(win, doc, 'clip.mp4');
  await flush();
  sendItem(win, doc, 0, 'v1');
  await flush();
  await flush();

  const frames = doc.querySelectorAll('.clip-thumb-frame');
  assert.ok(frames.length > 0, 'expected filmstrip frames to render');
  assert.equal(frames[0].src, THUMB_RECORD.frames[0].dataUrl);
});

test('degrades without ffmpeg: no IPC calls are made, the clip stays plain', opts, async () => {
  const { win, doc } = boot();
  installCanvasSpy(win);
  let waveformRequests = 0;
  let thumbnailRequests = 0;
  win.cutroom.getWaveform = async () => { waveformRequests++; return WAVE_RECORD; };
  win.cutroom.getThumbnails = async () => { thumbnailRequests++; return THUMB_RECORD; };
  // env:check's boot-time call already ran against dom-harness's default
  // (ffmpeg present) before this line — window.checkEnv is reachable
  // because it is a function *declaration* in app.js, not a `const`, so
  // re-running it here is what makes the override below actually apply.
  win.cutroom.checkEnv = async () => ({ ffmpeg: null, whisper: null, platform: 'linux' });
  await win.checkEnv();

  dropOne(win, doc, 'clip.mp4');
  await flush();
  sendItem(win, doc, 0, 'v1');
  await flush();
  await flush();

  assert.equal(waveformRequests, 0, 'ffmpeg is missing; nothing should ask main for a waveform');
  assert.equal(thumbnailRequests, 0, 'ffmpeg is missing; nothing should ask main for thumbnails');
  // The clip element itself still renders, just without media painted into it.
  assert.ok(doc.querySelector('.track-lane[data-track-id="v1"] .clip'));
});

test('a failed fetch is remembered, not retried on every subsequent re-render', opts, async () => {
  const { win, doc } = boot();
  installCanvasSpy(win);
  let waveformRequests = 0;
  win.cutroom.getWaveform = async () => { waveformRequests++; throw new Error('ffmpeg exited 1'); };
  win.cutroom.getThumbnails = async () => { throw new Error('no video fixture'); };

  await flush();
  dropOne(win, doc, 'broken.mp3');
  await flush();
  sendItem(win, doc, 0, 'a1');
  await flush();
  await flush();
  assert.equal(waveformRequests, 1);

  for (let i = 0; i < 3; i++) doc.getElementById('btnZoomIn').click();
  await flush();

  assert.equal(waveformRequests, 1, 'a source that already failed should not be retried on every re-render');
});
