/*
 * timeline-preview.js
 * ---------------------------------------------------------------------------
 * Decides what the preview pane should be showing at a given instant on the
 * timeline: which clip (or pair of clips, mid-crossfade) is active on each
 * video track, what source time each one should be seeked to, and how the
 * timeline clock advances while playing. Pure and DOM-free, the same split
 * key-preview.js draws between stepClipLoop (decision) and draw (DOM/GL) —
 * app.js is the part that turns these answers into <video>/<canvas> elements.
 *
 * The crossfade rule mirrors groupTrackRuns in shared/ffmpeg-builder.js on
 * purpose: two clips on the SAME video track that overlap, where the second
 * one also carries on past where the first ends, are the transition the
 * export folds through xfade. Two clips overlapping on DIFFERENT tracks are
 * layering, not a transition, and are handled by layersAt drawing one track
 * over another rather than by anything in here. shared/ffmpeg-builder.js is
 * not reachable from the renderer (it is required only by main.js, over in
 * the main process), so the rule is re-derived here rather than imported —
 * test/timeline-preview.test.js pins TRANSITION_TYPES against the export's
 * own list so the two cannot quietly drift apart.
 */

'use strict';

(function (root) {

  function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  // --------------------------------------------------------------------------
  // Clip timing — the same formulas app.js's clipDur/clipEnd and
  // shared/ffmpeg-builder.js's clipTimelineDuration/clipTimelineEnd use.
  // Kept local rather than imported for the reason in the header above.
  // --------------------------------------------------------------------------

  function clipTimelineDuration(clip) {
    const src = Math.max(0, num(clip && clip.outSec, 0) - num(clip && clip.inSec, 0));
    return src / (num(clip && clip.speed, 1) || 1);
  }

  function clipTimelineEnd(clip) {
    return num(clip && clip.startSec, 0) + clipTimelineDuration(clip);
  }

  /**
   * Where a clip's own source is sitting when the timeline is at t. Clamped
   * into [inSec, outSec) — a paused timeline outside a clip's window has no
   * meaning for that clip, so callers should only ask this for a clip
   * trackStateAt has already said is active at t.
   */
  function sourceTimeFor(clip, t) {
    const inSec = num(clip && clip.inSec, 0);
    const outSecRaw = num(clip && clip.outSec, inSec);
    const outSec = outSecRaw > inSec ? outSecRaw : inSec;
    const speed = num(clip && clip.speed, 1) || 1;
    const raw = inSec + (t - num(clip && clip.startSec, 0)) * speed;
    return clamp(raw, inSec, outSec);
  }

  // --------------------------------------------------------------------------
  // Crossfades — TRANSITION_TYPES/DEFAULT_TRANSITION/transitionFor are a
  // deliberate duplicate of the export's list; see the header comment.
  // --------------------------------------------------------------------------

  const TRANSITION_TYPES = [
    'fade', 'dissolve', 'fadeblack', 'fadewhite',
    'wipeleft', 'wiperight', 'slideleft', 'slideright',
    'circleopen', 'circleclose'
  ];
  const DEFAULT_TRANSITION = 'fade';

  function transitionFor(clip) {
    const name = clip && clip.transitionType;
    return TRANSITION_TYPES.includes(name) ? name : DEFAULT_TRANSITION;
  }

  /**
   * fps-derived overlap floor below which an overlap is treated as clips that
   * merely abut rather than a transition — one frame, the same amount
   * buildExportCommand passes to groupTrackRuns.
   */
  function minOverlapFor(project) {
    return 1 / (num(project && project.fps, 30) || 30);
  }

  /**
   * What one video track is showing at timeline time t.
   *
   * @returns {null|{kind:'solo', clip}|{kind:'crossfade', outgoing, incoming, progress, transition}}
   *   null            nothing on this track covers t
   *   'solo'          exactly one clip does, or several do but none of the
   *                   pairs straddling t qualify as a crossfade — the export
   *                   overlays same-track runs in start-time order, so the
   *                   latest-starting clip wins the pixels, same as here
   *   'crossfade'     t sits inside a same-track overlap that groupTrackRuns
   *                   would fold through xfade; progress runs 0 (outgoing
   *                   alone) to 1 (incoming alone)
   *
   * A third clip nested inside an active crossfade's own overlap window is
   * not resolved — same-track triple overlaps are pathological enough that
   * the export's own filter graph does not have a clean answer for them
   * either, and this only ever looks at the two clips nearest t.
   */
  function trackStateAt(clips, t, minOverlap) {
    const covering = (clips || [])
      .filter(c => c && c.src)
      .map(c => ({ clip: c, start: num(c.startSec, 0), end: clipTimelineEnd(c) }))
      .filter(c => t >= c.start && t < c.end)
      .sort((a, b) => a.start - b.start);

    if (!covering.length) return null;

    const top = covering[covering.length - 1];

    if (covering.length >= 2) {
      const prev = covering[covering.length - 2];
      // groupTrackRuns' own "joins" test: the incoming clip has to overlap
      // the outgoing one by at least minOverlap AND still be running after
      // it ends. Failing either makes this two clips that happen to overlap
      // (one nested inside the other) rather than a transition.
      const overlap = prev.end - top.start;
      const tail = top.end - prev.end;
      if (overlap >= minOverlap && tail >= minOverlap) {
        const prevDur = prev.end - prev.start;
        const topDur = top.end - top.start;
        const d = Math.min(overlap, prevDur, topDur);
        const progress = d > 0 ? clamp((t - top.start) / d, 0, 1) : 1;
        return {
          kind: 'crossfade',
          outgoing: prev.clip,
          incoming: top.clip,
          progress,
          transition: transitionFor(top.clip)
        };
      }
    }

    return { kind: 'solo', clip: top.clip };
  }

  /**
   * trackStateAt for every video track, bottom to top — project.tracks[0] is
   * the base layer, the same order buildExportCommand composites in. Hidden
   * tracks and non-video tracks are skipped; tracks with nothing active at t
   * are simply absent from the result rather than present with a null state,
   * so the caller can iterate it directly.
   */
  function layersAt(tracks, t, minOverlap) {
    const layers = [];
    for (const track of (tracks || [])) {
      if (!track || track.kind !== 'video' || track.hidden) continue;
      const state = trackStateAt(track.clips || [], t, minOverlap);
      if (state) layers.push({ trackId: track.id, state });
    }
    return layers;
  }

  // --------------------------------------------------------------------------
  // The timeline clock
  // --------------------------------------------------------------------------

  /**
   * Advance the timeline playhead by one tick of wall-clock time. Pure: no
   * <video> touched here, which is what makes play/pause/seek-at-a-boundary
   * testable without a real decoder. The caller (app.js) is the part that
   * reads real elapsed time, calls this, and writes state.playhead back.
   *
   * @param {{playhead:number, playing:boolean, dt:number, duration:number}} clock
   *   dt        seconds of real time since the last tick (0 on the tick that
   *             starts playback, so the first frame does not jump)
   *   duration  project length; the clock stops rather than looping past it
   * @returns {{playhead:number, playing:boolean}}
   */
  function stepTimelineClock(clock) {
    const duration = Math.max(0, num(clock && clock.duration, 0));
    if (!clock || !clock.playing) {
      return { playhead: clamp(num(clock && clock.playhead, 0), 0, duration), playing: false };
    }
    const dt = Math.max(0, num(clock.dt, 0));
    const next = num(clock.playhead, 0) + dt;
    if (next >= duration) return { playhead: duration, playing: false };
    return { playhead: next, playing: true };
  }

  /**
   * Whether a <video>'s currentTime has drifted far enough from where the
   * timeline clock says it should be to need a correction seek. Continuous
   * decoding drifts from wall-clock time by a frame or two even at 1x — a
   * seek on every tick would fight the decoder instead of letting it run, so
   * this only asks for one past a threshold the caller picks.
   *
   * @returns {number|null} the time to seek to, or null if close enough
   */
  function driftSeek(currentTime, expected, threshold) {
    return Math.abs(num(currentTime, 0) - expected) > Math.max(0, num(threshold, 0)) ? expected : null;
  }

  root.TimelinePreview = {
    clipTimelineDuration, clipTimelineEnd, sourceTimeFor,
    TRANSITION_TYPES, DEFAULT_TRANSITION, transitionFor, minOverlapFor,
    trackStateAt, layersAt,
    stepTimelineClock, driftSeek
  };

  if (typeof module !== 'undefined') {
    module.exports = root.TimelinePreview;
  }

})(typeof globalThis !== 'undefined' ? globalThis : this);
