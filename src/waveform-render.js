/*
 * waveform-render.js
 * ---------------------------------------------------------------------------
 * Turns a cached peaks array (shared/media-cache.js's pcmToPeaks, one
 * [min, max] pair per 1/peaksPerSecond bucket across the WHOLE source file)
 * into pixel bars for a canvas covering one clip's current trim and
 * on-screen width. Pure and DOM-free, the same split timeline-snapping.js
 * and timeline-preview.js already draw between the decision and the
 * canvas/pointer wiring that calls it — app.js is the layer that owns the
 * <canvas>, this only knows pixels and seconds.
 *
 * Working from the whole-source array here, rather than caching one array
 * per trim, is what lets dragging a clip's trim handle redraw instantly from
 * data already in memory instead of re-asking main for new peaks.
 */

'use strict';

(function (root) {

  function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  /**
   * One bar per output pixel column. Each bar covers the slice of source
   * time that column represents (`fromSec` + trim/width fraction) and takes
   * the min/max across every peaks bucket that falls inside that slice, so
   * zooming out to where several buckets share a column still shows the
   * loudest moment in it rather than a stray sample from wherever the column
   * boundary happened to land.
   *
   * Returns `{x, top, height}` per bar, already in the target canvas's pixel
   * space (`top` measured from the top, `height` downward) — a caller draws
   * each with a single `fillRect`.
   */
  function waveformBars(peaks, { peaksPerSecond, fromSec, toSec, width, height }) {
    const w = Math.max(0, Math.round(num(width, 0)));
    const h = Math.max(0, num(height, 0));
    const bars = [];
    if (w <= 0 || h <= 0 || !peaks || !peaks.length || !peaksPerSecond) return bars;

    const from = num(fromSec, 0);
    const span = Math.max(0, num(toSec, from) - from);
    if (span <= 0) return bars;

    const mid = h / 2;
    const bucketCount = peaks.length / 2;

    for (let x = 0; x < w; x++) {
      const t0 = from + (x / w) * span;
      const t1 = from + ((x + 1) / w) * span;
      const i0 = Math.max(0, Math.floor(t0 * peaksPerSecond));
      const i1 = Math.min(bucketCount, Math.max(i0 + 1, Math.ceil(t1 * peaksPerSecond)));

      let min = 0;
      let max = 0;
      for (let i = i0; i < i1; i++) {
        const mn = peaks[i * 2];
        const mx = peaks[i * 2 + 1];
        if (mn < min) min = mn;
        if (mx > max) max = mx;
      }

      const top = mid - max * mid;
      const bottom = mid - min * mid;
      bars.push({ x, top, height: Math.max(1, bottom - top) });
    }
    return bars;
  }

  root.WaveformRender = { waveformBars };

  if (typeof module !== 'undefined') {
    module.exports = root.WaveformRender;
  }

})(typeof globalThis !== 'undefined' ? globalThis : this);
