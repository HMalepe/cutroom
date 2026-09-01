'use strict';

/*
 * The decision logic behind the caption preview overlay: which caption row
 * is active at a timeline instant, the entry-animation state for
 * 'fade'/'pop'/'slide' as a pure function of local caption time, which
 * words are "spoken" for a real per-word typewriter sweep, and the
 * ASS-to-CSS unit conversion the overlay's sizing rides on. All pure — no
 * DOM, no styling actually applied — the same split timeline-preview.js
 * draws between deciding what's active and app.js drawing it; the DOM
 * wiring (syncCaptionOverlay/applyCaptionOverlay in app.js) is covered
 * separately in test/caption-overlay.test.js's jsdom integration tests.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const CP = require('../src/caption-preview.js');
const builder = require('../shared/ffmpeg-builder.js');

function cap(over) {
  return Object.assign({ start: 0, end: 2, text: 'hello' }, over);
}

// ==========================================================================
// activeCaptionAt
// ==========================================================================

test('nothing active before the first caption or after the last gives null', () => {
  const caps = [cap({ start: 1, end: 3 })];
  assert.equal(CP.activeCaptionAt(caps, 0), null);
  assert.equal(CP.activeCaptionAt(caps, 3), null, 'end is exclusive');
});

test('t exactly at a caption\'s start is covered, matching trackStateAt\'s convention', () => {
  const c = cap({ start: 1, end: 3 });
  assert.equal(CP.activeCaptionAt([c], 1), c);
});

test('one caption covering t is returned', () => {
  const c = cap({ start: 1, end: 3 });
  assert.equal(CP.activeCaptionAt([c, cap({ start: 10, end: 12 })], 2), c);
});

test('a gap between two captions gives null', () => {
  const caps = [cap({ start: 0, end: 1 }), cap({ start: 2, end: 3 })];
  assert.equal(CP.activeCaptionAt(caps, 1.5), null);
});

test('two captions overlapping at t: the later-starting one wins', () => {
  const early = cap({ start: 0, end: 5, text: 'early' });
  const late = cap({ start: 2, end: 4, text: 'late' });
  assert.equal(CP.activeCaptionAt([early, late], 3), late);
  // Order in the array should not matter.
  assert.equal(CP.activeCaptionAt([late, early], 3), late);
});

test('empty, missing or malformed input gives null rather than throwing', () => {
  assert.equal(CP.activeCaptionAt([], 5), null);
  assert.equal(CP.activeCaptionAt(null, 5), null);
  assert.equal(CP.activeCaptionAt(undefined, 5), null);
  assert.equal(CP.activeCaptionAt([null, {}, { start: 'x', end: 2 }], 1), null);
});

// ==========================================================================
// animationState — fade / pop / slide
// ==========================================================================

test('an unrecognised or "none" animation is the identity state', () => {
  assert.deepEqual(CP.animationState('none', 5, 5), { opacity: 1, scale: 1, lift: 0 });
  assert.deepEqual(CP.animationState('nonsense', 0, 0), { opacity: 1, scale: 1, lift: 0 });
});

test('fade: invisible at the caption\'s own start, opaque once past the fade-in window', () => {
  const start = CP.animationState('fade', 0, 10);
  assert.equal(start.opacity, 0);
  const mid = CP.animationState('fade', CP.FADE_SEC / 2, 10);
  assert.equal(mid.opacity, 0.5);
  const settled = CP.animationState('fade', CP.FADE_SEC, 10);
  assert.equal(settled.opacity, 1);
});

test('fade: ramps back down inside the fade-out window before the end', () => {
  const justBefore = CP.animationState('fade', 10, CP.FADE_SEC / 4);
  assert.equal(justBefore.opacity, 0.25);
  const atEnd = CP.animationState('fade', 10, 0);
  assert.equal(atEnd.opacity, 0);
});

test('fade: a caption shorter than both fade windows never reaches full opacity', () => {
  // Total duration = FADE_SEC (half of the fade-in window elapsed, half the
  // fade-out window remaining) — both ramps are still in progress at once.
  const short = CP.animationState('fade', CP.FADE_SEC / 2, CP.FADE_SEC / 2);
  assert.equal(short.opacity, 0.5);
});

test('pop: scales from 60% at the start to 100% once settled, linearly between', () => {
  assert.equal(CP.animationState('pop', 0, 10).scale, 0.6);
  assert.equal(CP.animationState('pop', CP.POP_SEC, 10).scale, 1);
  assert.equal(CP.animationState('pop', CP.POP_SEC / 2, 10).scale, 0.8);
  // Past the window it holds rather than overshooting.
  assert.equal(CP.animationState('pop', CP.POP_SEC * 10, 10).scale, 1);
});

test('slide: lifted at the start, settled to 0 once past the slide window', () => {
  assert.equal(CP.animationState('slide', 0, 10).lift, 1);
  assert.equal(CP.animationState('slide', CP.SLIDE_SEC, 10).lift, 0);
  assert.equal(CP.animationState('slide', CP.SLIDE_SEC / 2, 10).lift, 0.5);
});

test('animationState clamps negative elapsed/remaining rather than reading past the window', () => {
  // A caller should only ask for a caption's active window, but this should
  // not misbehave on a caller error either.
  assert.deepEqual(CP.animationState('fade', -5, 10).opacity, 0);
  assert.deepEqual(CP.animationState('pop', -5, 10).scale, 0.6);
});

// ==========================================================================
// animationState / buildAssFile: kept in sync by hand — pinned here
// ==========================================================================

test('FADE_SEC/POP_SEC/SLIDE_SEC match the literal ms values buildAssFile writes', () => {
  // shared/ never reaches the renderer (see caption-preview.js's header), so
  // these constants are necessarily a hand-kept duplicate of buildAssFile's
  // own \fad/\t/\move literals — this is what stops the two silently
  // drifting apart, the same role test/timeline-preview.test.js's
  // TRANSITION_TYPES pin plays for the crossfade list.
  const project = {
    width: 1080, height: 1920,
    captionStyle: { animation: 'fade' },
    captions: [{ start: 0, end: 2, text: 'hi' }]
  };

  const fadeAss = builder.buildAssFile(project);
  const fadeMatch = fadeAss.match(/\\fad\((\d+),(\d+)\)/);
  assert.ok(fadeMatch, 'buildAssFile should still write a \\fad tag');
  assert.equal(Number(fadeMatch[1]), CP.FADE_SEC * 1000);
  assert.equal(Number(fadeMatch[2]), CP.FADE_SEC * 1000);

  project.captionStyle.animation = 'pop';
  const popAss = builder.buildAssFile(project);
  const popMatch = popAss.match(/\\t\(0,(\d+),/);
  assert.ok(popMatch, 'buildAssFile should still write a \\t tag');
  assert.equal(Number(popMatch[1]), CP.POP_SEC * 1000);

  project.captionStyle.animation = 'slide';
  const slideAss = builder.buildAssFile(project);
  const slideMatch = slideAss.match(/\\move\([^)]*,0,(\d+)\)/);
  assert.ok(slideMatch, 'buildAssFile should still write a \\move tag');
  assert.equal(Number(slideMatch[1]), CP.SLIDE_SEC * 1000);
});

// ==========================================================================
// karaokeWordStates
// ==========================================================================

test('a caption with no words gives null, distinct from an empty words array', () => {
  assert.equal(CP.karaokeWordStates(cap({}), 1), null, 'no words field at all — hand-typed or imported');
  assert.deepEqual(CP.karaokeWordStates(cap({ words: [] }), 1), [], 'a words array, just an empty one, is not the same case');
});

test('a word is "spoken" from its own start onward, and never reverts', () => {
  const c = cap({
    words: [
      { start: 0, end: 0.4, text: 'hello' },
      { start: 0.4, end: 0.9, text: 'there' },
      { start: 0.9, end: 1.5, text: 'world' }
    ]
  });
  assert.deepEqual(
    CP.karaokeWordStates(c, 0.5).map(w => w.spoken),
    [true, true, false],
    'the first two words\' own starts have passed, the third has not'
  );
  assert.deepEqual(
    CP.karaokeWordStates(c, 0).map(w => w.spoken),
    [true, false, false],
    'exactly at a word\'s own start it is already spoken'
  );
  assert.deepEqual(
    CP.karaokeWordStates(c, 10).map(w => w.spoken),
    [true, true, true],
    'well past the end, every word stays spoken'
  );
});

test('karaokeWordStates carries the word text through unchanged', () => {
  const c = cap({ words: [{ start: 0, end: 1, text: 'Hi!' }] });
  assert.equal(CP.karaokeWordStates(c, 0)[0].text, 'Hi!');
});

// ==========================================================================
// scaledPx
// ==========================================================================

test('scaledPx scales an ASS-space measurement by the stage\'s real rendered height', () => {
  // A stage rendered at half the project's own height halves every measurement.
  assert.equal(CP.scaledPx(54, 960, 1920), 27);
  assert.equal(CP.scaledPx(70, 960, 1920), 35);
  // A stage rendered at exactly the project's own resolution is 1:1.
  assert.equal(CP.scaledPx(54, 1920, 1920), 54);
});

test('scaledPx falls back to 1:1 with the project height when the stage has not been measured', () => {
  // 0 is what an unmeasured or not-yet-laid-out element reports (real
  // browsers before first paint; jsdom always, having no layout engine at
  // all) — this is the fallback every jsdom overlay test that checks a
  // computed size is actually exercising, not real proportional scaling.
  assert.equal(CP.scaledPx(54, 0, 1920), 54);
  assert.equal(CP.scaledPx(70, 0, 1920), 70);
});

test('scaledPx degrades to a finite number rather than NaN/Infinity for missing or zero input', () => {
  assert.equal(CP.scaledPx(undefined, 960, 1920), 0, 'a missing measurement scales to 0');
  // A zero or missing project height would otherwise divide by zero.
  assert.equal(CP.scaledPx(54, 0, 0), 54);
  assert.equal(CP.scaledPx(54, 0, undefined), 54);
});
