'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildExportCommand,
  buildAssFile,
  parseSubtitles,
  groupWordsIntoCaptions,
  clipTimelineDuration,
  clipTimelineEnd,
  projectDuration,
  canStreamCopy,
  atempoChain,
  groupTrackRuns,
  TRANSITION_TYPES,
  DEFAULT_TRANSITION,
  transitionFor
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

  // A third video track has to fall off the fast path exactly the way a
  // second one already does — this only re-checks it under three rather
  // than trusting that the two-track coverage above generalises on its own.
  const threeVideoTracks = baseProject({
    tracks: [
      { id: 'v1', kind: 'video', name: 'Video 1', clips: [makeClip()] },
      { id: 'v2', kind: 'video', name: 'Video 2', clips: [] },
      { id: 'v3', kind: 'video', name: 'Video 3', clips: [] },
      { id: 'a1', kind: 'audio', name: 'Audio 1', clips: [] }
    ]
  });
  assert.equal(canStreamCopy(threeVideoTracks), false);

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
// Word-level captions: grouping whisper's one-word-per-cue output back into
// editable rows (main.js requests one SRT cue per word — see its comment on
// captions:transcribe — so this is what turns that into what the caption
// list actually shows).
// --------------------------------------------------------------------------

/** A word with tidy, hand-computable timing: start, then start+dur as end. */
function w(start, dur, text) {
  return { start, end: start + dur, text };
}

test('groupWordsIntoCaptions ends a row at sentence-ending punctuation', () => {
  // Only 0.3s between "friend." and "New" — comfortably under the 0.6s gap
  // threshold, so the break has to come from the period, not the pause.
  const words = [
    w(0.00, 0.30, 'Hello'),
    w(0.35, 0.25, 'there,'),
    w(0.65, 0.35, 'friend.'),
    w(1.30, 0.20, 'New'),
    w(1.55, 0.25, 'sentence')
  ];
  const groups = groupWordsIntoCaptions(words);
  assert.equal(groups.length, 2);

  assert.equal(groups[0].start, 0);
  assert.equal(groups[0].end, 1.0);
  assert.equal(groups[0].text, 'Hello there, friend.');
  assert.equal(groups[0].words.length, 3);
  assert.deepEqual(groups[0].words[1], { start: 0.35, end: 0.6, text: 'there,' });

  assert.equal(groups[1].start, 1.3);
  assert.equal(groups[1].end, 1.8);
  assert.equal(groups[1].text, 'New sentence');
});

test('groupWordsIntoCaptions also breaks on a pause, with no punctuation in sight', () => {
  // 0.8s of silence between "Wait" and "what" — no sentence-ending mark
  // anywhere, so only the default 0.6s gap threshold can end the row.
  const words = [w(0, 0.2, 'Wait'), w(1.0, 0.2, 'what')];
  const groups = groupWordsIntoCaptions(words);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].text, 'Wait');
  assert.equal(groups[1].text, 'what');
});

test('groupWordsIntoCaptions respects a custom gap threshold', () => {
  // Same 0.8s gap as above, but a 1s threshold should let it join into one row.
  const words = [w(0, 0.2, 'Wait'), w(1.0, 0.2, 'what')];
  const groups = groupWordsIntoCaptions(words, { maxGap: 1 });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].text, 'Wait what');
});

test('groupWordsIntoCaptions caps row length when nothing else would break it', () => {
  // 15 words, tight timing (0.1s gaps, well under the 0.6s default) and no
  // punctuation — the only thing that can stop this becoming one giant row.
  const words = Array.from({ length: 15 }, (_, i) => w(i * 0.3, 0.2, `w${i}`));
  const groups = groupWordsIntoCaptions(words);
  assert.deepEqual(groups.map(g => g.words.length), [12, 3]);
  assert.equal(groups[0].words[0].text, 'w0');
  assert.equal(groups[1].words[0].text, 'w12');
});

test('groupWordsIntoCaptions respects a custom word cap', () => {
  const words = Array.from({ length: 5 }, (_, i) => w(i * 0.3, 0.2, `w${i}`));
  const groups = groupWordsIntoCaptions(words, { maxWords: 2 });
  assert.deepEqual(groups.map(g => g.words.length), [2, 2, 1]);
});

// --------------------------------------------------------------------------
// Karaoke: buildAssFile's typewriter animation, with and without real
// per-word timing.
// --------------------------------------------------------------------------

/** Pulls the [V4+ Styles] Style line's comma-separated fields out. */
function styleFields(ass) {
  const line = ass.match(/^Style: Main,(.*)$/m)[1];
  return line.split(',');
}

test('typewriter falls back to one even-split \\k tag when a row has no word timing', () => {
  // Unchanged from before word-level timing existed: dur=1s over 2 characters
  // -> 100/2 = 50 centiseconds per character, one tag for the whole line.
  const project = baseProject({
    captions: [{ start: 0, end: 1, text: 'Hi' }],
    captionStyle: { animation: 'typewriter' }
  });
  const ass = buildAssFile(project);
  assert.match(ass, /,,\{\\k50\}Hi$/m);
});

test('typewriter uses real per-word \\k timing when the row has it', () => {
  // "Hello" only lasts 0.30s of the 0.35s it has before "there" starts — a
  // real 0.05s breath. That gap has to be charged to "Hello"'s own \k, not
  // dropped: a \k measured word-start-to-word-OWN-end would read 30 here,
  // not 35, and the highlight would jump onto "there" before it is actually
  // spoken.
  const project = baseProject({
    captions: [{
      start: 0, end: 1.0, text: 'Hello there friend',
      words: [w(0, 0.30, 'Hello'), w(0.35, 0.30, 'there'), w(0.65, 0.35, 'friend')]
    }],
    captionStyle: { animation: 'typewriter' }
  });
  const ass = buildAssFile(project);
  // \k is this word's start to the NEXT word's start (0.35s, then 0.30s),
  // except the last word, which has no next and runs to its own end
  // (1.0 - 0.65 = 0.35s) — all in centiseconds.
  assert.match(ass, /,,\{\\k35\}Hello \{\\k30\}there \{\\k35\}friend$/m);
});

test('typewriter drops a hand-edited row back to the even-split fallback', () => {
  // groupWordsIntoCaptions never produces a mismatch between `text` and
  // `words`, but the caption editor can — this is what renderCaptions in
  // app.js relies on `delete cap.words` to prevent: a caption whose `words`
  // no longer describes its `text` must not use the (now wrong) real timing.
  const project = baseProject({
    captions: [{ start: 0, end: 1, text: 'Hi', words: [] }],
    captionStyle: { animation: 'typewriter' }
  });
  const ass = buildAssFile(project);
  assert.match(ass, /,,\{\\k50\}Hi$/m);
});

test('karaoke SecondaryColour defaults to a dimmed PrimaryColour, not an identical one', () => {
  // Before this, both colours were `${primary},${primary}` — a real karaoke
  // sweep between two identical colours is invisible.
  const project = baseProject({ captionStyle: { color: '#FFFFFF' } });
  const [, , primary, secondary] = styleFields(buildAssFile(project));
  assert.equal(primary, '&H00FFFFFF');
  // 0.55 alpha -> round(0.55*255) = 140 = 0x8C.
  assert.equal(secondary, '&H8CFFFFFF');
  assert.notEqual(primary, secondary);
});

test('an explicit secondaryColor overrides the dimmed default, at full opacity', () => {
  const project = baseProject({ captionStyle: { color: '#FFFFFF', secondaryColor: '#FF0000' } });
  const [, , , secondary] = styleFields(buildAssFile(project));
  assert.equal(secondary, '&H000000FF');
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

// --------------------------------------------------------------------------
// Transition type: which xfade effect plays at a fold.
// --------------------------------------------------------------------------

test('transitionFor returns a recognised name unchanged', () => {
  for (const name of TRANSITION_TYPES) {
    assert.equal(transitionFor({ transitionType: name }), name);
  }
});

test('transitionFor falls back to the default for an unrecognised or missing name', () => {
  assert.equal(transitionFor({ transitionType: 'not-a-real-transition' }), DEFAULT_TRANSITION);
  assert.equal(transitionFor({}), DEFAULT_TRANSITION);
  assert.equal(transitionFor(null), DEFAULT_TRANSITION);
});

test('DEFAULT_TRANSITION is fade, so every existing project renders unchanged', () => {
  assert.equal(DEFAULT_TRANSITION, 'fade');
  assert.ok(TRANSITION_TYPES.includes('fade'));
});

test('the incoming clip of a fold picks the xfade transition', () => {
  // transitionType lives on the clip joining the run — the same clip whose
  // alpha fade-in is suppressed by noFadeIn. The first clip's own value, if
  // any, is never consulted: there is no fold before it.
  const project = baseProject();
  project.tracks[0].clips.push(
    makeClip({ src: '/tmp/a.mp4', inSec: 0, outSec: 4, startSec: 0, transitionType: 'circleopen' }),
    makeClip({ src: '/tmp/b.mp4', inSec: 0, outSec: 4, startSec: 3.4, transitionType: 'wipeleft' })
  );
  const graph = graphOf(project);
  assert.match(graph, /xfade=transition=wipeleft:duration=0\.6000:offset=3\.4000/);
  assert.ok(!graph.includes('transition=circleopen'), 'the outgoing clip\'s value must not be used');
});

test('an unrecognised transitionType falls back to fade in the built graph', () => {
  const graph = graphOf(overlapProject(0.6, { transitionType: 'not-a-real-transition' }));
  assert.match(graph, /xfade=transition=fade:duration=0\.6000:offset=3\.4000/);
});

test('a three-clip run can use a different transition at each fold', () => {
  const project = baseProject();
  project.tracks[0].clips.push(
    makeClip({ src: '/tmp/a.mp4', inSec: 0, outSec: 4, startSec: 0 }),
    makeClip({ src: '/tmp/b.mp4', inSec: 0, outSec: 4, startSec: 3.5, transitionType: 'dissolve' }),
    makeClip({ src: '/tmp/c.mp4', inSec: 0, outSec: 4, startSec: 7, transitionType: 'slideright' })
  );
  const graph = graphOf(project);
  assert.match(graph, /xfade=transition=dissolve:duration=0\.5000:offset=3\.5000\[x1\]/);
  assert.match(graph, /\[x1\]\[v2\]xfade=transition=slideright:duration=0\.5000:offset=7\.0000/);
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

// --------------------------------------------------------------------------
// The copy path's blind spots
//
// canStreamCopy was tested for tracks, clips, speed and chroma and stopped
// there, so five inspector settings it does not look at went unnoticed: each
// one exports silently discarded rather than slowly. These test the fields
// that were actually missing, not the ones next to them.
// --------------------------------------------------------------------------

/** A single-video-track project carrying one clip with these overrides. */
function copyCandidate(clipOverrides = {}) {
  const project = singleVideoTrackProject();
  project.tracks[0].clips.push(makeClip(clipOverrides));
  return project;
}

test('canStreamCopy rejects the inspector settings the copy path cannot honour', () => {
  // Every one of these is applied by the filter graph and by nothing else:
  // scale= for the size, the overlay's x/y for the nudge, volume= for the
  // level. -c copy runs none of them, so a clip carrying one has to re-encode
  // or the setting is thrown away with no error anywhere.
  assert.equal(canStreamCopy(copyCandidate({ scale: 0.5 })), false, 'scaled down');
  assert.equal(canStreamCopy(copyCandidate({ scale: 2 })), false, 'scaled up');
  assert.equal(canStreamCopy(copyCandidate({ posX: 200 })), false, 'nudged right');
  assert.equal(canStreamCopy(copyCandidate({ posY: -50 })), false, 'nudged up');
  assert.equal(canStreamCopy(copyCandidate({ volume: 0.25 })), false, 'quietened');
  assert.equal(canStreamCopy(copyCandidate({ volume: 0 })), false, 'silenced');

  // Muting lives on the track, and -c copy would carry the source's audio
  // stream out untouched regardless.
  const muted = copyCandidate();
  muted.tracks[0].muted = true;
  assert.equal(canStreamCopy(muted), false, 'muted track');

  // Hiding is the same trap one field over, and the two paths disagree in
  // opposite directions: the filter path drops a hidden track before the
  // canvas and renders black, while -c copy cannot express "show nothing" and
  // would hand back the hidden footage.
  const hidden = copyCandidate();
  hidden.tracks[0].hidden = true;
  assert.equal(canStreamCopy(hidden), false, 'hidden track');
});

test('a hidden video track renders black rather than being copied out', () => {
  // The bug this pins is not that one path is wrong on its own — it is that
  // the two paths disagree. Assert the filter path's answer (no clip reaches
  // the canvas) so the copy path has something concrete to match.
  const hidden = copyCandidate();
  hidden.tracks[0].hidden = true;

  const { args, mode } = buildExportCommand(hidden, 'out.mp4');
  assert.equal(mode, 'filter', 'a hidden track must not take the copy path');

  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.ok(
    !graph.includes('[0:v]'),
    `the hidden clip must not enter the video graph, got: ${graph}`
  );
});

test('canStreamCopy still takes the fast path for the defaults, however they are spelled', () => {
  // The fast path is the point of the check, so the defaults have to survive
  // it. Undefined is not a hypothetical spelling: it is what every project
  // saved before these fields existed actually looks like.
  assert.equal(canStreamCopy(copyCandidate({
    scale: 1, posX: 0, posY: 0, volume: 1
  })), true, 'explicit defaults');

  assert.equal(canStreamCopy(copyCandidate({
    scale: undefined, posX: undefined, posY: undefined, volume: undefined
  })), true, 'absent fields');

  const unmuted = copyCandidate();
  unmuted.tracks[0].muted = false;
  assert.equal(canStreamCopy(unmuted), true, 'muted: false');
});

test('previewSeconds clamps the copy path, not just the filter path', () => {
  // The existing previewSeconds test used a crossfading project, which takes
  // the other branch entirely — so "Test 3s" on the boring single clip that
  // most reaches for it exported the whole thing.
  const { args, mode, duration } = buildExportCommand(
    copyCandidate({ inSec: 0, outSec: 10 }), 'out.mp4', { previewSeconds: 3 });
  assert.equal(mode, 'copy');
  assert.equal(args[args.indexOf('-to') + 1], '3.0000');
  // The progress bar divides by this, so the full length made a 3-second test
  // render stop at 30%.
  assert.equal(duration, 3);
});

test('previewSeconds on a trimmed clip stops three seconds into the clip, not into the file', () => {
  // -ss and -to are both INPUT options here, and an input-side -to is a
  // position in the source's own timeline rather than a length measured from
  // -ss: `-ss 2 -to 5` yields three seconds, not five. Verified against a real
  // ffmpeg in ffmpeg-render.test.js rather than assumed, because the other
  // reading gives -to 3 for this clip, which starts after it stops and renders
  // nothing at all.
  const { args, duration } = buildExportCommand(
    copyCandidate({ inSec: 4, outSec: 10 }), 'out.mp4', { previewSeconds: 3 });
  assert.equal(args[args.indexOf('-ss') + 1], '4.0000');
  assert.equal(args[args.indexOf('-to') + 1], '7.0000');
  assert.equal(duration, 3);
});

test('previewSeconds longer than the clip does not stretch the copy path', () => {
  const { args, duration } = buildExportCommand(
    copyCandidate({ inSec: 0, outSec: 2 }), 'out.mp4', { previewSeconds: 3 });
  assert.equal(args[args.indexOf('-to') + 1], '2.0000');
  assert.equal(duration, 2);
});

test('the copy path without previewSeconds writes the -to it always wrote', () => {
  const { args, duration } = buildExportCommand(
    copyCandidate({ inSec: 1, outSec: 6 }), 'out.mp4');
  assert.equal(args[args.indexOf('-ss') + 1], '1.0000');
  assert.equal(args[args.indexOf('-to') + 1], '6.0000');
  assert.equal(duration, 5);
});

// --------------------------------------------------------------------------
// Caption text is data, not markup
// --------------------------------------------------------------------------

/** The Dialogue line for a one-caption project. */
function dialogueLine(text, style = {}, extra = {}) {
  const ass = buildAssFile({
    width: 1080, height: 1920,
    captionStyle: style,
    captions: [{ start: 0, end: 2, text, ...extra }]
  });
  return ass.trim().split('\n').pop();
}

test('a brace in caption text is escaped rather than read as an override block', () => {
  // libass reads `{` as the start of a tag block and drops everything up to
  // the matching `}`, so this line used to reach the screen as "costs  today"
  // with no error raised anywhere.
  assert.ok(dialogueLine('costs {50} today').endsWith(',costs \\{50\\} today'),
    dialogueLine('costs {50} today'));
});

test('a user backslash is separated from the character after it', () => {
  // \N and \n are line breaks in libass and \h is a hard space, so "C:\Notes"
  // wrapped onto two lines. Doubling does not fix it — libass reads `\\N` as a
  // literal backslash AND a line break — so a zero-width space is what breaks
  // the pair up.
  const line = dialogueLine('C:\\Notes');
  assert.ok(line.includes('C:\\\u200BNotes'), JSON.stringify(line));
  // Nothing that libass would still act on survives in the user's half.
  assert.ok(!/\\[Nnh]/.test(line.split(',,').pop().replace(/\\\u200B/g, '')),
    'no live escape left in the body');
});

test('escaping runs before the builder writes its own markup, not after', () => {
  // This is the ordering that matters. The user's text is escaped while it is
  // still only the user's text; the \N and the animation tag are the
  // builder's own markup and go around the result. Escape afterwards and the
  // builder defuses its own tags instead.
  const line = dialogueLine('two\nlines {x}', { animation: 'fade' });
  assert.ok(line.includes('{\\fad(120,120)}'), 'the fade tag stays live');
  assert.ok(line.includes('two\\Nlines'), 'the newline stays a real \\N');
  assert.ok(line.includes('\\{x\\}'), 'the user brace is escaped');
});

test('karaoke escapes each word without defusing its own \\k tags', () => {
  const line = dialogueLine('{A} B', { animation: 'typewriter' }, {
    words: [{ start: 0, end: 1, text: '{A}' }, { start: 1, end: 2, text: 'B' }]
  });
  assert.ok(line.endsWith(',{\\k100}\\{A\\} {\\k100}B'), line);
});

test('the karaoke fallback splits by visible characters, not by the escapes', () => {
  // Two characters over two seconds is 100cs each way. Counting the escapes
  // instead would see four characters and halve every highlight.
  assert.ok(dialogueLine('ab', { animation: 'typewriter' }).includes('{\\k100}'),
    dialogueLine('ab', { animation: 'typewriter' }));
  assert.ok(dialogueLine('{}', { animation: 'typewriter' }).includes('{\\k100}'),
    dialogueLine('{}', { animation: 'typewriter' }));
});

// --------------------------------------------------------------------------
// Audio delay
// --------------------------------------------------------------------------

test('adelay delays every channel, not only the first two', () => {
  // A two-entry delay list names two channels and ffmpeg leaves the rest
  // alone, so a 5.1 source keeps its centre, LFE and surrounds at zero while
  // the front pair moves. all=1 reuses the last delay for the remainder.
  const project = baseProject();
  project.tracks[2].clips.push(makeClip({ startSec: 2, hasAudio: true }));
  const graph = graphOf(project);
  assert.match(graph, /adelay=2000:all=1/);
  assert.ok(!/adelay=\d+\|/.test(graph), 'no hardcoded per-channel list');
});
