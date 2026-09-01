/*
 * thumbnail-render.js
 * ---------------------------------------------------------------------------
 * Picks which of a source's cached filmstrip frames (shared/media-cache.js's
 * thumbnailTimestamps, spread across the WHOLE source file) belong in one
 * clip's current trim and on-screen width, and where each lands on screen.
 * Pure and DOM-free for the same reason waveform-render.js is — app.js owns
 * the actual <img>/background-image elements, this only knows seconds and
 * pixels.
 *
 * Working from the whole-source list here rather than fetching frames per
 * trim is what lets re-trimming or resizing a clip redraw instantly from
 * frames already in memory.
 */

'use strict';

(function (root) {

  function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  /**
   * `frames` is the full cached list, each `{atSec, ...}`. Returns the
   * subset that belongs inside a clip spanning `fromSec`..`toSec` at
   * `width` px, each with an added `x` — the pixel column its timestamp
   * maps to — thinned so no two are closer together than `frameWidth`
   * (drawing overlapping tiles would waste the ffmpeg calls that cached
   * them for nothing visible).
   *
   * When the clip is narrower than one frame, or none of the cached
   * timestamps fall inside its trim at all (a short clip cut entirely
   * between two cached points), falls back to the single cached frame
   * closest to the clip's midpoint, positioned at the clip's left edge —
   * one representative frame, which is the minimum this feature promises.
   */
  function filmstripFrames(frames, { fromSec, toSec, width, frameWidth }) {
    const list = Array.isArray(frames) ? frames : [];
    const w = Math.max(0, num(width, 0));
    const from = num(fromSec, 0);
    const span = Math.max(0, num(toSec, from) - from);
    const fw = Math.max(1, num(frameWidth, 1));

    if (!list.length || w <= 0 || span <= 0) return [];

    const withX = (f) => ({ ...f, x: ((f.atSec - from) / span) * w });

    if (w < fw) {
      return [closestFrame(list, from + span / 2, withX)].filter(Boolean).map(f => ({ ...f, x: 0 }));
    }

    const inRange = list.filter(f => f.atSec >= from && f.atSec <= from + span);
    if (!inRange.length) {
      return [closestFrame(list, from + span / 2, withX)].filter(Boolean).map(f => ({ ...f, x: 0 }));
    }

    const positioned = inRange.map(withX).sort((a, b) => a.x - b.x);
    const out = [];
    let lastX = -Infinity;
    for (const f of positioned) {
      if (f.x - lastX < fw) continue;
      out.push(f);
      lastX = f.x;
    }
    return out;
  }

  function closestFrame(list, targetSec, withX) {
    let best = null;
    let bestDist = Infinity;
    for (const f of list) {
      const d = Math.abs(f.atSec - targetSec);
      if (d < bestDist) { bestDist = d; best = f; }
    }
    return best ? withX(best) : null;
  }

  root.ThumbnailRender = { filmstripFrames };

  if (typeof module !== 'undefined') {
    module.exports = root.ThumbnailRender;
  }

})(typeof globalThis !== 'undefined' ? globalThis : this);
