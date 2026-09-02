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
  createPeaksAccumulator,
  peaksToBuffer,
  bufferToPeaks,
  waveformExtractArgs,
  thumbnailTimestamps,
  thumbnailExtractArgs,
  keyframeProbeArgs,
  parseKeyframeTimestamps,
  averageKeyframeIntervalSec
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
// createPeaksAccumulator
// --------------------------------------------------------------------------

/** Feeds `buf` through a fresh accumulator, split at the given byte offsets. */
function accumulate(buf, opts, splitPoints) {
  const acc = createPeaksAccumulator(opts);
  let start = 0;
  for (const end of [...splitPoints, buf.length]) {
    acc.push(buf.subarray(start, end));
    start = end;
  }
  return acc.finish();
}

/** A deterministic pile of pseudo-random s16le samples, LCG-seeded so failures reproduce. */
function pseudoRandomPcm(sampleCount, seed = 1) {
  const buf = Buffer.alloc(sampleCount * 2);
  let state = seed;
  for (let i = 0; i < sampleCount; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    const sample = (state % 65536) - 32768;
    buf.writeInt16LE(sample, i * 2);
  }
  return buf;
}

test('createPeaksAccumulator fed as one whole chunk matches pcmToPeaks exactly', () => {
  const buf = pcm([0, 100, -100, 32767, -32768, 0, 0, 0]);
  const opts = { sampleRate: 8, peaksPerSecond: 1 };
  assert.deepEqual(accumulate(buf, opts, []), pcmToPeaks(buf, opts));
});

test('createPeaksAccumulator carries a running min/max across a chunk boundary inside one bucket', () => {
  // One bucket of 4 samples, split so no single chunk sees the whole bucket.
  const buf = pcm([10, -20000, 5, 32000]);
  const opts = { sampleRate: 4, peaksPerSecond: 1 };
  const peaks = accumulate(buf, opts, [2, 5]); // split after sample 1, and mid-sample at byte 5
  assert.deepEqual(peaks, pcmToPeaks(buf, opts));
});

test('createPeaksAccumulator handles a 16-bit sample split across two chunks (odd byte boundary)', () => {
  const buf = pcm([1000, -2000, 3000, -4000, 5000]);
  const opts = { sampleRate: 5, peaksPerSecond: 1 };
  // Split at every odd byte offset across the buffer, including ones that
  // land exactly between the two bytes of a sample.
  for (let cut = 1; cut < buf.length; cut++) {
    const peaks = accumulate(buf, opts, [cut]);
    assert.deepEqual(peaks, pcmToPeaks(buf, opts), `mismatch splitting at byte ${cut}`);
  }
});

test('createPeaksAccumulator matches pcmToPeaks across many buckets and many chunk splits', () => {
  const buf = pseudoRandomPcm(5000, 42);
  const opts = { sampleRate: 500, peaksPerSecond: 5 }; // samplesPerBucket = 100 -> 50 buckets
  const expected = pcmToPeaks(buf, opts);

  // Split into single-byte chunks: the most adversarial case for both the
  // odd-byte carry and the running min/max carrying across many buckets.
  const singleByteSplits = Array.from({ length: buf.length - 1 }, (_, i) => i + 1);
  assert.deepEqual(accumulate(buf, opts, singleByteSplits), expected);

  // A handful of arbitrary, unevenly-sized chunk splits.
  assert.deepEqual(accumulate(buf, opts, [1, 7, 8, 250, 251, 4001, 9999]), expected);

  // Fed as one chunk, matching whole-buffer pcmToPeaks trivially.
  assert.deepEqual(accumulate(buf, opts, []), expected);
});

test('createPeaksAccumulator returns an empty array when nothing is ever pushed', () => {
  const acc = createPeaksAccumulator({ sampleRate: 8000, peaksPerSecond: 100 });
  assert.deepEqual(acc.finish(), []);
});

test('createPeaksAccumulator flushes a trailing partial bucket, matching pcmToPeaks', () => {
  const buf = pcm([10, 20, 30, 40, 50]); // 5 samples at 2/sec -> buckets of [2, 2, 1]
  const opts = { sampleRate: 2, peaksPerSecond: 1 };
  assert.deepEqual(accumulate(buf, opts, [3]), pcmToPeaks(buf, opts));
});

// --------------------------------------------------------------------------
// peaksToBuffer / bufferToPeaks
// --------------------------------------------------------------------------

test('peaksToBuffer/bufferToPeaks round-trip a peaks array exactly', () => {
  const peaks = [-1, 1, 0, 0, -0.5, 0.899999976158142];
  const roundTripped = Array.from(bufferToPeaks(peaksToBuffer(peaks)));
  assert.deepEqual(roundTripped, Array.from(Float32Array.from(peaks)));
});

test('peaksToBuffer/bufferToPeaks round-trips an empty peaks array to an empty typed array', () => {
  const result = bufferToPeaks(peaksToBuffer([]));
  assert.equal(result.length, 0);
});

test('bufferToPeaks copes with a buffer that is not 4-byte aligned in its backing ArrayBuffer', () => {
  const peaks = [0.25, -0.75, 1, -1];
  const encoded = peaksToBuffer(peaks);
  // Prefix one unrelated byte so encoded's data starts at a misaligned offset.
  const misaligned = Buffer.concat([Buffer.from([0xff]), encoded]).subarray(1);
  assert.notEqual(misaligned.byteOffset % 4, 0, 'test setup should actually produce a misaligned view');
  assert.deepEqual(Array.from(bufferToPeaks(misaligned)), Array.from(Float32Array.from(peaks)));
});

// --------------------------------------------------------------------------
// waveformExtractArgs
// --------------------------------------------------------------------------

test('waveformExtractArgs asks for mono, the given sample rate, and raw s16le', () => {
  const args = waveformExtractArgs('/in.mp4', '/out.pcm', { sampleRate: 8000 });
  assert.deepEqual(args, ['-y', '-i', '/in.mp4', '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '/out.pcm']);
});

test('waveformExtractArgs asks ffmpeg to write to stdout when outPath is "-"', () => {
  const args = waveformExtractArgs('/in.mp4', '-', { sampleRate: 8000 });
  assert.deepEqual(args, ['-y', '-i', '/in.mp4', '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-']);
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

// --------------------------------------------------------------------------
// keyframeProbeArgs / parseKeyframeTimestamps / averageKeyframeIntervalSec
// --------------------------------------------------------------------------

test('keyframeProbeArgs decodes only keyframes and bounds the read to the given window', () => {
  const args = keyframeProbeArgs('/in.mp4', { windowSec: 60 });
  assert.deepEqual(args, [
    '-v', 'error',
    '-skip_frame', 'nokey',
    '-select_streams', 'v:0',
    '-show_entries', 'frame=pts_time',
    '-read_intervals', '%+60',
    '-of', 'csv=p=0',
    '/in.mp4'
  ]);
});

test('keyframeProbeArgs defaults the window when none is given, rather than an unbounded scan', () => {
  const args = keyframeProbeArgs('/in.mp4');
  assert.equal(args[args.indexOf('-read_intervals') + 1], '%+60');
});

test('keyframeProbeArgs falls back to the default window for a nonsense value instead of asking ffprobe to read a negative/zero span', () => {
  for (const bad of [0, -5, NaN, undefined]) {
    const args = keyframeProbeArgs('/in.mp4', { windowSec: bad });
    assert.equal(args[args.indexOf('-read_intervals') + 1], '%+60');
  }
});

test('parseKeyframeTimestamps reads one float per line and drops blanks', () => {
  assert.deepEqual(parseKeyframeTimestamps('0.000000\n1.001000\n2.002000\n'), [0, 1.001, 2.002]);
  assert.deepEqual(parseKeyframeTimestamps('0.5\n\n1.5\n'), [0.5, 1.5]);
});

test('parseKeyframeTimestamps drops lines that are not a real number rather than emitting NaN', () => {
  assert.deepEqual(parseKeyframeTimestamps('1.0\nN/A\n2.0\n'), [1, 2]);
});

test('parseKeyframeTimestamps reads only the first field when a line carries a trailing side_data_list comma', () => {
  // A real x264 keyframe (typically the first one) reports side_data_list,
  // which ffprobe's csv=p=0 renders as a second, empty field on that line.
  // Number('0.000000,') is NaN -- if this were read whole rather than
  // field-by-field, exactly that keyframe would be silently dropped.
  assert.deepEqual(parseKeyframeTimestamps('0.000000,\n10.000000\n'), [0, 10]);
});

test('averageKeyframeIntervalSec averages the gaps between a dense run of keyframes', () => {
  // 1s apart throughout: mean gap is exactly 1.
  assert.equal(averageKeyframeIntervalSec([0, 1, 2, 3, 4, 5]), 1);
});

test('averageKeyframeIntervalSec divides total span by (count - 1), not by count', () => {
  // 0, 30 — one gap of 30s, not "30 / 2 keyframes".
  assert.equal(averageKeyframeIntervalSec([0, 30]), 30);
});

test('averageKeyframeIntervalSec sorts out-of-order timestamps before measuring gaps', () => {
  assert.equal(averageKeyframeIntervalSec([5, 0, 10]), 5);
});

test('averageKeyframeIntervalSec returns null for fewer than 2 keyframes — insufficient data, not a measured zero', () => {
  assert.equal(averageKeyframeIntervalSec([]), null);
  assert.equal(averageKeyframeIntervalSec([0]), null);
});

test('averageKeyframeIntervalSec ignores non-finite entries when deciding whether there is enough data', () => {
  assert.equal(averageKeyframeIntervalSec([0, NaN, Infinity]), null);
  assert.equal(averageKeyframeIntervalSec([0, NaN, 4]), 4);
});
