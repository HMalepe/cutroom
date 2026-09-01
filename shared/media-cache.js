/*
 * media-cache.js
 * ---------------------------------------------------------------------------
 * Everything the waveform and thumbnail features need that is pure enough to
 * test without a real ffmpeg: the disk cache's freshness check, the PCM ->
 * peaks downsample, the filmstrip's timestamp policy, and the ffmpeg argument
 * arrays main.js spawns. Kept separate from shared/ffmpeg-builder.js because
 * that file's job is a whole Project's worth of clips folded into one export
 * graph — this one is a single source file's worth of extraction, generated
 * once per file rather than once per export. Pure functions, no I/O, same
 * reason ffmpeg-builder.js is pure: it is the easiest thing here to test.
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
 * The ffmpeg command that produces the raw PCM `pcmToPeaks` above expects:
 * mono, so a stereo mix does not need averaging on our side; a low sample
 * rate, because a peak envelope for a several-pixel-wide bar does not need
 * CD quality to look right; and `-f s16le` straight to a file rather than a
 * container, so the only thing on disk is the samples themselves.
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

module.exports = {
  sourceCacheKey,
  isCacheFresh,
  pcmToPeaks,
  waveformExtractArgs,
  thumbnailTimestamps,
  thumbnailExtractArgs
};
