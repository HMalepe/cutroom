'use strict';

/*
 * Drives the real app.js against the real index.html in a DOM.
 *
 * Audio was the one track kind still fixed at a single track (`a1`) after
 * video-tracks.test.js proved the video side could grow and shrink. This is
 * the audio mirror of that file: the "+ Audio track" button, the per-track
 * remove chip (refused while a track still has clips), the data-driven send
 * buttons now covering both kinds, and the numbering guarantees shared with
 * video via nextTrackNumber().
 *
 * The one deliberate asymmetry with video-tracks.test.js: audio has no
 * last-track floor. Video does, because the preview/export need at least one
 * video track to composite anything; a video clip's own synced sound rides
 * on its video track regardless of whether any audio-kind track exists, so a
 * project can legitimately have zero — see removeAudioTrack's own comment in
 * app.js. That is proven directly below, in contrast with the video floor
 * test it mirrors.
 *
 * ffmpeg-builder.test.js and ffmpeg-render.test.js cover what more than one
 * audio track does to the actual export mix; this file is about the track
 * list and its controls in isolation, same division as video's.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { opts, boot, seedBin, flush } = require('./dom-harness.js');

const headNames = (doc) => [...doc.querySelectorAll('.track-head-name')].map(el => el.textContent);
const sendButtonLabels = (doc) => [...doc.querySelectorAll('#sendButtons button')].map(el => el.textContent);
const toasts = (doc) => [...doc.querySelectorAll('#toasts .toast')].map(t => t.textContent).join('\n');
const removeChip = (head) => [...head.querySelectorAll('.chip')].find(b => b.textContent === '✕');

test('+ Audio track appends a new track at the end of the list, after every other track', opts, () => {
  const { doc } = boot();
  doc.getElementById('btnAddAudioTrack').click();

  assert.deepEqual(headNames(doc), ['Video 1', 'Video 2', 'Audio 1', 'Audio 2'],
    'the new track lands after both video tracks and the existing audio track');
  assert.deepEqual(sendButtonLabels(doc), ['→ Video 1', '→ Video 2', '→ Audio 1', '→ Audio 2']);
  assert.ok(doc.getElementById('btnSendA2'), 'a send button exists for the new track');
});

test('a clip can be sent to the newly added audio track', opts, async () => {
  const { win, doc } = boot();
  doc.getElementById('btnAddAudioTrack').click();
  seedBin(win, doc, ['a.mp4']);
  await flush();
  doc.querySelector('#binList .bin-item').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  doc.getElementById('btnSendA2').click();

  const clip = doc.querySelector('#lanes .clip');
  assert.ok(clip, 'the clip landed on the timeline');
  const lane = doc.querySelectorAll('.track-lane')[3]; // v1, v2, a1, a2
  assert.equal(lane.dataset.trackId, 'a2');
  assert.equal(lane.querySelectorAll('.clip').length, 1);
});

test('removing an empty audio track drops its head and its send button', opts, () => {
  const { doc } = boot();
  doc.getElementById('btnAddAudioTrack').click();
  const heads = doc.querySelectorAll('.track-head');
  const remove = removeChip(heads[3]);
  assert.ok(remove, 'the fourth track head (Audio 2) has a remove chip');

  remove.click();

  assert.deepEqual(headNames(doc), ['Video 1', 'Video 2', 'Audio 1']);
  assert.equal(doc.getElementById('btnSendA2'), null);
});

test('an audio track with clips on it refuses to be removed, with a toast', opts, async () => {
  const { win, doc } = boot();
  seedBin(win, doc, ['a.mp4']);
  await flush();
  doc.querySelector('#binList .bin-item').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  doc.getElementById('btnSendA1').click();

  const heads = doc.querySelectorAll('.track-head');
  removeChip(heads[2]).click(); // Audio 1

  assert.deepEqual(headNames(doc), ['Video 1', 'Video 2', 'Audio 1'], 'Audio 1 is still there');
  assert.match(toasts(doc), /Audio 1 has clips on it/);
  assert.equal(doc.querySelectorAll('#lanes .clip').length, 1, 'and its clip is untouched');
});

test('the last remaining audio track CAN be removed — unlike video, there is no floor', opts, () => {
  const { doc } = boot();
  const heads = doc.querySelectorAll('.track-head');
  removeChip(heads[2]).click(); // Audio 1, the only audio track

  assert.deepEqual(headNames(doc), ['Video 1', 'Video 2'],
    'a project with zero audio tracks is a legitimate state, not silently rejected');
  assert.equal(doc.getElementById('btnSendA1'), null);
  assert.doesNotMatch(toasts(doc), /audio track/i, 'no refusal toast — this one is allowed');
});

test('a removed audio track number is never handed to a later one while a higher number is still in use', opts, () => {
  const { doc } = boot();
  doc.getElementById('btnAddAudioTrack').click(); // Audio 2
  doc.getElementById('btnAddAudioTrack').click(); // Audio 3
  assert.deepEqual(headNames(doc), ['Video 1', 'Video 2', 'Audio 1', 'Audio 2', 'Audio 3']);

  // Remove Audio 2 (empty) while Audio 3 is still around.
  let heads = doc.querySelectorAll('.track-head');
  removeChip(heads[3]).click();
  assert.deepEqual(headNames(doc), ['Video 1', 'Video 2', 'Audio 1', 'Audio 3']);

  // A new track must not reuse "Audio 2" — Audio 3 is still on screen, so
  // counting audio tracks (there are 2 now) would collide with it.
  doc.getElementById('btnAddAudioTrack').click();
  assert.deepEqual(headNames(doc), ['Video 1', 'Video 2', 'Audio 1', 'Audio 3', 'Audio 4']);
});

test('adding an audio track is undoable and redoable', opts, () => {
  const { doc } = boot();
  doc.getElementById('btnAddAudioTrack').click();
  assert.deepEqual(headNames(doc), ['Video 1', 'Video 2', 'Audio 1', 'Audio 2']);
  assert.equal(doc.getElementById('btnUndo').disabled, false);

  doc.getElementById('btnUndo').click();
  assert.deepEqual(headNames(doc), ['Video 1', 'Video 2', 'Audio 1']);

  doc.getElementById('btnRedo').click();
  assert.deepEqual(headNames(doc), ['Video 1', 'Video 2', 'Audio 1', 'Audio 2']);
});

test('removing an empty audio track is undoable and redoable', opts, () => {
  const { doc } = boot();
  let heads = doc.querySelectorAll('.track-head');
  removeChip(heads[2]).click(); // Audio 1
  assert.deepEqual(headNames(doc), ['Video 1', 'Video 2']);

  doc.getElementById('btnUndo').click();
  assert.deepEqual(headNames(doc), ['Video 1', 'Video 2', 'Audio 1'], 'Audio 1 is back');

  doc.getElementById('btnRedo').click();
  assert.deepEqual(headNames(doc), ['Video 1', 'Video 2']);
});

test('a video track added after an audio track still lands above every video track and below every audio track', opts, () => {
  const { doc } = boot();
  doc.getElementById('btnAddAudioTrack').click(); // Audio 2
  doc.getElementById('btnAddVideoTrack').click(); // Video 3 — must not land after the audio tracks

  assert.deepEqual(headNames(doc), ['Video 1', 'Video 2', 'Video 3', 'Audio 1', 'Audio 2'],
    'video insertion still scans for the last video track, unaffected by a second audio track existing');
});
