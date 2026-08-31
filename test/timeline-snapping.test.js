'use strict';

/*
 * The decision logic behind edge snapping: which positions a dragged clip
 * edge is worth lining up with (edgeCandidates), which of those actually
 * qualifies at the current zoom (closestWithin/snapTarget), and how a
 * whole-clip move picks between its two edges (snapMoveStart). All pure —
 * no DOM, no pointer events — which is what test/snapping-integration.test.js
 * covers separately: that app.js's drag handlers actually call this and that
 * a real pointer gesture near another clip's edge lands on it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const TS = require('../src/timeline-snapping.js');

function clip(over) {
  return Object.assign({ id: 'c', src: '/a.mp4', inSec: 0, outSec: 10, startSec: 0, speed: 1 }, over);
}

// ==========================================================================
// edgeCandidates
// ==========================================================================

test('no tracks or no clips gives no candidates', () => {
  assert.deepEqual(TS.edgeCandidates([], 'x'), []);
  assert.deepEqual(TS.edgeCandidates([{ id: 't', clips: [] }], 'x'), []);
  assert.deepEqual(TS.edgeCandidates(null, 'x'), []);
});

test('a clip contributes its timeline start and end', () => {
  const tracks = [{ id: 't1', clips: [clip({ id: 'a', startSec: 5, inSec: 2, outSec: 8 })] }];
  assert.deepEqual(TS.edgeCandidates(tracks, 'nobody'), [5, 11]);
});

test('the clip being dragged is excluded from its own candidate list', () => {
  // The exact case the header comment on edgeCandidates calls out: a clip
  // must not be offered its own unmoved edges as something to snap to.
  const tracks = [{ id: 't1', clips: [clip({ id: 'a', startSec: 5, outSec: 8 })] }];
  assert.deepEqual(TS.edgeCandidates(tracks, 'a'), []);
});

test('candidates come from every track, not just the one holding the excluded clip', () => {
  // The point of this being cross-track: keying a clip on Video 2 to a cut
  // on Video 1 is ordinary, not a special case.
  const tracks = [
    { id: 'v1', clips: [clip({ id: 'a', startSec: 0, outSec: 10 })] },
    { id: 'v2', clips: [clip({ id: 'b', startSec: 20, outSec: 5 })] }
  ];
  assert.deepEqual(TS.edgeCandidates(tracks, 'b').sort((x, y) => x - y), [0, 10]);
  assert.deepEqual(TS.edgeCandidates(tracks, 'a').sort((x, y) => x - y), [20, 25]);
});

test('a clip\'s end accounts for speed, the same formula as clipDur/clipEnd', () => {
  const tracks = [{ id: 't1', clips: [clip({ id: 'a', startSec: 10, inSec: 2, outSec: 8, speed: 2 })] }];
  // (8-2)/2 = 3 timeline seconds, so the end is 10 + 3 = 13, not 10 + 6.
  assert.deepEqual(TS.edgeCandidates(tracks, 'nobody'), [10, 13]);
});

test('a malformed clip entry is skipped rather than throwing', () => {
  const tracks = [{ id: 't1', clips: [null, undefined, clip({ id: 'a', startSec: 1, outSec: 2 })] }];
  assert.deepEqual(TS.edgeCandidates(tracks, 'nobody'), [1, 3]);
});

// ==========================================================================
// closestWithin / snapTarget
// ==========================================================================

test('closestWithin is null when nothing is within threshold', () => {
  assert.equal(TS.closestWithin([0, 100], 50, 5), null);
  assert.equal(TS.closestWithin([], 50, 5), null);
});

test('closestWithin returns the nearest candidate within threshold', () => {
  assert.equal(TS.closestWithin([0, 9.9, 20], 10, 0.5), 9.9);
});

test('closestWithin includes a candidate exactly at the threshold distance', () => {
  assert.equal(TS.closestWithin([10], 9.8, 0.2), 10);
});

test('closestWithin excludes a candidate just past the threshold distance', () => {
  assert.equal(TS.closestWithin([10], 9.79, 0.2), null);
});

test('closestWithin keeps the first candidate on an exact distance tie', () => {
  assert.equal(TS.closestWithin([9, 11], 10, 5), 9);
});

test('closestWithin ignores non-finite candidates instead of throwing', () => {
  assert.equal(TS.closestWithin([NaN, undefined, null, 10], 10, 0.1), 10);
});

test('snapTarget falls back to pos, not null, when nothing qualifies', () => {
  assert.equal(TS.snapTarget([0, 100], 50, 5), 50);
});

test('snapTarget returns the qualifying candidate', () => {
  assert.equal(TS.snapTarget([0, 10, 100], 9.9, 0.5), 10);
});

// ==========================================================================
// snapMoveStart
// ==========================================================================

test('snapMoveStart leaves rawStart alone when neither edge is near a candidate', () => {
  assert.equal(TS.snapMoveStart(50, 10, [0, 100], 0.5), 50);
});

test('snapMoveStart snaps on the head edge when only it is close', () => {
  // rawStart=9.9 is within 0.2 of candidate 10; rawStart+dur=19.9 is not near
  // anything, so the head wins and the clip's start becomes exactly 10.
  assert.equal(TS.snapMoveStart(9.9, 10, [10], 0.2), 10);
});

test('snapMoveStart snaps on the tail edge when only it is close', () => {
  // The case a start-only snap would miss entirely: dragging clip A
  // rightward so its TAIL (rawStart+dur = 20.1) lands near candidate 20.
  // The result is candidate-minus-duration, not the candidate itself.
  assert.equal(TS.snapMoveStart(10.1, 10, [20], 0.2), 10);
});

test('snapMoveStart prefers whichever edge is closer when both qualify', () => {
  // head at distance 0.05 from candidate 10, tail at distance 0.15 from
  // candidate 20.1 — head should win.
  assert.equal(TS.snapMoveStart(9.95, 10, [10, 20.1], 0.5), 10);
  // Now swap which one is closer: tail at 0.05, head at 0.15.
  assert.equal(TS.snapMoveStart(9.85, 10, [10, 19.95], 0.5), 9.95);
});

test('snapMoveStart keeps the whole-clip duration exactly, snapped or not', () => {
  const result = TS.snapMoveStart(10.1, 10, [20], 0.2);
  assert.equal(20 - result, 10, 'tail minus head is still the clip\'s own duration');
});
