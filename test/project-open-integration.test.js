'use strict';

/*
 * Drives Open Project against the real app.js in a DOM.
 *
 * project-schema.test.js proves the shape check decides correctly. This proves
 * the decision is actually wired to the button: that a refused file produces a
 * message rather than a half-drawn window, and — the part that matters most —
 * that the project already open is still there afterwards.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { opts, boot, seedBin, flush, clipCount } = require('./dom-harness.js');

/** Boot the app with two clips on Video 1, so there is something to lose. */
async function bootWithWork() {
  const { win, doc } = boot();
  seedBin(win, doc);
  await flush();
  doc.querySelectorAll('#binList .bin-item').forEach(el => {
    el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, ctrlKey: true }));
  });
  doc.getElementById('btnSendV1').click();
  assert.equal(clipCount(doc), 2, 'set-up: two clips on the timeline');
  return { win, doc };
}

const toasts = (doc) => [...doc.querySelectorAll('#toasts .toast')].map(t => t.textContent);

test('a refused project leaves the open one alone and says so', opts, async () => {
  const { win, doc } = await bootWithWork();

  // What main.js returns for a file that parsed but is not a project.
  win.cutroom.openProject = async () => ({
    ok: false, error: 'That project has no track list.', detail: 'notes.json'
  });

  doc.getElementById('btnOpen').click();
  await flush();

  assert.equal(clipCount(doc), 2, 'the project on screen survived the bad file');
  const shown = toasts(doc).join('\n');
  assert.match(shown, /Could not open that project/);
  assert.match(shown, /no track list/, 'the reason reaches the user');
  assert.ok(!/Project opened/.test(shown), 'and it did not claim success');
});

test('an unreadable file is reported rather than thrown past the button', opts, async () => {
  // A truncated file throws inside JSON.parse in main.js. Before, that crossed
  // IPC as a rejected promise nothing caught; now it comes back as a result.
  const { win, doc } = await bootWithWork();

  win.cutroom.openProject = async () => ({
    ok: false, error: 'half.cutroom.json could not be read.',
    detail: 'Unexpected end of JSON input'
  });

  doc.getElementById('btnOpen').click();
  await flush();

  assert.equal(clipCount(doc), 2, 'nothing was replaced');
  assert.match(toasts(doc).join('\n'), /could not be read/);
});

test('cancelling the dialog changes nothing and says nothing', opts, async () => {
  const { win, doc } = await bootWithWork();
  win.cutroom.openProject = async () => null;

  doc.getElementById('btnOpen').click();
  await flush();

  assert.equal(clipCount(doc), 2);
  assert.equal(toasts(doc).length, 0, 'a cancel is not an error');
});

test('a valid project still opens, and replaces what was there', opts, async () => {
  // The guard has to let the good case through, which is the half a check
  // like this most easily breaks.
  const { win, doc } = await bootWithWork();

  win.cutroom.openProject = async () => ({
    ok: true,
    project: {
      name: 'opened', width: 1080, height: 1920, fps: 30,
      captionsEnabled: false, captions: [],
      // A real saved project always carries this; renderCaptionStyle reads
      // through it without checking, so a fixture without it would be
      // testing a file the app cannot actually open.
      captionStyle: { font: 'Arial', size: 54, color: '#FFFFFF', position: 'bottom' },
      tracks: [
        { id: 'v1', kind: 'video', name: 'Video 1', clips: [
          { id: 'c9', src: '/tmp/z.mp4', name: 'z.mp4', inSec: 0, outSec: 4,
            startSec: 0, speed: 1, volume: 1, scale: 1, posX: 0, posY: 0,
            fadeIn: 0, fadeOut: 0, hasVideo: true, hasAudio: false }
        ] },
        { id: 'v2', kind: 'video', name: 'Video 2', clips: [] },
        { id: 'a1', kind: 'audio', name: 'Audio 1', clips: [] }
      ]
    }
  });

  doc.getElementById('btnOpen').click();
  await flush();

  assert.equal(clipCount(doc), 1, 'the opened project replaced the old one');
  assert.match(toasts(doc).join('\n'), /Project opened/);
  // Undo must not reach back into the replaced project's history.
  assert.equal(doc.getElementById('btnUndo').disabled, true, 'history was cleared');
});
