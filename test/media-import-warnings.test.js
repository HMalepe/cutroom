'use strict';

/*
 * Drives addPaths (src/app.js) against the real app.js in jsdom, a stubbed
 * win.cutroom.probe standing in for main.js's media:probe — the same shape
 * media-relink-integration.test.js uses. main.js's own real-ffprobe
 * measurement of keyframeIntervalSec is covered by
 * test/media-cache-render.test.js; this only proves app.js's addPaths reacts
 * to that field the way it is meant to: a toast when a probed file's
 * keyframeIntervalSec exceeds SPARSE_KEYFRAME_THRESHOLD_SEC, no toast when it
 * does not (including the null "not measured" case), and the import itself
 * always succeeds either way — this is advisory, not a block.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { opts, boot, flush } = require('./dom-harness.js');

const toasts = (doc) => [...doc.querySelectorAll('#toasts .toast')].map(t => t.textContent);

/** Drop one file into the bin, with main.js's probe reporting a given keyframeIntervalSec. */
async function dropWithKeyframeInterval(win, doc, name, keyframeIntervalSec) {
  const absolutePath = `/media/${name}`;
  win.cutroom.pathForFile = () => absolutePath;
  win.cutroom.probe = async () => ({
    path: absolutePath, name, duration: 10, width: 1920, height: 1080,
    fps: 30, hasVideo: true, hasAudio: true, colorMatrix: 'bt601',
    keyframeIntervalSec
  });
  const ev = new win.Event('drop', { bubbles: true, cancelable: true });
  ev.dataTransfer = { files: [{ name }] };
  doc.dispatchEvent(ev);
  await flush();
}

test('importing a source with a wide keyframe interval warns and still adds it to the bin', opts, async () => {
  const { win, doc } = boot();
  await dropWithKeyframeInterval(win, doc, 'sparse.mp4', 12);

  const warn = doc.querySelector('#toasts .toast.warn');
  assert.ok(warn, 'expected a warn toast for a sparse-keyframe source');
  assert.match(warn.textContent, /sparse\.mp4/);
  assert.match(warn.textContent, /keyframe/i);
  assert.equal(doc.querySelectorAll('#binList .bin-item').length, 1,
    'the source should still land in the bin — this is advisory, not a block');
});

test('importing a source with an ordinary keyframe interval does not warn', opts, async () => {
  const { win, doc } = boot();
  await dropWithKeyframeInterval(win, doc, 'dense.mp4', 1.5);

  assert.equal(toasts(doc).some(t => /keyframe/i.test(t)), false,
    'an ordinary keyframe interval should not trigger the sparse-keyframe warning');
  assert.equal(doc.querySelectorAll('#binList .bin-item').length, 1);
});

test('importing a source main.js could not measure a keyframe interval for (null) does not warn', opts, async () => {
  const { win, doc } = boot();
  await dropWithKeyframeInterval(win, doc, 'unmeasured.mp4', null);

  assert.equal(toasts(doc).some(t => /keyframe/i.test(t)), false,
    'insufficient-data (null) must not be treated as sparse');
  assert.equal(doc.querySelectorAll('#binList .bin-item').length, 1);
});

test('a keyframe interval exactly at the threshold does not warn — the warning is for sources past it', opts, async () => {
  const { win, doc } = boot();
  await dropWithKeyframeInterval(win, doc, 'boundary.mp4', 8);

  assert.equal(toasts(doc).some(t => /keyframe/i.test(t)), false,
    'exactly at the threshold should read as not sparse, matching a strict > in addPaths');
});
