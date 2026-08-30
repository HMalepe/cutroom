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

require('../src/chroma-math.js'); // key-preview reads it off the global
const KP = require('../src/key-preview.js');
const { opts, boot, seedBin, flush, SRC } = require('./dom-harness.js');

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
