/*
 * ffmpeg-builder.js
 * ---------------------------------------------------------------------------
 * Turns a project object into an ffmpeg argument array.
 * This is the only place in the app that knows anything about ffmpeg.
 * Runs in Node (main process), not the browser.
 *
 * Timeline model
 * --------------
 * Every clip has:
 *   inSec / outSec  -> the region of the SOURCE file we want
 *   startSec        -> where that region lands on the OUTPUT timeline
 *   speed           -> playback multiplier (2 = twice as fast)
 *
 * So a clip occupies the output timeline from:
 *   startSec  ..  startSec + (outSec - inSec) / speed
 *
 * Keeping source-time and timeline-time as separate fields is the single most
 * important decision in the file. Mixing them is where export math drifts.
 */

'use strict';

// --------------------------------------------------------------------------
// Small helpers
// --------------------------------------------------------------------------

/** Length this clip occupies on the output timeline, in seconds. */
function clipTimelineDuration(clip) {
  const src = Math.max(0, (clip.outSec ?? 0) - (clip.inSec ?? 0));
  return src / (clip.speed || 1);
}

/** Where this clip ends on the output timeline. */
function clipTimelineEnd(clip) {
  return (clip.startSec || 0) + clipTimelineDuration(clip);
}

/** Total length of the whole project. */
function projectDuration(project) {
  let max = 0;
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      max = Math.max(max, clipTimelineEnd(clip));
    }
  }
  return Math.max(max, 0.04);
}

/**
 * atempo only accepts 0.5–2.0, so extreme speeds need a chain.
 * 4x becomes atempo=2.0,atempo=2.0
 */
function atempoChain(speed) {
  const parts = [];
  let remaining = speed || 1;
  if (Math.abs(remaining - 1) < 0.001) return [];
  while (remaining > 2.0) { parts.push('atempo=2.0'); remaining /= 2.0; }
  while (remaining < 0.5) { parts.push('atempo=0.5'); remaining /= 0.5; }
  parts.push(`atempo=${remaining.toFixed(6)}`);
  return parts;
}

/** ffmpeg filter syntax hates unescaped colons and backslashes in paths. */
function escapeFilterPath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// --------------------------------------------------------------------------
// Input de-duplication
// --------------------------------------------------------------------------

/**
 * Two clips can point at the same file. We only want to pass that file to
 * ffmpeg once, so we build a map of src -> input index.
 */
function collectInputs(project) {
  const order = [];
  const index = new Map();
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (!clip.src) continue;
      if (!index.has(clip.src)) {
        index.set(clip.src, order.length);
        order.push(clip.src);
      }
    }
  }
  return { order, index };
}

// --------------------------------------------------------------------------
// Fast path detection
// --------------------------------------------------------------------------

/**
 * If nothing needs re-encoding we can stream-copy, which is near-instant.
 * This is the difference between a 2-second export and a 4-minute one, so it
 * is worth checking for. Only the most boring possible project qualifies.
 */
function canStreamCopy(project) {
  const videoTracks = project.tracks.filter(t => t.kind === 'video');
  const audioTracks = project.tracks.filter(t => t.kind === 'audio');
  if (audioTracks.some(t => t.clips.length > 0)) return false;
  if (videoTracks.length !== 1) return false;

  const clips = videoTracks[0].clips;
  if (clips.length !== 1) return false;
  if (project.captionsEnabled && (project.captions || []).length) return false;

  // Muting is a property of the track, not the clip, and -c copy has no way to
  // honour it: it would copy the source's audio stream out untouched. The
  // filter path is the only one that can drop the sound.
  if (videoTracks[0].muted) return false;

  const c = clips[0];
  if ((c.speed || 1) !== 1) return false;
  if (c.chroma && c.chroma.on) return false;
  if (c.fadeIn || c.fadeOut) return false;
  if (c.filters && (c.filters.brightness || c.filters.contrast !== 1 || c.filters.saturation !== 1)) return false;
  if ((c.startSec || 0) !== 0) return false;
  // Geometry and level live on the clip but are applied by the filter graph —
  // scale by `scale=`, the nudge by the overlay's x/y, the level by `volume=`.
  // Copying the bitstream skips every one of them, so a clip carrying any of
  // them has to re-encode or the setting is silently thrown away. The defaults
  // are spelled out through num() so an untouched clip — where these are 1/0/1
  // or absent entirely — still takes the fast path, which is the whole point.
  if (num(c.scale, 1) !== 1) return false;
  if (num(c.posX, 0) !== 0 || num(c.posY, 0) !== 0) return false;
  if (num(c.volume, 1) !== 1) return false;
  return true;
}

// --------------------------------------------------------------------------
// Video chain for one clip
// --------------------------------------------------------------------------

/**
 * @param {object} opts  Set only when this clip is a member of a crossfade run:
 *   box          {w,h}  Shared geometry every clip in the run is padded to.
 *   noFadeIn            Suppress the alpha fade on the side facing an xfade.
 *   noFadeOut
 */
function buildVideoClipChain(clip, inputIdx, label, project, opts = {}) {
  const W = project.width;
  const H = project.height;
  const FPS = project.fps;
  const speed = clip.speed || 1;
  const start = num(clip.startSec);
  const dur = clipTimelineDuration(clip);
  const box = opts.box || null;
  const steps = [];

  // 1. Take only the slice of source we want.
  steps.push(`trim=start=${num(clip.inSec).toFixed(4)}:end=${num(clip.outSec).toFixed(4)}`);

  // 2. Rebase to zero and apply speed. Everything from here to step 7 works in
  //    CLIP-LOCAL time (0 = first frame of the clip). The shift onto the
  //    timeline happens last, in step 8. Doing the shift early makes fps=
  //    try to generate frames from t=0 up to the clip's start position.
  steps.push(`setpts=(PTS-STARTPTS)/${speed}`);

  // 3. Normalise frame rate.
  steps.push(`fps=${FPS}`);

  // 4. Fit inside the project canvas without distortion. No padding — the
  //    overlay in the caller centres it, which also keeps a keyed clip's
  //    transparent area transparent. (A run member is the exception; step 6b.)
  const scaleW = Math.round(W * (clip.scale ?? 1));
  const scaleH = Math.round(H * (clip.scale ?? 1));
  steps.push(`scale=${scaleW}:${scaleH}:force_original_aspect_ratio=decrease`);

  // 5. Colour adjustments.
  const f = clip.filters || {};
  const bright = num(f.brightness, 0);
  const contrast = num(f.contrast, 1);
  const sat = num(f.saturation, 1);
  if (bright !== 0 || contrast !== 1 || sat !== 1) {
    steps.push(`eq=brightness=${bright}:contrast=${contrast}:saturation=${sat}`);
  }

  // 6. Green screen. This is what forces a re-encode, so it is opt-in per clip.
  //    similarity: how far from the key colour still counts as background
  //    blend: softness of the edge (0 = hard cut, higher = feathered)
  const needsAlpha = (clip.chroma && clip.chroma.on) || clip.fadeIn || clip.fadeOut || box;
  if (needsAlpha) steps.push('format=yuva420p');

  if (clip.chroma && clip.chroma.on) {
    const colour = (clip.chroma.color || '0x00FF00').replace('#', '0x');
    steps.push(
      `chromakey=${colour}:${num(clip.chroma.similarity, 0.1).toFixed(3)}:${num(clip.chroma.blend, 0.05).toFixed(3)}`
    );
    // Cleans up the fringe of green that survives the key.
    steps.push('despill=type=green:mix=0.5:expand=0');
  }

  // 6b. Run members only. xfade refuses two inputs that disagree on size, and
  //     force_original_aspect_ratio=decrease hands every clip a different one,
  //     so pad each to the run's shared box. The padding is transparent, which
  //     is why it can do here what step 4 refuses to do in general: the canvas
  //     still shows through a letterboxed or keyed clip. Each clip's posX/posY
  //     is baked into the pad offset, so one overlay can serve the whole run
  //     without flattening per-clip nudges. It runs after eq so the colour
  //     filters never tint the padding.
  if (box) {
    const px = Math.round(num(clip.posX, 0));
    const py = Math.round(num(clip.posY, 0));
    const xoff = px === 0 ? '(ow-iw)/2' : `(ow-iw)/2${px > 0 ? '+' : ''}${px}`;
    const yoff = py === 0 ? '(oh-ih)/2' : `(oh-ih)/2${py > 0 ? '+' : ''}${py}`;
    steps.push(`pad=${box.w}:${box.h}:${xoff}:${yoff}:color=black@0`);
  }

  // 7. Transitions. An alpha fade against the background is a fade to black.
  //    Where a clip meets another clip it is xfade that does the blend, so the
  //    fade on that side is suppressed — running both dips through the canvas
  //    on the way across, which is the bug this replaced.
  if (clip.fadeIn > 0 && !opts.noFadeIn) {
    steps.push(`fade=t=in:st=0:d=${num(clip.fadeIn).toFixed(3)}:alpha=1`);
  }
  if (clip.fadeOut > 0 && !opts.noFadeOut) {
    const fadeStart = Math.max(0, dur - clip.fadeOut);
    steps.push(`fade=t=out:st=${fadeStart.toFixed(4)}:d=${num(clip.fadeOut).toFixed(3)}:alpha=1`);
  }

  // 8. Now shift the whole clip to its position on the output timeline, and
  //    fix the pixel aspect so overlay does not complain.
  //
  //    A run member skips the shift. xfade measures its offset in the joined
  //    stream's own time and re-bases what it is handed, so a shift here would
  //    not survive it — the run does the shift once, after the last fold,
  //    which is the only place it means anything. settb pins the timebase, the
  //    last of the four properties xfade insists its two inputs share.
  if (box) {
    steps.push('setsar=1');
    steps.push('settb=AVTB');
  } else {
    if (start > 0) steps.push(`setpts=PTS+${start.toFixed(4)}/TB`);
    steps.push('setsar=1');
  }

  return `[${inputIdx}:v]${steps.join(',')}[${label}]`;
}

// --------------------------------------------------------------------------
// Crossfade runs
// --------------------------------------------------------------------------

/**
 * Split one track's clips into runs that have to be rendered as a single
 * stream, because a crossfade joins them.
 *
 * What counts as a crossfade is a deliberate choice, and it is narrow: clips
 * that overlap in time ON THE SAME TRACK. Two clips overlapping on DIFFERENT
 * tracks are layering — a keyed face over a background — and stay on the
 * overlay path, because turning those into transitions would silently rewrite
 * what every existing project means.
 *
 * A boundary where clips merely abut ends a run rather than joining it, so
 * every fold inside a run is an xfade and none is a plain concat. That is
 * worth the sentence it costs: abutting clips are the common case, they are
 * what `split` produces, and leaving them in one-clip runs keeps them on
 * byte-for-byte the command they had before any of this existed.
 *
 * @param {number} minOverlap  Overlaps shorter than this are not transitions.
 *                             One frame, from the caller.
 */
function groupTrackRuns(clips, minOverlap = 0) {
  const sorted = [...clips]
    .filter(c => c && c.src)
    .sort((a, b) => num(a.startSec) - num(b.startSec));

  const runs = [];
  let current = null;
  let currentEnd = 0;

  for (const clip of sorted) {
    const start = num(clip.startSec);
    const end = clipTimelineEnd(clip);

    // Two conditions, and the second is the interesting one. A clip has to
    // overlap what is already on screen, and it has to carry on past it. A
    // clip that begins and ends inside its neighbour is not a transition —
    // there is nothing to transition to — so it stays on the overlay path
    // exactly as it is today rather than being folded in and dragged to the
    // end of the run.
    const joins = current
      && currentEnd - start >= minOverlap
      && end - currentEnd >= minOverlap;

    if (joins) {
      current.push(clip);
    } else {
      current = [clip];
      runs.push(current);
    }
    currentEnd = end;
  }

  return runs;
}

/**
 * xfade ships about fifty transitions of uneven reliability and visual
 * distinctness. This is the curated subset the inspector offers: the classic
 * dissolve family (fade/dissolve/fadeblack/fadewhite), a directional wipe and
 * slide each way, and a circle reveal each way. Every name here is proven
 * against a real ffmpeg in test/ffmpeg-render.test.js — that is what this
 * list exists to constrain.
 */
const TRANSITION_TYPES = [
  'fade', 'dissolve', 'fadeblack', 'fadewhite',
  'wipeleft', 'wiperight', 'slideleft', 'slideright',
  'circleopen', 'circleclose'
];
const DEFAULT_TRANSITION = 'fade';

/** Falls back to the default rather than handing ffmpeg a name it might reject. */
function transitionFor(clip) {
  const name = clip && clip.transitionType;
  return TRANSITION_TYPES.includes(name) ? name : DEFAULT_TRANSITION;
}

/**
 * Fold one run into a single labelled stream and return where it sits on the
 * timeline, so the caller can overlay it like any other layer.
 *
 * A one-clip run is the old path untouched: same chain, same shift, same
 * label. Only a genuine overlap takes the sequential route.
 */
function buildVideoRun(run, project, inputIndex, filters, labelNo) {
  const runStart = num(run[0].startSec);

  if (run.length === 1) {
    const label = `v${labelNo}`;
    filters.push(buildVideoClipChain(run[0], inputIndex.get(run[0].src), label, project));
    return { label, start: runStart, end: clipTimelineEnd(run[0]) };
  }

  // One geometry for the whole run. Big enough for the largest scale in it
  // plus the largest nudge, so the pad in step 6b never crops: a clip is at
  // most width*maxScale wide and is offset by at most maxX, and the box has
  // exactly that much slack on each side.
  const maxScale = Math.max(...run.map(c => num(c.scale, 1)));
  const maxX = Math.max(...run.map(c => Math.abs(Math.round(num(c.posX, 0)))));
  const maxY = Math.max(...run.map(c => Math.abs(Math.round(num(c.posY, 0)))));
  const box = {
    w: Math.round(project.width * maxScale) + 2 * maxX,
    h: Math.round(project.height * maxScale) + 2 * maxY
  };

  let acc = null;
  // Length of the folded stream so far, in its own time. This is the number
  // xfade offsets are measured against, and it is NOT a timeline position —
  // keeping the two apart is the same discipline the rest of the file keeps.
  let accLen = 0;

  run.forEach((clip, i) => {
    const label = `v${labelNo + i}`;
    filters.push(buildVideoClipChain(clip, inputIndex.get(clip.src), label, project, {
      box,
      // The fades facing this join were the old hand-rolled crossfade. xfade
      // does that blend now. Only the VIDEO fade goes: buildAudioClipChain
      // still writes the afade, and those overlapping afades under amix are
      // what crossfades the sound beneath the picture.
      noFadeIn: i > 0,
      noFadeOut: i < run.length - 1
    }));

    const dur = clipTimelineDuration(clip);
    if (acc === null) {
      acc = label;
      accLen = dur;
      return;
    }

    // How far into the joined stream this clip's start lands, and therefore
    // how long the two shots are on screen together.
    const overlap = accLen - (num(clip.startSec) - runStart);
    // xfade rejects a transition longer than either of its inputs. Grouping
    // already guarantees it fits — a clip that does not outlast its neighbour
    // never joins a run — so this is a belt to that braces, cheap enough to
    // keep against a future change to the grouping rule.
    const d = Math.min(overlap, accLen, dur);
    const offset = Math.max(0, accLen - d);

    const out = `x${labelNo + i}`;
    filters.push(
      `[${acc}][${label}]xfade=transition=${transitionFor(clip)}:duration=${d.toFixed(4)}:offset=${offset.toFixed(4)}[${out}]`
    );
    acc = out;
    // xfade runs the first stream to `offset`, blends for `d`, then plays out
    // the rest of the second — which comes to offset + dur seconds.
    accLen = offset + dur;
  });

  // One stream again, so shift it onto the timeline exactly once.
  const label = `r${labelNo}`;
  const tail = [];
  if (runStart > 0) tail.push(`setpts=PTS+${runStart.toFixed(4)}/TB`);
  tail.push('setsar=1');
  filters.push(`[${acc}]${tail.join(',')}[${label}]`);

  return { label, start: runStart, end: runStart + accLen };
}

// --------------------------------------------------------------------------
// Audio chain for one clip
// --------------------------------------------------------------------------

function buildAudioClipChain(clip, inputIdx, label) {
  const speed = clip.speed || 1;
  const start = num(clip.startSec);
  const steps = [];

  steps.push(`atrim=start=${num(clip.inSec).toFixed(4)}:end=${num(clip.outSec).toFixed(4)}`);
  steps.push('asetpts=PTS-STARTPTS');

  const tempo = atempoChain(speed);
  if (tempo.length) steps.push(...tempo);

  const vol = num(clip.volume, 1);
  if (vol !== 1) steps.push(`volume=${vol.toFixed(3)}`);

  if (clip.fadeIn > 0) steps.push(`afade=t=in:st=0:d=${num(clip.fadeIn).toFixed(3)}`);
  if (clip.fadeOut > 0) {
    const d = clipTimelineDuration(clip);
    steps.push(`afade=t=out:st=${Math.max(0, d - clip.fadeOut).toFixed(4)}:d=${num(clip.fadeOut).toFixed(3)}`);
  }

  // Resample to a common rate so amix does not silently drop a track.
  steps.push('aresample=48000');

  // adelay takes milliseconds, per channel, and leaves any channel the list
  // does not name completely undelayed — so a hardcoded two-entry list silently
  // desyncs everything past stereo. On a 5.1 source `adelay=1000|1000` moves
  // FL and FR and leaves FC, LFE, BL and BR sitting at zero (measured, not
  // assumed). `all=1` reuses the last delay for the remaining channels, which
  // is the whole point of the option.
  const ms = Math.round(start * 1000);
  if (ms > 0) steps.push(`adelay=${ms}:all=1`);

  return `[${inputIdx}:a]${steps.join(',')}[${label}]`;
}

// --------------------------------------------------------------------------
// Main builder
// --------------------------------------------------------------------------

/**
 * @param {object} project
 * @param {string} outPath
 * @param {object} opts  { assPath, previewSeconds, crf, preset }
 * @returns {{ args: string[], mode: 'copy'|'filter', duration: number }}
 */
function buildExportCommand(project, outPath, opts = {}) {
  const { order, index } = collectInputs(project);
  const duration = projectDuration(project);

  // ---- Fast path -----------------------------------------------------------
  if (canStreamCopy(project) && !opts.forceEncode) {
    const clip = project.tracks.find(t => t.kind === 'video').clips[0];
    // Test 3s has to clamp here too, not just on the filter path. Only the
    // copy path's own -to can do it: -c copy writes whatever it reads, so
    // without this the "3 second" test render is the entire clip.
    const copyDur = opts.previewSeconds
      ? Math.min(duration, opts.previewSeconds)
      : duration;
    // -ss and -to are BOTH input options here, and an input-side -to is a
    // position in the source's own timeline rather than a length measured from
    // -ss: `-ss 2 -to 5` yields three seconds, not five (checked against a
    // real ffmpeg, not assumed). So the stop point is inSec + the length we
    // want. A clip on this path has speed 1 and startSec 0, so its timeline
    // length and its source length are the same number, and with no
    // previewSeconds this is inSec + (outSec - inSec) — the same -to the copy
    // path has always written.
    const args = [
      '-hide_banner', '-y',
      '-ss', num(clip.inSec).toFixed(4),
      '-to', (num(clip.inSec) + copyDur).toFixed(4),
      '-i', clip.src,
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      outPath
    ];
    // The progress bar divides by this, so returning the full length made a
    // 3-second test render crawl to 30% and stop.
    return { args, mode: 'copy', duration: copyDur };
  }

  // ---- Filter path ---------------------------------------------------------
  const args = ['-hide_banner', '-y'];
  for (const src of order) args.push('-i', src);

  const filters = [];
  const W = project.width;
  const H = project.height;
  const FPS = project.fps;
  const exportDur = opts.previewSeconds
    ? Math.min(duration, opts.previewSeconds)
    : duration;

  // Black canvas everything sits on. lavfi input is added after the real files
  // so the input indices above stay stable.
  args.push('-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${FPS}:d=${exportDur.toFixed(3)}`);
  const canvasIdx = order.length;

  // Video tracks composite bottom-up: tracks[0] is the base layer.
  const videoTracks = project.tracks.filter(t => t.kind === 'video' && !t.hidden);
  let vLabel = `${canvasIdx}:v`;
  let vCount = 0;

  // Runs, not clips. Clips that overlap on the same track are a crossfade and
  // get folded into one stream by xfade before they reach the canvas; anything
  // else is still one overlay per clip. Runs cannot overlap each other on a
  // track — a run ends exactly where a clip stops overlapping — so composing
  // them here is the same job as composing clips was.
  let runCount = 0;
  for (const track of videoTracks) {
    for (const run of groupTrackRuns(track.clips, 1 / (FPS || 30))) {
      const { label, start, end } = buildVideoRun(run, project, index, filters, vCount);
      vCount += run.length;

      // (W-w)/2 centres the clip on the canvas whatever its aspect ratio, so a
      // landscape phone clip in a 9:16 project sits in the middle rather than
      // stuck to the top edge. posX/posY nudge it from there — for a run they
      // are already baked into each clip's pad, so the overlay just centres.
      const px = run.length > 1 ? 0 : Math.round(num(run[0].posX, 0));
      const py = run.length > 1 ? 0 : Math.round(num(run[0].posY, 0));
      const x = `(W-w)/2${px >= 0 ? '+' : ''}${px}`;
      const y = `(H-h)/2${py >= 0 ? '+' : ''}${py}`;
      const outLabel = `bg${runCount}`;

      // enable= stops the last frame of a clip from freezing on screen after
      // the clip is over, which is the classic overlay bug.
      filters.push(
        `[${vLabel}][${label}]overlay=x=${x}:y=${y}:eof_action=pass:` +
        `enable='between(t,${start.toFixed(4)},${end.toFixed(4)})'[${outLabel}]`
      );

      vLabel = outLabel;
      runCount++;
    }
  }

  // Burn in captions last so they sit above every video layer.
  if (opts.assPath && project.captionsEnabled && (project.captions || []).length) {
    const finalLabel = 'vsub';
    filters.push(`[${vLabel}]subtitles='${escapeFilterPath(opts.assPath)}'[${finalLabel}]`);
    vLabel = finalLabel;
  }

  // Trim the composite to exactly the project length.
  filters.push(`[${vLabel}]trim=duration=${exportDur.toFixed(3)},setpts=PTS-STARTPTS[vout]`);

  // ---- Audio ---------------------------------------------------------------
  const audioLabels = [];
  let aCount = 0;
  for (const track of project.tracks) {
    if (track.muted) continue;
    for (const clip of track.clips) {
      if (!clip.src) continue;
      if (!clip.hasAudio) continue;
      if (num(clip.volume, 1) === 0) continue;
      const label = `a${aCount}`;
      filters.push(buildAudioClipChain(clip, index.get(clip.src), label));
      audioLabels.push(`[${label}]`);
      aCount++;
    }
  }

  let hasAudio = audioLabels.length > 0;
  if (hasAudio) {
    if (audioLabels.length === 1) {
      filters.push(`${audioLabels[0]}apad,atrim=duration=${exportDur.toFixed(3)}[aout]`);
    } else {
      // normalize=0 keeps a voiceover from being ducked just because a music
      // bed exists underneath it. Mix levels stay under your control.
      filters.push(
        `${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:normalize=0,` +
        `atrim=duration=${exportDur.toFixed(3)}[aout]`
      );
    }
  }

  args.push('-filter_complex', filters.join(';'));
  args.push('-map', '[vout]');
  if (hasAudio) args.push('-map', '[aout]');

  args.push(
    '-c:v', 'libx264',
    '-preset', opts.preset || 'medium',
    '-crf', String(opts.crf ?? 20),
    '-pix_fmt', 'yuv420p',
    '-r', String(FPS)
  );
  if (hasAudio) args.push('-c:a', 'aac', '-b:a', '192k');
  args.push('-movflags', '+faststart');
  args.push(outPath);

  return { args, mode: 'filter', duration: exportDur };
}

// --------------------------------------------------------------------------
// ASS subtitle generation
// --------------------------------------------------------------------------

function assTime(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  const secs = Math.floor(rest);
  const cs = Math.round((rest - secs) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/** #RRGGBB -> &HAABBGGRR& (ASS is BGR and alpha is inverted) */
function assColour(hex, alpha = 0) {
  const clean = (hex || '#FFFFFF').replace('#', '');
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  const a = Math.round(alpha * 255).toString(16).padStart(2, '0');
  return `&H${a}${b}${g}${r}`.toUpperCase();
}

/** Breaks a backslash away from the character after it. Draws nothing. */
const ZWSP = '\u200B';

/**
 * libass reads a Dialogue line as markup, so a caption that merely mentions a
 * brace loses text with no error raised anywhere: `costs {50} today` renders
 * as `costs  today`, because `{` opens an override block and everything up to
 * the matching `}` is read as tags. `\` is live too — `\N` and `\n` are line
 * breaks and `\h` a hard space — so a caption reading `C:\Notes` silently
 * wraps onto two lines.
 *
 * `\{` and `\}` are the escapes libass honours for the braces. The backslash
 * has no escape of its own: libass renders `\\` as TWO backslashes and still
 * reads the `\N` in `\\Nx` as a line break, so doubling makes things worse
 * rather than better. The only thing that separates a user's backslash from
 * the character after it is a zero-width space, which libass passes through
 * and no font puts ink on. It goes in after every backslash rather than only
 * the three that are live today, so this never has to be kept in step with
 * libass's escape table.
 *
 * This is for the user's text ONLY. The `\N` line breaks and the `{\k}` /
 * `{\fad}` / `{\move}` tags the builder writes are markup we mean, and are
 * added around the result of this rather than passed through it.
 */
function assEscape(text) {
  return String(text)
    .replace(/\\/g, `\\${ZWSP}`)
    .replace(/[{}]/g, '\\$&');
}

/**
 * Real per-word karaoke for one caption line, built from `c.words` (each
 * `{start, end, text}`, real timestamps from whisper — see
 * `groupWordsIntoCaptions`). ASS `\k` takes the highlight's own duration in
 * centiseconds, measured from this word's start to the NEXT word's start —
 * not this word's own start-to-end — so a pause between words is charged to
 * the word before it and the highlight lands exactly when the next word
 * starts rather than early. The last word in the line has no "next", so it
 * runs to its own end.
 */
function karaokeText(words) {
  return words.map((w, i) => {
    const next = words[i + 1];
    const boundary = next ? next.start : w.end;
    const cs = Math.max(1, Math.round((boundary - w.start) * 100));
    // The tag is ours and stays live; only the word inside it is escaped.
    return `{\\k${cs}}${assEscape(String(w.text || '').trim())}`;
  }).join(' ');
}

function buildAssFile(project) {
  const st = project.captionStyle || {};
  const W = project.width;
  const H = project.height;

  const align = { bottom: 2, middle: 5, top: 8 }[st.position || 'bottom'];
  // borderStyle 3 draws a filled box behind the text; 1 draws an outline.
  const borderStyle = st.background ? 3 : 1;
  const primary = assColour(st.color || '#FFFFFF');
  const outline = st.background
    ? assColour(st.bgColor || '#000000', 1 - (st.bgOpacity ?? 0.7))
    : assColour(st.outlineColor || '#000000');
  // Karaoke reveals PrimaryColour (sung) against SecondaryColour (not yet
  // sung) — the two have to actually differ or the sweep is invisible. An
  // explicit secondaryColor wins; otherwise fall back to the text colour at
  // reduced opacity rather than a fixed hue, so the "not yet sung" state
  // stays visibly distinct from "sung" no matter what text colour was picked
  // (a fixed grey, for instance, would vanish into a grey caption).
  const secondary = st.secondaryColor
    ? assColour(st.secondaryColor)
    : assColour(st.color || '#FFFFFF', 0.55);

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Main,${st.font || 'Arial'},${st.size || 54},${primary},${secondary},${outline},${outline},${st.bold ? -1 : 0},0,0,0,100,100,${st.spacing || 0},0,${borderStyle},${st.outlineWidth ?? 3},0,${align},60,60,${st.marginV ?? 70},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  const anim = st.animation || 'none';
  const lines = (project.captions || [])
    .slice()
    .sort((a, b) => a.start - b.start)
    .map(c => {
      // Order matters and is the subtle part. The user's text is escaped
      // FIRST, while it is still only the user's text; the `\N` line breaks
      // and the animation tags below are the builder's own markup and are
      // wrapped around the escaped result. Escaping after either of those
      // would defuse the very tags this function exists to write.
      const source = String(c.text || '');
      let text = assEscape(source).replace(/\n/g, '\\N');
      if (anim === 'fade') text = `{\\fad(120,120)}${text}`;
      if (anim === 'pop') text = `{\\fscx60\\fscy60\\t(0,140,\\fscx100\\fscy100)}${text}`;
      if (anim === 'slide') text = `{\\move(${W / 2},${H + 40},${W / 2},${H - (st.marginV ?? 70)},0,160)}${text}`;
      if (anim === 'typewriter') {
        // Real per-word timing when this line came from a transcription that
        // has it. Anything else — hand-typed lines, an imported .srt/.vtt, or
        // a line whose timing/text was hand-edited after transcription (see
        // renderCaptions in app.js, which drops `words` the moment a line is
        // touched) — falls back to the old even-split-by-character estimate,
        // exactly as it rendered before word-level timing existed.
        if (Array.isArray(c.words) && c.words.length) {
          text = karaokeText(c.words);
        } else {
          const dur = Math.max(0.1, c.end - c.start);
          // Counted over the text the viewer sees, not over the escapes just
          // added around it — otherwise a caption with braces in it gets a
          // shorter highlight than the same caption without them.
          const visible = source.replace(/\n/g, '\\N').length;
          text = `{\\k${Math.round((dur * 100) / Math.max(1, visible))}}${text}`;
        }
      }
      return `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Main,,0,0,0,,${text}`;
    });

  return `${header}\n${lines.join('\n')}\n`;
}

// --------------------------------------------------------------------------
// SRT / VTT parsing, for bringing in captions from elsewhere
// --------------------------------------------------------------------------

function parseTimestamp(str) {
  const m = str.trim().match(/(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/);
  if (!m) {
    const short = str.trim().match(/(\d+):(\d{2})[,.](\d{1,3})/);
    if (!short) return 0;
    return Number(short[1]) * 60 + Number(short[2]) + Number(short[3]) / 1000;
  }
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

function parseSubtitles(text) {
  const blocks = text.replace(/\r/g, '').split(/\n\s*\n/);
  const out = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter(l => l.trim() && !/^WEBVTT/i.test(l));
    const timeLine = lines.find(l => l.includes('-->'));
    if (!timeLine) continue;
    const [a, b] = timeLine.split('-->');
    const body = lines.slice(lines.indexOf(timeLine) + 1).join('\n').trim();
    if (!body) continue;
    out.push({ start: parseTimestamp(a), end: parseTimestamp(b), text: body });
  }
  return out;
}

// --------------------------------------------------------------------------
// Word-level captions
//
// whisper.cpp (`-ml 1 -sow`) and openai-whisper (`--word_timestamps True
// --max_words_per_line 1`) can both be made to emit one SRT cue per word —
// see main.js's `captions:transcribe` for exactly how. That is real timing
// data, not something worth showing the editor one row per word: a minute of
// speech is a couple hundred one-word rows, which is unusable in the caption
// list. So the words are re-grouped here into sentence/phrase-sized rows for
// editing, while each word's own start/end rides along on the row for
// buildAssFile's karaoke `\k` tags to use.
// --------------------------------------------------------------------------

/** A word ending a sentence — closing quote/paren after the mark is common. */
const SENTENCE_END = /[.!?]["'”)\]]*$/;

/**
 * @param {{start:number, end:number, text:string}[]} words  One entry per
 *   word, in order, real timestamps in seconds.
 * @param {object} [opts]
 * @param {number} [opts.maxWords]  Hard cap so a transcript with no
 *   punctuation and no pauses (a run-on caption model, or the wrong language
 *   heuristics) still breaks into readable rows instead of one giant line.
 * @param {number} [opts.maxGap]  A silence at least this long (seconds)
 *   between two words ends the row even without punctuation.
 * @returns {{start:number, end:number, text:string, words:object[]}[]}
 */
function groupWordsIntoCaptions(words, opts = {}) {
  const maxWords = opts.maxWords ?? 12;
  const maxGap = opts.maxGap ?? 0.6;

  const groups = [];
  let current = [];

  function flush() {
    if (!current.length) return;
    groups.push({
      start: current[0].start,
      end: current[current.length - 1].end,
      text: current.map(w => w.text).join(' '),
      words: current.map(w => ({ start: w.start, end: w.end, text: w.text }))
    });
    current = [];
  }

  words.forEach((w, i) => {
    current.push(w);
    const next = words[i + 1];
    const gapToNext = next ? next.start - w.end : Infinity;
    const endsSentence = SENTENCE_END.test(String(w.text || '').trim());
    if (!next || endsSentence || gapToNext >= maxGap || current.length >= maxWords) flush();
  });

  return groups;
}

module.exports = {
  buildExportCommand,
  groupTrackRuns,
  buildAssFile,
  parseSubtitles,
  groupWordsIntoCaptions,
  clipTimelineDuration,
  clipTimelineEnd,
  projectDuration,
  canStreamCopy,
  atempoChain,
  TRANSITION_TYPES,
  DEFAULT_TRANSITION,
  transitionFor
};
