'use strict';

/*
 * Drives the real app.js against the real index.html in a DOM, the same way
 * test/undo-integration.test.js does — proving copy/paste/duplicate are
 * actually wired into the keyboard listener and the menu-command switch, not
 * just correct as an idea.
 *
 * Two delivery paths exist for Ctrl/Cmd+C and +V on purpose (see doCopy/
 * doPaste's own comment in app.js and wireClipboardShortcuts in main.js):
 * the keydown listener, and the 'copy-clips'/'paste-clips' menu commands the
 * real Electron main process sends because the Edit menu's own copy/paste
 * roles already own that key combo everywhere a text field needs it. This
 * file drives both paths — a real `before-input-event` main-process listener
 * is Electron-only and not reachable from jsdom, so the menu path here is
 * exercised the same way test/undo-integration.test.js exercises 'save' and
 * 'new': through the harness's own `menu()` helper standing in for main.js.
 *
 * Assertions read the rendered DOM rather than internal state, because that
 * is the only thing app.js exposes. All at the app's default 40px/s zoom, so
 * seconds and pixels convert by a fixed ×40.
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

function sendItem(win, doc, index, trackId) {
  const items = doc.querySelectorAll('#binList .bin-item');
  items[index].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  doc.getElementById(`btnSend${trackId.toUpperCase()}`).click();
}

function clipsIn(doc, trackId) {
  return [...doc.querySelectorAll(`.track-lane[data-track-id="${trackId}"] .clip`)]
    .sort((a, b) => parseFloat(a.style.left) - parseFloat(b.style.left));
}

function leftSec(el) { return sec(parseFloat(el.style.left)); }

function click(win, doc, el) {
  el.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 5 }));
  doc.getElementById('tlScroll').dispatchEvent(new win.MouseEvent('pointerup', { bubbles: true, clientX: 5, clientY: 5 }));
}

function toggleClick(win, el) {
  el.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 5, ctrlKey: true }));
}

function clickRuler(win, doc, atSec) {
  doc.getElementById('tlScroll').dispatchEvent(
    new win.MouseEvent('pointerdown', { bubbles: true, clientX: px(atSec), clientY: 5 })
  );
}

function keydown(win, doc, key, extra) {
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, ...extra }));
}

// ==========================================================================
// Copy / paste
// ==========================================================================

test('ctrl+c then ctrl+v pastes a clone at the playhead, with a fresh id and the same settings', opts, async () => {
  const { win, doc } = boot();
  seedBin(win, doc, ['a.mp4']);
  await flush();
  sendItem(win, doc, 0, 'v1'); // a.mp4, 10s -> v1 [0,10)

  const original = clipsIn(doc, 'v1')[0];
  click(win, doc, original);
  const speed2 = [...doc.querySelectorAll('.speed-chips .chip')].find(b => b.textContent === '2×');
  speed2.click(); // timeline duration halves to 5s

  keydown(win, doc, 'c');
  clickRuler(win, doc, 3);
  keydown(win, doc, 'v');

  assert.equal(clipCount(doc), 2);
  const clips = clipsIn(doc, 'v1');
  const pasted = clips.find(el => el.dataset.clipId !== original.dataset.clipId);
  assert.ok(pasted, 'a second, differently-id\'d clip exists');
  assert.equal(leftSec(pasted), 3, 'landed at the playhead');
  assert.ok(pasted.querySelector('.badge.spd'), 'the 2x speed setting came along, not just the id');
});

test('paste preserves the relative offsets between several copied clips', opts, async () => {
  const { win, doc } = boot();
  withDurations(win, { 'a.mp4': 5, 'b.mp4': 5 });
  seedBin(win, doc, ['a.mp4', 'b.mp4']);
  await flush();
  doc.querySelectorAll('#binList .bin-item').forEach((el, i) =>
    el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, ctrlKey: i > 0 })));
  doc.getElementById('btnSendV1').click(); // a [0,5) b [5,10)

  click(win, doc, clipsIn(doc, 'v1')[0]);
  // Re-queried, not reused from before the click above: a click re-renders
  // the whole lane list, so a reference captured earlier is a detached node
  // by now — dispatching on it would silently do nothing.
  toggleClick(win, clipsIn(doc, 'v1')[1]);
  keydown(win, doc, 'c');

  clickRuler(win, doc, 10); // paste anchor — past both originals, no overlap
  keydown(win, doc, 'v');

  assert.equal(clipCount(doc), 4);
  const lefts = clipsIn(doc, 'v1').map(leftSec);
  assert.deepEqual(lefts, [0, 5, 10, 15], 'the copied pair kept its own 5s spacing at the new anchor');
});

test('editing the original after Copy does not change what Paste produces later', opts, async () => {
  const { win, doc } = boot();
  seedBin(win, doc, ['a.mp4']);
  await flush();
  sendItem(win, doc, 0, 'v1');

  const original = clipsIn(doc, 'v1')[0];
  click(win, doc, original);
  keydown(win, doc, 'c'); // clipboard clones the clip at speed 1

  const speed2 = [...doc.querySelectorAll('.speed-chips .chip')].find(b => b.textContent === '2×');
  speed2.click(); // mutate the original AFTER copying

  keydown(win, doc, 'v');

  assert.equal(clipCount(doc), 2);
  const withBadge = doc.querySelectorAll('#lanes .clip .badge.spd');
  assert.equal(withBadge.length, 1, 'only the original shows the post-copy speed change');
});

test('nothing is added when there is nothing on the clipboard', opts, async () => {
  const { win, doc } = boot();
  seedBin(win, doc, ['a.mp4']);
  await flush();
  sendItem(win, doc, 0, 'v1');

  keydown(win, doc, 'v');
  assert.equal(clipCount(doc), 1, 'paste with an empty clipboard adds nothing');
  assert.match(doc.querySelector('#toasts .toast').textContent, /Nothing to paste/);
});

test('a caption text field\'s own ctrl+c is left alone, not read as a clip copy', opts, async () => {
  const { win, doc } = boot();
  seedBin(win, doc, ['a.mp4']);
  await flush();
  sendItem(win, doc, 0, 'v1');
  click(win, doc, clipsIn(doc, 'v1')[0]);

  doc.getElementById('btnAddCaption').click();
  const box = doc.querySelector('#capList .cap-text');
  box.focus();
  assert.equal(doc.activeElement, box, 'sanity: the caption box actually has focus');

  keydown(win, doc, 'c'); // should be swallowed by the typing guard, not copy the clip
  box.blur();

  keydown(win, doc, 'v');
  assert.equal(clipCount(doc), 1, 'nothing pasted — the clip was never copied');
  assert.match(doc.querySelector('#toasts .toast').textContent, /Nothing to paste/);
});

// ==========================================================================
// The menu-command path (Electron's Edit-menu accelerator, in real life)
// ==========================================================================

test('the copy-clips/paste-clips menu commands copy and paste the same way the keydown path does', opts, async () => {
  const { win, doc, menu } = boot();
  seedBin(win, doc, ['a.mp4']);
  await flush();
  sendItem(win, doc, 0, 'v1'); // a.mp4, 10s -> v1 [0,10)
  click(win, doc, clipsIn(doc, 'v1')[0]);

  await menu('copy-clips');
  clickRuler(win, doc, 3);
  await menu('paste-clips');

  assert.equal(clipCount(doc), 2);
  const pasted = clipsIn(doc, 'v1').find(el => leftSec(el) === 3);
  assert.ok(pasted, 'the menu path pasted a clip at the playhead');
});

test('a caption field\'s focus also blocks the menu-command copy path, not just the keydown one', opts, async () => {
  const { win, doc, menu } = boot();
  seedBin(win, doc, ['a.mp4']);
  await flush();
  sendItem(win, doc, 0, 'v1');
  click(win, doc, clipsIn(doc, 'v1')[0]);

  doc.getElementById('btnAddCaption').click();
  doc.querySelector('#capList .cap-text').focus();

  await menu('copy-clips');
  doc.activeElement.blur();

  await menu('paste-clips');
  assert.equal(clipCount(doc), 1, 'the menu path respected the same typing guard');
});

test('a caption field\'s focus also blocks the menu-command PASTE path on its own', opts, async () => {
  // Distinct from the copy test above: this proves the guard on the paste
  // side specifically, with something real already on the clipboard, rather
  // than relying on "nothing to paste" to mask a missing check there too.
  const { win, doc, menu } = boot();
  seedBin(win, doc, ['a.mp4']);
  await flush();
  sendItem(win, doc, 0, 'v1');
  click(win, doc, clipsIn(doc, 'v1')[0]);
  await menu('copy-clips'); // focus is nowhere special yet — this succeeds

  doc.getElementById('btnAddCaption').click();
  doc.querySelector('#capList .cap-text').focus();

  await menu('paste-clips');
  assert.equal(clipCount(doc), 1, 'a real clipboard was ignored while a text field had focus');
});

test('a paste arriving from both the keydown listener and the menu in quick succession only pastes once', opts, async () => {
  const { win, doc, menu } = boot();
  seedBin(win, doc, ['a.mp4']);
  await flush();
  sendItem(win, doc, 0, 'v1');
  click(win, doc, clipsIn(doc, 'v1')[0]);
  keydown(win, doc, 'c');

  // Both paths deliver the same keystroke on some platform (see
  // wireClipboardShortcuts in main.js) — commandGuard is what keeps that
  // from pasting twice. Fired back to back, well inside its 50ms window.
  keydown(win, doc, 'v');
  await menu('paste-clips');

  assert.equal(clipCount(doc), 2, 'the second arrival was dropped, not applied again');
});

// ==========================================================================
// Duplicate
// ==========================================================================

test('ctrl+d duplicates the clip right after itself, not on top of it', opts, async () => {
  const { win, doc } = boot();
  seedBin(win, doc, ['a.mp4']);
  await flush();
  sendItem(win, doc, 0, 'v1'); // a.mp4, 10s -> v1 [0,10)

  const original = clipsIn(doc, 'v1')[0];
  click(win, doc, original);
  keydown(win, doc, 'd');

  assert.equal(clipCount(doc), 2);
  const clips = clipsIn(doc, 'v1');
  assert.deepEqual(clips.map(leftSec), [0, 10], 'the copy landed exactly abutting the original, not overlapping it');

  const dup = clips.find(el => el.dataset.clipId !== original.dataset.clipId);
  assert.ok(dup.classList.contains('selected'), 'the duplicate becomes the new selection');

  doc.getElementById('btnUndo').click();
  assert.equal(clipCount(doc), 1, 'one undo removes just the duplicate');
});

test('ctrl+d on a multi-selection keeps the group\'s own layout, placed after the latest original', opts, async () => {
  const { win, doc } = boot();
  withDurations(win, { 'a.mp4': 5, 'b.mp4': 5 });
  seedBin(win, doc, ['a.mp4', 'b.mp4']);
  await flush();
  doc.querySelectorAll('#binList .bin-item').forEach((el, i) =>
    el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, ctrlKey: i > 0 })));
  doc.getElementById('btnSendV1').click(); // a [0,5) b [5,10)

  click(win, doc, clipsIn(doc, 'v1')[0]);
  // Re-queried for the same reason as the paste test above: the click just
  // above re-rendered the lane list, so the pre-click reference is detached.
  toggleClick(win, clipsIn(doc, 'v1')[1]);
  keydown(win, doc, 'd');

  assert.equal(clipCount(doc), 4);
  assert.deepEqual(clipsIn(doc, 'v1').map(leftSec), [0, 5, 10, 15], 'duplicated as a block right after b, keeping the 5s gap between the pair');
});

test('the duplicate button does not crash on the MouseEvent it receives as its first argument', opts, async () => {
  // duplicateSelected takes no parameters, unlike deleteSelected — this is a
  // regression check for the same class of bug the delete-button wrapper
  // above exists to prevent, confirming this one needed no such wrapper.
  const { win, doc } = boot();
  seedBin(win, doc, ['a.mp4']);
  await flush();
  sendItem(win, doc, 0, 'v1');
  click(win, doc, clipsIn(doc, 'v1')[0]);

  doc.getElementById('btnDuplicateClip').click();
  assert.equal(clipCount(doc), 2);
});
