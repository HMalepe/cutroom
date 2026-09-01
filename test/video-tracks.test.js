'use strict';

/*
 * Drives the real app.js against the real index.html in a DOM.
 *
 * Video tracks used to be a fixed pair (v1/v2) with two static "Send to
 * track" buttons in index.html. This proves the UI that makes the track
 * list itself variable: the "+ Video track" button, the per-track remove
 * chip (refused while a track still has clips, or while it is the last video
 * track), the data-driven send buttons, and that none of this loses undo
 * wiring or the numbering guarantees documented in app.js.
 *
 * key-preview.test.js covers what this does to the composited preview (a
 * third track's own layer, and the pool growing past its old fixed size);
 * this file is about the track list and its controls in isolation.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { opts, boot, seedBin, flush } = require('./dom-harness.js');

const headNames = (doc) => [...doc.querySelectorAll('.track-head-name')].map(el => el.textContent);
const sendButtonLabels = (doc) => [...doc.querySelectorAll('#sendButtons button')].map(el => el.textContent);
const toasts = (doc) => [...doc.querySelectorAll('#toasts .toast')].map(t => t.textContent).join('\n');

test('the default project boots with exactly two video tracks and one audio track', opts, () => {
  const { doc } = boot();
  assert.deepEqual(headNames(doc), ['Video 1', 'Video 2', 'Audio 1']);
  assert.deepEqual(sendButtonLabels(doc), ['→ Video 1', '→ Video 2', '→ Audio 1']);
  assert.ok(doc.getElementById('btnSendV1'));
  assert.ok(doc.getElementById('btnSendV2'));
  assert.ok(doc.getElementById('btnSendA1'));
});

test('+ Video track appends a new track above the existing video tracks, below the audio track', opts, () => {
  const { doc } = boot();
  doc.getElementById('btnAddVideoTrack').click();

  assert.deepEqual(headNames(doc), ['Video 1', 'Video 2', 'Video 3', 'Audio 1'],
    'the new track lands after the video tracks and before the audio track');
  assert.deepEqual(sendButtonLabels(doc), ['→ Video 1', '→ Video 2', '→ Video 3', '→ Audio 1']);
  assert.ok(doc.getElementById('btnSendV3'), 'a send button exists for the new track');
});

test('a clip can be sent to the newly added track', opts, async () => {
  const { win, doc } = boot();
  doc.getElementById('btnAddVideoTrack').click();
  seedBin(win, doc, ['a.mp4']);
  await flush();
  doc.querySelector('#binList .bin-item').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  doc.getElementById('btnSendV3').click();

  const clip = doc.querySelector('#lanes .clip');
  assert.ok(clip, 'the clip landed on the timeline');
  const lane = doc.querySelectorAll('.track-lane')[2]; // v1, v2, v3
  assert.equal(lane.dataset.trackId, 'v3');
  assert.equal(lane.querySelectorAll('.clip').length, 1);
});

test('removing an empty video track drops its head and its send button', opts, () => {
  const { doc } = boot();
  doc.getElementById('btnAddVideoTrack').click();
  const heads = doc.querySelectorAll('.track-head');
  const removeBtn = [...heads[2].querySelectorAll('.chip')].find(b => b.textContent === '✕');
  assert.ok(removeBtn, 'the third track head has a remove chip');

  removeBtn.click();

  assert.deepEqual(headNames(doc), ['Video 1', 'Video 2', 'Audio 1']);
  assert.equal(doc.getElementById('btnSendV3'), null);
});

test('a video track with clips on it refuses to be removed, with a toast', opts, async () => {
  const { win, doc } = boot();
  seedBin(win, doc, ['a.mp4']);
  await flush();
  doc.querySelector('#binList .bin-item').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  doc.getElementById('btnSendV1').click();

  const heads = doc.querySelectorAll('.track-head');
  const removeBtn = [...heads[0].querySelectorAll('.chip')].find(b => b.textContent === '✕');
  removeBtn.click();

  assert.deepEqual(headNames(doc), ['Video 1', 'Video 2', 'Audio 1'], 'Video 1 is still there');
  assert.match(toasts(doc), /Video 1 has clips on it/);
  assert.equal(doc.querySelectorAll('#lanes .clip').length, 1, 'and its clip is untouched');
});

test('the last remaining video track refuses to be removed even when empty', opts, () => {
  const { doc } = boot();
  // Remove Video 2 first (empty, allowed) so Video 1 is the only one left.
  let heads = doc.querySelectorAll('.track-head');
  [...heads[1].querySelectorAll('.chip')].find(b => b.textContent === '✕').click();

  assert.deepEqual(headNames(doc), ['Video 1', 'Audio 1']);

  heads = doc.querySelectorAll('.track-head');
  const lastRemove = [...heads[0].querySelectorAll('.chip')].find(b => b.textContent === '✕');
  lastRemove.click();

  assert.deepEqual(headNames(doc), ['Video 1', 'Audio 1'], 'Video 1 survives — it is the only video track left');
  assert.match(toasts(doc), /at least one video track/);
});

test('removing down to one video track is allowed — there is no floor at the original two', opts, () => {
  const { doc } = boot();
  const heads = doc.querySelectorAll('.track-head');
  [...heads[1].querySelectorAll('.chip')].find(b => b.textContent === '✕').click();

  assert.deepEqual(headNames(doc), ['Video 1', 'Audio 1'],
    'a one-video-track project is a legitimate end state, not silently rejected');
});

test('a removed track number is never handed to a later one while a higher number is still in use', opts, () => {
  const { doc } = boot();
  doc.getElementById('btnAddVideoTrack').click(); // Video 3
  doc.getElementById('btnAddVideoTrack').click(); // Video 4
  assert.deepEqual(headNames(doc), ['Video 1', 'Video 2', 'Video 3', 'Video 4', 'Audio 1']);

  // Remove Video 3 (empty) while Video 4 is still around.
  let heads = doc.querySelectorAll('.track-head');
  [...heads[2].querySelectorAll('.chip')].find(b => b.textContent === '✕').click();
  assert.deepEqual(headNames(doc), ['Video 1', 'Video 2', 'Video 4', 'Audio 1']);

  // A new track must not reuse "Video 3" — Video 4 is still on screen, so
  // counting tracks (there are 3 video tracks now) would collide with it.
  doc.getElementById('btnAddVideoTrack').click();
  assert.deepEqual(headNames(doc), ['Video 1', 'Video 2', 'Video 4', 'Video 5', 'Audio 1']);
});

test('adding a video track is undoable and redoable', opts, () => {
  const { doc } = boot();
  doc.getElementById('btnAddVideoTrack').click();
  assert.deepEqual(headNames(doc), ['Video 1', 'Video 2', 'Video 3', 'Audio 1']);
  assert.equal(doc.getElementById('btnUndo').disabled, false);

  doc.getElementById('btnUndo').click();
  assert.deepEqual(headNames(doc), ['Video 1', 'Video 2', 'Audio 1']);

  doc.getElementById('btnRedo').click();
  assert.deepEqual(headNames(doc), ['Video 1', 'Video 2', 'Video 3', 'Audio 1']);
});

test('removing an empty video track is undoable and redoable', opts, () => {
  const { doc } = boot();
  let heads = doc.querySelectorAll('.track-head');
  [...heads[1].querySelectorAll('.chip')].find(b => b.textContent === '✕').click();
  assert.deepEqual(headNames(doc), ['Video 1', 'Audio 1']);

  doc.getElementById('btnUndo').click();
  assert.deepEqual(headNames(doc), ['Video 1', 'Video 2', 'Audio 1'], 'Video 2 is back');

  doc.getElementById('btnRedo').click();
  assert.deepEqual(headNames(doc), ['Video 1', 'Audio 1']);
});
