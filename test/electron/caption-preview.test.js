'use strict';

/*
 * Drives the real Electron binary to prove the five claims about the caption
 * overlay (src/caption-preview.js, app.js's syncCaptionOverlay/
 * applyCaptionOverlay) that test/caption-overlay.test.js's jsdom run
 * structurally cannot: jsdom has no layout engine at all, so
 * #previewStage.clientHeight is always 0 there — exactly scaledPx's 1:1
 * fallback branch, never the real proportional-scaling branch — and jsdom
 * has no real WebGL, so it cannot tell the composited path from the
 * no-WebGL fallback except by stubbing createKeyPreview itself.
 *
 * This file is the permanent version of the one-off scratch-script check
 * the reviewing session ran by hand for PR #22 (see "Captions in the
 * preview" in the README) — same five claims, same real Electron-under-Xvfb
 * setup, now checked on every run instead of once.
 *
 * The real composited path needs real WebGL, which under Xvfb (no real GPU)
 * means Chromium's own software rasterizer: `--use-angle=swiftshader` plus
 * `--enable-unsafe-swiftshader` (recent Chromium refuses swiftshader WebGL
 * without the latter, the same "no accidental insecure fallback" gate that
 * motivates the flag's name). Every test below except the no-WebGL-fallback
 * one needs that combination, since the caption overlay only ever appears
 * on the composited stage (see hideCaptionOverlay's own header comment) —
 * drawPlainFallback hides it unconditionally.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { electronSkipReason, waitFor, launchApp, closeApp } = require('./harness');

function probe(bin) {
  try {
    return spawnSync(bin, ['-version'], { encoding: 'utf8' }).status === 0;
  } catch { return false; }
}
const HAS_FFMPEG = probe('ffmpeg');

const skipReason = electronSkipReason || (HAS_FFMPEG ? null : 'ffmpeg not on PATH');
const opts = skipReason ? { skip: skipReason } : {};

// See the header comment for why the composited path needs both of these
// under Xvfb, where there is no real GPU for ANGLE to bind to.
const WEBGL_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

let FIXTURE = null;
function fixture() {
  if (FIXTURE) return FIXTURE;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutroom-electron-caption-'));
  const file = path.join(dir, 'fixture.mp4');
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=8:size=320x240:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file
  ], { encoding: 'utf8' });
  assert.equal(r.status, 0, `fixture generation failed:\n${r.stderr}`);
  FIXTURE = file;
  return file;
}

/**
 * Add the fixture through the real "Add Video" button and real media:pick /
 * media:probe IPC (stubbing only the native dialog, same technique
 * media-preview.test.js uses), then send it to Video 1 — a clip spanning
 * 0..~8s is enough runway for every caption window used below.
 */
async function addAndPlaceFixture(app, page, src) {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, src);

  await page.click('#btnAddVideo');
  await waitFor(
    () => page.evaluate(() => document.querySelectorAll('#binList .bin-item').length > 0),
    { message: 'the fixture to appear in the bin' }
  );

  await page.click('#binList .bin-item');
  await page.click('#btnSendV1');
}

async function enableCaptions(page) {
  await page.evaluate(() => {
    const cb = document.getElementById('capEnabled');
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/**
 * "+ Add line" always starts a caption reading 'New line' at the current
 * playhead — this adds one and then edits it into shape through its own
 * row's inputs, the same fields a person would use (renderCaptions in
 * app.js) and the same technique test/caption-overlay.test.js's own
 * addAndEditCaption uses in jsdom. Never sets `cap.words`, since there is no
 * real UI path to hand-author per-word timing (only transcription produces
 * it) — which is exactly the "no per-word timing" shape behavior #4 below
 * needs.
 */
async function addAndEditCaption(page, { start, end, text }) {
  await page.click('#btnAddCaption');
  await page.evaluate(({ start, end, text }) => {
    const row = [...document.querySelectorAll('#capList .cap-row')]
      .find(r => r.querySelector('.cap-text').value === 'New line');
    const [startInput, endInput] = row.querySelectorAll('.cap-time');
    const textArea = row.querySelector('.cap-text');
    startInput.value = String(start);
    startInput.dispatchEvent(new Event('change', { bubbles: true }));
    endInput.value = String(end);
    endInput.dispatchEvent(new Event('change', { bubbles: true }));
    textArea.value = text;
    textArea.dispatchEvent(new Event('input', { bubbles: true }));
  }, { start, end, text });
}

/** #capStyle is rebuilt from scratch by renderCaptionStyle() on every style
 *  change, so there is no stable id to hold onto across edits — index into
 *  a fresh querySelectorAll each time instead. Position is the first
 *  <select> in the panel, Animation the second (see renderCaptionStyle's
 *  own DOM order in app.js). */
async function setCapSelect(page, index, value) {
  await page.evaluate(({ index, value }) => {
    const sel = document.querySelectorAll('#capStyle select')[index];
    sel.value = value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, { index, value });
}

/**
 * Move the playhead the way clicking the ruler does — a real pointerdown on
 * #tlScroll, which app.js's own handler reads relative to #tlInner's
 * getBoundingClientRect().left, not viewport x=0 (the track-head sidebar to
 * its left offsets everything). Getting that wrong would silently seek to
 * the wrong time by however many pixels the sidebar is wide, rather than
 * throwing — worth computing for real rather than assuming.
 */
async function seekTo(page, seconds) {
  const { left, rulerMid, pxPerSec } = await page.evaluate(() => {
    const inner = document.getElementById('tlInner').getBoundingClientRect();
    const ruler = document.getElementById('ruler').getBoundingClientRect();
    return {
      left: inner.left,
      rulerMid: ruler.top + ruler.height / 2,
      pxPerSec: parseFloat(document.getElementById('zoomLabel').textContent)
    };
  });
  await page.mouse.click(left + seconds * pxPerSec, rulerMid);
}

async function overlayState(page) {
  return page.evaluate(() => ({
    display: document.getElementById('captionOverlay').style.display,
    text: document.getElementById('captionOverlayText').textContent,
    spans: document.getElementById('captionOverlayText').querySelectorAll('span').length
  }));
}

/** Fails loudly, rather than quietly checking the wrong path, if real WebGL
 *  did not come up under Xvfb — every test that needs the composited stage
 *  calls this right after placing the fixture. */
async function assertComposited(page) {
  const display = await waitFor(
    () => page.evaluate(() => document.getElementById('previewStage').style.display),
    { message: 'the composited stage to appear (real WebGL via swiftshader)' }
  );
  assert.notEqual(display, 'none',
    'expected the composited WebGL path, got the plain-<video> fallback — real WebGL context creation failed under Xvfb');
}

// --------------------------------------------------------------------------
// 1. Real proportional scaling
// --------------------------------------------------------------------------

test('caption font size scales against the real, measured #previewStage height — not the 1:1 fallback', opts, async () => {
  const { app, page } = await launchApp(WEBGL_ARGS);
  try {
    await addAndPlaceFixture(app, page, fixture());
    await assertComposited(page);

    await addAndEditCaption(page, { start: 1, end: 3, text: 'Scaled caption' });
    await enableCaptions(page);
    // Past the default 'pop' animation's 140ms settle, so scale is exactly 1
    // and does not perturb anything downstream of font-size.
    await seekTo(page, 1.5);

    await waitFor(async () => (await overlayState(page)).display === 'flex',
      { message: 'the caption to become active' });

    const stageHeightPx = await page.evaluate(() => document.getElementById('previewStage').clientHeight);
    // jsdom always reports 0 here, which is what makes it fall onto
    // scaledPx's 1:1 branch — a real, laid-out browser never does.
    assert.ok(stageHeightPx > 0, 'expected a real, measured stage height, not the jsdom-only 0 case');

    const fontSizePx = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.getElementById('captionOverlayText')).fontSize));

    // captionStyle.size defaults to 54 (ASS units, relative to the
    // project's own height, 1920 — see defaultProject in app.js), run
    // through the exact scaledPx formula applyCaptionOverlay itself uses.
    const projectHeight = 1920;
    const captionSize = 54;
    const predictedPx = captionSize * (stageHeightPx / projectHeight);

    assert.ok(Math.abs(fontSizePx - predictedPx) < 0.5,
      `expected the real rendered font-size (${fontSizePx}px) to match scaledPx's prediction (${predictedPx}px) against the real stage height (${stageHeightPx}px)`);
  } finally {
    await closeApp(app);
  }
});

// --------------------------------------------------------------------------
// 2. Show/hide across a caption's start/end boundaries and a gap
// --------------------------------------------------------------------------

test('the overlay shows and hides across real playhead moves — a caption\'s start/end and the gap between two', opts, async () => {
  const { app, page } = await launchApp(WEBGL_ARGS);
  try {
    await addAndPlaceFixture(app, page, fixture());
    await assertComposited(page);

    await addAndEditCaption(page, { start: 1, end: 3, text: 'First' });
    await addAndEditCaption(page, { start: 4, end: 6, text: 'Second' });
    await enableCaptions(page);

    await seekTo(page, 0.5);
    await waitFor(async () => (await overlayState(page)).display === 'none',
      { message: 'nothing active before the first caption starts' });

    await seekTo(page, 1.5);
    await waitFor(async () => (await overlayState(page)).text === 'First',
      { message: '"First" to show mid-window' });

    await seekTo(page, 3.5); // the gap between the two — neither is active
    await waitFor(async () => (await overlayState(page)).display === 'none',
      { message: 'nothing active in the gap between the two captions' });

    await seekTo(page, 5);
    await waitFor(async () => (await overlayState(page)).text === 'Second',
      { message: '"Second" to show mid-window' });

    await seekTo(page, 6.5);
    await waitFor(async () => (await overlayState(page)).display === 'none',
      { message: 'nothing active after the second caption ends' });
  } finally {
    await closeApp(app);
  }
});

// --------------------------------------------------------------------------
// 3. The position select actually moves the rendered box on screen
// --------------------------------------------------------------------------

test('switching the style panel\'s position between top and bottom moves the real rendered box', opts, async () => {
  const { app, page } = await launchApp(WEBGL_ARGS);
  try {
    await addAndPlaceFixture(app, page, fixture());
    await assertComposited(page);

    await addAndEditCaption(page, { start: 1, end: 3, text: 'Positioned' });
    await enableCaptions(page);
    // 'none' so no scale/opacity animation state can perturb the box's own
    // layout while position is being compared.
    await setCapSelect(page, 1, 'none');
    await seekTo(page, 1.5);
    await waitFor(async () => (await overlayState(page)).display === 'flex',
      { message: 'the caption to become active' });

    await setCapSelect(page, 0, 'top');
    await waitFor(
      () => page.evaluate(() => document.getElementById('captionOverlay').className.includes('pos-top')),
      { message: 'the overlay to switch to pos-top' }
    );
    const topY = await page.evaluate(() =>
      document.getElementById('captionOverlayText').getBoundingClientRect().top);

    await setCapSelect(page, 0, 'bottom');
    await waitFor(
      () => page.evaluate(() => document.getElementById('captionOverlay').className.includes('pos-bottom')),
      { message: 'the overlay to switch to pos-bottom' }
    );
    const bottomY = await page.evaluate(() =>
      document.getElementById('captionOverlayText').getBoundingClientRect().top);

    assert.ok(topY < bottomY,
      `expected 'top' (${topY}) to render higher on screen (a smaller y) than 'bottom' (${bottomY})`);
  } finally {
    await closeApp(app);
  }
});

// --------------------------------------------------------------------------
// 4. No per-word timing sweeps by real character, not a \k-style word sweep
//    nor plain static text — see charSplitKaraokeStates in
//    src/caption-preview.js, added after this file's first version (which
//    predates it) asserted the old plain-text behavior it replaced.
// --------------------------------------------------------------------------

test('typewriter on a caption with no per-word timing sweeps by real character span', opts, async () => {
  const { app, page } = await launchApp(WEBGL_ARGS);
  try {
    await addAndPlaceFixture(app, page, fixture());
    await assertComposited(page);

    // Hand-typed via "+ Add line" — never carries cap.words, the same as an
    // imported .srt/.vtt or a transcribed row whose text or timing was
    // edited afterward (renderCaptions drops `words` the moment a row is
    // touched). 'Hi' over 1s (start 0, end 1) is the same case
    // test/caption-preview.test.js's own pin test uses: buildAssFile's
    // even-split fallback computes 50cs = 0.5s per character, so at t=0
    // only 'H' has landed and at t=0.5 both characters have.
    await addAndEditCaption(page, { start: 0, end: 1, text: 'Hi' });
    await enableCaptions(page);
    await setCapSelect(page, 1, 'typewriter');
    await seekTo(page, 0);

    await waitFor(async () => (await overlayState(page)).display === 'flex',
      { message: 'the caption to become active' });

    let state = await overlayState(page);
    assert.equal(state.spans, 2, 'a caption with no cap.words should still render one <span> per character');
    const spanColors = () => page.evaluate(() =>
      [...document.querySelectorAll('#captionOverlayText span')].map(s => s.style.color));
    let colors = await spanColors();
    assert.notEqual(colors[0], colors[1], '"H" (spoken) and "i" (not yet) should differ in colour at t=0');

    await seekTo(page, 0.5);
    await waitFor(async () => {
      const c = await spanColors();
      return c[0] === c[1];
    }, { message: 'both characters to share the "spoken" colour once the per-character duration has elapsed' });
  } finally {
    await closeApp(app);
  }
});

// --------------------------------------------------------------------------
// 5. The no-WebGL fallback suppresses the caption overlay too
// --------------------------------------------------------------------------

/**
 * Forces every getContext('webgl'/'webgl2'/'experimental-webgl') call to
 * return null, the same as a machine with no WebGL at all — key-preview.js's
 * createKeyPreview tries 'webgl' then 'experimental-webgl' (see its own
 * header comment), so both have to be covered. Registered via harness.js's
 * `initScript` (app.context().addInitScript, before firstWindow() is ever
 * awaited) rather than a page.evaluate after the fact: keyerFor caches its
 * WebGL-creation result forever per pool entry behind a `keyerTried` flag,
 * so a patch applied after the app's first (real) WebGL attempt would be a
 * silent no-op — this has to be in place before app.js's own first script
 * execution.
 */
function forceNoWebGL() {
  const proto = HTMLCanvasElement.prototype;
  const original = proto.getContext;
  proto.getContext = function (type, ...rest) {
    if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') return null;
    return original.call(this, type, ...rest);
  };
}

test('the no-WebGL fallback hides the caption overlay even with an active caption', opts, async () => {
  const { app, page } = await launchApp([], { initScript: forceNoWebGL });
  try {
    await addAndPlaceFixture(app, page, fixture());
    await addAndEditCaption(page, { start: 0, end: 5, text: 'Never shown here' });
    await enableCaptions(page);

    await waitFor(
      () => page.evaluate(() => document.getElementById('video').style.display === 'block'
        && document.getElementById('previewStage').style.display === 'none'),
      { message: 'the plain <video> fallback to take over (real WebGL forced unavailable)' }
    );

    const { display } = await overlayState(page);
    assert.equal(display, 'none',
      'a deliberate gap — see "Captions in the preview" in the README for why');
  } finally {
    await closeApp(app);
  }
});
