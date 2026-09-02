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
// charSplitKaraokeStates
// ==========================================================================

test('a caption with no text gives null, distinct from an empty-string one', () => {
  assert.equal(CP.charSplitKaraokeStates(cap({ text: undefined }), 1), null, 'not even a string');
  assert.deepEqual(CP.charSplitKaraokeStates(cap({ text: '' }), 1), [], 'a string, just an empty one');
});

test('empty, missing or malformed input gives null rather than throwing', () => {
  assert.equal(CP.charSplitKaraokeStates(null, 1), null);
  assert.equal(CP.charSplitKaraokeStates(undefined, 1), null);
  assert.equal(CP.charSplitKaraokeStates({}, 1), null);
});

test('the first character is spoken from the caption\'s own start onward, matching karaokeWordStates\' first-word convention', () => {
  const c = cap({ start: 2, end: 4, text: 'Hi' }); // dur=2s, 2 chars -> 100cs/char = 1s/char
  assert.deepEqual(CP.charSplitKaraokeStates(c, 2).map(s => s.spoken), [true, false]);
});

test('a later character becomes spoken once elapsed time reaches its own index times the per-character duration', () => {
  const c = cap({ start: 0, end: 2, text: 'Hi' }); // 100cs/char = 1s/char
  assert.deepEqual(CP.charSplitKaraokeStates(c, 0.99).map(s => s.spoken), [true, false]);
  assert.deepEqual(CP.charSplitKaraokeStates(c, 1).map(s => s.spoken), [true, true]);
});

test('every character stays spoken well past the caption\'s own end, the same as karaokeWordStates', () => {
  const c = cap({ start: 0, end: 2, text: 'Hi' });
  assert.deepEqual(CP.charSplitKaraokeStates(c, 100).map(s => s.spoken), [true, true]);
});

test('charSplitKaraokeStates carries each character through unchanged, in order', () => {
  const c = cap({ start: 0, end: 1, text: 'Hi!' });
  assert.deepEqual(CP.charSplitKaraokeStates(c, 0).map(s => s.char), ['H', 'i', '!']);
});

test('a caption shorter than the 0.1s floor uses the floor, matching buildAssFile\'s own clamp', () => {
  // dur clamps to 0.1s regardless of how short start..end actually is, the
  // same Math.max(0.1, ...) buildAssFile's own fallback branch applies.
  const short = cap({ start: 0, end: 0.001, text: 'Hi' }); // floor -> dur=0.1s, 2 chars -> 5cs/char = 0.05s/char
  assert.deepEqual(CP.charSplitKaraokeStates(short, 0.04).map(s => s.spoken), [true, false]);
  assert.deepEqual(CP.charSplitKaraokeStates(short, 0.05).map(s => s.spoken), [true, true]);
});

test('a newline counts as two characters in the per-character duration, the same quirk buildAssFile\'s \\N conversion produces', () => {
  // "a\nb": divisor is the ASS-escaped length (a, \, N, b = 4), not the real
  // character count (a, \n, b = 3) — so with dur=4s the increment is 1s/char
  // but there are only 3 real slots to walk through, and the last one (b)
  // is already spoken by t=2s rather than t=3s.
  const c = cap({ start: 0, end: 4, text: 'a\nb' });
  const states = CP.charSplitKaraokeStates(c, 0);
  assert.deepEqual(states.map(s => s.char), ['a', '\n', 'b']);
  assert.deepEqual(CP.charSplitKaraokeStates(c, 0.99).map(s => s.spoken), [true, false, false]);
  assert.deepEqual(CP.charSplitKaraokeStates(c, 1).map(s => s.spoken), [true, true, false]);
  assert.deepEqual(CP.charSplitKaraokeStates(c, 2).map(s => s.spoken), [true, true, true]);
});

// ==========================================================================
// charSplitKaraokeStates / buildAssFile: pinned so the two cannot drift
// ==========================================================================

test('charSplitKaraokeStates\' per-character duration matches the literal \\k value buildAssFile writes for the fallback', () => {
  // Same role the FADE_SEC/POP_SEC/SLIDE_SEC pin test plays above: this
  // recomputes buildAssFile's even-split-by-character formula by hand
  // (shared/ never reaches the renderer), so the ONLY thing that keeps the
  // two honest is a test that checks the real, current buildAssFile output
  // rather than a copy of the formula pasted into the test itself.
  const project = {
    width: 1080, height: 1920,
    captionStyle: { animation: 'typewriter' },
    captions: [{ start: 0, end: 1, text: 'Hi' }]
  };
  const ass = builder.buildAssFile(project);
  const kMatch = ass.match(/,,\{\\k(\d+)\}Hi$/m);
  assert.ok(kMatch, 'buildAssFile should still write a single \\k tag for the no-word-timing fallback');
  const secPerChar = Number(kMatch[1]) / 100;

  const caption = project.captions[0];
  // Character 0 is spoken immediately; character 1 only once secPerChar —
  // the exact duration buildAssFile's own \k tag carries — has elapsed.
  assert.deepEqual(CP.charSplitKaraokeStates(caption, 0).map(s => s.spoken), [true, false]);
  assert.deepEqual(
    CP.charSplitKaraokeStates(caption, secPerChar - 0.001).map(s => s.spoken),
    [true, false]
  );
  assert.deepEqual(
    CP.charSplitKaraokeStates(caption, secPerChar).map(s => s.spoken),
    [true, true]
  );
});

test('charSplitKaraokeStates still matches buildAssFile\'s \\k value for a longer, uneven line', () => {
  // dur=3.4s over 18 visible characters -> 340/18 = 18.888..., which rounds
  // to 19 rather than truncating to 18 — chosen deliberately so a rounding
  // mistake (floor instead of round) shows up as a wrong boundary rather
  // than hiding inside a margin wide enough to tolerate either.
  const project = {
    width: 1080, height: 1920,
    captionStyle: { animation: 'typewriter' },
    captions: [{ start: 5, end: 8.4, text: 'Hello there friend' }]
  };
  const ass = builder.buildAssFile(project);
  const kMatch = ass.match(/,,\{\\k(\d+)\}Hello there friend$/m);
  assert.ok(kMatch);
  assert.equal(Number(kMatch[1]), 19, 'sanity: buildAssFile still rounds up here');
  const secPerChar = Number(kMatch[1]) / 100;

  const caption = project.captions[0];
  // Character index 1 ('e') switches exactly one per-character duration
  // after the caption's own start — the same tight boundary check the "Hi"
  // pin test above uses.
  assert.deepEqual(
    CP.charSplitKaraokeStates(caption, caption.start + secPerChar - 0.001).map(s => s.spoken).slice(0, 2),
    [true, false]
  );
  assert.deepEqual(
    CP.charSplitKaraokeStates(caption, caption.start + secPerChar).map(s => s.spoken).slice(0, 2),
    [true, true]
  );
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
