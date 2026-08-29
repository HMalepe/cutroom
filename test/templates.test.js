'use strict';

/*
 * applyTemplate rearranges every clip on Video 1 in one click, and it is the
 * only pure function in the app that was still untested. A bug here does not
 * throw — it silently produces a timeline that is subtly wrong, which is the
 * worst failure mode an edit tool has.
 *
 * The arithmetic worth pinning down is the interaction between three things:
 * slot length (what the template wants), source length (what the clip has),
 * and speed (which converts between timeline time and source time).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { TEMPLATES, applyTemplate } = require('../src/templates');

/** A bin-derived clip, shaped like makeClip's output in app.js. */
function clip(overrides = {}) {
  return {
    id: 'c1',
    src: '/tmp/a.mp4',
    name: 'a.mp4',
    sourceDuration: 60,
    hasAudio: true,
    hasVideo: true,
    inSec: 0,
    outSec: 60,
    startSec: 0,
    speed: 1,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
    scale: 1,
    posX: 0,
    posY: 0,
    chroma: { on: false, color: '#00FF00', similarity: 0.1, blend: 0.05 },
    filters: { brightness: 0, contrast: 1, saturation: 1 },
    ...overrides
  };
}

/** Minimal template, so each test states exactly the shape it depends on. */
function template(slots, extra = {}) {
  return { id: 't', name: 'T', note: '', tag: 'test', slots, ...extra };
}

const timelineLen = (c) => (c.outSec - c.inSec) / (c.speed || 1);

// --------------------------------------------------------------------------
// Laying clips end to end
// --------------------------------------------------------------------------

test('clips are laid end to end, each starting where the last ended', () => {
  const tpl = template([
    { dur: 2, speed: 1 },
    { dur: 3, speed: 1 }
  ]);
  const out = applyTemplate(tpl, [clip(), clip({ id: 'c2' })], 120);

  assert.equal(out[0].startSec, 0);
  assert.equal(timelineLen(out[0]), 2);
  assert.equal(out[1].startSec, 2, 'second clip starts where the first ended');
  assert.equal(timelineLen(out[1]), 3);
});

test('a slot shorter than the source trims the clip rather than stretching it', () => {
  const tpl = template([{ dur: 2, speed: 1 }]);
  const [out] = applyTemplate(tpl, [clip({ sourceDuration: 60 })], 120);

  assert.equal(out.inSec, 0);
  assert.equal(out.outSec, 2, 'takes only the 2s the slot asked for');
});

test('a slot longer than the source takes the whole source instead of inventing frames', () => {
  const tpl = template([{ dur: 10, speed: 1 }]);
  const [out] = applyTemplate(tpl, [clip({ sourceDuration: 3, outSec: 3 })], 120);

  assert.equal(out.outSec, 3, 'capped at what the file actually has');
  assert.equal(timelineLen(out), 3, 'so the slot comes up short rather than freezing');
});

// --------------------------------------------------------------------------
// Speed, and the timeline/source conversion
// --------------------------------------------------------------------------

test('a fast slot consumes more source than it occupies on the timeline', () => {
  // 2s of timeline at 2x needs 4s of source.
  const tpl = template([{ dur: 2, speed: 2 }]);
  const [out] = applyTemplate(tpl, [clip({ sourceDuration: 60 })], 120);

  assert.equal(out.speed, 2);
  assert.equal(out.outSec - out.inSec, 4, 'four seconds of source consumed');
  assert.equal(timelineLen(out), 2, 'occupying the two seconds the slot asked for');
});

test('a slow slot consumes less source than it occupies on the timeline', () => {
  // 2s of timeline at 0.5x needs only 1s of source.
  const tpl = template([{ dur: 2, speed: 0.5 }]);
  const [out] = applyTemplate(tpl, [clip({ sourceDuration: 60 })], 120);

  assert.equal(out.outSec - out.inSec, 1);
  assert.equal(timelineLen(out), 2);
});

test('the cursor advances in timeline time, not source time', () => {
  // The bug this guards: advancing by sourceNeeded instead of sourceNeeded/speed
  // would put the second clip at 4s rather than 2s.
  const tpl = template([
    { dur: 2, speed: 2 },
    { dur: 1, speed: 1 }
  ]);
  const out = applyTemplate(tpl, [clip(), clip({ id: 'c2' })], 120);

  assert.equal(out[1].startSec, 2);
});

test('a short source under a fast slot still advances by what it occupies', () => {
  // 1s of source at 2x occupies 0.5s of timeline, so the next clip starts there.
  const tpl = template([
    { dur: 5, speed: 2 },
    { dur: 1, speed: 1 }
  ]);
  const out = applyTemplate(tpl, [clip({ sourceDuration: 1, outSec: 1 }), clip({ id: 'c2' })], 120);

  assert.equal(out[0].outSec - out[0].inSec, 1, 'all the source there is');
  assert.equal(out[1].startSec, 0.5, 'advanced by timeline length, not source length');
});

// --------------------------------------------------------------------------
// Beat-based templates
// --------------------------------------------------------------------------

test('beat slots resolve against the project BPM', () => {
  const tpl = template([{ beats: 4, speed: 1 }], { beatBased: true });

  // At 120bpm a beat is 0.5s, so four beats is 2s.
  const [at120] = applyTemplate(tpl, [clip()], 120);
  assert.equal(timelineLen(at120), 2);

  // At 60bpm a beat is 1s, so the same slot is twice as long.
  const [at60] = applyTemplate(tpl, [clip()], 60);
  assert.equal(timelineLen(at60), 4);
});

test('beats take precedence over dur when a slot carries both', () => {
  const tpl = template([{ beats: 2, dur: 99, speed: 1 }]);
  const [out] = applyTemplate(tpl, [clip()], 120);

  assert.equal(timelineLen(out), 1, '2 beats at 120bpm, not the 99s dur');
});

test('a missing or zero BPM falls back to 120 rather than dividing by zero', () => {
  const tpl = template([{ beats: 4, speed: 1 }]);

  for (const bpm of [undefined, 0, null]) {
    const [out] = applyTemplate(tpl, [clip()], bpm);
    assert.equal(timelineLen(out), 2, `bpm ${bpm} falls back to 120`);
    assert.ok(Number.isFinite(out.outSec), `bpm ${bpm} produces a finite outSec`);
  }
});

// --------------------------------------------------------------------------
// More clips than slots
// --------------------------------------------------------------------------

test('clips past the last slot reuse it, so footage is never dropped', () => {
  const tpl = template([
    { dur: 1, speed: 1 },
    { dur: 2, speed: 2, fadeOut: 0.4 }
  ]);
  const out = applyTemplate(tpl, [clip(), clip({ id: 'c2' }), clip({ id: 'c3' }), clip({ id: 'c4' })], 120);

  assert.equal(out.length, 4, 'every clip survives');
  for (const c of out.slice(1)) {
    assert.equal(c.speed, 2, 'clips 2..4 all take the last slot');
    assert.equal(c.fadeOut, 0.4);
    assert.equal(timelineLen(c), 2);
  }
  assert.deepEqual(out.map(c => c.startSec), [0, 1, 3, 5]);
});

test('fewer clips than slots simply uses the leading slots', () => {
  const tpl = template([
    { dur: 1, speed: 1 },
    { dur: 2, speed: 1 },
    { dur: 3, speed: 1 }
  ]);
  const out = applyTemplate(tpl, [clip()], 120);

  assert.equal(out.length, 1);
  assert.equal(timelineLen(out[0]), 1);
});

test('no clips yields no clips', () => {
  assert.deepEqual(applyTemplate(template([{ dur: 1 }]), [], 120), []);
});

// --------------------------------------------------------------------------
// Overlap
// --------------------------------------------------------------------------

test('an overlapping template pulls each clip back over the one before it', () => {
  const tpl = template([{ dur: 2, speed: 1 }, { dur: 2, speed: 1 }], { overlap: 0.5 });
  const out = applyTemplate(tpl, [clip(), clip({ id: 'c2' })], 120);

  assert.equal(out[0].startSec, 0);
  assert.equal(out[1].startSec, 1.5, 'starts half a second before the first ends');
  // The overlap is what the alpha fades cross over.
  assert.ok(out[1].startSec < out[0].startSec + timelineLen(out[0]));
});

test('startSec never goes negative even if overlap exceeds a clip', () => {
  const tpl = template([{ dur: 1, speed: 1 }, { dur: 1, speed: 1 }], { overlap: 5 });
  const out = applyTemplate(tpl, [clip(), clip({ id: 'c2' })], 120);

  for (const c of out) assert.ok(c.startSec >= 0, `startSec ${c.startSec} is not negative`);
});

// --------------------------------------------------------------------------
// What is carried over from the original clip
// --------------------------------------------------------------------------

test('everything the template does not set is carried through untouched', () => {
  const tpl = template([{ dur: 1, speed: 1 }]);
  const original = clip({
    chroma: { on: true, color: '#00CC22', similarity: 0.3, blend: 0.1 },
    filters: { brightness: 0.2, contrast: 1.4, saturation: 0.8 },
    volume: 0.5,
    posX: 40,
    scale: 1.2
  });
  const [out] = applyTemplate(tpl, [original], 120);

  assert.deepEqual(out.chroma, original.chroma, 'a key survives being templated');
  assert.deepEqual(out.filters, original.filters);
  assert.equal(out.volume, 0.5);
  assert.equal(out.posX, 40);
  assert.equal(out.scale, 1.2);
  assert.equal(out.src, original.src);
  assert.equal(out.id, original.id);
});

test('the template sets fades, overwriting whatever the clip had', () => {
  const tpl = template([{ dur: 1, speed: 1, fadeIn: 0.3, fadeOut: 0.2 }]);
  const [out] = applyTemplate(tpl, [clip({ fadeIn: 9, fadeOut: 9 })], 120);

  assert.equal(out.fadeIn, 0.3);
  assert.equal(out.fadeOut, 0.2);
});

test('a slot with no fades clears the clip\'s existing ones', () => {
  const tpl = template([{ dur: 1, speed: 1 }]);
  const [out] = applyTemplate(tpl, [clip({ fadeIn: 9, fadeOut: 9 })], 120);

  assert.equal(out.fadeIn, 0, 'Brutalist Slab promises hard cuts only');
  assert.equal(out.fadeOut, 0);
});

test('the input clips are not mutated', () => {
  const tpl = template([{ dur: 1, speed: 3 }]);
  const original = clip({ speed: 1, startSec: 42 });
  const before = structuredClone(original);

  applyTemplate(tpl, [original], 120);

  assert.deepEqual(original, before, 'applyTemplate returns new clips, it does not edit in place');
});

test('a clip already trimmed keeps its in point and is measured from there', () => {
  const tpl = template([{ dur: 2, speed: 1 }]);
  const [out] = applyTemplate(tpl, [clip({ inSec: 5, outSec: 20, sourceDuration: 60 })], 120);

  assert.equal(out.inSec, 5, 'in point preserved');
  assert.equal(out.outSec, 7, 'two seconds measured from the in point');
});

test('a clip with no sourceDuration falls back to its trimmed length', () => {
  const tpl = template([{ dur: 10, speed: 1 }]);
  const [out] = applyTemplate(tpl, [clip({ sourceDuration: 0, inSec: 0, outSec: 4 })], 120);

  assert.equal(out.outSec, 4, 'bounded by out-in when sourceDuration is missing');
});

// --------------------------------------------------------------------------
// The shipped templates
// --------------------------------------------------------------------------

test('every shipped template is well formed', () => {
  assert.ok(TEMPLATES.length > 0);

  const ids = new Set();
  for (const tpl of TEMPLATES) {
    assert.ok(tpl.id, 'has an id');
    assert.equal(ids.has(tpl.id), false, `id ${tpl.id} is unique`);
    ids.add(tpl.id);

    assert.ok(tpl.name, `${tpl.id} has a name`);
    assert.ok(tpl.note, `${tpl.id} has a note explaining the rhythm`);
    assert.ok(tpl.tag, `${tpl.id} has a tag`);
    assert.ok(Array.isArray(tpl.slots) && tpl.slots.length, `${tpl.id} has slots`);

    for (const [i, slot] of tpl.slots.entries()) {
      const where = `${tpl.id} slot ${i}`;
      // renderTemplates draws the bars from beats-or-dur; a slot with neither
      // would render a zero-width bar and lay out a zero-length clip.
      assert.ok(slot.beats || slot.dur, `${where} has a length`);
      assert.ok((slot.beats || slot.dur) > 0, `${where} has a positive length`);
      if (slot.speed !== undefined) {
        assert.ok(slot.speed > 0, `${where} has a positive speed`);
        // The inspector offers 0.25x to 4x; a template should stay inside it.
        assert.ok(slot.speed >= 0.25 && slot.speed <= 4, `${where} speed is in range`);
      }
    }
  }
});

test('a template flagged beatBased actually uses beats', () => {
  for (const tpl of TEMPLATES.filter(t => t.beatBased)) {
    for (const [i, slot] of tpl.slots.entries()) {
      assert.ok(slot.beats, `${tpl.id} slot ${i} is measured in beats`);
    }
  }
});

test('every shipped template lays out a sane timeline', () => {
  const clips = Array.from({ length: 6 }, (_, i) => clip({ id: `c${i}` }));

  for (const tpl of TEMPLATES) {
    const out = applyTemplate(tpl, clips, 120);
    assert.equal(out.length, clips.length, `${tpl.id} keeps every clip`);

    let prevStart = -Infinity;
    for (const c of out) {
      assert.ok(Number.isFinite(c.startSec), `${tpl.id} start is finite`);
      assert.ok(c.startSec >= 0, `${tpl.id} start is not negative`);
      assert.ok(c.outSec > c.inSec, `${tpl.id} clip has positive length`);
      assert.ok(c.startSec >= prevStart, `${tpl.id} clips run forwards`);
      prevStart = c.startSec;
    }
  }
});
