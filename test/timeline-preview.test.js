'use strict';

/*
 * The decision logic behind the playhead-driven composited preview: which
 * clip (or crossfading pair) is active on a video track at a given instant,
 * how a clip's own source time maps to the timeline, and how the timeline
 * clock advances while playing. All pure — no DOM, no video element, no GL —
 * which is the whole point: app.js wires these answers to real elements, and
 * that wiring is covered separately in test/key-preview.test.js's jsdom
 * integration tests. Nothing here proves a pixel lands correctly on screen;
 * see timeline-preview.js's header for why the crossfade rule is written the
 * way it is.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const TP = require('../src/timeline-preview.js');
const builder = require('../shared/ffmpeg-builder.js');

function clip(over) {
  return Object.assign({
    src: '/a.mp4', inSec: 0, outSec: 10, startSec: 0, speed: 1
  }, over);
}

// ==========================================================================
// clipTimelineEnd / sourceTimeFor
// ==========================================================================

test('clipTimelineEnd is startSec plus (outSec-inSec)/speed', () => {
  assert.equal(TP.clipTimelineEnd(clip({ startSec: 5, inSec: 2, outSec: 8, speed: 2 })), 5 + 3);
});

test('sourceTimeFor maps timeline time onto the clip\'s own source time', () => {
  const c = clip({ startSec: 10, inSec: 2, outSec: 8, speed: 2 });
  assert.equal(TP.sourceTimeFor(c, 10), 2, 'at the clip\'s own start, its inSec');
  assert.equal(TP.sourceTimeFor(c, 11), 4, 'one timeline second in, at 2x speed, is two source seconds');
});

test('sourceTimeFor clamps into [inSec, outSec) rather than reading past the trim', () => {
  const c = clip({ startSec: 0, inSec: 2, outSec: 8, speed: 1 });
  assert.equal(TP.sourceTimeFor(c, -5), 2, 'before the clip starts, held at inSec');
  assert.equal(TP.sourceTimeFor(c, 999), 8, 'long after it ends, held at outSec');
});

// ==========================================================================
// trackStateAt — solo
// ==========================================================================

test('nothing on the track at t gives null', () => {
  assert.equal(TP.trackStateAt([], 5, 0.1), null);
  assert.equal(TP.trackStateAt([clip({ startSec: 10, outSec: 5 })], 2, 0.1), null);
});

test('one clip covering t is a solo state carrying that clip', () => {
  const c = clip({ startSec: 0, outSec: 5 });
  const state = TP.trackStateAt([c], 2, 0.1);
  assert.equal(state.kind, 'solo');
  assert.equal(state.clip, c);
});

test('t exactly at a clip\'s end is not covered — the next clip owns that instant', () => {
  const c = clip({ startSec: 0, outSec: 5 });
  assert.equal(TP.trackStateAt([c], 5, 0.1), null);
});

test('a clip nested entirely inside another (no shared tail) is not a crossfade', () => {
  // Export behaviour: groupTrackRuns' "joins" test requires the later clip to
  // carry on PAST the earlier one. A clip that starts and ends inside its
  // neighbour fails that, so both stay on the overlay path and the
  // later-starting one simply wins the pixels where they overlap.
  const outer = clip({ startSec: 0, outSec: 10 });
  const inner = clip({ startSec: 3, outSec: 6 });
  const state = TP.trackStateAt([outer, inner], 4, 0.1);
  assert.equal(state.kind, 'solo');
  assert.equal(state.clip, inner, 'the later-starting clip is drawn on top, same as the export\'s overlay order');
});

test('clips that merely abut (overlap below the frame threshold) are solo, not a crossfade', () => {
  const a = clip({ startSec: 0, outSec: 5 });
  const b = clip({ startSec: 5, outSec: 10 });
  // No overlap at all here, but also pin the near-zero case: an overlap
  // thinner than one frame should not qualify either.
  const c2 = clip({ startSec: 4.99, outSec: 10 });
  assert.equal(TP.trackStateAt([a, b], 4.9, 0.033).kind, 'solo');
  assert.equal(TP.trackStateAt([a, c2], 4.995, 0.033).kind, 'solo');
});

// ==========================================================================
// trackStateAt — crossfade
// ==========================================================================

test('two clips overlapping, the second outlasting the first, is a crossfade', () => {
  const a = clip({ startSec: 0, outSec: 6 });   // outgoing
  const b = clip({ startSec: 4, outSec: 10 });  // incoming, overlap 4..6
  const state = TP.trackStateAt([a, b], 5, 0.1);
  assert.equal(state.kind, 'crossfade');
  assert.equal(state.outgoing, a);
  assert.equal(state.incoming, b);
});

test('crossfade progress runs 0 at the overlap\'s start to 1 at its end', () => {
  const a = clip({ startSec: 0, outSec: 6 });
  const b = clip({ startSec: 4, outSec: 10 });
  assert.equal(TP.trackStateAt([a, b], 4, 0.1).progress, 0, 'the instant the overlap begins');
  assert.ok(TP.trackStateAt([a, b], 6 - 1e-9, 0.1).progress < 1, 'just before it ends');
  const mid = TP.trackStateAt([a, b], 5, 0.1);
  assert.ok(Math.abs(mid.progress - 0.5) < 1e-9, 'halfway through a 2s overlap is progress 0.5');
});

test('the crossfade carries the incoming clip\'s transitionType, falling back like the export does', () => {
  const a = clip({ startSec: 0, outSec: 6 });
  const withType = clip({ startSec: 4, outSec: 10, transitionType: 'wipeleft' });
  assert.equal(TP.trackStateAt([a, withType], 5, 0.1).transition, 'wipeleft');

  const unknown = clip({ startSec: 4, outSec: 10, transitionType: 'not-a-real-one' });
  assert.equal(TP.trackStateAt([a, unknown], 5, 0.1).transition, TP.DEFAULT_TRANSITION);
});

test('TRANSITION_TYPES matches the export\'s own curated list exactly', () => {
  // The two lists are necessarily separate files (shared/ffmpeg-builder.js
  // never reaches the renderer), so nothing stops them drifting apart except
  // this test.
  assert.deepEqual(TP.TRANSITION_TYPES, builder.TRANSITION_TYPES);
  assert.equal(TP.DEFAULT_TRANSITION, builder.DEFAULT_TRANSITION);
});

test('minOverlapFor is one frame, matching what buildExportCommand passes to groupTrackRuns', () => {
  assert.equal(TP.minOverlapFor({ fps: 25 }), 1 / 25);
  assert.equal(TP.minOverlapFor({}), 1 / 30, 'a missing fps falls back to 30, the project default');
});

// ==========================================================================
// layersAt
// ==========================================================================

function tracks(over) {
  return [
    { id: 'v1', kind: 'video', clips: [] },
    { id: 'v2', kind: 'video', clips: [] },
    { id: 'a1', kind: 'audio', clips: [clip({ startSec: 0, outSec: 20 })] }
  ].map(t => Object.assign(t, over[t.id] || {}));
}

test('layersAt is bottom-to-top: v1 before v2, the same order the export composites in', () => {
  const t = tracks({
    v1: { clips: [clip({ startSec: 0, outSec: 5 })] },
    v2: { clips: [clip({ startSec: 0, outSec: 5 })] }
  });
  const layers = TP.layersAt(t, 2, 0.1);
  assert.deepEqual(layers.map(l => l.trackId), ['v1', 'v2']);
});

test('layersAt skips a track with nothing at t, rather than returning a null entry', () => {
  const t = tracks({ v1: { clips: [clip({ startSec: 0, outSec: 5 })] } });
  const layers = TP.layersAt(t, 2, 0.1);
  assert.equal(layers.length, 1);
  assert.equal(layers[0].trackId, 'v1');
});

test('layersAt skips a hidden track even if a clip covers t', () => {
  const t = tracks({ v1: { clips: [clip({ startSec: 0, outSec: 5 })], hidden: true } });
  assert.deepEqual(TP.layersAt(t, 2, 0.1), []);
});

test('layersAt ignores the audio track entirely', () => {
  // The fixture's a1 track has a clip covering every t used above; if this
  // ever leaked into the result it would mean an audio "layer" trying to draw
  // through the keyed canvas pipeline.
  assert.deepEqual(TP.layersAt(tracks({}), 10, 0.1), []);
});

// ==========================================================================
// stepTimelineClock
// ==========================================================================

test('while paused, the clock just clamps playhead into [0, duration]', () => {
  assert.deepEqual(TP.stepTimelineClock({ playhead: 5, playing: false, duration: 20 }),
    { playhead: 5, playing: false });
  assert.deepEqual(TP.stepTimelineClock({ playhead: -3, playing: false, duration: 20 }),
    { playhead: 0, playing: false });
  assert.deepEqual(TP.stepTimelineClock({ playhead: 99, playing: false, duration: 20 }),
    { playhead: 20, playing: false });
});

test('while playing, the clock advances playhead by dt', () => {
  const next = TP.stepTimelineClock({ playhead: 5, playing: true, dt: 0.5, duration: 20 });
  assert.deepEqual(next, { playhead: 5.5, playing: true });
});

test('the clock stops at the project end rather than running past it', () => {
  const next = TP.stepTimelineClock({ playhead: 19.8, playing: true, dt: 1, duration: 20 });
  assert.deepEqual(next, { playhead: 20, playing: false });
});

test('landing exactly on duration also stops, not just overshooting it', () => {
  const next = TP.stepTimelineClock({ playhead: 19, playing: true, dt: 1, duration: 20 });
  assert.deepEqual(next, { playhead: 20, playing: false });
});

test('a negative dt (a clock glitch) does not run the playhead backwards', () => {
  const next = TP.stepTimelineClock({ playhead: 5, playing: true, dt: -1, duration: 20 });
  assert.equal(next.playhead, 5);
});

// ==========================================================================
// driftSeek
// ==========================================================================

test('driftSeek is null when the video is already close enough', () => {
  assert.equal(TP.driftSeek(5.02, 5, 0.15), null);
});

test('driftSeek returns the expected time once the gap passes the threshold', () => {
  assert.equal(TP.driftSeek(5.5, 5, 0.15), 5);
});

test('driftSeek treats the threshold as exclusive, matching stepClipLoop\'s own boundary style', () => {
  assert.equal(TP.driftSeek(5.1499, 5, 0.15), null, 'just under the threshold is still close enough');
  assert.equal(TP.driftSeek(5.1501, 5, 0.15), 5, 'just past it needs a correction');
});
