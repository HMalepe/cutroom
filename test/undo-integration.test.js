'use strict';

/*
 * Drives the real app.js against the real index.html in a DOM.
 *
 * history.test.js proves the stack behaves; this proves it is actually wired
 * to the buttons and the timeline — the wiring being the part that silently
 * rots when someone adds a new edit and forgets to record it.
 *
 * Assertions read the rendered DOM rather than internal state, because that
 * is the only thing app.js exposes, and it is what the user actually sees.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { opts, boot, seedBin, flush, clipCount } = require('./dom-harness.js');

test('sending clips to a track is undoable and redoable', opts, async () => {
  const { win, doc } = boot();
  seedBin(win, doc);
  await flush();

  // Select everything in the bin, then send it to Video 1.
  doc.querySelectorAll('#binList .bin-item').forEach(el => {
    el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, ctrlKey: true }));
  });
  assert.equal(clipCount(doc), 0, 'nothing on the timeline yet');

  doc.getElementById('btnSendV1').click();
  assert.equal(clipCount(doc), 2, 'both clips landed');
  assert.equal(doc.getElementById('btnUndo').disabled, false, 'undo became available');

  doc.getElementById('btnUndo').click();
  assert.equal(clipCount(doc), 0, 'undo cleared the timeline');
  assert.equal(doc.getElementById('btnRedo').disabled, false, 'redo became available');

  doc.getElementById('btnRedo').click();
  assert.equal(clipCount(doc), 2, 'redo put them back');
});

test('undo is disabled at boot and after unwinding every edit', opts, async () => {
  const { win, doc } = boot();
  await flush();

  assert.equal(doc.getElementById('btnUndo').disabled, true, 'nothing to undo at boot');
  assert.equal(doc.getElementById('btnRedo').disabled, true, 'nothing to redo at boot');

  seedBin(win, doc);
  await flush();
  doc.querySelector('#binList .bin-item')
    .dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  doc.getElementById('btnSendV1').click();
  assert.equal(doc.getElementById('btnUndo').disabled, false);

  doc.getElementById('btnUndo').click();
  assert.equal(doc.getElementById('btnUndo').disabled, true, 'back to a clean stack');
});

test('deleting a clip is undoable, and undo restores the selection', opts, async () => {
  const { win, doc } = boot();
  seedBin(win, doc, ['a.mp4']);
  await flush();

  doc.querySelector('#binList .bin-item')
    .dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  doc.getElementById('btnSendV1').click();
  assert.equal(clipCount(doc), 1);

  // Select it the way a user does: press on the clip in the lane.
  const clip = doc.querySelector('#lanes .clip');
  clip.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 5 }));
  doc.getElementById('tlScroll')
    .dispatchEvent(new win.MouseEvent('pointerup', { bubbles: true, clientX: 5, clientY: 5 }));
  assert.ok(doc.querySelector('#lanes .clip.selected'), 'clip is selected');

  doc.getElementById('btnDeleteClip').click();
  assert.equal(clipCount(doc), 0, 'clip gone');

  doc.getElementById('btnUndo').click();
  assert.equal(clipCount(doc), 1, 'clip back');
  assert.ok(doc.querySelector('#lanes .clip.selected'), 'and still selected');
});

test('a click that only selects a clip records no undo entry', opts, async () => {
  const { win, doc } = boot();
  seedBin(win, doc, ['a.mp4']);
  await flush();

  doc.querySelector('#binList .bin-item')
    .dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  doc.getElementById('btnSendV1').click();

  // One entry so far: the send. Selecting must not add a second.
  doc.getElementById('btnUndo').click();
  assert.equal(clipCount(doc), 0);
  doc.getElementById('btnRedo').click();
  assert.equal(clipCount(doc), 1);

  const clip = doc.querySelector('#lanes .clip');
  clip.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 5 }));
  doc.getElementById('tlScroll')
    .dispatchEvent(new win.MouseEvent('pointerup', { bubbles: true, clientX: 5, clientY: 5 }));

  // If selecting had recorded an entry, this undo would consume it and leave
  // the clip on the timeline.
  doc.getElementById('btnUndo').click();
  assert.equal(clipCount(doc), 0, 'the only entry was the send');
});

test('a speed change is undoable from the inspector', opts, async () => {
  const { win, doc } = boot();
  seedBin(win, doc, ['a.mp4']);
  await flush();

  doc.querySelector('#binList .bin-item')
    .dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  doc.getElementById('btnSendV1').click();

  const clip = doc.querySelector('#lanes .clip');
  clip.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 5 }));
  doc.getElementById('tlScroll')
    .dispatchEvent(new win.MouseEvent('pointerup', { bubbles: true, clientX: 5, clientY: 5 }));

  const speedChip = [...doc.querySelectorAll('#inspector .speed-chips .chip')]
    .find(b => b.textContent === '2×');
  assert.ok(speedChip, 'the 2x chip is rendered');
  speedChip.click();

  assert.ok(doc.querySelector('#lanes .clip .badge.spd'), 'clip shows a speed badge');
  doc.getElementById('btnUndo').click();
  assert.equal(doc.querySelector('#lanes .clip .badge.spd'), null, 'speed reverted');
});

test('adding a caption line is undoable', opts, async () => {
  const { doc } = boot();
  await flush();

  assert.equal(doc.querySelectorAll('#capList .cap-row').length, 0);
  doc.getElementById('btnAddCaption').click();
  assert.equal(doc.querySelectorAll('#capList .cap-row').length, 1);

  doc.getElementById('btnUndo').click();
  assert.equal(doc.querySelectorAll('#capList .cap-row').length, 0, 'caption removed');

  doc.getElementById('btnRedo').click();
  assert.equal(doc.querySelectorAll('#capList .cap-row').length, 1, 'caption back');
});

test('ctrl+z and ctrl+shift+z drive undo and redo', opts, async () => {
  const { win, doc } = boot();
  await flush();

  doc.getElementById('btnAddCaption').click();
  assert.equal(doc.querySelectorAll('#capList .cap-row').length, 1);

  const key = (opts) => doc.dispatchEvent(
    new win.KeyboardEvent('keydown', { key: 'z', bubbles: true, ...opts })
  );

  key({ ctrlKey: true });
  assert.equal(doc.querySelectorAll('#capList .cap-row').length, 0, 'ctrl+z undid');

  key({ ctrlKey: true, shiftKey: true });
  assert.equal(doc.querySelectorAll('#capList .cap-row').length, 1, 'ctrl+shift+z redid');
});

test('undoing a canvas size change restores the project inputs', opts, async () => {
  const { doc } = boot();
  await flush();

  assert.equal(doc.getElementById('projW').value, '1080');
  doc.getElementById('btnLandscape').click();
  assert.equal(doc.getElementById('projW').value, '1920');
  assert.equal(doc.getElementById('projH').value, '1080');

  doc.getElementById('btnUndo').click();
  // The inputs are static markup, so this only passes if the undo path pushes
  // the restored project back into them.
  assert.equal(doc.getElementById('projW').value, '1080', 'width input resynced');
  assert.equal(doc.getElementById('projH').value, '1920', 'height input resynced');
});

test('typing in a caption is one undo step, closed on blur', opts, async () => {
  const { win, doc } = boot();
  await flush();

  doc.getElementById('btnAddCaption').click();
  const box = doc.querySelector('#capList .cap-text');
  assert.equal(box.value, 'New line');

  box.dispatchEvent(new win.Event('focus'));
  // Typed character by character, as oninput would fire.
  for (const v of ['H', 'He', 'Hel', 'Hell', 'Hello']) {
    box.value = v;
    box.dispatchEvent(new win.Event('input', { bubbles: true }));
  }
  box.dispatchEvent(new win.Event('blur'));

  doc.getElementById('btnUndo').click();
  // One step back is the text before typing, not one character back.
  assert.equal(doc.querySelector('#capList .cap-text').value, 'New line');

  // A second step removes the line itself, proving the typing was one entry.
  doc.getElementById('btnUndo').click();
  assert.equal(doc.querySelectorAll('#capList .cap-row').length, 0);
});

test('repeated undos replace their toast instead of stacking', opts, async () => {
  const { win, doc } = boot();
  await flush();

  doc.getElementById('btnAddCaption').click();
  doc.getElementById('btnAddCaption').click();

  const undo = () => doc.dispatchEvent(
    new win.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })
  );
  undo(); undo();
  // Two more than there is history for, which is the case that used to bury
  // the window in identical warnings.
  undo(); undo();

  assert.equal(doc.querySelectorAll('#toasts .toast').length, 1);
  assert.match(doc.querySelector('#toasts .toast').textContent, /Nothing left to undo/);
});

test('splitting a clip is undoable', opts, async () => {
  const { win, doc } = boot();
  seedBin(win, doc, ['a.mp4']);
  await flush();

  doc.querySelector('#binList .bin-item')
    .dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  doc.getElementById('btnSendV1').click();

  const clip = doc.querySelector('#lanes .clip');
  clip.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 5 }));
  doc.getElementById('tlScroll')
    .dispatchEvent(new win.MouseEvent('pointerup', { bubbles: true, clientX: 5, clientY: 5 }));

  // Move the playhead into the middle of the 10s clip, then split.
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
  doc.getElementById('btnSplit').click();
  assert.equal(clipCount(doc), 2, 'clip split in two');

  doc.getElementById('btnUndo').click();
  assert.equal(clipCount(doc), 1, 'split undone');
});
