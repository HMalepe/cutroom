'use strict';

/*
 * Drives the real app.js against the real index.html in a DOM, the same way
 * test/undo-integration.test.js and test/snapping-integration.test.js do —
 * proving multi-select and ripple delete are actually wired into the pointer
 * handlers and the keyboard listener, not just correct as an idea.
 *
 * Assertions read the rendered DOM (a clip's `.selected` class, its
 * style.left/width) rather than internal state, because that is the only
 * thing app.js exposes and what a user actually sees. All at the app's
 * default 40px/s zoom, so seconds and pixels convert by a fixed ×40.
 *
 * Every interaction below re-queries its clip element from the DOM
 * immediately before dispatching on it, by track + sorted position, rather
 * than holding a reference across two interactions: a click or toggle
 * re-renders the whole lane list (renderLanes replaces every `.clip`
 * element), so a reference captured before an earlier action is a detached
 * node by the time a later action dispatches on it — silently a no-op,
 * since a detached node has no ancestor to bubble the event up to.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { opts, boot, seedBin, flush, fakeMedia, clipCount } = require('./dom-harness.js');

const PX_PER_SEC = 40;
const sec = (px) => px / PX_PER_SEC;
const px = (s) => s * PX_PER_SEC;

function withDurations(win, durations) {
  win.cutroom.probe = async (p) => {
    const name = path.basename(p);
    return fakeMedia(name, durations[name] ?? 10);
  };
}

/** Select every bin item, in click order, then send the whole selection to a track. */
function sendAll(win, doc, trackId) {
  doc.querySelectorAll('#binList .bin-item').forEach((el, i) => {
    el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, ctrlKey: i > 0 }));
  });
  doc.getElementById(`btnSend${trackId.toUpperCase()}`).click();
}

function clipsIn(doc, trackId) {
  return [...doc.querySelectorAll(`.track-lane[data-track-id="${trackId}"] .clip`)]
    .sort((a, b) => parseFloat(a.style.left) - parseFloat(b.style.left));
}

function leftSec(el) { return sec(parseFloat(el.style.left)); }

/** Plain click, by track + sorted index: pointerdown then pointerup at the same spot. */
function click(win, doc, trackId, i) {
  const el = clipsIn(doc, trackId)[i];
  el.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 5 }));
  doc.getElementById('tlScroll').dispatchEvent(new win.MouseEvent('pointerup', { bubbles: true, clientX: 5, clientY: 5 }));
}

/** Ctrl-click, by track + sorted index: toggles the clip, no drag. */
function toggleClick(win, doc, trackId, i, extra) {
  const el = clipsIn(doc, trackId)[i];
  el.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 5, ctrlKey: true, ...extra }));
}

// ==========================================================================
// Multi-select
// ==========================================================================

test('a plain click replaces the selection with just the clicked clip', opts, async () => {
  const { win, doc } = boot();
  seedBin(win, doc, ['a.mp4', 'b.mp4']);
  await flush();
  sendAll(win, doc, 'v1');
  assert.equal(clipCount(doc), 2);

  click(win, doc, 'v1', 0);
  toggleClick(win, doc, 'v1', 1);
  assert.equal(doc.querySelectorAll('#lanes .clip.selected').length, 2, 'sanity: two selected before the plain click');

  click(win, doc, 'v1', 0);
  const selected = doc.querySelectorAll('#lanes .clip.selected');
  assert.equal(selected.length, 1, 'plain click collapses back to one');
  assert.equal(selected[0], clipsIn(doc, 'v1')[0]);
});

test('ctrl-click and shift-click both toggle a clip into and out of the selection', opts, async () => {
  const { win, doc } = boot();
  seedBin(win, doc, ['a.mp4', 'b.mp4']);
  await flush();
  sendAll(win, doc, 'v1');

  click(win, doc, 'v1', 0);
  assert.equal(doc.querySelectorAll('#lanes .clip.selected').length, 1);

  toggleClick(win, doc, 'v1', 1);
  assert.equal(doc.querySelectorAll('#lanes .clip.selected').length, 2, 'ctrl-click adds the second clip');
  const [a, b] = clipsIn(doc, 'v1');
  assert.ok(a.classList.contains('selected') && b.classList.contains('selected'));

  // Shift-click toggles the same way ctrl-click does — see the pointerdown
  // handler's own comment for why this app does not treat Shift as a range.
  toggleClick(win, doc, 'v1', 1, { ctrlKey: false, shiftKey: true });
  assert.equal(doc.querySelectorAll('#lanes .clip.selected').length, 1, 'shift-click removed it again');
  assert.ok(clipsIn(doc, 'v1')[0].classList.contains('selected'));
});

test('a modifier-click only changes the selection, never starts a drag', opts, async () => {
  const { win, doc } = boot();
  seedBin(win, doc, ['a.mp4', 'b.mp4']);
  await flush();
  sendAll(win, doc, 'v1');

  click(win, doc, 'v1', 0);
  const bStart = leftSec(clipsIn(doc, 'v1')[1]);

  // pointermove without a matching pointerdown-without-modifier should not
  // move anything — toggle-clicking b, then moving the pointer, must leave
  // b exactly where it was.
  toggleClick(win, doc, 'v1', 1);
  doc.getElementById('tlScroll').dispatchEvent(
    new win.MouseEvent('pointermove', { bubbles: true, clientX: 5 + px(3), clientY: 5 })
  );
  assert.equal(leftSec(clipsIn(doc, 'v1')[1]), bStart, 'modifier-click did not open a drag');
});

test('the inspector shows one clip\'s settings only while exactly one clip is selected', opts, async () => {
  const { win, doc } = boot();
  seedBin(win, doc, ['a.mp4', 'b.mp4']);
  await flush();
  sendAll(win, doc, 'v1');

  click(win, doc, 'v1', 0);
  assert.ok(doc.querySelector('#inspector .speed-chips'), 'single selection shows the full inspector');

  toggleClick(win, doc, 'v1', 1);
  assert.equal(doc.querySelector('#inspector .speed-chips'), null, 'multi-selection hides the single-clip inspector');
  assert.match(doc.getElementById('clipName').textContent, /2 clips selected/);
});

// ==========================================================================
// Delete — multi-select and ripple
// ==========================================================================

test('deleting a multi-selection removes every selected clip as one undo step', opts, async () => {
  const { win, doc } = boot();
  seedBin(win, doc, ['a.mp4', 'b.mp4']);
  await flush();
  sendAll(win, doc, 'v1');
  assert.equal(clipCount(doc), 2);

  click(win, doc, 'v1', 0);
  toggleClick(win, doc, 'v1', 1);

  doc.getElementById('btnDeleteClip').click();
  assert.equal(clipCount(doc), 0, 'both clips removed');

  doc.getElementById('btnUndo').click();
  assert.equal(clipCount(doc), 2, 'one undo restores both');
});

test('a plain delete (button or bare key) still leaves a gap, unripped', opts, async () => {
  const { win, doc } = boot();
  withDurations(win, { 'a.mp4': 5, 'b.mp4': 3, 'c.mp4': 2 });
  seedBin(win, doc, ['a.mp4', 'b.mp4', 'c.mp4']);
  await flush();
  sendAll(win, doc, 'v1'); // a [0,5) b [5,8) c [8,10)

  click(win, doc, 'v1', 1); // b

  // Through the toolbar button: this is the regression case for onclick
  // handing deleteSelected a MouseEvent as its `ripple` argument, which
  // would read as truthy and ripple-delete on every plain click.
  doc.getElementById('btnDeleteClip').click();
  assert.equal(clipCount(doc), 2);
  const remaining = clipsIn(doc, 'v1');
  assert.deepEqual(remaining.map(leftSec), [0, 8], 'c stayed at 8 — the gap b left is untouched');
});

test('shift+delete ripples the gap closed, on the affected track only', opts, async () => {
  const { win, doc } = boot();
  withDurations(win, { 'a.mp4': 5, 'b.mp4': 3, 'c.mp4': 2, 'filler.mp4': 6, 'later.mp4': 3 });
  seedBin(win, doc, ['a.mp4', 'b.mp4', 'c.mp4', 'filler.mp4', 'later.mp4']);
  await flush();

  // v1: a [0,5) b [5,8) c [8,10) — b is deleted, ripple should pull c to 5.
  doc.querySelectorAll('#binList .bin-item')[0].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  doc.getElementById('btnSendV1').click();
  doc.querySelectorAll('#binList .bin-item')[1].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  doc.getElementById('btnSendV1').click();
  doc.querySelectorAll('#binList .bin-item')[2].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  doc.getElementById('btnSendV1').click();

  // v2: filler [0,6) later [6,9) — an unrelated track, present only to prove
  // the ripple never touches it. `later` starts at 6, past b's own startSec
  // of 5 on v1 — deliberately, so a bug that computed the shift from every
  // deleted clip project-wide (rather than scoping it to clips actually
  // removed from THIS track) would move it and still be missed by a clip
  // sitting before that point, the way filler alone would have missed it.
  doc.querySelectorAll('#binList .bin-item')[3].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  doc.getElementById('btnSendV2').click();
  doc.querySelectorAll('#binList .bin-item')[4].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  doc.getElementById('btnSendV2').click();

  click(win, doc, 'v1', 1); // b

  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Delete', shiftKey: true, bubbles: true }));

  const v1 = clipsIn(doc, 'v1');
  assert.equal(v1.length, 2);
  assert.deepEqual(v1.map(leftSec), [0, 5], 'c closed the gap b left, sliding from 8 to 5');

  const v2 = clipsIn(doc, 'v2');
  assert.equal(v2.length, 2);
  assert.deepEqual(v2.map(leftSec), [0, 6], 'neither clip on the other track moved');
});

test('ripple-deleting two non-adjacent clips on one track shifts every later clip by the right cumulative amount', opts, async () => {
  const { win, doc } = boot();
  // A [0,5) B [5,8) C [8,10) D [10,12) E [12,15) — B and D are removed.
  withDurations(win, { 'a.mp4': 5, 'b.mp4': 3, 'c.mp4': 2, 'd.mp4': 2, 'e.mp4': 3 });
  seedBin(win, doc, ['a.mp4', 'b.mp4', 'c.mp4', 'd.mp4', 'e.mp4']);
  await flush();
  sendAll(win, doc, 'v1');
  assert.deepEqual(clipsIn(doc, 'v1').map(leftSec), [0, 5, 8, 10, 12]);

  click(win, doc, 'v1', 1); // B
  toggleClick(win, doc, 'v1', 3); // D

  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Delete', shiftKey: true, bubbles: true }));

  const remaining = clipsIn(doc, 'v1');
  assert.equal(remaining.length, 3, 'A, C and E remain');
  // C was ahead of both removals-worth of gap (3 + 2 = 5): 8 - 3 = 5.
  // E was ahead of both: 12 - 3 - 2 = 7.
  assert.deepEqual(remaining.map(leftSec), [0, 5, 7]);
});

test('a ripple delete of a multi-selection is one undo step', opts, async () => {
  const { win, doc } = boot();
  withDurations(win, { 'a.mp4': 5, 'b.mp4': 3, 'c.mp4': 2 });
  seedBin(win, doc, ['a.mp4', 'b.mp4', 'c.mp4']);
  await flush();
  sendAll(win, doc, 'v1'); // a [0,5) b [5,8) c [8,10)

  click(win, doc, 'v1', 1); // b
  toggleClick(win, doc, 'v1', 2); // c

  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Delete', shiftKey: true, bubbles: true }));
  assert.equal(clipCount(doc), 1);

  doc.getElementById('btnUndo').click();
  assert.equal(clipCount(doc), 3, 'one undo restores all three');
  assert.deepEqual(clipsIn(doc, 'v1').map(leftSec), [0, 5, 8], 'and their original positions');
});
