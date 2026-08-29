'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildExportCommand,
  buildAssFile,
  parseSubtitles,
  clipTimelineDuration,
  clipTimelineEnd,
  projectDuration,
  canStreamCopy,
  atempoChain
} = require('../shared/ffmpeg-builder');

function baseProject(overrides = {}) {
  return {
    name: 'test',
    width: 1080,
    height: 1920,
    fps: 30,
    captionsEnabled: false,
    captions: [],
    tracks: [
      { id: 'v1', kind: 'video', name: 'Video 1', clips: [] },
      { id: 'v2', kind: 'video', name: 'Video 2', clips: [] },
      { id: 'a1', kind: 'audio', name: 'Audio 1', clips: [] }
    ],
    ...overrides
  };
}

function makeClip(overrides = {}) {
  return {
    src: '/tmp/clip.mp4',
    inSec: 0,
    outSec: 10,
    startSec: 0,
    speed: 1,
    hasAudio: true,
    hasVideo: true,
    ...overrides
  };
}

test('clipTimelineDuration accounts for speed', () => {
  assert.equal(clipTimelineDuration(makeClip({ inSec: 0, outSec: 10, speed: 1 })), 10);
  assert.equal(clipTimelineDuration(makeClip({ inSec: 0, outSec: 10, speed: 2 })), 5);
});

test('clipTimelineEnd offsets by startSec', () => {
  const clip = makeClip({ inSec: 2, outSec: 6, startSec: 3, speed: 1 });
  assert.equal(clipTimelineEnd(clip), 3 + 4);
});

test('projectDuration is the max clip end across all tracks, with a floor', () => {
  const project = baseProject();
  assert.equal(projectDuration(project), 0.04);

  project.tracks[0].clips.push(makeClip({ startSec: 0, inSec: 0, outSec: 5 }));
  project.tracks[1].clips.push(makeClip({ startSec: 10, inSec: 0, outSec: 2 }));
  assert.equal(projectDuration(project), 12);
});

test('atempoChain leaves normal speed untouched', () => {
  assert.deepEqual(atempoChain(1), []);
});

test('atempoChain splits extreme speeds into 0.5-2.0 steps', () => {
  assert.deepEqual(atempoChain(4), ['atempo=2.0', 'atempo=2.000000']);
  assert.deepEqual(atempoChain(0.25), ['atempo=0.5', 'atempo=0.500000']);
});

function singleVideoTrackProject(overrides = {}) {
  return baseProject({
    tracks: [
      { id: 'v1', kind: 'video', name: 'Video 1', clips: [] },
      { id: 'a1', kind: 'audio', name: 'Audio 1', clips: [] }
    ],
    ...overrides
  });
}

test('canStreamCopy accepts the single boring clip case', () => {
  const project = singleVideoTrackProject();
  project.tracks[0].clips.push(makeClip());
  assert.equal(canStreamCopy(project), true);
});

test('canStreamCopy rejects a second video track, a second clip, speed change, or chroma key', () => {
  assert.equal(canStreamCopy(baseProject()), false); // two video tracks (v1 + v2)

  const twoClips = singleVideoTrackProject();
  twoClips.tracks[0].clips.push(makeClip(), makeClip({ startSec: 10 }));
  assert.equal(canStreamCopy(twoClips), false);

  const sped = singleVideoTrackProject();
  sped.tracks[0].clips.push(makeClip({ speed: 2 }));
  assert.equal(canStreamCopy(sped), false);

  const keyed = singleVideoTrackProject();
  keyed.tracks[0].clips.push(makeClip({ chroma: { on: true } }));
  assert.equal(canStreamCopy(keyed), false);
});

test('buildExportCommand takes the copy fast path for a boring project', () => {
  const project = singleVideoTrackProject();
  project.tracks[0].clips.push(makeClip({ inSec: 1, outSec: 6 }));
  const { args, mode, duration } = buildExportCommand(project, 'out.mp4');
  assert.equal(mode, 'copy');
  assert.equal(duration, 5);
  assert.ok(args.includes('-c'));
  assert.ok(args.includes('copy'));
  assert.equal(args[args.length - 1], 'out.mp4');
});

test('buildExportCommand builds a filter graph when anything is non-trivial', () => {
  const project = baseProject();
  project.tracks[0].clips.push(makeClip({ speed: 2 }));
  const { args, mode } = buildExportCommand(project, 'out.mp4');
  assert.equal(mode, 'filter');
  assert.ok(args.includes('-filter_complex'));
  const filterIdx = args.indexOf('-filter_complex');
  assert.match(args[filterIdx + 1], /setpts=\(PTS-STARTPTS\)\/2/);
});

test('buildExportCommand mixes multiple audio clips, single clip skips amix', () => {
  const single = baseProject();
  single.tracks[0].clips.push(makeClip({ speed: 2, hasAudio: false }));
  single.tracks[2].clips.push(makeClip({ src: '/tmp/a.mp3', hasVideo: false }));
  const { args: singleArgs } = buildExportCommand(single, 'out.mp4');
  const singleFilters = singleArgs[singleArgs.indexOf('-filter_complex') + 1];
  assert.ok(!singleFilters.includes('amix'));

  const multi = baseProject();
  multi.tracks[0].clips.push(makeClip({ speed: 2, hasAudio: false }));
  multi.tracks[2].clips.push(
    makeClip({ src: '/tmp/a.mp3', hasVideo: false }),
    makeClip({ src: '/tmp/b.mp3', hasVideo: false, startSec: 5 })
  );
  const { args: multiArgs } = buildExportCommand(multi, 'out.mp4');
  const multiFilters = multiArgs[multiArgs.indexOf('-filter_complex') + 1];
  assert.ok(multiFilters.includes('amix=inputs=2'));
});

test('parseSubtitles reads SRT timestamps and text', () => {
  const srt = [
    '1',
    '00:00:01,000 --> 00:00:02,500',
    'Hello there',
    '',
    '2',
    '00:00:03,000 --> 00:00:04,000',
    'Second line'
  ].join('\n');

  const captions = parseSubtitles(srt);
  assert.equal(captions.length, 2);
  assert.equal(captions[0].start, 1);
  assert.equal(captions[0].end, 2.5);
  assert.equal(captions[0].text, 'Hello there');
  assert.equal(captions[1].text, 'Second line');
});

test('parseSubtitles reads WEBVTT timestamps', () => {
  const vtt = [
    'WEBVTT',
    '',
    '00:00:00.500 --> 00:00:01.500',
    'Hi'
  ].join('\n');

  const captions = parseSubtitles(vtt);
  assert.equal(captions.length, 1);
  assert.equal(captions[0].start, 0.5);
  assert.equal(captions[0].text, 'Hi');
});

test('buildAssFile embeds project dimensions and caption text', () => {
  const project = baseProject({
    captions: [{ start: 0, end: 1, text: 'line one' }],
    captionStyle: { font: 'Arial', size: 54, color: '#FFFFFF' }
  });
  const ass = buildAssFile(project);
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /PlayResY: 1920/);
  assert.match(ass, /line one/);
});
