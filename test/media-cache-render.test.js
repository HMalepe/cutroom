'use strict';

/*
 * Runs shared/media-cache.js's ffmpeg argument builders through a real
 * ffmpeg, the same relationship test/ffmpeg-render.test.js has to
 * ffmpeg-builder.test.js: the pure-module tests prove the argument arrays
 * are the ones intended, this file proves ffmpeg actually accepts them and
 * hands back something usable — a real PCM stream that pcmToPeaks turns
 * into a sensible envelope, and real PNG frames at the requested width and
 * count.
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
