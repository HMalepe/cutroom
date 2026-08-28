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

const path = require('path');

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

  const c = clips[0];
  if ((c.speed || 1) !== 1) return false;
  if (c.chroma && c.chroma.on) return false;
  if (c.fadeIn || c.fadeOut) return false;
  if (c.filters && (c.filters.brightness || c.filters.contrast !== 1 || c.filters.saturation !== 1)) return false;
  if ((c.startSec || 0) !== 0) return false;
  return true;
}

// --------------------------------------------------------------------------
// Video chain for one clip
// --------------------------------------------------------------------------

function buildVideoClipChain(clip, inputIdx, label, project) {
  const W = project.width;
  const H = project.height;
  const FPS = project.fps;
  const speed = clip.speed || 1;
  const start = num(clip.startSec);
  const dur = clipTimelineDuration(clip);
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
  //    transparent area transparent.
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
  const needsAlpha = (clip.chroma && clip.chroma.on) || clip.fadeIn || clip.fadeOut;
  if (needsAlpha) steps.push('format=yuva420p');

  if (clip.chroma && clip.chroma.on) {
    const colour = (clip.chroma.color || '0x00FF00').replace('#', '0x');
    steps.push(
      `chromakey=${colour}:${num(clip.chroma.similarity, 0.1).toFixed(3)}:${num(clip.chroma.blend, 0.05).toFixed(3)}`
    );
    // Cleans up the fringe of green that survives the key.
    steps.push('despill=type=green:mix=0.5:expand=0');
  }

  // 7. Transitions. Fading the alpha channel means overlapping two clips on the
  //    timeline produces a real crossfade, with no separate transition system.
  if (clip.fadeIn > 0) {
    steps.push(`fade=t=in:st=0:d=${num(clip.fadeIn).toFixed(3)}:alpha=1`);
  }
  if (clip.fadeOut > 0) {
    const fadeStart = Math.max(0, dur - clip.fadeOut);
    steps.push(`fade=t=out:st=${fadeStart.toFixed(4)}:d=${num(clip.fadeOut).toFixed(3)}:alpha=1`);
  }

  // 8. Now shift the whole clip to its position on the output timeline, and
  //    fix the pixel aspect so overlay does not complain.
  if (start > 0) steps.push(`setpts=PTS+${start.toFixed(4)}/TB`);
  steps.push('setsar=1');

  return `[${inputIdx}:v]${steps.join(',')}[${label}]`;
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

  // adelay takes milliseconds, per channel.
  const ms = Math.round(start * 1000);
  if (ms > 0) steps.push(`adelay=${ms}|${ms}`);

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
    const args = [
      '-hide_banner', '-y',
      '-ss', num(clip.inSec).toFixed(4),
      '-to', num(clip.outSec).toFixed(4),
      '-i', clip.src,
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      outPath
    ];
    return { args, mode: 'copy', duration };
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

  for (const track of videoTracks) {
    const sorted = [...track.clips].sort((a, b) => a.startSec - b.startSec);
    for (const clip of sorted) {
      if (!clip.src) continue;
      const inputIdx = index.get(clip.src);
      const label = `v${vCount}`;
      filters.push(buildVideoClipChain(clip, inputIdx, label, project));

      const start = num(clip.startSec);
      const end = clipTimelineEnd(clip);
      // (W-w)/2 centres the clip on the canvas whatever its aspect ratio, so a
      // landscape phone clip in a 9:16 project sits in the middle rather than
      // stuck to the top edge. posX/posY nudge it from there.
      const x = `(W-w)/2${num(clip.posX, 0) >= 0 ? '+' : ''}${Math.round(num(clip.posX, 0))}`;
      const y = `(H-h)/2${num(clip.posY, 0) >= 0 ? '+' : ''}${Math.round(num(clip.posY, 0))}`;
      const outLabel = `bg${vCount}`;

      // enable= stops the last frame of a clip from freezing on screen after
      // the clip is over, which is the classic overlay bug.
      filters.push(
        `[${vLabel}][${label}]overlay=x=${x}:y=${y}:eof_action=pass:` +
        `enable='between(t,${start.toFixed(4)},${end.toFixed(4)})'[${outLabel}]`
      );

      vLabel = outLabel;
      vCount++;
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

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Main,${st.font || 'Arial'},${st.size || 54},${primary},${primary},${outline},${outline},${st.bold ? -1 : 0},0,0,0,100,100,${st.spacing || 0},0,${borderStyle},${st.outlineWidth ?? 3},0,${align},60,60,${st.marginV ?? 70},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  const anim = st.animation || 'none';
  const lines = (project.captions || [])
    .slice()
    .sort((a, b) => a.start - b.start)
    .map(c => {
      let text = String(c.text || '').replace(/\n/g, '\\N');
      if (anim === 'fade') text = `{\\fad(120,120)}${text}`;
      if (anim === 'pop') text = `{\\fscx60\\fscy60\\t(0,140,\\fscx100\\fscy100)}${text}`;
      if (anim === 'slide') text = `{\\move(${W / 2},${H + 40},${W / 2},${H - (st.marginV ?? 70)},0,160)}${text}`;
      if (anim === 'typewriter') {
        const dur = Math.max(0.1, c.end - c.start);
        text = `{\\k${Math.round((dur * 100) / Math.max(1, text.length))}}${text}`;
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

module.exports = {
  buildExportCommand,
  buildAssFile,
  parseSubtitles,
  clipTimelineDuration,
  clipTimelineEnd,
  projectDuration,
  canStreamCopy,
  atempoChain
};
