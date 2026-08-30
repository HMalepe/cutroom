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

const { buildExportCommand } = require('../shared/ffmpeg-builder');

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
/** Deliberately a different size and frame rate, to exercise the agreement rules. */
const odd = () => source('odd', ['-f', 'lavfi', '-i', 'testsrc=duration=6:size=640x360:rate=25', '-pix_fmt', 'yuv420p']);
/** Short and wide, so scaling into a 4:3 canvas leaves transparent bars. */
const band = () => source('band', ['-f', 'lavfi', '-i', 'color=c=blue:s=640x160:r=30:d=6', '-pix_fmt', 'yuv420p']);
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

/** The average colour of an 8x8 patch at (x,y) on the frame at time t. */
function pixel(file, t, x = 156, y = 116) {
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', file, '-ss', String(t), '-frames:v', '1',
    '-vf', `crop=8:8:${x}:${y},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'
  ], { encoding: 'buffer' });
  assert.equal(r.status, 0, 'pixel probe failed');
  return [r.stdout[0], r.stdout[1], r.stdout[2]];
}

const near = (actual, want, tol, msg) =>
  assert.ok(Math.abs(actual - want) <= tol, `${msg}: got ${actual}, wanted ${want}±${tol}`);

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
