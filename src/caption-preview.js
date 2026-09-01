/*
 * caption-preview.js
 * ---------------------------------------------------------------------------
 * Decides what the caption overlay should be showing at a given instant:
 * which caption row (if any) is active, the entry-animation state for
 * 'fade'/'pop'/'slide', which words are "spoken" for a real per-word
 * typewriter sweep, and the ASS-to-CSS unit conversion the overlay's sizing
 * rides on. Pure and DOM-free, the same split timeline-preview.js draws
 * between deciding what's active and app.js drawing it — the caption
 * overlay's own DOM wiring (src/app.js's syncCaptionOverlay/
 * applyCaptionOverlay) is what turns these answers into an actual styled
 * <div>.
 *
 * This is an HTML/CSS approximation of a real libass render, not a port of
 * one — see the README's "Captions in the preview" section for exactly what
 * it does and does not attempt, and why.
 */

'use strict';

(function (root) {

  function clamp01(v) {
    return Math.min(1, Math.max(0, v));
  }

  // These mirror the literal millisecond values buildAssFile writes into the
  // \fad / \t / \move tags for the 'fade' / 'pop' / 'slide' animations (see
  // shared/ffmpeg-builder.js). shared/ never reaches the renderer, so — the
  // same duplication timeline-preview.js's TRANSITION_TYPES already accepts
  // for the same reason — these are kept in sync by hand rather than
  // imported; test/caption-preview.test.js pins them against buildAssFile's
  // own output so the two cannot quietly drift apart.
  const FADE_SEC = 0.12;
  const POP_SEC = 0.14;
  const SLIDE_SEC = 0.16;

  /**
   * Which caption row (if any) is on screen at timeline time t. `end` is
   * exclusive, the same convention timeline-preview.js's trackStateAt uses
   * for a clip's own window. Caption rows are a flat, independently-timed
   * list — nothing in the caption editor stops two from overlapping — so
   * more than one can be active at once; this does not stack them the way a
   * real libass render would, it picks the later-starting one, the same
   * tie-break trackStateAt's own 'solo' case uses for overlapping clips.
   * That is a stated approximation, not an attempt at real collision
   * layout — see the README.
   */
  function activeCaptionAt(captions, t) {
    let best = null;
    for (const c of (captions || [])) {
      if (!c || typeof c.start !== 'number' || typeof c.end !== 'number') continue;
      if (t >= c.start && t < c.end) {
        if (!best || c.start > best.start) best = c;
      }
    }
    return best;
  }

  /**
   * Opacity / scale / lift for the 'fade', 'pop' and 'slide' entry
   * animations, as a pure function of elapsed time since the caption's own
   * start and time remaining before its end. buildAssFile's \fad/\t/\move
   * tags are themselves pure functions of local Dialogue time — an ASS
   * renderer computes the right frame for whatever timestamp it is asked
   * for, it does not "replay" an animation from a trigger — so this can be
   * called straight from a scrub that lands mid-caption and gives the right
   * answer immediately, with no need to detect "just became active" and
   * restart a CSS animation by hand.
   *
   * 'typewriter' is not answered here — see karaokeWordStates — and 'none'
   * or anything unrecognised is the identity state.
   */
  function animationState(animation, elapsed, remaining) {
    const e = Math.max(0, elapsed);
    const r = Math.max(0, remaining);
    if (animation === 'fade') {
      // \fad(120,120): opacity ramps 0->1 over the first 120ms and 1->0 over
      // the last 120ms. min() is what makes a caption shorter than 240ms
      // fade both ways at once rather than snapping to fully opaque between
      // two overlapping ramps.
      const opacity = Math.min(clamp01(e / FADE_SEC), clamp01(r / FADE_SEC));
      return { opacity, scale: 1, lift: 0 };
    }
    if (animation === 'pop') {
      // \fscx60\fscy60\t(0,140,\fscx100\fscy100): scale ramps 60%->100% over
      // the first 140ms, then holds.
      const scale = 0.6 + 0.4 * clamp01(e / POP_SEC);
      return { opacity: 1, scale, lift: 0 };
    }
    if (animation === 'slide') {
      // \move(...,0,160): the real tag interpolates position over the first
      // 160ms too; `lift` is 1 at the caption's own start and 0 once settled,
      // for the DOM layer to turn into an upward translate.
      const lift = 1 - clamp01(e / SLIDE_SEC);
      return { opacity: 1, scale: 1, lift };
    }
    return { opacity: 1, scale: 1, lift: 0 };
  }

  /**
   * Per-word spoken/unspoken state for the typewriter animation, when the
   * caption carries real per-word timestamps (see groupWordsIntoCaptions in
   * shared/ffmpeg-builder.js). A word's ASS \k tag switches it from
   * SecondaryColour to PrimaryColour the instant the word's own start
   * arrives, and never reverts — see karaokeText's own comment for why that
   * is the trigger instant rather than the (later) point its own \k
   * duration ends — so "spoken" here is exactly `t >= word.start`.
   *
   * Returns null, not an empty array, for a caption with no `words`, so the
   * caller can tell "no real per-word timing to show" apart from "zero
   * words" — a hand-typed line, an imported .srt/.vtt, or a transcribed row
   * whose text or timing was subsequently hand-edited all land here, and
   * none of them have a word-by-word sweep to approximate; see the README
   * for why that is a stated gap rather than an attempt at the old
   * even-split-by-character fallback buildAssFile itself uses for them.
   */
  function karaokeWordStates(caption, t) {
    if (!caption || !Array.isArray(caption.words)) return null;
    return caption.words.map(w => ({ text: w.text, spoken: t >= w.start }));
  }

  /**
   * An ASS-space measurement (relative to the project's own height, the way
   * PlayResY/fontsize/MarginV all are) converted to real CSS pixels for the
   * overlay's own rendered box. `stageHeightPx` is the composited stage's
   * own measured height (app.js reads #previewStage.clientHeight each
   * draw); 0 — no real layout yet, which is what jsdom always reports,
   * never having a real layout engine to begin with — falls back to 1:1
   * with the project's own height, so an ASS unit becomes exactly one CSS
   * pixel rather than a NaN or an Infinity. That fallback is also what
   * every jsdom test in test/caption-overlay.test.js that checks a computed
   * size is actually exercising: real proportional scaling against a real
   * rendered box needs a real browser to prove, the same way the WebGL
   * compositing itself does — see the README.
   */
  function scaledPx(assUnits, stageHeightPx, projectHeight) {
    const H = Number(projectHeight) || 1;
    const stage = Number(stageHeightPx) || H;
    return (Number(assUnits) || 0) * (stage / H);
  }

  root.CaptionPreview = {
    FADE_SEC, POP_SEC, SLIDE_SEC,
    activeCaptionAt, animationState, karaokeWordStates, scaledPx
  };

  if (typeof module !== 'undefined') {
    module.exports = root.CaptionPreview;
  }

})(typeof globalThis !== 'undefined' ? globalThis : this);
