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
  atempoChain,
  groupTrackRuns
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

// --------------------------------------------------------------------------
// Crossfade runs
//
// The rule under test: clips that overlap ON THE SAME TRACK are a transition
// and get folded with xfade. Everything else — abutting clips, gaps, and
// overlaps across two tracks — stays on the overlay path it was always on.
// --------------------------------------------------------------------------

/** The -filter_complex string for a project, which is where all of this lives. */
function graphOf(project, opts = {}) {
  const { args } = buildExportCommand(project, 'out.mp4', opts);
  return args[args.indexOf('-filter_complex') + 1];
}

function overlapProject(gap, extra = {}) {
  const project = baseProject();
  project.tracks[0].clips.push(
    makeClip({ src: '/tmp/a.mp4', inSec: 0, outSec: 4, startSec: 0, ...extra }),
    makeClip({ src: '/tmp/b.mp4', inSec: 0, outSec: 4, startSec: 4 - gap, ...extra })
  );
  return project;
}

test('groupTrackRuns keeps abutting clips apart', () => {
  const runs = groupTrackRuns([
    makeClip({ inSec: 0, outSec: 4, startSec: 0 }),
    makeClip({ inSec: 0, outSec: 4, startSec: 4 })
  ], 1 / 30);
  assert.deepEqual(runs.map(r => r.length), [1, 1]);
});

test('groupTrackRuns keeps clips with a gap apart', () => {
  const runs = groupTrackRuns([
    makeClip({ inSec: 0, outSec: 4, startSec: 0 }),
    makeClip({ inSec: 0, outSec: 4, startSec: 10 })
  ], 1 / 30);
  assert.deepEqual(runs.map(r => r.length), [1, 1]);
});

test('groupTrackRuns joins overlapping clips into one run', () => {
  const runs = groupTrackRuns([
    makeClip({ inSec: 0, outSec: 4, startSec: 0 }),
    makeClip({ inSec: 0, outSec: 4, startSec: 3 }),
    makeClip({ inSec: 0, outSec: 4, startSec: 6 })
  ], 1 / 30);
  assert.deepEqual(runs.map(r => r.length), [3]);
});

test('groupTrackRuns sorts by startSec before grouping', () => {
  const runs = groupTrackRuns([
    makeClip({ inSec: 0, outSec: 4, startSec: 3 }),
    makeClip({ inSec: 0, outSec: 4, startSec: 0 })
  ], 1 / 30);
  assert.deepEqual(runs.map(r => r.length), [2]);
  assert.equal(runs[0][0].startSec, 0);
});

test('groupTrackRuns ignores an overlap shorter than a frame', () => {
  // Half a frame of overlap is float noise from a drag, not a transition.
  const runs = groupTrackRuns([
    makeClip({ inSec: 0, outSec: 4, startSec: 0 }),
    makeClip({ inSec: 0, outSec: 4, startSec: 4 - 1 / 60 })
  ], 1 / 30);
  assert.deepEqual(runs.map(r => r.length), [1, 1]);
});

test('groupTrackRuns leaves a clip swallowed by its neighbour alone', () => {
  // A clip that starts and ends inside another has nothing to transition to.
  // It stays its own run, which is the overlay path it is on today.
  const runs = groupTrackRuns([
    makeClip({ inSec: 0, outSec: 20, startSec: 0 }),
    makeClip({ inSec: 0, outSec: 1, startSec: 2 })
  ], 1 / 30);
  assert.deepEqual(runs.map(r => r.length), [1, 1]);
});

test('groupTrackRuns requires a clip to extend the run, not just touch it', () => {
  // Overlaps by 2s and carries 2s past the end: a transition.
  assert.deepEqual(groupTrackRuns([
    makeClip({ inSec: 0, outSec: 4, startSec: 0 }),
    makeClip({ inSec: 0, outSec: 4, startSec: 2 })
  ], 1 / 30).map(r => r.length), [2]);

  // Overlaps by 4s and ends level with it: nothing new to cut to.
  assert.deepEqual(groupTrackRuns([
    makeClip({ inSec: 0, outSec: 4, startSec: 0 }),
    makeClip({ inSec: 0, outSec: 2, startSec: 2 })
  ], 1 / 30).map(r => r.length), [1, 1]);
});

test('groupTrackRuns drops clips with no src', () => {
  const runs = groupTrackRuns([makeClip(), { startSec: 0, inSec: 0, outSec: 4 }], 1 / 30);
  assert.deepEqual(runs.map(r => r.length), [1]);
});

test('overlapping clips on one track become an xfade of the overlap length', () => {
  const graph = graphOf(overlapProject(0.6));
  // 0.6s of overlap, beginning 3.4s into the folded stream.
  assert.match(graph, /xfade=transition=fade:duration=0\.6000:offset=3\.4000/);
});

test('overlapping clips on DIFFERENT tracks stay an overlay, not a transition', () => {
  const project = baseProject();
  project.tracks[0].clips.push(makeClip({ src: '/tmp/a.mp4', inSec: 0, outSec: 4, startSec: 0 }));
  project.tracks[1].clips.push(makeClip({ src: '/tmp/b.mp4', inSec: 0, outSec: 4, startSec: 3.4 }));
  const graph = graphOf(project);
  assert.ok(!graph.includes('xfade'), 'layering must not be rewritten into a transition');
  assert.equal(graph.match(/overlay=/g).length, 2);
});

test('abutting clips emit no xfade', () => {
  const project = baseProject();
  project.tracks[0].clips.push(
    makeClip({ src: '/tmp/a.mp4', inSec: 0, outSec: 4, startSec: 0 }),
    makeClip({ src: '/tmp/b.mp4', inSec: 0, outSec: 4, startSec: 4 })
  );
  assert.ok(!graphOf(project).includes('xfade'));
});

test('a three-clip run folds twice and lands one overlay on the canvas', () => {
  const project = baseProject();
  project.tracks[0].clips.push(
    makeClip({ src: '/tmp/a.mp4', inSec: 0, outSec: 4, startSec: 0 }),
    makeClip({ src: '/tmp/b.mp4', inSec: 0, outSec: 4, startSec: 3.5 }),
    makeClip({ src: '/tmp/c.mp4', inSec: 0, outSec: 4, startSec: 7 })
  );
  const graph = graphOf(project);
  assert.equal(graph.match(/xfade=/g).length, 2);
  assert.equal(graph.match(/overlay=/g).length, 1);
  // Second fold offsets into the already-folded stream, not the timeline.
  assert.match(graph, /xfade=transition=fade:duration=0\.5000:offset=3\.5000\[x1\]/);
  assert.match(graph, /\[x1\]\[v2\]xfade=transition=fade:duration=0\.5000:offset=7\.0000/);
});

test('the fades facing a transition are dropped, the outer ones kept', () => {
  const project = baseProject();
  project.tracks[0].clips.push(
    makeClip({ src: '/tmp/a.mp4', inSec: 0, outSec: 4, startSec: 0, fadeIn: 0.5, fadeOut: 0.6 }),
    makeClip({ src: '/tmp/b.mp4', inSec: 0, outSec: 4, startSec: 3.4, fadeIn: 0.6, fadeOut: 0.7 })
  );
  const graph = graphOf(project);
  const [first, second] = graph.split(';');
  assert.match(first, /fade=t=in:st=0:d=0\.500:alpha=1/);
  assert.ok(!first.includes('fade=t=out'), 'fadeOut into the transition must go');
  assert.ok(!second.includes('fade=t=in'), 'fadeIn out of the transition must go');
  assert.match(second, /fade=t=out:.*d=0\.700:alpha=1/);
});

test('suppressing a video fade leaves the audio afade alone', () => {
  // The overlapping afades under amix are what crossfades the sound; only the
  // video fade is superseded by xfade.
  const project = baseProject();
  project.tracks[0].clips.push(
    makeClip({ src: '/tmp/a.mp4', inSec: 0, outSec: 4, startSec: 0, fadeOut: 0.6 }),
    makeClip({ src: '/tmp/b.mp4', inSec: 0, outSec: 4, startSec: 3.4, fadeIn: 0.6 })
  );
  const graph = graphOf(project);
  assert.match(graph, /afade=t=out:st=3\.4000:d=0\.600/);
  assert.match(graph, /afade=t=in:st=0:d=0\.600/);
});

test('run members are padded to one shared box and left at t=0', () => {
  const graph = graphOf(overlapProject(0.6));
  const chains = graph.split(';').filter(f => f.startsWith('[0:v]') || f.startsWith('[1:v]'));
  assert.equal(chains.length, 2);
  for (const chain of chains) {
    // xfade insists both inputs agree on size, pixel format, SAR and timebase.
    assert.match(chain, /pad=1080:1920:\(ow-iw\)\/2:\(oh-ih\)\/2:color=black@0/);
    assert.match(chain, /format=yuva420p/);
    assert.match(chain, /setsar=1,settb=AVTB\[/);
    // The timeline shift belongs to the run, not the clip.
    assert.ok(!/setpts=PTS\+/.test(chain), 'a run member must still start at zero');
  }
  // The run starts at zero here, so the fold needs no shift at all.
  assert.match(graph, /\[x1\]setsar=1\[r0\]/);
});

test('xfade offsets are measured in the folded stream, not on the timeline', () => {
  // These coincide whenever a run starts at zero, which is why this case has
  // to start somewhere else: the offset is 2 (into the fold), not 7 (on the
  // timeline). Handing ffmpeg the timeline figure asks for a transition past
  // the end of its first input.
  const project = baseProject();
  project.tracks[0].clips.push(
    makeClip({ src: '/tmp/a.mp4', inSec: 0, outSec: 3, startSec: 5 }),
    makeClip({ src: '/tmp/b.mp4', inSec: 0, outSec: 3, startSec: 7 })
  );
  assert.match(graphOf(project), /xfade=transition=fade:duration=1\.0000:offset=2\.0000/);
});

test('the run shifts onto the timeline exactly once, after the fold', () => {
  const project = baseProject();
  project.tracks[0].clips.push(
    makeClip({ src: '/tmp/a.mp4', inSec: 0, outSec: 4, startSec: 5 }),
    makeClip({ src: '/tmp/b.mp4', inSec: 0, outSec: 4, startSec: 8.4 })
  );
  const graph = graphOf(project);
  assert.equal(graph.match(/setpts=PTS\+/g).length, 1);
  assert.match(graph, /\[x1\]setpts=PTS\+5\.0000\/TB,setsar=1\[r0\]/);
  // The overlay window spans the whole run: 5 -> 8.4 + 4.
  assert.match(graph, /enable='between\(t,5\.0000,12\.4000\)'/);
});

test('the shared box grows to fit the largest scale and nudge in the run', () => {
  const project = baseProject();
  project.tracks[0].clips.push(
    makeClip({ src: '/tmp/a.mp4', inSec: 0, outSec: 4, startSec: 0, scale: 0.5, posX: -30 }),
    makeClip({ src: '/tmp/b.mp4', inSec: 0, outSec: 4, startSec: 3.4, scale: 0.8, posY: 20 })
  );
  const graph = graphOf(project);
  // 1080*0.8 + 2*30 wide, 1920*0.8 + 2*20 tall — room for every member.
  assert.match(graph, /pad=924:1576:\(ow-iw\)\/2-30:\(oh-ih\)\/2:color=black@0/);
  assert.match(graph, /pad=924:1576:\(ow-iw\)\/2:\(oh-ih\)\/2\+20:color=black@0/);
  // Each clip's nudge is in its own pad, so the overlay only centres the box.
  assert.match(graph, /overlay=x=\(W-w\)\/2\+0:y=\(H-h\)\/2\+0/);
});

test('a clip swallowed by its neighbour stays an overlay at its own position', () => {
  // Folding it in would ask xfade for a transition longer than one of its
  // inputs, and would drag the clip to the end of the run to boot. It keeps
  // the behaviour it has today instead.
  const project = baseProject();
  project.tracks[0].clips.push(
    makeClip({ src: '/tmp/a.mp4', inSec: 0, outSec: 10, startSec: 0 }),
    makeClip({ src: '/tmp/b.mp4', inSec: 0, outSec: 1, startSec: 2 })
  );
  const graph = graphOf(project);
  assert.ok(!graph.includes('xfade'));
  assert.match(graph, /enable='between\(t,2\.0000,3\.0000\)'/);
});

test('chroma, eq, scale and captions survive the run path', () => {
  const project = baseProject({
    captionsEnabled: true,
    captions: [{ start: 0, end: 1, text: 'hello' }]
  });
  project.tracks[0].clips.push(
    makeClip({
      src: '/tmp/a.mp4', inSec: 0, outSec: 4, startSec: 0, scale: 0.5,
      chroma: { on: true, color: '#00FF22', similarity: 0.2, blend: 0.1 },
      filters: { brightness: 0.1, contrast: 1.2, saturation: 0.8 }
    }),
    makeClip({ src: '/tmp/b.mp4', inSec: 0, outSec: 4, startSec: 3.4 })
  );
  const graph = graphOf(project, { assPath: '/tmp/c.ass' });
  assert.match(graph, /eq=brightness=0\.1:contrast=1\.2:saturation=0\.8/);
  assert.match(graph, /chromakey=0x00FF22:0\.200:0\.100/);
  assert.match(graph, /despill=type=green/);
  assert.match(graph, /scale=540:960:force_original_aspect_ratio=decrease/);
  // eq runs before the pad, so the colour filters never tint the padding.
  const chain = graph.split(';')[0];
  assert.ok(chain.indexOf('eq=') < chain.indexOf('pad='));
  // Captions still burn in above every layer.
  assert.match(graph, /\[bg0\]subtitles=/);
});

test('previewSeconds still clamps a project that crossfades', () => {
  const { args, duration } = buildExportCommand(overlapProject(0.6), 'out.mp4', { previewSeconds: 3 });
  assert.equal(duration, 3);
  assert.match(args[args.indexOf('-filter_complex') + 1], /trim=duration=3\.000,setpts=PTS-STARTPTS\[vout\]/);
});

test('a crossfade project never takes the stream-copy fast path', () => {
  const project = singleVideoTrackProject();
  project.tracks[0].clips.push(
    makeClip({ src: '/tmp/a.mp4', inSec: 0, outSec: 4, startSec: 0 }),
    makeClip({ src: '/tmp/b.mp4', inSec: 0, outSec: 4, startSec: 3.4 })
  );
  assert.equal(canStreamCopy(project), false);
  assert.equal(buildExportCommand(project, 'out.mp4').mode, 'filter');
});

test('the Slow Dissolve template lands on the crossfade path', () => {
  // templates.js is the one thing in the app that produces same-track
  // overlaps, and this is the template that does it — `overlap: 0.6` on a
  // template whose own note promises "everything crossfades into everything".
  // It is the case the old alpha-fade approach rendered as a dip through
  // black, so it is the case worth pinning to the new path.
  const { TEMPLATES, applyTemplate } = require('../src/templates');
  const tpl = TEMPLATES.find(t => t.overlap > 0);
  assert.ok(tpl, 'expected a template that overlaps its slots');

  const poured = applyTemplate(tpl, [
    makeClip({ src: '/tmp/a.mp4', sourceDuration: 10 }),
    makeClip({ src: '/tmp/b.mp4', sourceDuration: 10 }),
    makeClip({ src: '/tmp/c.mp4', sourceDuration: 10 })
  ], 120);

  const project = baseProject();
  project.tracks[0].clips.push(...poured);
  const graph = graphOf(project);
  assert.equal(graph.match(/xfade=/g).length, 2, 'three clips, two transitions');
  assert.match(graph, new RegExp(`duration=${tpl.overlap.toFixed(4)}`));
  // One overlay for the lot, instead of one per clip fading against black.
  assert.equal(graph.match(/overlay=/g).length, 1);
});

test('a run on one track still composites under a layer on the track above', () => {
  const project = baseProject();
  project.tracks[0].clips.push(
    makeClip({ src: '/tmp/a.mp4', inSec: 0, outSec: 4, startSec: 0 }),
    makeClip({ src: '/tmp/b.mp4', inSec: 0, outSec: 4, startSec: 3.4 })
  );
  project.tracks[1].clips.push(makeClip({ src: '/tmp/c.mp4', inSec: 0, outSec: 2, startSec: 1 }));
  const graph = graphOf(project);
  assert.equal(graph.match(/xfade=/g).length, 1);
  // The folded run first, then the overlaying clip on top of it.
  assert.match(graph, /\[r0\]overlay=.*\[bg0\]/);
  assert.match(graph, /\[bg0\]\[v2\]overlay=.*\[bg1\]/);
});
