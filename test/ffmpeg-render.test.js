'use strict';

/*
 * Runs the commands the builder writes through a real ffmpeg.
 *
 * ffmpeg-builder.test.js proves we assembled the string we meant to. It cannot
 * prove ffmpeg accepts it, and xfade is the fussiest filter in the file: it
 * refuses two inputs that disagree on size, pixel format, frame rate, SAR or
 * timebase, and every one of those is something the per-clip chain is free to
 * vary. So these tests build against synthetic lavfi media, execute, and look
 * at the pixels that come out.
 *
 * CI has no ffmpeg, so the whole file skips cleanly when it is not on PATH.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { buildExportCommand, TRANSITION_TYPES } = require('../shared/ffmpeg-builder');

const FFMPEG = probe('ffmpeg');
const FFPROBE = probe('ffprobe');

function probe(bin) {
  try {
    return spawnSync(bin, ['-version'], { encoding: 'utf8' }).status === 0;
  } catch { return false; }
}

// Same shape as the jsdom guard in undo-integration.test.js: skip, don't fail.
const opts = FFMPEG && FFPROBE ? {} : { skip: 'ffmpeg/ffprobe not on PATH' };

const DIR = FFMPEG ? fs.mkdtempSync(path.join(os.tmpdir(), 'cutroom-render-')) : null;
if (DIR) process.on('exit', () => fs.rmSync(DIR, { recursive: true, force: true }));

// --------------------------------------------------------------------------
// Fixtures. Small and short — the point is that ffmpeg accepts the graph, not
// that it encodes a lot of frames.
// --------------------------------------------------------------------------

const sources = new Map();

/** A synthetic source file, built once and reused. */
function source(name, args) {
  if (!sources.has(name)) {
    const file = path.join(DIR, `${name}.mp4`);
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, file],
      { encoding: 'utf8' });
    assert.equal(r.status, 0, `fixture ${name} failed:\n${r.stderr}`);
    sources.set(name, file);
  }
  return sources.get(name);
}

const white = () => source('white', ['-f', 'lavfi', '-i', 'color=c=white:s=320x240:r=30:d=6', '-pix_fmt', 'yuv420p']);
const bars = () => source('bars', ['-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x240:rate=30', '-pix_fmt', 'yuv420p']);
/** Full-canvas solids, for telling which of two clips a pixel came from. */
const red = () => source('red', ['-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=30:d=6', '-pix_fmt', 'yuv420p']);
const solidBlue = () => source('solid-blue', ['-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=30:d=6', '-pix_fmt', 'yuv420p']);
/** Deliberately a different size and frame rate, to exercise the agreement rules. */
const odd = () => source('odd', ['-f', 'lavfi', '-i', 'testsrc=duration=6:size=640x360:rate=25', '-pix_fmt', 'yuv420p']);
/** Short and wide, so scaling into a 4:3 canvas leaves transparent bars. */
const band = () => source('band', ['-f', 'lavfi', '-i', 'color=c=blue:s=640x160:r=30:d=6', '-pix_fmt', 'yuv420p']);
/** Same shape as band(), a different colour — for stacking two bands to prove which one is on top. */
const bandWhite = () => source('band-white', ['-f', 'lavfi', '-i', 'color=c=white:s=640x160:r=30:d=6', '-pix_fmt', 'yuv420p']);
/** Left half green (keyable), right half blue. */
const keyable = () => source('keyable', [
  '-f', 'lavfi', '-i', 'color=c=0x00FF00:s=160x240:r=30:d=6',
  '-f', 'lavfi', '-i', 'color=c=blue:s=160x240:r=30:d=6',
  '-filter_complex', '[0:v][1:v]hstack[v]', '-map', '[v]', '-pix_fmt', 'yuv420p'
]);
const withSound = () => source('sound', [
  '-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x240:rate=30',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
  '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'
]);

/**
 * A solid 320x240 frame built from exact YUV bytes rather than an ffmpeg
 * colour source, so its Y/U/V is known precisely instead of trusted to
 * survive an RGB colour spec through a first encode untouched. Tagged with
 * real -colorspace/-color_primaries/-color_trc/-color_range flags — used to
 * prove ffmpeg reads its OWN decoded frame's tag with no help from
 * buildVideoClipChain, which never passes any of those flags itself.
 */
function taggedSolid(name, { y, u, v, tag }) {
  const key = `tagged-${name}`;
  if (!sources.has(key)) {
    const w = 320, h = 240, frames = 90;
    // rawvideo has no frame count of its own — the demuxer just reads
    // w*h*1.5-byte chunks until the file runs out — so the frame has to be
    // repeated on disk rather than asked for with -frames:v against a
    // single copy, or the "clip" is one real frame and 2.97s of nothing.
    const frame = Buffer.concat([
      Buffer.alloc(w * h, y),
      Buffer.alloc((w * h) / 4, u),
      Buffer.alloc((w * h) / 4, v)
    ]);
    const rawFile = path.join(DIR, `${name}.yuv`);
    fs.writeFileSync(rawFile, Buffer.concat(Array(frames).fill(frame)));
    const file = path.join(DIR, `${name}.mp4`);
    const r = spawnSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${w}x${h}`, '-r', '30', '-i', rawFile,
      '-pix_fmt', 'yuv420p',
      '-colorspace', tag, '-color_primaries', tag, '-color_trc', tag, '-color_range', 'tv',
      file
    ], { encoding: 'utf8' });
    assert.equal(r.status, 0, `fixture ${name} failed:\n${r.stderr}`);
    sources.set(key, file);
  }
  return sources.get(key);
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function project(clips, extra = {}) {
  return {
    name: 'render', width: 320, height: 240, fps: 30,
    captionsEnabled: false, captions: [],
    tracks: [
      { id: 'v1', kind: 'video', name: 'Video 1', clips: clips[0] || [] },
      { id: 'v2', kind: 'video', name: 'Video 2', clips: clips[1] || [] },
      { id: 'a1', kind: 'audio', name: 'Audio 1', clips: clips[2] || [] }
    ],
    ...extra
  };
}

function clip(src, o = {}) {
  return { src, inSec: 0, outSec: 3, startSec: 0, speed: 1, hasVideo: true, hasAudio: false, ...o };
}

/** Same shape as project(), with a third video track — for proving three video
 *  tracks (not just the fixed two every other test in this file uses) really
 *  do all reach a real ffmpeg command and composite in the right order. */
function project3(v1clips, v2clips, v3clips, extra = {}) {
  return {
    name: 'render3', width: 320, height: 240, fps: 30,
    captionsEnabled: false, captions: [],
    tracks: [
      { id: 'v1', kind: 'video', name: 'Video 1', clips: v1clips },
      { id: 'v2', kind: 'video', name: 'Video 2', clips: v2clips },
      { id: 'v3', kind: 'video', name: 'Video 3', clips: v3clips },
      { id: 'a1', kind: 'audio', name: 'Audio 1', clips: [] }
    ],
    ...extra
  };
}

/** Same shape as project(), with a second audio track — for proving two
 *  audio tracks (not just the fixed one every other test in this file uses)
 *  both really reach the mix, rather than trusting that a two-clips-on-one-
 *  track amix (already covered in ffmpeg-builder.test.js) generalises to a
 *  second track on its own. */
function project2audio(v1clips, a1clips, a2clips, extra = {}) {
  return {
    name: 'render2audio', width: 320, height: 240, fps: 30,
    captionsEnabled: false, captions: [],
    tracks: [
      { id: 'v1', kind: 'video', name: 'Video 1', clips: v1clips },
      { id: 'a1', kind: 'audio', name: 'Audio 1', clips: a1clips },
      { id: 'a2', kind: 'audio', name: 'Audio 2', clips: a2clips }
    ],
    ...extra
  };
}

/** Build the command for a project and actually run it. Returns the output path. */
function render(name, proj, buildOpts = {}) {
  const out = path.join(DIR, `${name}.mp4`);
  const { args, mode } = buildExportCommand(proj, out, { preset: 'ultrafast', ...buildOpts });
  assert.equal(mode, 'filter', 'these all exercise the filter graph');
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  assert.equal(r.status, 0,
    `ffmpeg rejected the graph:\n${r.stderr.split('\n').slice(-25).join('\n')}\n\n` +
    `filter_complex was:\n${args[args.indexOf('-filter_complex') + 1].split(';').join(';\n')}`);
  assert.ok(fs.existsSync(out) && fs.statSync(out).size > 0, 'no output file');
  return out;
}

function durationOf(file) {
  const r = spawnSync('ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { encoding: 'utf8' });
  return Number(r.stdout.trim());
}

/** The average colour of a w*h patch at (x,y) on the frame at time t. */
function pixel(file, t, x = 156, y = 116, w = 8, h = 8) {
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', file, '-ss', String(t), '-frames:v', '1',
    '-vf', `crop=${w}:${h}:${x}:${y},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'
  ], { encoding: 'buffer' });
  assert.equal(r.status, 0, 'pixel probe failed');
  return [r.stdout[0], r.stdout[1], r.stdout[2]];
}

const near = (actual, want, tol, msg) =>
  assert.ok(Math.abs(actual - want) <= tol, `${msg}: got ${actual}, wanted ${want}±${tol}`);

/**
 * Decode an exported file's audio to mono 16-bit PCM at a fixed rate, for
 * tests that need to look inside the mix rather than just trust that the
 * command said `amix`.
 */
function decodePcm(file, rate = 48000) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file,
    '-map', '0:a', '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', String(rate), '-'],
    { encoding: 'buffer', maxBuffer: 1 << 28 });
  assert.equal(r.status, 0, 'could not decode the exported audio');
  const n = r.stdout.length / 2;
  const samples = new Float64Array(n);
  for (let i = 0; i < n; i++) samples[i] = r.stdout.readInt16LE(i * 2);
  return samples;
}

/**
 * Goertzel algorithm: the magnitude of one specific frequency bin, without
 * computing a full FFT. Two sines mixed together (amix sums the waveforms)
 * cannot be told apart by ear or by amplitude alone — this is what tells
 * whether a *specific* frequency survived the mix, which is the only way to
 * prove two audio tracks both actually reached the output rather than one
 * silently winning or the other never being routed into the graph at all.
 * `freq` should land on an exact bin (`samples.length * freq / rate` an
 * integer) to avoid spectral leakage softening the reading.
 */
function goertzelMagnitude(samples, rate, freq) {
  const n = samples.length;
  const k = Math.round(n * freq / rate);
  const w = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(w);
  let q1 = 0, q2 = 0;
  for (let i = 0; i < n; i++) {
    const q0 = coeff * q1 - q2 + samples[i];
    q2 = q1;
    q1 = q0;
  }
  const real = q1 - q2 * Math.cos(w);
  const imag = q2 * Math.sin(w);
  return Math.sqrt(real * real + imag * imag) / n;
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

test('a same-track crossfade is a graph ffmpeg accepts, and is the right length', opts, () => {
  const out = render('basic', project([[
    clip(bars(), { startSec: 0 }),
    clip(bars(), { startSec: 2 })   // 1s overlap
  ]]));
  // 2 + 3 = 5s of timeline, not 6: the overlap is shared, not appended.
  near(durationOf(out), 5, 0.15, 'crossfade output duration');
});

test('a crossfade between two identical shots never dips', opts, () => {
  // This is the whole point. White dissolving into white must stay white.
  // The old two-tracks-of-alpha-fades approach fell to about 203/255 in the
  // middle, because both clips were fading towards the black canvas at once.
  const out = render('white-xfade', project([[
    clip(white(), { startSec: 0, fadeOut: 1 }),
    clip(white(), { startSec: 2, fadeIn: 1 })
  ]]));
  for (const t of [1.0, 2.25, 2.5, 2.75, 4.0]) {
    near(pixel(out, t)[0], 255, 6, `luminance at t=${t}`);
  }
});

test('the outer fades of a run still fade, only the inner ones are dropped', opts, () => {
  const out = render('outer-fades', project([[
    clip(white(), { startSec: 0, fadeIn: 1, fadeOut: 1 }),
    clip(white(), { startSec: 2, fadeIn: 1, fadeOut: 1 })
  ]]));
  // Fading up from the black canvas at the head...
  assert.ok(pixel(out, 0.1)[0] < 120, 'run should still fade in from black');
  // ...and back down to it at the tail. The run ends at 5s.
  assert.ok(pixel(out, 4.9)[0] < 120, 'run should still fade out to black');
  // ...but full brightness in between, including across the join.
  near(pixel(out, 2.5)[0], 255, 6, 'no dip at the join');
});

test('clips that disagree on size and frame rate still fold together', opts, () => {
  // 320x240@30 crossfading with 640x360@25, one of them scaled to half.
  // Every one of the properties xfade insists on is mismatched at the source.
  const out = render('mismatched', project([[
    clip(bars(), { startSec: 0 }),
    clip(odd(), { startSec: 2, scale: 0.5 })
  ]]));
  near(durationOf(out), 5, 0.15, 'mismatched-source crossfade duration');
});

test('a letterboxed clip keeps the canvas visible through the transition', opts, () => {
  // The pad that normalises geometry for xfade is transparent, so the bars
  // above and below a wide clip must still show the layer underneath rather
  // than becoming opaque black.
  const proj = project([
    [clip(band(), { startSec: 0 }), clip(band(), { startSec: 2 })],
    [clip(white(), { startSec: 0, outSec: 6 })]
  ]);
  // Track 1 is the run; put it on top of a white base so we can see through it.
  proj.tracks = [proj.tracks[1], proj.tracks[0], proj.tracks[2]];
  const out = render('letterbox', proj);
  // Top-left is outside the blue band, mid-transition.
  const [r, g, b] = pixel(out, 2.5, 0, 0);
  assert.ok(r > 200 && g > 200 && b > 200,
    `padding must stay transparent, saw rgb(${r},${g},${b})`);
  // Centre is still the blue band.
  const centre = pixel(out, 2.5);
  assert.ok(centre[2] > 150 && centre[0] < 90, `centre should be blue, saw ${centre}`);
});

test('a chroma key survives being folded into a run', opts, () => {
  const proj = project([
    [clip(white(), { startSec: 0, outSec: 6 })],
    [
      clip(keyable(), { startSec: 0, chroma: { on: true, color: '#00FF00', similarity: 0.3, blend: 0.1 } }),
      clip(keyable(), { startSec: 2, chroma: { on: true, color: '#00FF00', similarity: 0.3, blend: 0.1 } })
    ]
  ]);
  const out = render('keyed-run', proj);
  // Left half was green and is keyed out, so the white base shows through,
  // even in the middle of the transition.
  const left = pixel(out, 2.5, 40, 116);
  assert.ok(left[0] > 190 && left[1] > 190 && left[2] > 190,
    `keyed area should show the layer below, saw rgb(${left})`);
  // Right half was blue and is still blue.
  const right = pixel(out, 2.5, 240, 116);
  assert.ok(right[2] > 140 && right[0] < 110, `unkeyed area should stay blue, saw ${right}`);
});

test('per-clip posX survives a run, because the nudge rides in the pad', opts, () => {
  // Two clips in one run with different nudges: one overlay serves both, so
  // the offsets have to be baked into each clip's own padding.
  const out = render('nudged', project([[
    clip(band(), { startSec: 0, posY: -60 }),
    clip(band(), { startSec: 2, posY: 60 })
  ]]));
  // First clip only: the band sits above centre, so above-centre is blue and
  // below-centre is the black canvas.
  const above = pixel(out, 1.0, 156, 60);
  const below = pixel(out, 1.0, 156, 180);
  assert.ok(above[2] > 140, `nudged-up band should be above centre, saw ${above}`);
  assert.ok(below[2] < 70, `below centre should be empty canvas, saw ${below}`);
  // Last clip only: the nudge is the other way round.
  const late = pixel(out, 4.5, 156, 180);
  assert.ok(late[2] > 140, `nudged-down band should be below centre, saw ${late}`);
});

test('three overlapping clips fold twice into one stream', opts, () => {
  const out = render('three', project([[
    clip(bars(), { startSec: 0 }),
    clip(white(), { startSec: 2 }),
    clip(bars(), { startSec: 4 })
  ]]));
  near(durationOf(out), 7, 0.15, 'three-clip run duration');
});

test('a speed change inside a run still folds at the right place', opts, () => {
  // The clip is 3s of source at 2x, so 1.5s of timeline. Starting at 2 it runs
  // to 3.5, overlapping the first clip by 1s.
  const out = render('sped', project([[
    clip(bars(), { startSec: 0 }),
    clip(white(), { startSec: 2, speed: 2 })
  ]]));
  near(durationOf(out), 3.5, 0.15, 'sped-up crossfade duration');
});

test('a run composites with layering, audio and burnt-in captions all at once', opts, () => {
  const assPath = path.join(DIR, 'caps.ass');
  fs.writeFileSync(assPath, require('../shared/ffmpeg-builder').buildAssFile({
    width: 320, height: 240,
    captionStyle: { font: 'Arial', size: 20, color: '#FFFFFF' },
    captions: [{ start: 0, end: 4, text: 'hello' }]
  }));

  const proj = project([
    [
      clip(withSound(), { startSec: 0, hasAudio: true }),
      clip(withSound(), { startSec: 2, hasAudio: true })
    ],
    [clip(band(), { startSec: 1, outSec: 2 })],       // layering, must stay an overlay
    [clip(withSound(), { startSec: 0, hasAudio: true, hasVideo: false })]
  ], { captionsEnabled: true, captions: [{ start: 0, end: 4, text: 'hello' }] });

  const out = render('everything', proj, { assPath });
  near(durationOf(out), 5, 0.2, 'combined project duration');

  const streams = spawnSync('ffprobe',
    ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', out],
    { encoding: 'utf8' }).stdout.trim().split('\n').sort();
  assert.deepEqual(streams, ['audio', 'video'], 'both streams should survive');
});

test('three video tracks all composite in one export, the newest on top', opts, () => {
  // Not a run — three separate, non-crossfading video tracks, which is the
  // shape "more than two video tracks" actually takes for most projects.
  // v1 is a full-canvas base; v2 and v3 are band-shaped clips placed at the
  // exact same spot, so if the newest track (v3) did not land above v2 the
  // way Video 2 always composited over Video 1, the centre sample below
  // would come back blue instead of white.
  const proj = project3(
    [clip(red(), { startSec: 0, outSec: 3 })],
    [clip(band(), { startSec: 0, outSec: 3 })],       // blue band, dead centre
    [clip(bandWhite(), { startSec: 0, outSec: 3 })]   // white band, same spot, on top
  );
  const out = render('three-video-tracks', proj);

  // Dead centre: covered by both bands. The topmost track (v3, white) must win.
  const centre = pixel(out, 1.5);
  assert.ok(centre[0] > 220 && centre[1] > 220 && centre[2] > 220,
    `centre should show v3's white on top of v2's blue, saw rgb(${centre})`);

  // Above the bands: neither v2 nor v3 reaches here, so v1's red base shows through.
  const above = pixel(out, 1.5, 156, 20);
  assert.ok(above[0] > 180 && above[1] < 90 && above[2] < 90,
    `uncovered area should fall through to v1's red base, saw rgb(${above})`);
});

test('real per-word karaoke timing sweeps through libass, not just through the builder', opts, () => {
  // ffmpeg-builder.test.js proves the \k values are computed correctly. It
  // cannot prove libass actually reveals PrimaryColour word-by-word on that
  // schedule rather than, say, all at once or not at all — subtitles
  // rendering is exactly the kind of thing that reads right and renders
  // wrong. So this burns a real two-word karaoke line onto a black canvas
  // with maximally distinct, fully-opaque colours and samples a pixel inside
  // each word's glyphs before and after its \k window closes.
  const assPath = path.join(DIR, 'karaoke.ass');
  fs.writeFileSync(assPath, require('../shared/ffmpeg-builder').buildAssFile({
    width: 320, height: 240,
    captionStyle: {
      font: 'Arial', size: 120, position: 'middle', animation: 'typewriter',
      color: '#FF0000', secondaryColor: '#0000FF'
    },
    captions: [{
      start: 0, end: 2, text: 'A B',
      words: [{ start: 0, end: 1, text: 'A' }, { start: 1, end: 2, text: 'B' }]
    }]
  }));

  // No visible clip is needed — the point is the caption over plain black —
  // but projectDuration only looks at clips, so an inaudible, invisible dummy
  // clip on the audio track is what actually gives the project the 2.5s of
  // length the karaoke line needs; it never reaches the video graph at all.
  const proj = project([[], [], [clip(bars(), { startSec: 0, outSec: 2.5, hasAudio: false })]],
    { captionsEnabled: true, captions: [{ start: 0, end: 2, text: 'A B' }] });
  const out = render('karaoke', proj, { assPath });

  // x=120 sits inside "A", x=185 inside "B" — found by rendering this exact
  // line and reading back where its glyphs actually landed, not guessed. The
  // crop is taller than it is wide because both letters have gaps between
  // strokes at some heights (the crossbar of the "A", the bowl of the "B"),
  // and a wider-than-tall sample risked crossing into the space between the
  // two words instead of staying inside one of them.
  const wordA = (t) => pixel(out, t, 120, 110, 6, 20);
  const wordB = (t) => pixel(out, t, 185, 110, 6, 20);

  // t=0.3: "A"'s \k (0 -> 1s) is running, "B"'s has not started.
  const [ar0, , ab0] = wordA(0.3);
  const [br0, , bb0] = wordB(0.3);
  assert.ok(ar0 > 200 && ab0 < 60, `"A" should already be sung (red) at t=0.3, saw rgb(${wordA(0.3)})`);
  assert.ok(bb0 > 200 && br0 < 60, `"B" should still be unsung (blue) at t=0.3, saw rgb(${wordB(0.3)})`);

  // t=1.3: "B"'s \k (1s -> 2s) has now run too, and karaoke never un-sings a
  // word, so "A" is still red.
  const [ar1] = wordA(1.3);
  const [br1, , bb1] = wordB(1.3);
  assert.ok(ar1 > 200, `"A" should stay sung (red) at t=1.3, saw rgb(${wordA(1.3)})`);
  assert.ok(br1 > 200 && bb1 < 60, `"B" should now be sung (red) at t=1.3, saw rgb(${wordB(1.3)})`);
});

test('a run that does not start at zero folds at the right offset', opts, () => {
  // The fold offset and the clip's timeline position are the same number
  // whenever a run starts at zero, so only a run that starts elsewhere can
  // tell them apart. Here the offset into the fold is 2 and the timeline
  // position is 7; using the latter asks xfade to transition past the end of
  // its first input, and ffmpeg refuses the graph outright.
  const out = render('offset', project([[
    clip(bars(), { startSec: 5 }),
    clip(white(), { startSec: 7 })
  ]]));
  // 5s of leading black canvas, then the run through to 10.
  near(durationOf(out), 10, 0.15, 'shifted run duration');
  assert.ok(pixel(out, 2.0)[0] < 40, 'nothing on screen before the run starts');
  near(pixel(out, 9.5)[0], 255, 8, 'the run ends on the white clip');
});

test('a clip swallowed by its neighbour renders where it was put', opts, () => {
  // Not a transition: it stays an overlay, on top, at its own position.
  const out = render('swallowed', project([[
    clip(bars(), { startSec: 0, outSec: 6 }),
    clip(white(), { startSec: 2, outSec: 1 })
  ]]));
  near(durationOf(out), 6, 0.15, 'swallowed clip must not extend the project');
  near(pixel(out, 2.5)[0], 255, 8, 'the buried clip shows at 2..3, not at the end');
  assert.ok(pixel(out, 5.5)[0] < 240, 'and is gone by the end');
});

test('previewSeconds still cuts a crossfading project short', opts, () => {
  const out = render('preview', project([[
    clip(bars(), { startSec: 0 }),
    clip(bars(), { startSec: 2 })
  ]]), { previewSeconds: 2 });
  near(durationOf(out), 2, 0.15, 'preview duration');
});

test('abutting clips, which take no xfade at all, still render', opts, () => {
  // The untouched path. Worth executing so a change to the run grouping that
  // accidentally folds these shows up here rather than in someone's export.
  const out = render('abutting', project([[
    clip(bars(), { startSec: 0 }),
    clip(white(), { startSec: 3 })
  ]]));
  near(durationOf(out), 6, 0.15, 'abutting clips are appended, not overlapped');
});

// --------------------------------------------------------------------------
// Transition type: every curated name has to be a graph real ffmpeg accepts,
// not just a string ffmpeg-builder.test.js is happy with. xfade's own docs
// are not trusted here either — each one is run for real and its pixels
// inspected, the same standard the plain `fade` crossfade above is held to.
// --------------------------------------------------------------------------

test('every curated transition type is a graph real ffmpeg accepts', opts, () => {
  for (const t of TRANSITION_TYPES) {
    const out = render(`xf-${t}`, project([[
      clip(bars(), { startSec: 0 }),
      clip(white(), { startSec: 2, transitionType: t })
    ]]));
    near(durationOf(out), 5, 0.15, `${t}: crossfade output duration`);
  }
});

test('an unrecognised transitionType still renders, falling back to fade', opts, () => {
  const out = render('xf-unknown', project([[
    clip(bars(), { startSec: 0 }),
    clip(white(), { startSec: 2, transitionType: 'not-a-real-transition' })
  ]]));
  near(durationOf(out), 5, 0.15, 'fallback crossfade duration');
});

test('wipeleft sweeps the incoming clip in from the right, closing on the left', opts, () => {
  // "left" names the direction the wipe boundary travels, not which side
  // changes first — the boundary moves leftward, so the right side of the
  // frame turns over to the incoming clip before the left side does.
  const out = render('wipeleft', project([[
    clip(red(), { startSec: 0, outSec: 3 }),
    clip(solidBlue(), { startSec: 2, outSec: 3, transitionType: 'wipeleft' })
  ]]));
  // Mid-transition (t=2.5, halfway through the 1s overlap): right has already
  // turned over to blue, left is still red.
  const left = pixel(out, 2.5, 40, 116);
  const right = pixel(out, 2.5, 280, 116);
  assert.ok(left[0] > 200 && left[2] < 60, `left should still be red mid-wipe, saw ${left}`);
  assert.ok(right[2] > 200 && right[0] < 60, `right should already be blue mid-wipe, saw ${right}`);
});

test('circleopen reveals the incoming clip from the centre outward', opts, () => {
  const out = render('circleopen', project([[
    clip(red(), { startSec: 0, outSec: 3 }),
    clip(solidBlue(), { startSec: 2, outSec: 3, transitionType: 'circleopen' })
  ]]));
  // Mid-transition: the centre has opened to blue, a corner has not.
  const centre = pixel(out, 2.5, 156, 116);
  const corner = pixel(out, 2.5, 4, 4);
  assert.ok(centre[2] > 200 && centre[0] < 60, `centre should already be blue, saw ${centre}`);
  assert.ok(corner[0] > 200 && corner[2] < 60, `corner should still be red, saw ${corner}`);
});

test('fadeblack dips through black on its way from one clip to the next', opts, () => {
  const out = render('fadeblack', project([[
    clip(red(), { startSec: 0, outSec: 3 }),
    clip(solidBlue(), { startSec: 2, outSec: 3, transitionType: 'fadeblack' })
  ]]));
  // The 1s overlap runs from t=2 to t=3. fadeblack is not symmetric — it dips
  // to true black about a fifth of the way through, not at the midpoint —
  // confirmed against this exact ffmpeg build rather than assumed.
  const [r, g, b] = pixel(out, 2.2);
  assert.ok(r < 20 && g < 20 && b < 20, `should be near-black just after the halfway mark, saw rgb(${r},${g},${b})`);
});

test('dissolve ends on the incoming clip, same as every other transition', opts, () => {
  const out = render('dissolve', project([[
    clip(red(), { startSec: 0, outSec: 3 }),
    clip(solidBlue(), { startSec: 2, outSec: 3, transitionType: 'dissolve' })
  ]]));
  near(durationOf(out), 5, 0.15, 'dissolve crossfade duration');
  near(pixel(out, 4.5)[2], 255, 8, 'should have settled on the incoming blue clip');
});

// --------------------------------------------------------------------------
// Colour tags: does the export need to know about them itself?
// --------------------------------------------------------------------------

/*
 * chroma-math.js has to guess the source's YUV matrix, because a browser
 * hands the preview RGB with no tag attached. The export never has that
 * problem — it stays in ffmpeg's own decode the whole way — but does
 * `buildVideoClipChain` need to pass a matrix along anyway for despill (the
 * one filter in the chain that briefly leaves YUV) to get it right?
 *
 * These two fixtures are the exact same YUV bytes, tagged two different real
 * ways. Nothing in the builder passes -colorspace, -color_primaries or
 * -color_trc — so if despill's output still comes out correct for each tag,
 * that is swscale reading the decoded frame's own colour metadata on its
 * own, and the builder needs no change. Expected values below were computed
 * independently, from chroma-math.js's own yuvToRgb + despillGreen, not
 * copied from a prior run of this test.
 */
test('despill reads the source\'s real colour tag on its own; the builder passes it nothing', opts, () => {
  const chroma = { on: true, color: '#00FF00', similarity: 0.1, blend: 0.05 };
  const src709 = taggedSolid('src709', { y: 150, u: 97, v: 96, tag: 'bt709' });
  const src601 = taggedSolid('src601', { y: 150, u: 97, v: 96, tag: 'smpte170m' });

  const out709 = render('tag709', project([[clip(src709, { chroma })]]));
  const out601 = render('tag601', project([[clip(src601, { chroma })]]));

  const [r709, g709, b709] = pixel(out709, 0.5);
  const [r601, g601, b601] = pixel(out601, 0.5);

  // Y150/U97/V96 read as bt709 is true rgb(99,180,91); despill (mix=0.5) pulls
  // green's excess over the red/blue average back out, landing near (99,95,91).
  near(r709, 99, 8, 'bt709: red is untouched by despill');
  near(g709, 95, 8, 'bt709: green is despilled down from ~180');
  near(b709, 91, 8, 'bt709: blue is untouched by despill');

  // The identical bytes read as bt601 are a different true colour, rgb(105,
  // 194, 93); despilled that lands near (105, 99, 93) — visibly different
  // from the bt709 render above, from the tag alone.
  near(r601, 105, 8, 'bt601: red is untouched by despill');
  near(g601, 99, 8, 'bt601: green is despilled down from ~194');
  near(b601, 93, 8, 'bt601: blue is untouched by despill');

  assert.ok(Math.abs(g709 - g601) > 3,
    `identical bytes under different tags should despill to visibly different green, saw ${g709} vs ${g601}`);
});

// --------------------------------------------------------------------------
// Caption text that libass would otherwise read as markup
// --------------------------------------------------------------------------

/** Lit pixels on the frame at t. Text that is on screen puts ink on it. */
function inkCount(file, t) {
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', file, '-ss', String(t), '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-'
  ], { encoding: 'buffer', maxBuffer: 1 << 26 });
  assert.equal(r.status, 0, 'ink probe failed');
  let lit = 0;
  for (const b of r.stdout) if (b > 100) lit++;
  return lit;
}

/** Burn one caption line over black through the real builder and ffmpeg. */
function captionRender(name, text) {
  const assPath = path.join(DIR, `${name}.ass`);
  fs.writeFileSync(assPath, require('../shared/ffmpeg-builder').buildAssFile({
    width: 320, height: 240,
    captionStyle: { font: 'Arial', size: 40, position: 'middle', color: '#FFFFFF' },
    captions: [{ start: 0, end: 3, text }]
  }));
  // As in the karaoke test: the caption is the subject, so the only clip is an
  // inaudible one on the audio track, there to give the project a length.
  const proj = project([[], [], [clip(bars(), { startSec: 0, outSec: 2.5, hasAudio: false })]],
    { captionsEnabled: true, captions: [{ start: 0, end: 3, text }] });
  return render(name, proj, { assPath });
}

test('a caption containing braces reaches the screen instead of being deleted', opts, () => {
  // libass reads `{` as the start of an override block and drops everything up
  // to the matching `}`, so `costs {50} today` burned in as `costs  today` —
  // no error, no warning, just missing words.
  //
  // Asserting the line is merely "visible" would have passed on the broken
  // output too, since most of it always rendered. What separates them is that
  // the broken render was pixel-for-pixel the same as the line with the braces
  // and their contents removed, so that is what this compares against.
  const braced = captionRender('braced', 'costs {50} today');
  const gutted = captionRender('gutted', 'costs  today');

  const withBraces = inkCount(braced, 1);
  const without = inkCount(gutted, 1);
  assert.ok(withBraces > without + 200,
    `"costs {50} today" should carry visibly more ink than "costs  today": ` +
    `got ${withBraces} vs ${without}`);

  // And a line that is nothing but braces used to render as an empty frame.
  assert.ok(inkCount(captionRender('all-braces', '{50}'), 1) > 200,
    'a caption of "{50}" should not be a blank screen');
});

test('a backslash in a caption does not silently wrap the line', opts, () => {
  // \N and \n are line breaks to libass and \h is a hard space, so `C:\Notes`
  // came out as two lines. One line of 40px text is nowhere near as tall as
  // two, which is what this measures.
  const out = captionRender('backslash', 'C:\\Notes');
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', out, '-ss', '1', '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-'
  ], { encoding: 'buffer', maxBuffer: 1 << 26 });
  assert.equal(r.status, 0);
  let minY = Infinity, maxY = -1;
  for (let i = 0; i < r.stdout.length; i++) {
    if (r.stdout[i] > 100) { const y = Math.floor(i / 320); if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  assert.ok(maxY >= 0, 'the caption rendered at all');
  assert.ok(maxY - minY < 40,
    `"C:\\Notes" should be one line of 40px text, but its ink spans ${maxY - minY}px`);
});

// --------------------------------------------------------------------------
// The copy path
// --------------------------------------------------------------------------

test('previewSeconds on the copy path really is three seconds of ffmpeg output', opts, () => {
  // The builder writes -ss and -to as INPUT options, and an input-side -to is
  // a position in the source rather than a length measured from -ss. The whole
  // clamp depends on that reading, so it is checked here against a real ffmpeg
  // instead of against the documentation: this clip starts at 4s, and the
  // other reading would write `-to 3` — a stop point before the start, which
  // renders nothing at all.
  //
  // -g 10 puts a keyframe every third of a second. Stream copy can only start
  // at a keyframe, and -avoid_negative_ts make_zero keeps everything from the
  // one before the seek point, so on a source with a sparse GOP the output
  // runs longer than asked whatever -to says. That is stream copy's nature
  // rather than something the builder can fix; a dense GOP here keeps this
  // test measuring the clamp instead of measuring keyframe luck.
  const src = source('ten', ['-f', 'lavfi', '-i',
    'testsrc=duration=10:size=320x240:rate=30', '-g', '10', '-pix_fmt', 'yuv420p']);

  // One video track, so the project qualifies for the copy path at all.
  const proj = {
    name: 'copy', width: 320, height: 240, fps: 30, captionsEnabled: false, captions: [],
    tracks: [
      { id: 'v1', kind: 'video', name: 'Video 1', clips: [clip(src, { inSec: 4, outSec: 10 })] },
      { id: 'a1', kind: 'audio', name: 'Audio 1', clips: [] }
    ]
  };

  const out = path.join(DIR, 'copy-preview.mp4');
  const { args, mode, duration } = buildExportCommand(proj, out, { previewSeconds: 3 });
  assert.equal(mode, 'copy', 'this has to be the copy path to be testing anything');
  assert.equal(duration, 3);
  assert.equal(args[args.indexOf('-to') + 1], '7.0000', 'inSec + 3, in the source timeline');

  const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  assert.equal(r.status, 0, `ffmpeg refused the copy command:\n${r.stderr.split('\n').slice(-15).join('\n')}`);
  // Stream copy can only cut on the frames it is given, so the tolerance is
  // wider than an encode's would be — but nowhere near the six seconds the
  // whole clip would have been.
  near(durationOf(out), 3, 0.3, 'a three-second test render');
});

// --------------------------------------------------------------------------
// Multi-channel audio
// --------------------------------------------------------------------------

test('adelay moves every channel of a 5.1 source, not just the front pair', opts, () => {
  // adelay leaves any channel its delay list does not name completely alone,
  // so `adelay=1000|1000` moved FL and FR and left the centre, LFE and both
  // surrounds sitting at zero — a full second of desync on exactly the
  // material that would notice.
  //
  // Each channel carries a short burst at the top of the file and silence
  // afterwards, so "where does this channel start" is measurable. The LFE tone
  // is 60Hz because the encoder band-limits that channel and a 500Hz tone in
  // it does not survive to be measured.
  const freqs = [440, 460, 480, 60, 520, 540];
  const src = source('surround51', [
    '-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=30',
    ...freqs.flatMap(f => ['-f', 'lavfi', '-i', `sine=frequency=${f}:duration=0.5,apad=whole_dur=4`]),
    '-filter_complex', '[1:a][2:a][3:a][4:a][5:a][6:a]join=inputs=6:channel_layout=5.1[a]',
    '-map', '0:v', '-map', '[a]', '-pix_fmt', 'yuv420p', '-c:a', 'aac'
  ]);

  const proj = project([[], [], [
    clip(src, { startSec: 1, inSec: 0, outSec: 3, hasVideo: false, hasAudio: true })
  ]]);
  const out = render('surround-delay', proj);

  // The layout has to survive the graph, or the channel indices below mean
  // nothing.
  const layout = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=channels', '-of', 'csv=p=0', out], { encoding: 'utf8' }).stdout.trim();
  assert.equal(layout, '6', 'the export should still be 5.1');

  const raw = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', out,
    '-map', '0:a', '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '6', '-ar', '48000', '-'],
    { encoding: 'buffer', maxBuffer: 1 << 28 });
  assert.equal(raw.status, 0, 'could not decode the exported audio');

  const CH = 6, RATE = 48000;
  const onset = new Array(CH).fill(null);
  for (let f = 0; f < raw.stdout.length / 2 / CH; f++) {
    for (let c = 0; c < CH; c++) {
      if (onset[c] === null && Math.abs(raw.stdout.readInt16LE((f * CH + c) * 2)) > 800) {
        onset[c] = f / RATE;
      }
    }
  }

  const NAMES = ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR'];
  onset.forEach((t, c) => {
    assert.ok(t !== null, `${NAMES[c]} carried no sound at all`);
    // The old two-entry list left the last four of these at 0.
    near(t, 1, 0.15, `${NAMES[c]} should start one second in`);
  });
});

// --------------------------------------------------------------------------
// Multiple audio tracks
// --------------------------------------------------------------------------

test('two audio tracks both survive amix — each track\'s own tone is present in the output', opts, () => {
  // ffmpeg-builder.test.js proves the filter graph names amix=inputs=2 for
  // clips split across two tracks. It cannot prove ffmpeg actually mixes
  // both into audible sound rather than, say, one track silently winning
  // because of a routing mistake elsewhere in the graph — so this renders a
  // real project with a 440Hz tone on Audio 1 and an 880Hz tone on Audio 2,
  // both for the full two seconds, and looks for each frequency independently
  // in the decoded output via Goertzel (see its own comment above). Plain
  // amplitude cannot distinguish "both tones present" from "one tone at
  // double the volume" — only reading the specific frequency bins can.
  const RATE = 48000;
  const tone440 = () => source('tone440', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'aac']);
  const tone880 = () => source('tone880', ['-f', 'lavfi', '-i', 'sine=frequency=880:duration=2', '-c:a', 'aac']);

  const proj = project2audio(
    [], // no video clip — an empty video track composites as plain black, same as the karaoke test above
    [clip(tone440(), { startSec: 0, outSec: 2, hasVideo: false, hasAudio: true })],
    [clip(tone880(), { startSec: 0, outSec: 2, hasVideo: false, hasAudio: true })]
  );
  const out = render('two-audio-tracks', proj);

  const samples = decodePcm(out, RATE);
  // 2 seconds at 48000Hz = 96000 samples; 440 and 880 both divide it exactly
  // (bins 880 and 1760), so neither reading is softened by spectral leakage.
  const mag440 = goertzelMagnitude(samples, RATE, 440);
  const mag880 = goertzelMagnitude(samples, RATE, 880);
  // A frequency neither track carries, still on an exact bin, as the floor
  // this test should be measuring against rather than an arbitrary constant.
  const magSilent = goertzelMagnitude(samples, RATE, 660);

  assert.ok(mag440 > magSilent * 5, `Audio 1's 440Hz tone should stand out from the noise floor: ${mag440} vs ${magSilent}`);
  assert.ok(mag880 > magSilent * 5, `Audio 2's 880Hz tone should stand out from the noise floor: ${mag880} vs ${magSilent}`);
});
