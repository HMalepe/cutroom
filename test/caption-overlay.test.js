'use strict';

/*
 * The DOM wiring for the caption preview overlay: does #captionOverlay show
 * the right caption's text, at the right time, styled from the caption
 * style panel, and does it stay in sync with the playhead through the same
 * requestPreviewFrame()/syncTimelinePreview() path the video layers already
 * ride — see "Captions in the preview" in the README and the header
 * comment above syncCaptionOverlay/applyCaptionOverlay in app.js.
 *
 * Everything here goes through the real UI the way a person would drive it
 * — clicking the ruler, editing a caption row's inputs, toggling the style
 * panel's controls — the same discipline test/key-preview.test.js already
 * follows ("app.js exposes nothing to call directly, on purpose, so these
 * exercise exactly what a browser would run"). Nothing reaches into app.js's
 * private `state`.
 *
 * jsdom has no WebGL, so this reuses key-preview.test.js's own trick: stub
 * createKeyPreview so the composited path — the only path the overlay ever
 * appears on — actually runs. jsdom's DOM does support real CSS text
 * properties (color, background-color, class names, inline style strings),
 * unlike its faked <canvas>, so those are checked directly here; what is
 * NOT checked, because jsdom has no real layout engine, is anything that
 * depends on actual measured pixels — `cqh` units resolving to a real size,
 * text actually landing at the top/middle/bottom of the rendered frame, or
 * the animation states reading correctly on screen. Those need a real
 * browser; see the README for what a screenshot comparison there could
 * confirm that this suite cannot.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { opts, boot, seedBin, flush } = require('./dom-harness.js');

function stubKeyer() {
  return { draw: () => true, resize: () => ({ width: 1920, height: 1080 }), destroy: () => {}, isLost: () => false };
}

const rafTick = () => new Promise((r) => setTimeout(r, 100));

async function selectAClip(win, doc) {
  seedBin(win, doc, ['green.mp4']);
  await flush();
  doc.querySelector('#binList .bin-item').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  doc.getElementById('btnSendV1').click();
  const clip = doc.querySelector('#lanes .clip');
  clip.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }));
  return clip;
}

/**
 * Move the playhead the way clicking the ruler does, at 40px/s (the app's
 * default zoom). The ruler's own pointerdown handler calls
 * syncTimelinePreview() synchronously (see app.js), so this doubles as "force
 * a resync right now" even when moving to the playhead's current position —
 * used below instead of waiting out a real RAF tick wherever a synchronous
 * answer is enough, including in the no-WebGL fallback tests, which never
 * start a RAF loop at all.
 */
function setPlayhead(doc, sec) {
  doc.getElementById('tlScroll').dispatchEvent(
    new doc.defaultView.MouseEvent('pointerdown', { bubbles: true, clientX: sec * 40, clientY: 5 })
  );
}

// Same reasoning as key-preview.test.js's stopLoop: the stub keyer starts a
// real requestAnimationFrame loop with nothing to end it, so every test that
// used it tears the loop down in a `finally`, win or lose on the assertions.
function stopLoop(doc) {
  if (doc.getElementById('btnPlay').textContent === 'Pause') doc.getElementById('btnPlay').click();
  doc.getElementById('btnDeleteClip').click();
}

function enableCaptions(win, doc) {
  const cb = doc.getElementById('capEnabled');
  cb.checked = true;
  cb.dispatchEvent(new win.Event('change', { bubbles: true }));
}

/**
 * Add a caption row through "+ Add line" (which always starts it at the
 * current playhead, 2 seconds long, reading "New line") and then edit it
 * into shape through its own row's inputs — the same fields a person would
 * use, renderCaptions in app.js. `text` should be unique among captions
 * added in the same test: it is what makes the freshly-added, still
 * default-text row identifiable before anything else about it is set.
 */
function addAndEditCaption(win, doc, { atPlayhead, start, end, text }) {
  setPlayhead(doc, atPlayhead);
  doc.getElementById('btnAddCaption').click();
  const row = [...doc.querySelectorAll('#capList .cap-row')]
    .find(r => r.querySelector('.cap-text').value === 'New line');
  const [startInput, endInput] = row.querySelectorAll('.cap-time');
  const textArea = row.querySelector('.cap-text');

  startInput.value = String(start);
  startInput.dispatchEvent(new win.Event('change', { bubbles: true }));
  endInput.value = String(end);
  endInput.dispatchEvent(new win.Event('change', { bubbles: true }));
  textArea.value = text;
  textArea.dispatchEvent(new win.Event('input', { bubbles: true }));
}

/** #capStyle is built fresh by renderCaptionStyle() (see app.js), one
 *  field() per control, each labelled — matching by label text is what
 *  survives that panel's own layout changing, the same way test/key-
 *  preview.test.js's setTrim reaches #inspector's generated rows by
 *  structure rather than a fixed id. */
function capField(doc, labelText) {
  const field = [...doc.querySelectorAll('#capStyle .field')]
    .find(f => f.querySelector('.field-label').textContent === labelText);
  return field ? field.querySelector('input, select') : null;
}

function setCapField(win, doc, labelText, value) {
  const el = capField(doc, labelText);
  el.value = value;
  el.dispatchEvent(new win.Event('change', { bubbles: true }));
}

function rgbFromHex(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

// ==========================================================================
// Which caption shows, and when
// ==========================================================================

test('a caption active at the playhead shows in the overlay, styled from captionStyle', opts, async () => {
  const { win, doc } = boot();
  win.createKeyPreview = stubKeyer;
  try {
    await selectAClip(win, doc);
    addAndEditCaption(win, doc, { atPlayhead: 0, start: 0, end: 5, text: 'Hello there' });
    enableCaptions(win, doc);
    setCapField(win, doc, 'Animation', 'none');
    setPlayhead(doc, 0); // force a synchronous resync at the same instant

    const overlay = doc.getElementById('captionOverlay');
    const text = doc.getElementById('captionOverlayText');
    assert.equal(overlay.style.display, 'flex');
    assert.equal(text.textContent, 'Hello there');
    assert.equal(text.style.color, rgbFromHex('#FFFFFF'), 'the project default text colour');
  } finally {
    stopLoop(doc);
  }
});

test('scrubbing past a caption\'s end hides it; scrubbing into the next caption\'s window shows that one', opts, async () => {
  const { win, doc } = boot();
  win.createKeyPreview = stubKeyer;
  try {
    await selectAClip(win, doc);
    addAndEditCaption(win, doc, { atPlayhead: 0, start: 0, end: 2, text: 'First' });
    addAndEditCaption(win, doc, { atPlayhead: 3, start: 3, end: 5, text: 'Second' });
    enableCaptions(win, doc);
    setPlayhead(doc, 0.5);
    assert.equal(doc.getElementById('captionOverlayText').textContent, 'First');

    setPlayhead(doc, 2.5); // the gap between the two — neither is active
    assert.equal(doc.getElementById('captionOverlay').style.display, 'none', 'nothing active in the gap');

    setPlayhead(doc, 4);
    assert.equal(doc.getElementById('captionOverlayText').textContent, 'Second');
  } finally {
    stopLoop(doc);
  }
});

test('captionsEnabled=false shows nothing, even with captions on the project', opts, async () => {
  const { win, doc } = boot();
  win.createKeyPreview = stubKeyer;
  try {
    await selectAClip(win, doc);
    addAndEditCaption(win, doc, { atPlayhead: 0, start: 0, end: 5, text: 'Hidden' });
    // capEnabled is never checked — the project default (false).
    setPlayhead(doc, 0);

    assert.equal(doc.getElementById('captionOverlay').style.display, 'none');
  } finally {
    stopLoop(doc);
  }
});

test('a project with no captions at all shows nothing', opts, async () => {
  const { win, doc } = boot();
  win.createKeyPreview = stubKeyer;
  try {
    await selectAClip(win, doc);
    enableCaptions(win, doc);
    setPlayhead(doc, 0);

    assert.equal(doc.getElementById('captionOverlay').style.display, 'none');
  } finally {
    stopLoop(doc);
  }
});

test('turning captionsEnabled off does not leave a stale caption on screen', opts, async () => {
  const { win, doc } = boot();
  win.createKeyPreview = stubKeyer;
  try {
    await selectAClip(win, doc);
    addAndEditCaption(win, doc, { atPlayhead: 0, start: 0, end: 5, text: 'On screen' });
    enableCaptions(win, doc);
    setPlayhead(doc, 0);
    assert.equal(doc.getElementById('captionOverlayText').textContent, 'On screen');

    const cb = doc.getElementById('capEnabled');
    cb.checked = false;
    cb.dispatchEvent(new win.Event('change', { bubbles: true }));
    await rafTick(); // capEnabled's own handler does not resync synchronously — the running RAF loop is what picks it up, same as any other style change

    assert.equal(doc.getElementById('captionOverlay').style.display, 'none', 'toggling off hides it without needing a scrub');
  } finally {
    stopLoop(doc);
  }
});

test('the overlay only appears while the composited stage itself is showing (not bin mode)', opts, async () => {
  const { win, doc } = boot();
  win.createKeyPreview = stubKeyer;
  try {
    await selectAClip(win, doc);
    addAndEditCaption(win, doc, { atPlayhead: 0, start: 0, end: 5, text: 'On the timeline' });
    enableCaptions(win, doc);
    setPlayhead(doc, 0);
    assert.equal(doc.getElementById('captionOverlay').style.display, 'flex');

    doc.querySelector('#binList .bin-item').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    assert.equal(doc.getElementById('captionOverlay').style.display, 'none', 'bin preview is a raw file, not the timeline');
  } finally {
    stopLoop(doc);
  }
});

test('with no WebGL, the fallback plain <video> shows and the caption overlay stays hidden', opts, async () => {
  // No win.createKeyPreview stub here — the harness's real getContext()
  // stub (see dom-harness.js) returns null, same as a machine with no
  // WebGL, which is exactly the path under test. This path never starts a
  // RAF loop (see syncTimelinePreview's !keyer0 branch), so setPlayhead's
  // synchronous resync — not a rafTick wait — is what proves this rather
  // than just "never got a chance to check".
  const { win, doc } = boot();
  try {
    await selectAClip(win, doc);
    addAndEditCaption(win, doc, { atPlayhead: 0, start: 0, end: 5, text: 'Never shown here' });
    enableCaptions(win, doc);
    setPlayhead(doc, 0);

    assert.equal(doc.getElementById('video').style.display, 'block', 'the plain <video> fallback is showing');
    assert.equal(doc.getElementById('previewStage').style.display, 'none');
    assert.equal(doc.getElementById('captionOverlay').style.display, 'none',
      'a deliberate gap — see "Captions in the preview" in the README for why');
  } finally {
    doc.getElementById('btnDeleteClip').click();
  }
});

// ==========================================================================
// Style panel changes reach the overlay without an extra trigger
// ==========================================================================

test('changing the caption size in the style panel updates the live overlay', opts, async () => {
  const { win, doc } = boot();
  win.createKeyPreview = stubKeyer;
  try {
    await selectAClip(win, doc);
    addAndEditCaption(win, doc, { atPlayhead: 0, start: 0, end: 5, text: 'Size test' });
    enableCaptions(win, doc);
    setPlayhead(doc, 0);

    setCapField(win, doc, 'Size', '120');
    await rafTick(); // the size field's own onchange only sets previewDirty — the running RAF loop is the trigger, not a synchronous call

    // jsdom never lays anything out, so #previewStage.clientHeight is always
    // 0 and scaledPx falls back to 1:1 — see caption-preview.js. That is a
    // real limit of what this suite can confirm: real proportional scaling
    // against a real rendered box needs a real browser, the same way the
    // WebGL compositing itself does.
    assert.equal(doc.getElementById('captionOverlayText').style.fontSize, '120px',
      'reached with no scrub or extra trigger written for this feature');
  } finally {
    stopLoop(doc);
  }
});

test('changing the text colour updates the live overlay', opts, async () => {
  const { win, doc } = boot();
  win.createKeyPreview = stubKeyer;
  try {
    await selectAClip(win, doc);
    addAndEditCaption(win, doc, { atPlayhead: 0, start: 0, end: 5, text: 'Colour test' });
    enableCaptions(win, doc);
    setCapField(win, doc, 'Animation', 'none');
    setPlayhead(doc, 0);

    setCapField(win, doc, 'Text colour', '#123456');
    await rafTick();

    assert.equal(doc.getElementById('captionOverlayText').style.color, rgbFromHex('#123456'));
  } finally {
    stopLoop(doc);
  }
});

test('changing position updates the overlay\'s alignment class', opts, async () => {
  const { win, doc } = boot();
  win.createKeyPreview = stubKeyer;
  try {
    await selectAClip(win, doc);
    addAndEditCaption(win, doc, { atPlayhead: 0, start: 0, end: 5, text: 'Position test' });
    enableCaptions(win, doc);
    setPlayhead(doc, 0);
    assert.ok(doc.getElementById('captionOverlay').classList.contains('pos-bottom'), 'the project default');

    setCapField(win, doc, 'Position', 'top');
    await rafTick();

    assert.ok(doc.getElementById('captionOverlay').classList.contains('pos-top'));
    assert.ok(!doc.getElementById('captionOverlay').classList.contains('pos-bottom'));
  } finally {
    stopLoop(doc);
  }
});

test('editing a caption row\'s text updates the live overlay', opts, async () => {
  const { win, doc } = boot();
  win.createKeyPreview = stubKeyer;
  try {
    await selectAClip(win, doc);
    addAndEditCaption(win, doc, { atPlayhead: 0, start: 0, end: 5, text: 'Original' });
    enableCaptions(win, doc);
    setPlayhead(doc, 0);
    assert.equal(doc.getElementById('captionOverlayText').textContent, 'Original');

    const textArea = doc.querySelector('#capList .cap-text');
    textArea.value = 'Edited live';
    textArea.dispatchEvent(new win.Event('input', { bubbles: true }));
    await rafTick();

    assert.equal(doc.getElementById('captionOverlayText').textContent, 'Edited live');
  } finally {
    stopLoop(doc);
  }
});

// ==========================================================================
// Background box on/off
// ==========================================================================

test('the "Box behind text" checkbox toggles a real background-color on the overlay text', opts, async () => {
  const { win, doc } = boot();
  win.createKeyPreview = stubKeyer;
  try {
    await selectAClip(win, doc);
    addAndEditCaption(win, doc, { atPlayhead: 0, start: 0, end: 5, text: 'Boxed' });
    enableCaptions(win, doc);
    setPlayhead(doc, 0);
    assert.equal(doc.getElementById('captionOverlayText').style.backgroundColor, 'transparent',
      'the project default has no box');

    const checkbox = doc.getElementById('capBg');
    checkbox.checked = true;
    checkbox.dispatchEvent(new win.Event('change', { bubbles: true }));
    await rafTick();

    const bg = doc.getElementById('captionOverlayText').style.backgroundColor;
    assert.notEqual(bg, 'transparent');
    assert.match(bg, /^rgba\(/);
  } finally {
    stopLoop(doc);
  }
});

// ==========================================================================
// Typewriter / karaoke
// ==========================================================================

test('typewriter with real per-word timing renders one span per word, coloured by whether it has been "spoken" yet', opts, async () => {
  const { win, doc } = boot();
  win.createKeyPreview = stubKeyer;
  // Real per-word timing only ever reaches state.project.captions through
  // transcription (or an import, which this harness does not fake either) —
  // there is no UI path to hand-author it, so this is the one caption in
  // this suite not built through addAndEditCaption.
  win.cutroom.transcribe = async () => ({
    ok: true,
    captions: [{
      start: 0, end: 1.5, text: 'hello there world',
      words: [
        { start: 0, end: 0.5, text: 'hello' },
        { start: 0.5, end: 1, text: 'there' },
        { start: 1, end: 1.5, text: 'world' }
      ]
    }]
  });
  try {
    await selectAClip(win, doc); // startSec 0, inSec 0, speed 1 — transcribeSelected's shift is 0
    doc.getElementById('btnTranscribe').click();
    await flush();
    setCapField(win, doc, 'Animation', 'typewriter');
    setPlayhead(doc, 0.7); // past word 0 and 1's own starts, not word 2's

    const spans = [...doc.querySelectorAll('#captionOverlayText span')];
    assert.equal(spans.length, 3);
    assert.deepEqual(spans.map(s => s.textContent), ['hello', 'there', 'world']);
    const primary = rgbFromHex('#FFFFFF');
    assert.equal(spans[0].style.color, primary, 'spoken');
    assert.equal(spans[1].style.color, primary, 'spoken — its own start has passed');
    assert.notEqual(spans[2].style.color, primary, 'not yet spoken');
  } finally {
    stopLoop(doc);
  }
});

test('typewriter on a caption with no per-word timing shows plain text — a documented gap, not a crash', opts, async () => {
  const { win, doc } = boot();
  win.createKeyPreview = stubKeyer;
  try {
    await selectAClip(win, doc);
    addAndEditCaption(win, doc, { atPlayhead: 0, start: 0, end: 3, text: 'no word timing here' });
    enableCaptions(win, doc);
    setCapField(win, doc, 'Animation', 'typewriter');
    setPlayhead(doc, 0);

    assert.equal(doc.querySelectorAll('#captionOverlayText span').length, 0);
    assert.equal(doc.getElementById('captionOverlayText').textContent, 'no word timing here');
  } finally {
    stopLoop(doc);
  }
});
