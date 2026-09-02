/*
 * media-cache.js
 * ---------------------------------------------------------------------------
 * Everything the waveform, thumbnail and keyframe-spacing features need that
 * is pure enough to test without a real ffmpeg: the disk cache's freshness
 * check, the PCM -> peaks downsample (both the whole-buffer version and the
 * incremental accumulator main.js streams ffmpeg's stdout through), the
 * peaks array's binary on-disk encoding, the filmstrip's timestamp policy,
 * the ffmpeg/ffprobe argument arrays main.js spawns, and the average-gap math
 * media:probe uses to turn a sampled window of keyframe timestamps into one
 * number. Kept separate from shared/ffmpeg-builder.js
 * because that file's job is a whole Project's worth of clips folded into
 * one export graph — this one is a single source file's worth of
 * extraction, generated once per file rather than once per export. Pure
 * functions, no I/O, same reason ffmpeg-builder.js is pure: it is the
 * easiest thing here to test. (Actually spawning ffmpeg and streaming its
 * stdout lives in shared/waveform-extract.js instead, since that part
 * cannot be pure — kept small and separate so this file's own tests stay
 * child-process-free.)
 */

'use strict';

const crypto = require('crypto');

/**
 * Waveform and thumbnail caches both key their disk entry off a source
 * file's path, not its content — hashing a multi-gigabyte video just to find
 * out whether it changed would cost more than the ffmpeg run it is meant to
 * save. `isCacheFresh` below is what actually decides whether a cached entry
 * still describes the file on disk.
 */
function sourceCacheKey(filePath) {
  return crypto.createHash('sha1').update(String(filePath)).digest('hex');
}

/**
 * A cached entry is good as long as the source's size and mtime match what
 * it was generated from. Not a content hash, for the reason above — a source
 * replaced at the same path (a re-export overwriting a proxy, for instance)
 * changes at least one of the two, which is enough to invalidate without
 * reading the file to find out.
 */
function isCacheFresh(record, stat) {
  return Boolean(record) && stat &&
    record.size === stat.size && record.mtimeMs === stat.mtimeMs;
}

/**
 * Downsample signed 16-bit little-endian PCM into a peaks array: one
 * [min, max] pair per bucket, normalized to [-1, 1], flattened into a single
 * array (`peaks[i*2]`, `peaks[i*2+1]`). Buckets are sized from
 * `peaksPerSecond` rather than the array being sized to a fixed total bucket
 * count, so a caller who only knows a clip's trim in seconds can index straight
 * in with `Math.floor(sec * peaksPerSecond)` — no need to know the source's
 * total duration at draw time. That is what lets a trimmed clip and its
 * untrimmed source share one cached array instead of one per trim.
 */
function pcmToPeaks(buffer, { sampleRate, peaksPerSecond }) {
  const BYTES_PER_SAMPLE = 2; // s16le
  const totalSamples = Math.floor(buffer.length / BYTES_PER_SAMPLE);
  const samplesPerBucket = Math.max(1, Math.round(sampleRate / peaksPerSecond));
  const bucketCount = Math.max(0, Math.ceil(totalSamples / samplesPerBucket));
  const peaks = new Array(bucketCount * 2);

  for (let b = 0; b < bucketCount; b++) {
    const start = b * samplesPerBucket;
    const end = Math.min(totalSamples, start + samplesPerBucket);
    // Starting from +-Infinity, not 0, matters: a bucket that is entirely
    // above or below zero (a DC-biased source, or just a short run that
    // never crosses the middle) has to report its real min/max, not one
    // artificially clamped toward silence.
    let min = Infinity;
    let max = -Infinity;
    for (let i = start; i < end; i++) {
      const v = buffer.readInt16LE(i * BYTES_PER_SAMPLE) / 32768;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!Number.isFinite(min)) { min = 0; max = 0; } // an empty bucket, never actually reached above
    peaks[b * 2] = min;
    peaks[b * 2 + 1] = max;
  }
  return peaks;
}

/**
 * A stateful, incremental counterpart to pcmToPeaks above: same bucketing,
 * fed PCM in pieces instead of one already-complete Buffer. This is what
 * lets a caller pipe ffmpeg's stdout straight into bucketing as chunks
 * arrive, rather than buffering a whole source's decoded audio -- tens to
 * hundreds of MB for a multi-hour recording -- into one Buffer before
 * bucketing can even start.
 *
 * push(chunk) can be called any number of times with chunks of any size: a
 * bucket boundary has nothing to do with a chunk boundary, and neither does
 * a 16-bit sample's own two bytes. A chunk that ends between them leaves
 * exactly one byte carried forward to be prefixed onto the next push(),
 * rather than dropped or misread as a whole sample by itself. finish()
 * flushes whatever bucket is left in progress (a sample count that is not a
 * multiple of samplesPerBucket always ends mid-bucket, same as the trailing
 * partial bucket pcmToPeaks handles) and returns the same peaks array
 * pcmToPeaks(wholeBuffer, opts) would have for the same PCM, whatever the
 * chunking -- that equivalence, not just "produces plausible-looking
 * numbers", is what the tests for this pin down.
 */
function createPeaksAccumulator({ sampleRate, peaksPerSecond }) {
  const BYTES_PER_SAMPLE = 2; // s16le
  const samplesPerBucket = Math.max(1, Math.round(sampleRate / peaksPerSecond));
  const peaks = [];

  let leftover = null; // the one odd byte carried over from the previous chunk, or null
  let min = Infinity;
  let max = -Infinity;
  let countInBucket = 0;

  function flushBucket() {
    peaks.push(min, max);
    min = Infinity;
    max = -Infinity;
    countInBucket = 0;
  }

  function push(chunk) {
    const buf = leftover ? Buffer.concat([leftover, chunk]) : chunk;
    leftover = null;
    const usable = buf.length - (buf.length % BYTES_PER_SAMPLE);
    if (usable < buf.length) leftover = buf.subarray(usable);

    for (let i = 0; i < usable; i += BYTES_PER_SAMPLE) {
      const v = buf.readInt16LE(i) / 32768;
      if (v < min) min = v;
      if (v > max) max = v;
      if (++countInBucket === samplesPerBucket) flushBucket();
    }
  }

  function finish() {
    // A trailing odd byte across the whole stream is dropped rather than
    // treated as a sample, same as pcmToPeaks's Math.floor(length / 2).
    if (countInBucket > 0) flushBucket();
    return peaks;
  }

  return { push, finish };
}

/**
 * Binary on-disk encoding for a peaks array, used in place of JSON for this
 * one field: a waveform's peaks array is one [min, max] pair per 1/100s
 * across a whole source, which for a multi-hour recording is millions of
 * numbers. JSON.stringify/parse over an array that size is itself a
 * significant, synchronous, main-thread-blocking cost -- separate from how
 * the PCM was decoded -- paid on every cache write AND every cache hit (the
 * common case, since caching is the whole point). A Float32Array read back
 * as a raw byte view costs nothing beyond the read() itself: no parsing
 * loop, no per-number string round-trip. Float32 rather than Float64
 * because these values are normalized to [-1, 1] for display -- a canvas
 * bar a few dozen pixels tall cannot show more precision than float32
 * already carries, so float64 would only double the file size for nothing.
 * Int16 would halve it again, but only by pushing a scale-back-by-32767
 * convention onto every future reader of this file; float32 keeps the
 * on-disk numbers identical to the in-memory ones.
 *
 * bufferToPeaks assumes `buffer.length` is a multiple of 4 -- the caller
 * (main.js's readWaveformCache) is what decides a file that fails that
 * check is corrupt/old-format and should be treated as a cache miss rather
 * than handed here.
 */
function peaksToBuffer(peaks) {
  return Buffer.from(Float32Array.from(peaks).buffer);
}

function bufferToPeaks(buffer) {
  // fs.readFileSync's Buffer is not guaranteed to start at a multiple-of-4
  // offset within its backing ArrayBuffer, and Float32Array requires that
  // alignment -- copy on the rare occasion it does not, which for a cache
  // file this small is cheap insurance rather than the cost this format
  // change exists to avoid.
  const aligned = buffer.byteOffset % Float32Array.BYTES_PER_ELEMENT === 0
    ? buffer
    : Buffer.from(buffer);
  return new Float32Array(aligned.buffer, aligned.byteOffset, aligned.length / Float32Array.BYTES_PER_ELEMENT);
}

/**
 * The ffmpeg command that produces the raw PCM `pcmToPeaks`/
 * `createPeaksAccumulator` above expect: mono, so a stereo mix does not need
 * averaging on our side; a low sample rate, because a peak envelope for a
 * several-pixel-wide bar does not need CD quality to look right; and
 * `-f s16le` rather than a container, so the only thing produced is the
 * samples themselves. `outPath` of `'-'` asks ffmpeg to write that raw PCM
 * to stdout instead of a file -- what shared/waveform-extract.js pipes
 * straight into createPeaksAccumulator so a multi-hour source is never
 * fully decoded to disk-then-memory before bucketing can start.
 */
function waveformExtractArgs(filePath, outPath, { sampleRate }) {
  return ['-y', '-i', filePath, '-vn', '-ac', '1', '-ar', String(sampleRate), '-f', 's16le', outPath];
}

/**
 * Timestamps for a filmstrip, spread evenly across the whole source and
 * generated once — same reasoning as the peaks array above: cache once,
 * redraw any clip's trim or on-screen width from the same set rather than
 * asking ffmpeg again per clip. Capped at `maxCount` so a feature-length
 * source does not spawn, cache and hold hundreds of frames; past the cap the
 * spacing between frames grows instead of the count.
 */
function thumbnailTimestamps(durationSec, { targetIntervalSec = 4, maxCount = 30 } = {}) {
  const duration = Math.max(0, Number(durationSec) || 0);
  if (duration <= 0) return [0];
  const wanted = Math.max(1, Math.round(duration / targetIntervalSec));
  const count = Math.min(maxCount, wanted);
  const step = duration / count;
  const out = [];
  for (let i = 0; i < count; i++) out.push(i * step);
  return out;
}

/**
 * One ffmpeg pass grabs every frame `thumbnailTimestamps` asked for, rather
 * than one process per timestamp — `fps=count/duration` lands a frame at
 * (approximately) each of those evenly-spaced points, and `-frames:v` caps
 * the output at exactly `count` so a rounding-up inside ffmpeg's own fps
 * filter cannot hand back one more file than the timestamps array has
 * entries for. `count <= 1` (a still image, or a source too short to be
 * worth spacing out) skips the fps filter entirely: it has no meaning for a
 * single frame, and asking for it would divide by whatever `durationSec` is,
 * including zero.
 */
function thumbnailExtractArgs(filePath, outPattern, { count, durationSec, width }) {
  if (count <= 1) {
    return ['-y', '-i', filePath, '-frames:v', '1', '-vf', `scale=${width}:-2`, outPattern];
  }
  // Guards the same zero/near-zero duration pcmToPeaks's caller already
  // guards for thumbnailTimestamps — a count > 1 always came from a positive
  // duration there, but this function is exercised directly in tests too.
  const fps = count / Math.max(durationSec, count * 0.01);
  return ['-y', '-i', filePath, '-vf', `fps=${fps},scale=${width}:-2`, '-frames:v', String(count), outPattern];
}

/**
 * ffprobe args to list keyframe presentation timestamps for a source's video
 * stream, decoding only keyframes (`-skip_frame nokey`) rather than every
 * frame — cheap regardless of the source's own length, unlike the full-decode
 * mistake this codebase's waveform extraction used to make before it was
 * fixed to stream (see shared/waveform-extract.js). `-read_intervals`
 * bounds the packet scan itself to roughly the file's first `windowSec`
 * seconds, so this stays cheap on a multi-hour source too: without it,
 * ffprobe walks the entire packet index just to answer a question this
 * feature only needs an early sample for.
 */
function keyframeProbeArgs(filePath, { windowSec } = {}) {
  const window = Number.isFinite(windowSec) && windowSec > 0 ? windowSec : 60;
  return [
    '-v', 'error',
    '-skip_frame', 'nokey',
    '-select_streams', 'v:0',
    '-show_entries', 'frame=pts_time',
    '-read_intervals', `%+${window}`,
    '-of', 'csv=p=0',
    filePath
  ];
}

/**
 * Parse ffprobe's `csv=p=0` output for `frame=pts_time` into a plain number
 * array: one timestamp per line, blank lines dropped. Only the first
 * comma-separated field is read, not the whole line -- a keyframe carrying
 * SEI/side-data (real x264 output does this on the first frame of a GOP)
 * makes ffprobe emit `side_data_list` as a second, empty CSV field on that
 * line (`0.000000,`), which `Number()` on the raw line would silently read
 * as NaN and drop -- exactly the keyframe a GOP-interval measurement can
 * least afford to lose.
 */
function parseKeyframeTimestamps(stdout) {
  return String(stdout)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => Number(line.split(',')[0]))
    .filter(Number.isFinite);
}

/**
 * Average gap between consecutive keyframes, from timestamps sampled over a
 * bounded early window (see keyframeProbeArgs above) rather than a whole
 * source — good enough for "is this source's GOP sparse", the only question
 * this feature asks, without the cost of a full packet scan.
 *
 * Fewer than 2 keyframes in that window is not "a sparse interval of zero" —
 * it is not enough data to measure an interval at all (a clip shorter than
 * the window, or a first GOP that already outruns it), so this returns null
 * rather than a number that would either understate a real problem or flag a
 * short, perfectly ordinary clip as sparse from nothing but bad luck on
 * sample size.
 */
function averageKeyframeIntervalSec(timestamps) {
  const ts = (timestamps || []).filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (ts.length < 2) return null;
  return (ts[ts.length - 1] - ts[0]) / (ts.length - 1);
}

module.exports = {
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
};
