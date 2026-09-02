'use strict';

/*
 * Runs shared/media-cache.js's ffmpeg argument builders, and
 * shared/waveform-extract.js's streaming extraction, through a real ffmpeg —
 * the same relationship test/ffmpeg-render.test.js has to
 * ffmpeg-builder.test.js: the pure-module tests prove the argument arrays
 * and bucketing math are the ones intended, this file proves ffmpeg actually
 * accepts them and hands back something usable — a real PCM stream that
 * pcmToPeaks turns into a sensible envelope, a streamed extraction that
 * matches it bit-for-bit without ever buffering the whole decode, and real
 * PNG frames at the requested width and count.
 *
 * CI has no ffmpeg, so the whole file skips cleanly when it is not on PATH.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  pcmToPeaks,
  waveformExtractArgs,
  thumbnailTimestamps,
  thumbnailExtractArgs
} = require('../shared/media-cache');
const { extractWaveformPeaks } = require('../shared/waveform-extract');

function probe(bin) {
  try {
    return spawnSync(bin, ['-version'], { encoding: 'utf8' }).status === 0;
  } catch { return false; }
}

const FFMPEG = probe('ffmpeg');
const FFPROBE = probe('ffprobe');
// Same shape as the jsdom guard in undo-integration.test.js: skip, don't fail.
const opts = FFMPEG && FFPROBE ? {} : { skip: 'ffmpeg/ffprobe not on PATH' };

const DIR = FFMPEG ? fs.mkdtempSync(path.join(os.tmpdir(), 'cutroom-media-cache-')) : null;
if (DIR) process.on('exit', () => fs.rmSync(DIR, { recursive: true, force: true }));

/** A short synthetic source with both a tone and picture, built once and reused. */
let SOURCE = null;
let SOURCE_DURATION = 0;
function source() {
  if (SOURCE) return SOURCE;
  const file = path.join(DIR, 'source.mp4');
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x240:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file
  ], { encoding: 'utf8' });
  assert.equal(r.status, 0, `fixture failed:\n${r.stderr}`);
  SOURCE = file;
  SOURCE_DURATION = 6;
  return file;
}

/** A silent source with picture but no audio stream at all. */
let SILENT = null;
function silentSource() {
  if (SILENT) return SILENT;
  const file = path.join(DIR, 'silent.mp4');
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=30:d=2', '-pix_fmt', 'yuv420p', file
  ], { encoding: 'utf8' });
  assert.equal(r.status, 0, `silent fixture failed:\n${r.stderr}`);
  SILENT = file;
  return file;
}

// --------------------------------------------------------------------------
// Waveform extraction
// --------------------------------------------------------------------------

test('waveformExtractArgs produces PCM a real ffmpeg accepts, decodable into a real peak envelope', opts, () => {
  const src = source();
  const out = path.join(DIR, 'wave.pcm');
  const args = waveformExtractArgs(src, out, { sampleRate: 8000 });
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `ffmpeg rejected the waveform args:\n${r.stderr}`);

  const buf = fs.readFileSync(out);
  // 6s of mono s16le at 8000Hz -> 6 * 8000 * 2 bytes, give or take container rounding.
  assert.ok(Math.abs(buf.length - 6 * 8000 * 2) < 8000, `unexpected PCM length ${buf.length}`);

  const peaks = pcmToPeaks(buf, { sampleRate: 8000, peaksPerSecond: 100 });
  assert.ok(peaks.length > 0);
  // A real 440Hz tone crosses zero — some bucket's max should be a real
  // positive swing, not the [0, 0] a silent or all-clamped decode would give.
  assert.ok(peaks.some(v => v > 0.05), 'expected the real tone to produce audible peaks');
  assert.ok(peaks.every(v => v >= -1 && v <= 1), 'peaks must stay normalized to [-1, 1]');
});

test('waveformExtractArgs fails the way main.js expects when the source has no audio stream', opts, () => {
  const src = silentSource();
  const out = path.join(DIR, 'no-audio.pcm');
  const args = waveformExtractArgs(src, out, { sampleRate: 8000 });
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  // main.js only calls this for a clip whose hasAudio is true, so a real
  // no-audio source is not a case it has to handle gracefully — this just
  // pins that ffmpeg's own failure (a non-zero exit, no PCM produced) is what
  // main.js's spawn().on('close', ...) rejection actually keys off of.
  assert.notEqual(r.status, 0);
  assert.ok(!fs.existsSync(out) || fs.readFileSync(out).length === 0);
});

test('extractWaveformPeaks (streaming stdout) matches pcmToPeaks (whole-buffer-to-file) for the same real decode', opts, async () => {
  const src = source();
  const sampleRate = 8000;
  const peaksPerSecond = 100;

  // The old path this replaces: decode to a file, read the whole file, bucket it.
  const out = path.join(DIR, 'wave-whole-buffer.pcm');
  const fileArgs = waveformExtractArgs(src, out, { sampleRate });
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...fileArgs], { encoding: 'utf8' });
  assert.equal(r.status, 0, `ffmpeg rejected the whole-buffer args:\n${r.stderr}`);
  const wholeBufferPeaks = pcmToPeaks(fs.readFileSync(out), { sampleRate, peaksPerSecond });

  // The new path: ffmpeg's stdout streamed straight into the accumulator.
  const streamedPeaks = await extractWaveformPeaks('ffmpeg', src, { sampleRate, peaksPerSecond });

  assert.ok(wholeBufferPeaks.length > 0);
  assert.deepEqual(streamedPeaks, wholeBufferPeaks,
    'streaming extraction should produce bit-identical peaks to the old whole-buffer path');
});

test('extractWaveformPeaks never buffers anywhere near the whole decode at once', opts, async () => {
  const src = source();
  const sampleRate = 8000;

  let maxChunk = 0;
  let chunkCount = 0;
  let totalBytes = 0;
  await extractWaveformPeaks('ffmpeg', src, {
    sampleRate,
    peaksPerSecond: 100,
    onChunk: (n) => { maxChunk = Math.max(maxChunk, n); chunkCount++; totalBytes += n; }
  });

  // 6s of mono s16le at 8000Hz is ~96000 bytes total. If a regression ever
  // buffered the whole decode into one Buffer before handing it off (the
  // exact bug this fix removes), onChunk would fire once with ~totalBytes
  // and chunkCount would be 1 — this is the test that would catch that.
  assert.ok(totalBytes > 50000, `expected a real amount of PCM, got ${totalBytes} bytes total`);
  assert.ok(chunkCount > 1, `expected delivery across multiple stdout chunks, got ${chunkCount}`);
  assert.ok(maxChunk < totalBytes / 2,
    `expected no single chunk to hold a large fraction of the decode; largest was ${maxChunk} of ${totalBytes} total bytes`);
  // A generous bound well above a typical pipe buffer (usually 64KB on Linux)
  // but far below what a several-minute-or-longer source would produce if
  // this ever regressed back to whole-file buffering.
  assert.ok(maxChunk < 262144, `single stdout chunk was ${maxChunk} bytes, larger than expected for streamed delivery`);
});

// --------------------------------------------------------------------------
// Thumbnail extraction
// --------------------------------------------------------------------------

test('thumbnailExtractArgs (count > 1) produces exactly the timestamps\' worth of correctly-sized PNGs', opts, () => {
  const src = source();
  const timestamps = thumbnailTimestamps(SOURCE_DURATION, { targetIntervalSec: 2, maxCount: 30 });
  assert.ok(timestamps.length > 1, 'fixture should be long enough to need more than one frame');

  const pattern = path.join(DIR, 'thumb-%03d.png');
  const args = thumbnailExtractArgs(src, pattern, { count: timestamps.length, durationSec: SOURCE_DURATION, width: 120 });
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `ffmpeg rejected the thumbnail args:\n${r.stderr}`);

  const files = fs.readdirSync(DIR).filter(f => /^thumb-\d+\.png$/.test(f)).sort();
  assert.equal(files.length, timestamps.length, '-frames:v should cap output at exactly the requested count');

  for (const f of files) {
    const bytes = fs.readFileSync(path.join(DIR, f));
    assert.equal(bytes.readUInt32BE(16), 120, `${f} should be scaled to width 120`);
    assert.ok(bytes.readUInt32BE(20) > 0, `${f} should have a positive height`);
  }
});

test('thumbnailExtractArgs (count <= 1) grabs exactly one frame with no fps filter', opts, () => {
  const src = source();
  const single = path.join(DIR, 'single-%03d.png');
  const args = thumbnailExtractArgs(src, single, { count: 1, durationSec: SOURCE_DURATION, width: 80 });
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `ffmpeg rejected the single-frame args:\n${r.stderr}`);

  const files = fs.readdirSync(DIR).filter(f => /^single-\d+\.png$/.test(f));
  assert.equal(files.length, 1);
  const bytes = fs.readFileSync(path.join(DIR, files[0]));
  assert.equal(bytes.readUInt32BE(16), 80);
});
