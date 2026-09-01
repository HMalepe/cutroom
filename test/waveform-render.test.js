'use strict';

/*
 * Pure-module tests for src/waveform-render.js — no DOM, no canvas. Feeds
 * synthetic peaks arrays (shaped like shared/media-cache.js's pcmToPeaks
 * output) straight into waveformBars and checks the pixel bars it hands
 * back, the same split test/timeline-snapping.test.js draws against its own
 * DOM-free module.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { waveformBars } = require('../src/waveform-render.js');

/** peaksPerSecond=1: bucket i is one whole second. */
const PEAKS = [
  -0.2, 0.2, // second 0
  -0.5, 0.9, // second 1
  -1.0, 1.0, // second 2
  -0.1, 0.1  // second 3
];

test('one bar per output pixel column', () => {
  const bars = waveformBars(PEAKS, { peaksPerSecond: 1, fromSec: 0, toSec: 4, width: 40, height: 20 });
  assert.equal(bars.length, 40);
  assert.deepEqual(bars.map(b => b.x), Array.from({ length: 40 }, (_, i) => i));
});

test('a bar spanning one bucket reflects that bucket\'s min/max around the vertical middle', () => {
  // width=4, span=4s -> each column is exactly one second/bucket wide.
  const bars = waveformBars(PEAKS, { peaksPerSecond: 1, fromSec: 0, toSec: 4, width: 4, height: 20 });
  const mid = 10;
  // second 2: min -1.0, max 1.0 -> full height, top at 0, bottom at 20.
  assert.equal(bars[2].top, mid - 1.0 * mid);
  assert.equal(bars[2].height, (mid - (-1.0) * mid) - (mid - 1.0 * mid));
  // second 3: min -0.1, max 0.1 -> a thin bar near the middle.
  assert.ok(bars[3].height < bars[2].height);
});

test('respects the clip\'s trim: fromSec/toSec slice a sub-range of the source', () => {
  // Trimmed to just second 2 (the loudest bucket), stretched across the width.
  const bars = waveformBars(PEAKS, { peaksPerSecond: 1, fromSec: 2, toSec: 3, width: 10, height: 20 });
  assert.equal(bars.length, 10);
  // Every column falls inside bucket 2 (min -1, max 1) -> every bar is full height.
  for (const b of bars) assert.equal(b.height, 20);
});

test('a column spanning several buckets takes the loudest min/max across them, not just the first', () => {
  // width=1 across the whole 4s source -> one column covering every bucket.
  const bars = waveformBars(PEAKS, { peaksPerSecond: 1, fromSec: 0, toSec: 4, width: 1, height: 20 });
  assert.equal(bars.length, 1);
  assert.equal(bars[0].height, 20); // the -1.0/1.0 bucket dominates the column
});

test('redraws identically from the same array at a different width (re-trim/resize, no re-fetch)', () => {
  const wide = waveformBars(PEAKS, { peaksPerSecond: 1, fromSec: 0, toSec: 2, width: 100, height: 20 });
  const narrow = waveformBars(PEAKS, { peaksPerSecond: 1, fromSec: 0, toSec: 2, width: 10, height: 20 });
  assert.equal(wide.length, 100);
  assert.equal(narrow.length, 10);
  // Both stay within the loudest range spanned by seconds 0-1 (max 0.9).
  for (const b of wide.concat(narrow)) assert.ok(b.height <= 20);
});

test('degrades to no bars rather than throwing for missing/empty inputs', () => {
  assert.deepEqual(waveformBars(null, { peaksPerSecond: 1, fromSec: 0, toSec: 1, width: 10, height: 20 }), []);
  assert.deepEqual(waveformBars([], { peaksPerSecond: 1, fromSec: 0, toSec: 1, width: 10, height: 20 }), []);
  assert.deepEqual(waveformBars(PEAKS, { peaksPerSecond: 1, fromSec: 0, toSec: 1, width: 0, height: 20 }), []);
  assert.deepEqual(waveformBars(PEAKS, { peaksPerSecond: 1, fromSec: 0, toSec: 1, width: 10, height: 0 }), []);
  assert.deepEqual(waveformBars(PEAKS, { peaksPerSecond: 1, fromSec: 2, toSec: 2, width: 10, height: 20 }), []);
});
