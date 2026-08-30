'use strict';

/*
 * The WebGL half of the live key preview.
 *
 * There is no GPU here, so nothing below renders a pixel — the shader is
 * verified against chroma-math.js in a real browser, outside this suite (see
 * the PR and the note in key-preview.js). What is testable in Node is the part
 * that has actually broken things before: whether the module degrades cleanly
 * when there is no context, whether the page loads it in a way the app's CSP
 * allows, and whether the pane falls back to the plain <video> when it must.
 *
 * The DOM half uses the same jsdom harness as the undo tests, where
 * getContext() returns null — which is exactly the case being tested.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const M = require('../src/chroma-math.js'); // key-preview reads it off the global too
const KP = require('../src/key-preview.js');
const { opts, boot, seedBin, flush, SRC, fakeMedia } = require('./dom-harness.js');

// ==========================================================================
// Degrading
// ==========================================================================

test('a canvas with no WebGL context gives null, not an exception', () => {
  // The single most important line in the file: a machine without WebGL, and
  // jsdom, both land here, and the app has to keep working.
  assert.equal(KP.createKeyPreview({ getContext: () => null }), null);
});

test('a getContext that throws is treated as no WebGL', () => {
  // Some hardened browser configurations throw rather than returning null.
  assert.equal(KP.createKeyPreview({ getContext: () => { throw new Error('blocked'); } }), null);
});

test('a missing or malformed canvas gives null', () => {
  assert.equal(KP.createKeyPreview(null), null);
  assert.equal(KP.createKeyPreview(undefined), null);
  assert.equal(KP.createKeyPreview({}), null);
});

test('a context that cannot compile the shader gives null rather than half a preview', () => {
  // A driver can advertise WebGL and then fail on a real program. Better to
  // fall back than to show a black canvas and let someone key against it.
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3,
    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => false,
    getShaderInfoLog: () => 'no',
    deleteShader: () => {}
  };
  assert.equal(KP.createKeyPreview({ getContext: () => gl }), null);
});

// ==========================================================================
// The shader source itself
// ==========================================================================

test('the shaders are plain strings, which is what the CSP leaves room for', () => {
  // index.html sets default-src 'self' with no script-src, so an inline
  // <script> and any CDN are silently dead. Shader source in a JS string in a
  // file loaded by <script src> is the way through that, and this pins it.
  assert.equal(typeof KP.VERT, 'string');
  assert.equal(typeof KP.FRAG, 'string');
  assert.ok(KP.FRAG.includes('gl_FragColor'), 'the fragment shader writes a colour');
});

test('the shader keeps the filter order the export uses', () => {
  // eq, then chromakey, then despill. If someone reorders the shader without
  // reordering buildVideoClipChain the preview stops matching, and the failure
  // is invisible until a render disagrees.
  // Measured inside main() only — the uniform declarations at the top are in
  // alphabetical-ish order and say nothing about when anything runs.
  const body = KP.FRAG.slice(KP.FRAG.indexOf('void main'));
  const eq = body.indexOf('uEqLumaOn)');
  const key = body.indexOf('uSimilarity');
  const despill = body.indexOf('uDespillMix');
  assert.ok(eq > 0 && key > eq, 'eq comes before the key');
  assert.ok(despill > key, 'despill comes after the key');
});

test('the shader uses ffmpeg\'s constants, not rounded-off versions of them', () => {
  // The three numbers the maths turns on, spelled the way vf_chromakey.c
  // spells them. A search-and-replace that "tidied" 255.0 * 255.0 * 2.0 into
  // 130050.0 would still be correct; anything else would not be.
  assert.ok(KP.FRAG.includes('255.0 * 255.0 * 2.0'), 'the distance normaliser');
  assert.ok(KP.FRAG.includes('0.0001'), 'the blend threshold');
  // eq is process_c's integer arithmetic, not create_lut's float one. The
  // 4096 is its >> 12; if it turns back into a 256.0 the preview has quietly
  // gone back to the version that disagreed with the export by five codes.
  assert.ok(KP.FRAG.includes('4096.0'), 'process_c\'s fixed point');
  assert.ok(!KP.FRAG.includes('256.0 *'), 'and not create_lut\'s scale');
});

// ==========================================================================
// Colour matrix selection
// ==========================================================================

/*
 * draw() needs a real, linkable program before it will reach the uniform
 * uploads, so the shader-compile mock above is not enough; this builds one
 * that succeeds at every step and just records what draw() sent to
 * uniformMatrix3fv, keyed by the uniform's own name.
 */
function makeFakeGl() {
  const uniforms = {};
  const uniformMatrix3fv = [];
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
    ARRAY_BUFFER: 5, STATIC_DRAW: 6, TEXTURE_2D: 7, TEXTURE_WRAP_S: 8, TEXTURE_WRAP_T: 9,
    CLAMP_TO_EDGE: 10, TEXTURE_MIN_FILTER: 11, TEXTURE_MAG_FILTER: 12, LINEAR: 13,
    RGBA: 14, UNSIGNED_BYTE: 15, COLOR_BUFFER_BIT: 16, TRIANGLE_STRIP: 17, FLOAT: 18, TEXTURE0: 19,
    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    deleteShader: () => {},
    createProgram: () => ({}),
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    deleteProgram: () => {},
    createBuffer: () => ({}),
    bindBuffer: () => {},
    bufferData: () => {},
    getAttribLocation: () => 0,
    getUniformLocation: (_prog, name) => (uniforms[name] || (uniforms[name] = { name })),
    createTexture: () => ({}),
    bindTexture: () => {},
    texParameteri: () => {},
    texImage2D: () => {},
    viewport: () => {},
    clearColor: () => {},
    clear: () => {},
    useProgram: () => {},
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    activeTexture: () => {},
    uniform1i: () => {},
    uniform2f: () => {},
    uniform4f: () => {},
    uniform3f: () => {},
    uniform1f: () => {},
    uniformMatrix3fv: (loc, transpose, data) => uniformMatrix3fv.push({ name: loc.name, data: Array.from(data) }),
    drawArrays: () => {},
    deleteTexture: () => {},
    deleteBuffer: () => {}
  };
  return { gl, uniformMatrix3fv };
}

/** Row-major MATRICES entry -> the column-major array WebGL wants, computed
 *  independently of columnMajor() in key-preview.js so the test cannot pass
 *  by sharing a bug with the code it checks. Rounded through Float32Array,
 *  the same lossy step draw() itself applies before the upload. */
function columnMajorIndependently(m) {
  return Array.from(new Float32Array(
    [m[0][0], m[1][0], m[2][0], m[0][1], m[1][1], m[2][1], m[0][2], m[1][2], m[2][2]]
  ));
}

test('draw() selects the matrix from the clip\'s colour tag, not the project', () => {
  const canvas = { width: 0, height: 0, getContext: () => fake.gl, addEventListener: () => {} };
  const fake = makeFakeGl();
  const kp = KP.createKeyPreview(canvas);
  assert.ok(kp, 'the fully-stubbed context should link');

  const video = { videoWidth: 100, videoHeight: 100 };
  const project = { width: 100, height: 100, colorMatrix: 'bt709' }; // must be ignored
  const clip = { chroma: { color: '#00FF00' }, colorMatrix: 'bt601' };

  assert.ok(kp.draw(video, clip, project), 'draw should report a frame drawn');
  const uFwd = fake.uniformMatrix3fv.filter(c => c.name === 'uFwd');
  assert.equal(uFwd.length, 1);
  assert.deepEqual(uFwd[0].data, columnMajorIndependently(M.MATRICES.bt601.m),
    'a project.colorMatrix of bt709 must not leak into a bt601 clip');
});

test('draw() falls back to DEFAULT_MATRIX for an untagged clip', () => {
  const canvas = { width: 0, height: 0, getContext: () => fake.gl, addEventListener: () => {} };
  const fake = makeFakeGl();
  const kp = KP.createKeyPreview(canvas);

  const video = { videoWidth: 100, videoHeight: 100 };
  const project = { width: 100, height: 100 };
  const clip = { chroma: { color: '#00FF00' } }; // no colorMatrix: an untagged source

  kp.draw(video, clip, project);
  const uFwd = fake.uniformMatrix3fv.find(c => c.name === 'uFwd');
  assert.deepEqual(uFwd.data, columnMajorIndependently(M.MATRICES[M.DEFAULT_MATRIX].m));
});

test('two clips in the same project can carry different colour matrices', () => {
  const canvas = { width: 0, height: 0, getContext: () => fake.gl, addEventListener: () => {} };
  const fake = makeFakeGl();
  const kp = KP.createKeyPreview(canvas);
  const video = { videoWidth: 100, videoHeight: 100 };
  const project = { width: 100, height: 100 };

  kp.draw(video, { chroma: {}, colorMatrix: 'bt709' }, project);
  kp.draw(video, { chroma: {}, colorMatrix: 'bt601' }, project);

  const sent = fake.uniformMatrix3fv.filter(c => c.name === 'uFwd').map(c => c.data);
  assert.deepEqual(sent[0], columnMajorIndependently(M.MATRICES.bt709.m));
  assert.deepEqual(sent[1], columnMajorIndependently(M.MATRICES.bt601.m));
});

// ==========================================================================
// Loop / speed
// ==========================================================================

/*
 * stepClipLoop is the whole decision behind looping the preview's <video>
 * between a clip's trim points at its speed: given where playback currently
 * sits and the clip's inSec/outSec/speed, what should the caller do. No DOM,
 * no video element, so every case below is a plain call and assert.
 */

test('inside the trim, no seek and playbackRate matches speed', () => {
  const step = KP.stepClipLoop(5, { inSec: 2, outSec: 8, speed: 2 });
  assert.equal(step.seekTo, null);
  assert.equal(step.playbackRate, 2);
});

test('at the very start of the trim, no seek', () => {
  const step = KP.stepClipLoop(2, { inSec: 2, outSec: 8, speed: 1 });
  assert.equal(step.seekTo, null);
});

test('reaching outSec loops back to inSec', () => {
  // "Reaches" means currentTime has arrived at or passed outSec — the exact
  // moment ffmpeg's own trim would stop reading source frames.
  const step = KP.stepClipLoop(8, { inSec: 2, outSec: 8, speed: 1 });
  assert.equal(step.seekTo, 2);
});

test('past outSec also loops back, not just exactly on it', () => {
  const step = KP.stepClipLoop(9.5, { inSec: 2, outSec: 8, speed: 1 });
  assert.equal(step.seekTo, 2);
});

test('before inSec (a fresh load, or a trim moved forward) seeks up to it', () => {
  const step = KP.stepClipLoop(0, { inSec: 2, outSec: 8, speed: 1 });
  assert.equal(step.seekTo, 2);
});

test('a degenerate trim (outSec <= inSec) holds at inSec instead of looping nothing', () => {
  const holds = KP.stepClipLoop(5, { inSec: 5, outSec: 5, speed: 1 });
  assert.equal(holds.seekTo, 5);
  const inverted = KP.stepClipLoop(3, { inSec: 5, outSec: 1, speed: 1 });
  assert.equal(inverted.seekTo, 5);
});

test('a clip missing inSec/outSec/speed defaults to a 1x full-source read', () => {
  const step = KP.stepClipLoop(0, {});
  assert.equal(step.seekTo, 0);
  assert.equal(step.playbackRate, 1);
});

test('playbackRate is clamped to what HTMLMediaElement actually supports', () => {
  assert.equal(KP.clampPlaybackRate(50), KP.MAX_PLAYBACK_RATE);
  assert.equal(KP.clampPlaybackRate(0.001), KP.MIN_PLAYBACK_RATE);
  assert.equal(KP.clampPlaybackRate(2), 2, 'a normal clip speed is untouched');
  assert.equal(KP.clampPlaybackRate(NaN), 1, 'not-a-number falls back to 1x rather than clamping to a bound');
  assert.equal(KP.clampPlaybackRate(undefined), 1);
});

test('the app\'s own speed range (0.25x-4x) sits well inside the clamp', () => {
  // If a future PR widens the speed slider past this, it should still be a
  // deliberate decision against the real HTMLMediaElement limits, not a
  // silent clamp discovered in the field.
  assert.ok(KP.MIN_PLAYBACK_RATE <= 0.25 && KP.MAX_PLAYBACK_RATE >= 4);
});

// ==========================================================================
// How the page loads it
// ==========================================================================

test('index.html loads both modules with <script src>, before app.js', () => {
  const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  const order = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);

  assert.ok(order.includes('chroma-math.js'), 'chroma-math.js is loaded');
  assert.ok(order.includes('key-preview.js'), 'key-preview.js is loaded');
  assert.ok(
    order.indexOf('chroma-math.js') < order.indexOf('app.js'),
    'and both before app.js, which reaches them through the shared global scope'
  );
  assert.ok(order.indexOf('key-preview.js') < order.indexOf('app.js'));
});

test('the page still has no inline script for the CSP to swallow', () => {
  const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  // A <script> with a body rather than a src, or an on* attribute, would run
  // in a browser with no CSP and silently not run in this one — the worst
  // possible failure mode, so it is worth a test rather than a comment.
  assert.equal(html.match(/<script(?![^>]*\ssrc=)[^>]*>/g), null, 'no inline <script>');
  assert.equal(html.match(/\son(click|load|change|input)=/g), null, 'no inline handlers');
});

// ==========================================================================
// The pane, in a DOM with no WebGL
// ==========================================================================

/** Put a clip on Video 1 and select it, which is what turns the preview on. */
async function selectAClip(win, doc) {
  seedBin(win, doc, ['green.mp4']);
  await flush();
  doc.querySelector('#binList .bin-item').dispatchEvent(
    new win.MouseEvent('click', { bubbles: true })
  );
  doc.getElementById('btnSendV1').click();

  const clip = doc.querySelector('#lanes .clip');
  clip.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }));
  return clip;
}

test('with no WebGL the pane falls back to the plain video, controls and all', opts, async () => {
  const { win, doc } = boot();
  await selectAClip(win, doc);

  const video = doc.getElementById('video');
  const canvas = doc.getElementById('keyCanvas');

  assert.equal(canvas.style.display, 'none', 'the canvas stays hidden');
  assert.equal(video.style.display, 'block', 'the video is what shows');
  assert.equal(video.controls, true, 'and keeps its own controls');
  assert.equal(
    video.classList.contains('texture-only'), false,
    'and is not demoted to a texture source'
  );
});

test('the scrub bar only appears when the canvas it drives does', opts, async () => {
  const { win, doc } = boot();
  await selectAClip(win, doc);
  assert.equal(doc.getElementById('scrub').style.display, 'none');
});

test('selecting a clip points the preview at its source file', opts, async () => {
  const { win, doc } = boot();
  await selectAClip(win, doc);
  assert.match(doc.getElementById('video').src, /green\.mp4$/);
});

test('an empty timeline shows the empty pane, not a leftover fallback frame', opts, () => {
  // No clip has ever been added, so there is nothing for the no-WebGL
  // fallback to show — this pins that it says so rather than drawing
  // whatever the fallback's own stale state happens to default to.
  const { doc } = boot();
  assert.equal(doc.getElementById('viewerEmpty').style.display, 'block');
  assert.equal(doc.getElementById('previewStage').style.display, 'none');
  assert.equal(doc.getElementById('video').style.display, 'none');
});

test('the canvas exists in the markup even where it can never be used', opts, () => {
  // app.js asks for it by id at boot. If it is dropped from index.html the
  // failure is a null dereference on first selection, not a missing preview.
  const { doc } = boot();
  assert.ok(doc.getElementById('keyCanvas'), '#keyCanvas');
  assert.ok(doc.getElementById('scrub'), '#scrub');
});

test('booting the app touches no graphics context at all', opts, () => {
  // Building a GL context costs something and a project that never keys never
  // needs one, so it is created on first use rather than at startup — which is
  // also what keeps this suite quiet.
  const { win, doc } = boot();
  let asked = 0;
  win.HTMLCanvasElement.prototype.getContext = () => { asked++; return null; };
  doc.getElementById('btnZoomIn').click();
  assert.equal(asked, 0, 'nothing asked for a context');
});

test('deleting the clip under the playhead drops the preview to the empty pane, not a ghost of it', opts, async () => {
  // The pane is playhead-driven now, not selection-driven — so what proves
  // this is deleting the clip the playhead is actually sitting over, not
  // deleting whatever happens to be selected.
  const { win, doc } = boot();
  await selectAClip(win, doc);
  doc.getElementById('btnDeleteClip').click();

  assert.equal(doc.getElementById('keyCanvas').style.display, 'none');
  assert.equal(doc.getElementById('video').style.display, 'none', 'not the old file either');
  assert.equal(doc.getElementById('viewerEmpty').style.display, 'block', 'the empty pane is what is left');
});

test('a bin selection previews plain, because a bin item has no key to show', opts, async () => {
  const { win, doc } = boot();
  seedBin(win, doc, ['a.mp4']);
  await flush();
  doc.querySelector('#binList .bin-item').dispatchEvent(
    new win.MouseEvent('click', { bubbles: true })
  );

  assert.equal(doc.getElementById('keyCanvas').style.display, 'none');
  assert.equal(doc.getElementById('video').controls, true);
  assert.match(doc.getElementById('video').src, /a\.mp4$/);
});

// ==========================================================================
// Loop wiring: does the keyed pane actually drive the <video>
// ==========================================================================

/*
 * jsdom has no WebGL, so without help keyerFor() falls back to the plain
 * <video> before app.js ever reaches the compositing logic — which is what
 * every test above this point relies on. These tests instead hand app.js a
 * fake keyer with the real one's shape (draw/resize/destroy/isLost), the same
 * way a browser with a working driver would, so the composited branch — the
 * one that drives a layer's own <video> — runs for real. What is under test
 * is app.js's wiring: does the playhead sitting over a clip reach that
 * clip's <video>, and does play advance the timeline clock the way it is
 * meant to. The draw call itself, and the shader it feeds, are covered
 * elsewhere (chroma-math.test.js, and by hand against real ffmpeg output per
 * the header comments) — nothing here asserts a pixel.
 */
function stubKeyer() {
  return {
    draw: () => true,
    resize: () => ({ width: 1920, height: 1080 }),
    destroy: () => {},
    isLost: () => false
  };
}

// app.js redraws on a requestAnimationFrame loop; jsdom's rAF runs on real
// timers (see the loop in key-preview.js's own draw scheduling), so the tests
// below wait out a real tick rather than calling any internal function —
// app.js exposes nothing to call directly, on purpose, so these exercise
// exactly what a browser would run.
const rafTick = () => new Promise((r) => setTimeout(r, 100));

function setSpeed(doc, factor) {
  const btn = [...doc.querySelectorAll('#inspector .speed-chips button')]
    .find((b) => b.textContent === `${factor}×`);
  btn.click();
}

function setTrim(win, doc, inSec, outSec) {
  const [inInput, outInput] = doc.querySelectorAll('#inspector .row')[0].querySelectorAll('input');
  inInput.value = String(inSec);
  inInput.dispatchEvent(new win.Event('change', { bubbles: true }));
  outInput.value = String(outSec);
  outInput.dispatchEvent(new win.Event('change', { bubbles: true }));
}

// The composited pane no longer drives #video — each layer gets its own
// hidden <video>, appended into #viewer with the same texture-only class
// #video used to borrow while it was a texture source. #video itself never
// carries that class in composited mode (see loadPreviewFromBin/
// drawPlainFallback), so this selector is unambiguous. With one clip on one
// track there is exactly one.
function poolVideo(doc) {
  return doc.querySelector('#viewer video.texture-only');
}

// The stub keyer above makes app.js actually start its requestAnimationFrame
// redraw loop, which real WebGL-less tests never trigger. That loop reschedules
// itself on a real timer with nothing to stop it once the test's assertions
// are done, which is enough to keep `node --test` from ever exiting — so every
// test below deletes the clip in a `finally`, which is the app's own way of
// tearing the loop down (see "deleting the clip under the playhead...",
// above), win or lose on the assertions. A test that started the timeline
// clock pauses it first, since a playing clock outlives the clip it was
// playing.
function stopLoop(doc) {
  if (doc.getElementById('btnPlay').textContent === 'Pause') doc.getElementById('btnPlay').click();
  doc.getElementById('btnDeleteClip').click();
}

test('a clip at the playhead loops its layer video to its inSec and sets playbackRate to its speed', opts, async () => {
  const { win, doc } = boot();
  win.createKeyPreview = stubKeyer;
  try {
    await selectAClip(win, doc);
    setTrim(win, doc, 2, 6);
    setSpeed(doc, 2);
    await rafTick();

    const video = poolVideo(doc);
    assert.equal(video.playbackRate, 2, 'playbackRate follows the clip speed');
    // Playhead is still 0 (selecting a clip does not move it), which after a
    // trim to [2, 6) is clamped to the clip's own inSec.
    assert.equal(video.currentTime, 2, 'the playhead maps to the clip\'s inSec at its own start');
  } finally {
    stopLoop(doc);
  }
});

test('scrubbing the playhead across the clip moves the layer video with it', opts, async () => {
  const { win, doc } = boot();
  win.createKeyPreview = stubKeyer;
  try {
    await selectAClip(win, doc);
    setTrim(win, doc, 2, 6);
    await rafTick();
    assert.equal(poolVideo(doc).currentTime, 2, 'settled at inSec before the next step');

    // Move the playhead with the scrub bar the way dragging it would —
    // #scrub now represents state.playhead, not a single video's own
    // currentTime, so its range is the project duration.
    const dur = win.projectDuration();
    const scrub = doc.getElementById('scrub');
    scrub.value = String((3 / dur) * 1000);
    scrub.dispatchEvent(new win.Event('input', { bubbles: true }));

    assert.equal(poolVideo(doc).currentTime, 5, 'timeline second 3 lands on source second inSec(2)+3');
  } finally {
    stopLoop(doc);
  }
});

test('changing speed alone updates playbackRate without moving the layer video', opts, async () => {
  const { win, doc } = boot();
  win.createKeyPreview = stubKeyer;
  try {
    await selectAClip(win, doc);
    await rafTick();

    setSpeed(doc, 4);
    await rafTick();

    const video = poolVideo(doc);
    assert.equal(video.playbackRate, 4);
    assert.equal(video.currentTime, 0, 'the default trim starts at 0, untouched by a speed-only change');
  } finally {
    stopLoop(doc);
  }
});

/*
 * jsdom's own HTMLMediaElement.play()/pause() are stubs that log a "not
 * implemented" error and never touch .paused — real enough for every test
 * above this point, which never calls either, but not for these two, which
 * are exactly about whether app.js calls them. This fakes just enough of a
 * real element's play/pause state machine (an internal flag .paused reads
 * back) for that to be observable, without pretending jsdom can decode.
 */
function fakeMediaPlayback(win) {
  const paused = new WeakMap();
  Object.defineProperty(win.HTMLMediaElement.prototype, 'paused', {
    configurable: true,
    get() { return paused.get(this) !== false; }
  });
  win.HTMLMediaElement.prototype.play = function () { paused.set(this, false); return Promise.resolve(); };
  win.HTMLMediaElement.prototype.pause = function () { paused.set(this, true); };
}

test('pressing play advances the timeline clock and a layer video plays', opts, async () => {
  const { win, doc } = boot();
  win.createKeyPreview = stubKeyer;
  fakeMediaPlayback(win);
  try {
    await selectAClip(win, doc);
    await rafTick();

    doc.getElementById('btnPlay').click();
    await rafTick();

    assert.equal(poolVideo(doc).paused, false, 'the layer is told to play');
    assert.equal(doc.getElementById('btnPlay').textContent, 'Pause');
    // state.playhead is private, but the timecode text is the same number
    // formatted — a non-zero one is the timeline clock having actually
    // ticked, not just play() having been called once and left there.
    const secs = Number(doc.getElementById('timecode').textContent.split(':').pop());
    assert.ok(secs > 0, 'the playhead advanced past 0 while playing');
  } finally {
    stopLoop(doc);
  }
});

test('pausing stops the layer video and leaves the playhead where it was', opts, async () => {
  const { win, doc } = boot();
  win.createKeyPreview = stubKeyer;
  fakeMediaPlayback(win);
  try {
    await selectAClip(win, doc);
    doc.getElementById('btnPlay').click();
    await rafTick();
    doc.getElementById('btnPlay').click(); // pause

    const parkedAt = poolVideo(doc).currentTime;
    await rafTick();
    assert.equal(poolVideo(doc).paused, true, 'the layer is paused, not still being driven');
    assert.equal(doc.getElementById('btnPlay').textContent, 'Play');
    assert.equal(poolVideo(doc).currentTime, parkedAt, 'nothing kept seeking it after pause');
  } finally {
    stopLoop(doc);
  }
});

test('a probed colour tag survives the whole probe -> bin -> clip -> draw() pipeline', opts, async () => {
  // End to end, through the real app.js and the real makeClip, rather than
  // constructing a clip object by hand: the thing worth pinning here is that
  // nothing along that path drops main.js's tag or defaults it away.
  const { win, doc } = boot();
  const drawnClips = [];
  win.createKeyPreview = () => ({
    draw: (video, clip) => { drawnClips.push(clip); return true; },
    resize: () => ({ width: 1920, height: 1080 }),
    destroy: () => {},
    isLost: () => false
  });
  win.cutroom.probe = async (p) => ({ ...fakeMedia(path.basename(p)), colorMatrix: 'bt709' });

  try {
    seedBin(win, doc, ['camera.mp4']);
    await flush();
    doc.querySelector('#binList .bin-item').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    doc.getElementById('btnSendV1').click();
    doc.querySelector('#lanes .clip').dispatchEvent(
      new win.MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 })
    );
    await rafTick();

    assert.ok(drawnClips.length > 0, 'draw() should have been called at least once');
    assert.ok(drawnClips.every(c => c.colorMatrix === 'bt709'),
      'every draw() call should carry the probed tag through to the clip');
  } finally {
    stopLoop(doc);
  }
});

test('leaving a bin item to select a clip already sitting at the playhead shows it immediately', opts, async () => {
  // Nothing about this path runs through renderAll() (see the pointerdown
  // handler), so it is the one case requestPreviewFrame() is not already
  // called for it by something else — the composited pane has to notice the
  // active layer set changed (bin -> this clip) on its own, or it stays
  // showing the empty/hidden stage left over from bin mode.
  const { win, doc } = boot();
  win.createKeyPreview = stubKeyer;
  try {
    await selectAClip(win, doc); // adds and selects a clip at playhead 0
    await rafTick();
    assert.equal(doc.getElementById('previewStage').style.display, 'inline-block', 'composited to start with');

    doc.querySelector('#binList .bin-item').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    assert.equal(doc.getElementById('previewStage').style.display, 'none', 'bin mode hides it');

    // Re-select the same clip — still at playhead 0, nothing about the
    // timeline changed, only which pane is showing.
    doc.querySelector('#lanes .clip').dispatchEvent(
      new win.MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 })
    );
    await rafTick();

    assert.equal(doc.getElementById('previewStage').style.display, 'inline-block', 'composited again, without needing an edit first');
    assert.equal(doc.getElementById('keyCanvas').style.display, 'block');
  } finally {
    stopLoop(doc);
  }
});

// ==========================================================================
// Multi-track compositing and crossfades
// ==========================================================================

/*
 * Which clip is active on which track at a given time, and where a crossfade
 * window sits, is trackStateAt's job and is covered — with mutation-tested
 * unit coverage — in test/timeline-preview.test.js. What is only provable
 * here, through the real app.js in a real DOM, is the wiring on top of that:
 * does a second active track actually get a second canvas+<video> pair, does
 * it land above the first in the stage, does a crossfade get two pool
 * entries with the dissolve split across their opacity, and does leaving a
 * layer's clip in the DOM's stopLoop-style teardown release it rather than
 * leaving a hidden <video> stuck playing.
 */

/** One clip on v1, a second on v2, both starting at 0 (fakeMedia is 10s). */
async function twoTrackClips(win, doc) {
  seedBin(win, doc, ['a.mp4', 'b.mp4']);
  await flush();
  const items = doc.querySelectorAll('#binList .bin-item');
  items[0].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  doc.getElementById('btnSendV1').click();
  items[1].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  doc.getElementById('btnSendV2').click();
}

/**
 * Two clips end to end on v1, then the second dragged left until it overlaps
 * the first by `overlapSec` — a real pointerdown/pointermove/pointerup drag,
 * the same gesture a user makes, at the app's default 40px/s zoom.
 */
async function crossfadeOnV1(win, doc, overlapSec) {
  seedBin(win, doc, ['a.mp4', 'b.mp4']);
  await flush();
  const items = doc.querySelectorAll('#binList .bin-item');
  items[0].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  doc.getElementById('btnSendV1').click();
  items[1].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  doc.getElementById('btnSendV1').click();

  const second = doc.querySelectorAll('#lanes .clip')[1]; // starts at 10 (a.mp4 is 10s)
  const pxPerSec = 40;
  const dx = -overlapSec * pxPerSec;
  const tl = doc.getElementById('tlScroll');
  second.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, clientX: 300, clientY: 5 }));
  tl.dispatchEvent(new win.MouseEvent('pointermove', { bubbles: true, clientX: 300 + dx, clientY: 5 }));
  tl.dispatchEvent(new win.MouseEvent('pointerup', { bubbles: true, clientX: 300 + dx, clientY: 5 }));
}

/** Move the playhead the way clicking the ruler does, at 40px/s. */
function setPlayhead(doc, sec) {
  doc.getElementById('tlScroll').dispatchEvent(
    new doc.defaultView.MouseEvent('pointerdown', { bubbles: true, clientX: sec * 40, clientY: 5 })
  );
}

function stopLoopViaBin(doc) {
  const item = doc.querySelector('#binList .bin-item');
  if (item) item.click();
}

test('two clips on two video tracks each get their own layer canvas, v2 stacked over v1', opts, async () => {
  const { win, doc } = boot();
  win.createKeyPreview = stubKeyer;
  try {
    await twoTrackClips(win, doc);
    await rafTick();

    const canvases = [...doc.getElementById('previewStage').querySelectorAll('canvas')];
    assert.equal(canvases.length, 2, 'one canvas per active video track');
    assert.equal(canvases[0].id, 'keyCanvas', 'v1 is the bottom, pre-existing canvas');
    assert.equal(canvases[0].style.opacity, '1', 'no crossfade here, fully opaque');
    assert.equal(canvases[1].style.opacity, '1');
    assert.ok(
      canvases[0].compareDocumentPosition(canvases[1]) & win.Node.DOCUMENT_POSITION_FOLLOWING,
      'v2\'s canvas comes after v1\'s in the stage, which is what puts it on top'
    );

    const videos = doc.querySelectorAll('#viewer video.texture-only');
    assert.equal(videos.length, 2, 'one hidden decoding <video> per layer');
    assert.match(videos[0].src, /a\.mp4$/);
    assert.match(videos[1].src, /b\.mp4$/);
  } finally {
    stopLoopViaBin(doc);
  }
});

test('a track with nothing at the playhead is not given a layer at all', opts, async () => {
  const { win, doc } = boot();
  win.createKeyPreview = stubKeyer;
  try {
    // Only v1 gets a clip this time — v2 stays empty.
    seedBin(win, doc, ['a.mp4']);
    await flush();
    doc.querySelector('#binList .bin-item').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    doc.getElementById('btnSendV1').click();
    await rafTick();

    const canvases = doc.getElementById('previewStage').querySelectorAll('canvas');
    assert.equal(canvases.length, 1, 'v2 contributes nothing to composite');
  } finally {
    stopLoopViaBin(doc);
  }
});

test('a same-track overlap past the crossfade threshold draws both clips, split by dissolve progress', opts, async () => {
  const { win, doc } = boot();
  win.createKeyPreview = stubKeyer;
  try {
    // a.mp4 is 10s at startSec 0; dragged left 6s puts b.mp4 at startSec 4 —
    // an overlap of [4, 10), a 6-second crossfade. t=5 is 1/6 of the way
    // through it, deliberately not the midpoint — a bug that swapped which
    // clip gets which opacity would be invisible at a symmetric 0.5/0.5.
    await crossfadeOnV1(win, doc, 6);
    setPlayhead(doc, 5);
    await rafTick();

    const canvases = [...doc.getElementById('previewStage').querySelectorAll('canvas')];
    const videos = [...doc.querySelectorAll('#viewer video.texture-only')];
    assert.equal(canvases.length, 2, 'outgoing and incoming both draw during the overlap');

    // Pool entry i's canvas and its <video> are created together (see
    // makePoolEntry), so the two lists line up index for index; matching by
    // source file rather than assuming array order is what actually pins
    // "a.mp4 fades out" against "b.mp4 fades in".
    const outgoingIdx = videos.findIndex(v => /a\.mp4$/.test(v.src));
    const incomingIdx = videos.findIndex(v => /b\.mp4$/.test(v.src));
    assert.ok(outgoingIdx >= 0 && incomingIdx >= 0 && outgoingIdx !== incomingIdx);

    const progress = (5 - 4) / 6; // 1/6
    assert.ok(
      Math.abs(Number(canvases[outgoingIdx].style.opacity) - (1 - progress)) < 1e-6,
      'the outgoing clip (a.mp4) fades out as progress rises'
    );
    assert.ok(
      Math.abs(Number(canvases[incomingIdx].style.opacity) - progress) < 1e-6,
      'the incoming clip (b.mp4) fades in'
    );

    const badge = doc.getElementById('xfadeBadge');
    assert.equal(badge.style.display, 'block', 'the preview names its own approximation');
    assert.match(badge.textContent, /dissolve/i);
  } finally {
    stopLoopViaBin(doc);
  }
});

test('outside the overlap the same two clips are back to one solo layer, fully opaque', opts, async () => {
  const { win, doc } = boot();
  win.createKeyPreview = stubKeyer;
  try {
    await crossfadeOnV1(win, doc, 6); // overlap is [4, 10)
    setPlayhead(doc, 1); // inside the first clip, well before the overlap
    await rafTick();

    const canvases = doc.getElementById('previewStage').querySelectorAll('canvas');
    assert.equal(canvases.length, 1, 'no crossfade here');
    assert.equal(canvases[0].style.opacity, '1');
    assert.equal(doc.getElementById('xfadeBadge').style.display, 'none');
  } finally {
    stopLoopViaBin(doc);
  }
});

test('a clip too short to reach the crossfade threshold is not treated as one', opts, async () => {
  const { win, doc } = boot();
  win.createKeyPreview = stubKeyer;
  try {
    // Same drag, but only a hair over zero — below one frame at the
    // project's default 30fps, so groupTrackRuns' own rule (mirrored in
    // trackStateAt) says this is not a transition.
    await crossfadeOnV1(win, doc, 0.01);
    setPlayhead(doc, 9.995);
    await rafTick();

    const canvases = doc.getElementById('previewStage').querySelectorAll('canvas');
    assert.equal(canvases.length, 1, 'too thin an overlap to be a crossfade');
  } finally {
    stopLoopViaBin(doc);
  }
});

test('scrubbing across a track boundary swaps which clip the layer video plays', opts, async () => {
  const { win, doc } = boot();
  win.createKeyPreview = stubKeyer;
  try {
    // Two abutting clips on v1: a.mp4 [0,10), b.mp4 [10,20).
    seedBin(win, doc, ['a.mp4', 'b.mp4']);
    await flush();
    const items = doc.querySelectorAll('#binList .bin-item');
    items[0].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    doc.getElementById('btnSendV1').click();
    items[1].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    doc.getElementById('btnSendV1').click();

    setPlayhead(doc, 2);
    await rafTick();
    assert.match(poolVideo(doc).src, /a\.mp4$/, 'inside the first clip');

    setPlayhead(doc, 12);
    await rafTick();
    assert.match(poolVideo(doc).src, /b\.mp4$/, 'crossed into the second clip');
    assert.equal(poolVideo(doc).currentTime, 2, 'seeked to 2s into b.mp4\'s own source');
  } finally {
    stopLoopViaBin(doc);
  }
});

test('a track that drops out of the composite pauses and hides its layer, rather than leaking it', opts, async () => {
  const { win, doc } = boot();
  win.createKeyPreview = stubKeyer;
  fakeMediaPlayback(win);
  try {
    await crossfadeOnV1(win, doc, 6); // overlap [4, 10) needs two layers
    setPlayhead(doc, 7);
    doc.getElementById('btnPlay').click();
    await rafTick();

    let videos = [...doc.querySelectorAll('#viewer video.texture-only')];
    assert.equal(videos.length, 2);
    assert.equal(videos[1].paused, false, 'the second layer is actually playing, not just present');

    doc.getElementById('btnPlay').click(); // pause the transport
    setPlayhead(doc, 1); // and scrub back to before the overlap: one layer again
    await rafTick();

    // The pool itself is never shrunk (see layerPool's header comment), so
    // the second entry's <canvas> and <video> still exist in the DOM — what
    // has to change is that the canvas stops showing and the video stops
    // playing, not that either is removed.
    const canvases = [...doc.getElementById('previewStage').querySelectorAll('canvas')];
    assert.equal(canvases.length, 2, 'the pool entry itself is kept, not torn down');
    const visible = canvases.filter(c => c.style.display !== 'none');
    assert.equal(visible.length, 1, 'but only one layer is actually shown now');

    videos = [...doc.querySelectorAll('#viewer video.texture-only')];
    assert.equal(videos.length, 2, 'the video pool entry is kept too');
    assert.equal(videos[1].paused, true, 'but nothing is still playing on it');
  } finally {
    stopLoopViaBin(doc);
  }
});
