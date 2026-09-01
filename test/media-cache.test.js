'use strict';

/*
 * Pure-module tests for shared/media-cache.js — no ffmpeg, no Electron, no
 * DOM. Mirrors ffmpeg-builder.test.js's split: this file proves the
 * downsample math and the ffmpeg argument arrays are the ones intended;
 * test/media-cache-render.test.js proves a real ffmpeg accepts them and
 * produces something usable.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sourceCacheKey,
  isCacheFresh,
  pcmToPeaks,
  waveformExtractArgs,
  thumbnailTimestamps,
  thumbnailExtractArgs
} = require('../shared/media-cache');

// --------------------------------------------------------------------------
// sourceCacheKey / isCacheFresh
// --------------------------------------------------------------------------

test('sourceCacheKey is deterministic and distinguishes different paths', () => {
  assert.equal(sourceCacheKey('/a/b.mp4'), sourceCacheKey('/a/b.mp4'));
  assert.notEqual(sourceCacheKey('/a/b.mp4'), sourceCacheKey('/a/c.mp4'));
  // A hex sha1 digest, not something reused as a filename that could collide
  // with an unrelated file or escape the cache directory.
  assert.match(sourceCacheKey('/a/b.mp4'), /^[0-9a-f]{40}$/);
});

test('isCacheFresh accepts a record whose size and mtime still match the file', () => {
  const stat = { size: 1024, mtimeMs: 5000 };
  assert.equal(isCacheFresh({ size: 1024, mtimeMs: 5000 }, stat), true);
});

test('isCacheFresh rejects a size mismatch (the file was replaced)', () => {
  const stat = { size: 2048, mtimeMs: 5000 };
  assert.equal(isCacheFresh({ size: 1024, mtimeMs: 5000 }, stat), false);
});

test('isCacheFresh rejects an mtime mismatch (the file was touched, size unchanged)', () => {
  const stat = { size: 1024, mtimeMs: 6000 };
  assert.equal(isCacheFresh({ size: 1024, mtimeMs: 5000 }, stat), false);
});

test('isCacheFresh rejects a missing record rather than throwing', () => {
  assert.equal(isCacheFresh(null, { size: 1, mtimeMs: 1 }), false);
  assert.equal(isCacheFresh(undefined, { size: 1, mtimeMs: 1 }), false);
});

// --------------------------------------------------------------------------
// pcmToPeaks
// --------------------------------------------------------------------------

/** A buffer of s16le samples built from a plain JS array, LE by construction. */
function pcm(samples) {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
  return buf;
}

test('pcmToPeaks buckets by sampleRate/peaksPerSecond, not a fixed sample count', () => {
  // 8 samples at 8 samples/sec sampleRate, 1 peak/sec -> one bucket of 8.
  const buf = pcm([0, 100, -100, 32767, -32768, 0, 0, 0]);
  const peaks = pcmToPeaks(buf, { sampleRate: 8, peaksPerSecond: 1 });
  assert.equal(peaks.length, 2); // one [min, max] pair
  assert.equal(peaks[0], -1); // -32768 / 32768
  assert.ok(Math.abs(peaks[1] - 32767 / 32768) < 1e-9);
});

test('pcmToPeaks splits into multiple buckets when there is more than one second', () => {
  const buf = pcm([1000, 2000, -3000, -4000]); // 4 samples, 2 samples/sec -> 2 buckets
  const peaks = pcmToPeaks(buf, { sampleRate: 2, peaksPerSecond: 1 });
  assert.equal(peaks.length, 4);
  assert.equal(peaks[0], 1000 / 32768); // bucket 0 min
  assert.equal(peaks[1], 2000 / 32768); // bucket 0 max
  assert.equal(peaks[2], -4000 / 32768); // bucket 1 min
  assert.equal(peaks[3], -3000 / 32768); // bucket 1 max
});

test('pcmToPeaks treats a bucket of pure silence as [0, 0], not an empty gap', () => {
  const buf = pcm([0, 0, 0, 0]);
  const peaks = pcmToPeaks(buf, { sampleRate: 4, peaksPerSecond: 1 });
  assert.deepEqual(peaks, [0, 0]);
});

test('pcmToPeaks handles a trailing partial bucket rather than dropping it', () => {
  // 5 samples at 2/sec -> buckets of [2, 2, 1] samples, not evenly divisible.
  const buf = pcm([10, 20, 30, 40, 50]);
  const peaks = pcmToPeaks(buf, { sampleRate: 2, peaksPerSecond: 1 });
  assert.equal(peaks.length / 2, 3);
  assert.equal(peaks[4], 50 / 32768);
  assert.equal(peaks[5], 50 / 32768);
});

test('pcmToPeaks returns an empty array for an empty buffer', () => {
  assert.deepEqual(pcmToPeaks(Buffer.alloc(0), { sampleRate: 8000, peaksPerSecond: 100 }), []);
});

// --------------------------------------------------------------------------
// waveformExtractArgs
// --------------------------------------------------------------------------

test('waveformExtractArgs asks for mono, the given sample rate, and raw s16le', () => {
  const args = waveformExtractArgs('/in.mp4', '/out.pcm', { sampleRate: 8000 });
  assert.deepEqual(args, ['-y', '-i', '/in.mp4', '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '/out.pcm']);
});

// --------------------------------------------------------------------------
// thumbnailTimestamps
// --------------------------------------------------------------------------

test('thumbnailTimestamps returns a single frame at 0 for a zero or negative duration', () => {
  assert.deepEqual(thumbnailTimestamps(0), [0]);
  assert.deepEqual(thumbnailTimestamps(-5), [0]);
});

test('thumbnailTimestamps spaces frames evenly across the duration', () => {
  const ts = thumbnailTimestamps(20, { targetIntervalSec: 5, maxCount: 100 });
  assert.deepEqual(ts, [0, 5, 10, 15]);
});

test('thumbnailTimestamps caps the count for a very long source rather than growing without bound', () => {
  const ts = thumbnailTimestamps(10000, { targetIntervalSec: 5, maxCount: 30 });
  assert.equal(ts.length, 30);
  assert.equal(ts[0], 0);
  assert.equal(ts[29], 29 * (10000 / 30));
});

test('thumbnailTimestamps still returns at least one frame for a source shorter than the target interval', () => {
  const ts = thumbnailTimestamps(1, { targetIntervalSec: 5, maxCount: 30 });
  assert.deepEqual(ts, [0]);
});

// --------------------------------------------------------------------------
// thumbnailExtractArgs
// --------------------------------------------------------------------------

test('thumbnailExtractArgs grabs a single frame with no fps filter when count <= 1', () => {
  const args = thumbnailExtractArgs('/in.mp4', '/out.png', { count: 1, durationSec: 0, width: 120 });
  assert.deepEqual(args, ['-y', '-i', '/in.mp4', '-frames:v', '1', '-vf', 'scale=120:-2', '/out.png']);
});

test('thumbnailExtractArgs uses fps = count/duration and caps output with -frames:v', () => {
  const args = thumbnailExtractArgs('/in.mp4', '/out-%03d.png', { count: 4, durationSec: 20, width: 120 });
  assert.deepEqual(args, [
    '-y', '-i', '/in.mp4',
    '-vf', 'fps=0.2,scale=120:-2',
    '-frames:v', '4',
    '/out-%03d.png'
  ]);
});

test('thumbnailExtractArgs does not divide by zero for a degenerate duration with count > 1', () => {
  const args = thumbnailExtractArgs('/in.mp4', '/out-%03d.png', { count: 3, durationSec: 0, width: 120 });
  assert.ok(Number.isFinite(Number(args[4].match(/fps=([\d.]+)/)[1])));
});
