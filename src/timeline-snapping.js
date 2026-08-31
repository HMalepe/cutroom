/*
 * timeline-snapping.js
 * ---------------------------------------------------------------------------
 * Decides where a dragged clip edge lands when it is close enough to
 * something worth lining up with — another clip's start or end, the
 * playhead, the timeline's own zero, or (when beat-snap is on) the nearest
 * beat. Pure and DOM-free, the same split timeline-preview.js and
 * key-preview.js already draw between the decision and the pointermove/DOM
 * wiring that calls it — app.js is the layer that knows about pixels and
 * `state`; this only knows about seconds.
 *
 * Candidate gathering (edgeCandidates) and the actual pick (closestWithin /
 * snapTarget) are kept separate so app.js can freely mix in things that are
 * not clip edges — the playhead, zero, a beat-grid line — without this file
 * needing to know where any of them came from.
 */

'use strict';

(function (root) {

  function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  /**
   * Timeline-space start/end for every clip in `tracks`, on every track,
   * excluding the one being dragged (by id) — comparing a clip against its
   * own unmoved edges is not a snap, it is a clip that can never leave the
   * position it started at. Deliberately not filtered by track: keying a
   * clip on Video 2 to a cut on Video 1 is a normal thing to want, not a
   * special case.
   *
   * The duration formula mirrors clipDur/clipEnd in app.js and
   * clipTimelineEnd in timeline-preview.js; kept local rather than imported,
   * the same decoupling those two already keep from shared/ffmpeg-builder.js
   * (see timeline-preview.js's header) — three tiny copies of one line is
   * cheaper than a load-order dependency between renderer-side pure modules.
   */
  function edgeCandidates(tracks, excludeClipId) {
    const out = [];
    for (const track of (tracks || [])) {
      for (const c of ((track && track.clips) || [])) {
        if (!c || c.id === excludeClipId) continue;
        const start = num(c.startSec, 0);
        const dur = Math.max(0, num(c.outSec, 0) - num(c.inSec, 0)) / (num(c.speed, 1) || 1);
        out.push(start, start + dur);
      }
    }
    return out;
  }

  /**
   * The candidate closest to `pos`, as long as it is within `thresholdSec`.
   * Returns `null` — not `pos` — when nothing qualifies, so callers that
   * need to know whether a snap actually happened (snapMoveStart, below)
   * don't have to guess from a coincidental distance-zero match. Ties keep
   * whichever candidate was found first.
   */
  function closestWithin(candidates, pos, thresholdSec) {
    const threshold = Math.max(0, num(thresholdSec, 0));
    let best = null;
    let bestDist = Infinity;
    for (const c of (candidates || [])) {
      if (!Number.isFinite(c)) continue;
      const d = Math.abs(c - pos);
      if (d <= threshold && d < bestDist) { bestDist = d; best = c; }
    }
    return best;
  }

  /**
   * closestWithin, but falls back to `pos` unchanged rather than `null` — the
   * shape a caller wants when it is just going to assign the result straight
   * back to whatever it was about to set (a trim's single moving edge).
   */
  function snapTarget(candidates, pos, thresholdSec) {
    const hit = closestWithin(candidates, pos, thresholdSec);
    return hit === null ? pos : hit;
  }

  /**
   * Snapping a whole-clip move. The pointer only drives one number (the
   * clip's new timeline start) but a clip has two edges on screen, and
   * dragging clip A rightward toward clip B is a snap on A's TAIL, not its
   * head — snapTarget on the start alone would never catch that half of the
   * gesture, and that half is the more common one: butting a new clip up
   * against something already on the timeline usually means pushing its
   * trailing edge into place. Whichever edge lands nearer a candidate wins;
   * the other edge is carried along by the same delta rather than snapped on
   * its own, so the clip's own length never changes because of this.
   */
  function snapMoveStart(rawStart, durationSec, candidates, thresholdSec) {
    const dur = Math.max(0, num(durationSec, 0));
    const head = closestWithin(candidates, rawStart, thresholdSec);
    const tail = closestWithin(candidates, rawStart + dur, thresholdSec);
    if (head === null && tail === null) return rawStart;
    if (tail === null) return head;
    if (head === null) return tail - dur;
    const headDist = Math.abs(head - rawStart);
    const tailDist = Math.abs(tail - (rawStart + dur));
    return headDist <= tailDist ? head : (tail - dur);
  }

  root.TimelineSnapping = { edgeCandidates, closestWithin, snapTarget, snapMoveStart };

  if (typeof module !== 'undefined') {
    module.exports = root.TimelineSnapping;
  }

})(typeof globalThis !== 'undefined' ? globalThis : this);
