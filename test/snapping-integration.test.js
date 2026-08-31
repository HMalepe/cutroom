'use strict';

/*
 * Drives the real app.js against the real index.html in a DOM, the same way
 * test/undo-integration.test.js and test/key-preview.test.js do — proving the
 * wiring test/timeline-snapping.test.js can't: that dragging a clip near
 * another clip's edge, the playhead, or a beat line in the actual pointer
 * handlers lands on it, and that a drag or a keypress with nothing nearby
 * lands exactly where the raw, unsnapped math says it should. That second
 * half matters as much as the first — a test that only checks "did it snap"
 * would pass just as well if snapping silently never ran and the unsnapped
 * position happened to look right.
 *
 * Assertions read the rendered DOM (the inspector's numeric fields, the
 * clip and playhead elements' own style.left) rather than internal state,
 * because that is the only thing app.js exposes and what a user actually
 * sees. All at the app's default 40px/s zoom, so seconds and pixels convert
 * by a fixed ×40.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { opts, boot, seedBin, flush, fakeMedia } = require('./dom-harness.js');

const PX_PER_SEC = 40;
const sec = (px) => px / PX_PER_SEC;
const px = (s) => s * PX_PER_SEC;

/** Send the bin item at `index` to `trackId`, the way clicking it and Send does. */
function sendItem(win, doc, index, trackId) {
  const items = doc.querySelectorAll('#binList .bin-item');
  items[index].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  doc.getElementById(`btnSend${trackId.toUpperCase()}`).click();
}

/** Select a clip element without moving it — pointerdown then pointerup at the same spot. */
function selectClip(win, doc, clipEl) {
  clipEl.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 5 }));
  doc.getElementById('tlScroll').dispatchEvent(new win.MouseEvent('pointerup', { bubbles: true, clientX: 5, clientY: 5 }));
}

/** A real pointerdown/pointermove/pointerup drag, the same gesture a user makes. */
function drag(win, doc, target, downX, upX) {
  const tl = doc.getElementById('tlScroll');
  target.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, clientX: downX, clientY: 5 }));
  tl.dispatchEvent(new win.MouseEvent('pointermove', { bubbles: true, clientX: upX, clientY: 5 }));
  tl.dispatchEvent(new win.MouseEvent('pointerup', { bubbles: true, clientX: upX, clientY: 5 }));
}

/** Move the playhead the way clicking the ruler/empty lane space does. */
function clickRuler(win, doc, atSec) {
  doc.getElementById('tlScroll').dispatchEvent(
    new win.MouseEvent('pointerdown', { bubbles: true, clientX: px(atSec), clientY: 5 })
  );
}

function clipIn(doc, trackId) {
  return doc.querySelector(`.track-lane[data-track-id="${trackId}"] .clip`);
}

/** Read a numeric inspector field by its label prefix, e.g. "Start (timeline)". */
function inspectorValue(doc, labelPrefix) {
  const rows = [...doc.querySelectorAll('#inspector .field')];
  const row = rows.find(el => el.querySelector('.field-label')?.textContent.startsWith(labelPrefix));
  if (!row) throw new Error(`no inspector field labelled "${labelPrefix}"`);
  return Number(row.querySelector('input').value);
}

function playheadSec(doc) {
  return sec(parseFloat(doc.getElementById('playhead').style.left));
}

/** durations keyed by filename, read by a probe stub installed before seedBin. */
function withDurations(win, durations) {
  win.cutroom.probe = async (p) => {
    const name = path.basename(p);
    return fakeMedia(name, durations[name] ?? 10);
  };
}

// ==========================================================================
// Whole-clip move
// ==========================================================================

test('dragging a clip near another clip\'s edge on a DIFFERENT track snaps to it', opts, async () => {
  const { win, doc } = boot();
  seedBin(win, doc, ['a.mp4', 'b.mp4']);
  await flush();

  sendItem(win, doc, 0, 'v1'); // a.mp4, 10s -> v1 [0,10)
  sendItem(win, doc, 1, 'v2'); // b.mp4, 10s -> v2 [0,10)

  // Drag b.mp4 (v2) so its raw, un-snapped landing (9.9) is just short of
  // a.mp4's end on v1 (10) — close enough to snap, not so close it would
  // have landed there by coincidence.
  const b = clipIn(doc, 'v2');
  drag(win, doc, b, 100, 100 + px(9.9));

  assert.equal(inspectorValue(doc, 'Start (timeline)'), 10, 'snapped exactly onto the other track\'s clip end');
});

test('a whole-clip move can snap on its TAIL edge, not just its head', opts, async () => {
  // The case a start-only snap (what the old beat-snap-only code effectively
  // was) can never catch: pushing a clip's trailing edge up against
  // something ahead of it. b.mp4 sits at v2 [20,30); a.mp4 on v1 starts at 0
  // and is dragged rightward so its END approaches 20, not its start.
  const { win, doc } = boot();
  withDurations(win, { 'filler.mp4': 20 });
  seedBin(win, doc, ['a.mp4', 'filler.mp4', 'b.mp4']);
  await flush();

  sendItem(win, doc, 0, 'v1');        // a.mp4, 10s -> v1 [0,10)
  sendItem(win, doc, 1, 'v2');        // filler.mp4, 20s -> v2 [0,20)
  sendItem(win, doc, 2, 'v2');        // b.mp4, 10s -> v2 [20,30)

  const a = clipIn(doc, 'v1');
  drag(win, doc, a, 100, 100 + px(9.9)); // raw start 9.9 -> raw end 19.9, close to 20

  assert.equal(inspectorValue(doc, 'Start (timeline)'), 10, 'a.mp4\'s tail landed exactly on b.mp4\'s start');
});

test('a clip does not spuriously snap to its own edges', opts, async () => {
  const { win, doc } = boot();
  seedBin(win, doc, ['a.mp4']);
  await flush();
  sendItem(win, doc, 0, 'v1'); // a.mp4, 10s -> v1 [0,10)

  // First drag: nothing nearby, so the landing spot is whatever the raw
  // pointer math says — proves this suite isn't fooled by a coincidental
  // default position either.
  const first = clipIn(doc, 'v1');
  drag(win, doc, first, 100, 100 + px(30));
  assert.equal(inspectorValue(doc, 'Start (timeline)'), 30, 'unsnapped move landed exactly where dragged');

  // Second drag, from the clip's own now-current position: move it 0.1s,
  // well inside the snap threshold of where it just was. If the dragged
  // clip's own edges were not excluded from its candidate list, this would
  // snap straight back to 30 — the clip would refuse to move at all.
  const second = clipIn(doc, 'v1');
  drag(win, doc, second, 100, 100 + px(0.1));
  assert.equal(inspectorValue(doc, 'Start (timeline)'), 30.1, 'moved by the full 0.1s, not pulled back to its own start');
});

test('the playhead is a snap target for a whole-clip move', opts, async () => {
  const { win, doc } = boot();
  seedBin(win, doc, ['a.mp4']);
  await flush();
  sendItem(win, doc, 0, 'v1'); // a.mp4, 10s -> v1 [0,10)

  clickRuler(win, doc, 8); // playhead -> 8.0, within the 10s project
  assert.equal(playheadSec(doc), 8, 'sanity: ruler click landed the playhead where expected');

  const clip = clipIn(doc, 'v1');
  drag(win, doc, clip, 100, 100 + px(7.9)); // raw start 7.9, just short of the playhead

  assert.equal(inspectorValue(doc, 'Start (timeline)'), 8, 'snapped onto the playhead, not left at the raw 7.9');
});

test('beat-snap still works, composed with edge candidates, and only when it is on', opts, async () => {
  const { win, doc } = boot();
  seedBin(win, doc, ['a.mp4']);
  await flush();
  sendItem(win, doc, 0, 'v1'); // a.mp4, 10s -> v1 [0,10)

  const snapBeats = doc.getElementById('snapBeats');
  snapBeats.checked = true;
  snapBeats.dispatchEvent(new win.Event('change', { bubbles: true }));

  // Default bpm 120 -> a beat every 0.5s. 3.05 is near beat line 3.0 and far
  // from any edge, the playhead, or zero.
  drag(win, doc, clipIn(doc, 'v1'), 100, 100 + px(3.05));
  assert.equal(inspectorValue(doc, 'Start (timeline)'), 3, 'snapped to the beat grid with beat-snap on');

  snapBeats.checked = false;
  snapBeats.dispatchEvent(new win.Event('change', { bubbles: true }));

  // Same shape of move, a different beat line (6.0), with beat-snap off:
  // nothing else is nearby either, so this must land unsnapped.
  drag(win, doc, clipIn(doc, 'v1'), 100, 100 + px(3.05));
  assert.equal(inspectorValue(doc, 'Start (timeline)'), 6.05, 'beat lines are not candidates once beat-snap is off');
});

// ==========================================================================
// Trims — the coupling between timeline space and source space
// ==========================================================================

test('left-trim snaps the clip\'s timeline start, at speed 1', opts, async () => {
  const { win, doc } = boot();
  seedBin(win, doc, ['a.mp4']);
  await flush();
  sendItem(win, doc, 0, 'v1'); // a.mp4, 10s -> v1 [0,10)

  clickRuler(win, doc, 3); // playhead -> 3.0

  const handle = clipIn(doc, 'v1').querySelector('.clip-handle.left');
  drag(win, doc, handle, 5, 5 + px(2.9)); // raw new start 2.9, just short of the playhead

  assert.equal(inspectorValue(doc, 'Start (timeline)'), 3, 'start snapped to the playhead');
  assert.equal(inspectorValue(doc, 'In (source)'), 3, 'at speed 1, source time moved by the same amount');
});

test('left-trim snaps in timeline space and converts back through speed, not the other way round', opts, async () => {
  const { win, doc } = boot();
  withDurations(win, { 'a.mp4': 30 });
  seedBin(win, doc, ['a.mp4']);
  await flush();
  sendItem(win, doc, 0, 'v1'); // a.mp4, 30s -> v1 [0,30)

  selectClip(win, doc, clipIn(doc, 'v1'));
  const speed2 = [...doc.querySelectorAll('.speed-chips .chip')].find(b => b.textContent === '2×');
  speed2.click(); // timeline duration halves: clip now runs v1 [0,15)

  clickRuler(win, doc, 6); // playhead -> 6.0, inside the new 15s timeline length

  // Raw new timeline start 5.9 — snapping compares this (timeline seconds)
  // against the playhead, not the source-space value dragging produces.
  const handle = clipIn(doc, 'v1').querySelector('.clip-handle.left');
  drag(win, doc, handle, 5, 5 + px(5.9));

  assert.equal(inspectorValue(doc, 'Start (timeline)'), 6, 'timeline start snapped onto the playhead');
  // inSec is source seconds: at 2x speed, 6 timeline seconds of trim is 12
  // source seconds — proof the snap ran in timeline space and was converted
  // back, rather than snapping inSec (source seconds) directly against a
  // timeline-second candidate.
  assert.equal(inspectorValue(doc, 'In (source)'), 12, 'source-space inSec reflects the speed coupling');
});

test('right-trim snaps in timeline space and converts back through speed', opts, async () => {
  const { win, doc } = boot();
  withDurations(win, { 'a.mp4': 30 });
  seedBin(win, doc, ['a.mp4']);
  await flush();
  sendItem(win, doc, 0, 'v1'); // a.mp4, 30s -> v1 [0,30)

  selectClip(win, doc, clipIn(doc, 'v1'));
  const speed2 = [...doc.querySelectorAll('.speed-chips .chip')].find(b => b.textContent === '2×');
  speed2.click(); // clip now runs v1 [0,15)

  clickRuler(win, doc, 12); // playhead -> 12.0, inside the 15s timeline length

  // Raw new timeline end 11.9 — trimming the right handle left by enough
  // that the clip's tail lands just short of the playhead. outSec moves by
  // dSec*speed, so reaching a raw timeline end of 11.9 (outSec 23.8, down
  // from 30) takes a pointer delta of (23.8-30)/2 = -3.1s = -124px.
  const handle = clipIn(doc, 'v1').querySelector('.clip-handle.right');
  drag(win, doc, handle, 600, 600 - px(3.1));

  assert.equal(inspectorValue(doc, 'Start (timeline)'), 0, 'the start handle was untouched by this drag');
  // timeline end snapped to 12 -> outSec = inSec + (12 - startSec) * speed = 0 + 12*2 = 24.
  assert.equal(inspectorValue(doc, 'Out (source)'), 24, 'source-space outSec reflects the speed coupling, snapped end at 12');
});

// ==========================================================================
// Playhead clamp — manual seek paths only; stepTimelineClock covers playback
// ==========================================================================

test('ArrowRight cannot walk the playhead past the end of the project', opts, async () => {
  const { win, doc } = boot();
  seedBin(win, doc, ['a.mp4']);
  await flush();
  sendItem(win, doc, 0, 'v1'); // a.mp4, 10s -> v1 [0,10)

  clickRuler(win, doc, 9.5);
  assert.equal(playheadSec(doc), 9.5);

  // A 1s Shift-step from 9.5 would land at 10.5 without the clamp.
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
  assert.equal(playheadSec(doc), 10, 'clamped to the project\'s own length, not walked past it');
});

test('clicking the ruler past the last clip clamps to the project length', opts, async () => {
  const { win, doc } = boot();
  seedBin(win, doc, ['a.mp4']);
  await flush();
  sendItem(win, doc, 0, 'v1'); // a.mp4, 10s -> v1 [0,10)

  clickRuler(win, doc, 50); // far past the 10s project
  assert.equal(playheadSec(doc), 10, 'clamped to project length rather than left at the raw click position');
});
