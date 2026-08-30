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

test('deleting the selected clip drops the preview back rather than keying a ghost', opts, async () => {
  const { win, doc } = boot();
  await selectAClip(win, doc);
  doc.getElementById('btnDeleteClip').click();

  const video = doc.getElementById('video');
  assert.equal(doc.getElementById('keyCanvas').style.display, 'none');
  assert.equal(video.controls, true, 'the plain player is back');
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
 * jsdom has no WebGL, so without help getKeyer() falls back to the plain
 * <video> before app.js ever reaches the loop logic — which is what every
 * test above this point relies on. These tests instead hand app.js a fake
 * keyer with the real one's shape (draw/resize/destroy/isLost), the same way
 * a browser with a working driver would, so the "keyed" branch — the one
 * that drives currentTime and playbackRate — runs for real. What is under
 * test is app.js's wiring: does selecting a clip and changing its speed or
 * trim reach the <video>. The draw call itself, and the shader it feeds,
 * are covered elsewhere (chroma-math.test.js, and by hand against real
 * ffmpeg output per the header comments) — nothing here asserts a pixel.
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

// The stub keyer above makes app.js actually start its requestAnimationFrame
// redraw loop, which real WebGL-less tests never trigger. That loop reschedules
// itself on a real timer with nothing to stop it once the test's assertions
// are done, which is enough to keep `node --test` from ever exiting — so every
// test below deletes the clip in a `finally`, which is the app's own way of
// tearing the loop down (see "deleting the selected clip drops the preview
// back", above), win or lose on the assertions.
function stopLoop(doc) {
  doc.getElementById('btnDeleteClip').click();
}

test('selecting a clip loops the video to its inSec and sets playbackRate to its speed', opts, async () => {
  const { win, doc } = boot();
  win.createKeyPreview = stubKeyer;
  try {
    await selectAClip(win, doc);
    setTrim(win, doc, 2, 6);
    setSpeed(doc, 2);
    await rafTick();

    const video = doc.getElementById('video');
    assert.equal(video.playbackRate, 2, 'playbackRate follows the clip speed');
    assert.equal(video.currentTime, 2, 'the loop puts a fresh clip at its own inSec, not the start of the source');
  } finally {
    stopLoop(doc);
  }
});

test('playback reaching outSec loops back to inSec', opts, async () => {
  const { win, doc } = boot();
  win.createKeyPreview = stubKeyer;
  try {
    await selectAClip(win, doc);
    setTrim(win, doc, 2, 6);
    await rafTick();

    const video = doc.getElementById('video');
    assert.equal(video.currentTime, 2, 'settled at inSec before the next step');

    // Nothing in jsdom actually decodes video, so playback reaching outSec is
    // simulated the way the scrub bar itself sets currentTime — the only path
    // in this app that writes it other than the loop under test.
    Object.defineProperty(video, 'duration', { value: 8, configurable: true });
    const scrub = doc.getElementById('scrub');
    scrub.value = String((6 / 8) * 1000);
    scrub.dispatchEvent(new win.Event('input', { bubbles: true }));
    assert.equal(video.currentTime, 6, 'scrubbing landed exactly on outSec');

    await rafTick();
    assert.equal(video.currentTime, 2, 'the loop caught it on the next tick and jumped back to inSec');
  } finally {
    stopLoop(doc);
  }
});

test('changing speed alone updates playbackRate without moving the loop window', opts, async () => {
  const { win, doc } = boot();
  win.createKeyPreview = stubKeyer;
  try {
    await selectAClip(win, doc);
    await rafTick();

    setSpeed(doc, 4);
    await rafTick();

    const video = doc.getElementById('video');
    assert.equal(video.playbackRate, 4);
    assert.equal(video.currentTime, 0, 'the default trim starts at 0, untouched by a speed-only change');
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
