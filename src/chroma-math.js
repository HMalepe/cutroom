/*
 * chroma-math.js
 * ---------------------------------------------------------------------------
 * The colour maths behind the live key preview. Pure, no DOM, no WebGL, so it
 * can be unit-tested against known values — which matters more here than
 * anywhere else in the app, because a preview that disagrees with the export
 * is worse than no preview at all. It teaches you the wrong slider settings
 * and you only find out after a full render.
 *
 * Everything in this file is a port of what ffmpeg actually does, taken from
 * the filter sources rather than from the documentation:
 *
 *   libavfilter/vf_chromakey.c   chromakey=<colour>:<similarity>:<blend>
 *   libavfilter/vf_despill.c     despill=type=green:mix=0.5:expand=0
 *   libavfilter/vf_eq.h          eq=brightness=..:contrast=..:saturation=..
 *
 * That last one is vf_eq.h and not vf_eq.c on purpose — see the eq section.
 *
 * `shared/ffmpeg-builder.js` is the authority on which of those run and in
 * what order; `buildVideoClipChain` puts them in this sequence, and so do we:
 *
 *   scale -> eq -> chromakey -> despill
 *
 * The order is not cosmetic. eq runs on the YUV planes, so raising saturation
 * moves U and V, which moves what chromakey measures. Key first and the same
 * slider values give a different matte.
 *
 * Units. ffmpeg works on 8-bit planes, so every YUV value here is 0..255 and
 * every RGB value is 0..255 unless the name says otherwise. Alpha comes back
 * 0..1 because that is what a shader and a canvas both want.
 *
 * Where we knowingly differ from the export, the comment says so and starts
 * with the word APPROXIMATION.
 *
 * How close it gets. Measured against the real filter chain run over a frame
 * already in yuv420p, which is what every decoded file is: the matte agrees
 * within 4/255 of alpha at every pixel, on a green-screen frame and on
 * per-pixel colour noise alike. The residual is the one approximation that
 * cannot be removed from a browser — see the RGB <-> YUV section.
 */

'use strict';

(function (root) {

  // ------------------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------------------

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  /**
   * #RGB, #RRGGBB, 0xRRGGBB or a bare RRGGBB -> [r, g, b] as 0..255.
   * The inspector's colour input emits #rrggbb; the project file may hold
   * 0xRRGGBB because that is the form the ffmpeg builder writes.
   */
  function hexToRgb(hex) {
    let s = String(hex == null ? '' : hex).trim();
    if (s.startsWith('#')) s = s.slice(1);
    else if (/^0x/i.test(s)) s = s.slice(2);

    if (/^[0-9a-f]{3}$/i.test(s)) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    if (!/^[0-9a-f]{6}$/i.test(s)) return [0, 255, 0]; // same silent default as the builder

    return [
      parseInt(s.slice(0, 2), 16),
      parseInt(s.slice(2, 4), 16),
      parseInt(s.slice(4, 6), 16)
    ];
  }

  // ------------------------------------------------------------------------
  // The key colour -> U, V
  // ------------------------------------------------------------------------

  /*
   * vf_chromakey.c turns the `color` option into a pair of chroma bytes with
   * fixed-point integer arithmetic, at 10 fractional bits:
   *
   *   #define FIXNUM(x) lrint((x) * (1 << 10))
   *   #define RGB_TO_U(rgb) (((- FIXNUM(0.16874) * rgb[0] - FIXNUM(0.33126) * rgb[1] \
   *                            + FIXNUM(0.50000) * rgb[2] + (1 << 9) - 1) >> 10) + 128)
   *   #define RGB_TO_V(rgb) (((  FIXNUM(0.50000) * rgb[0] - FIXNUM(0.41869) * rgb[1] \
   *                            - FIXNUM(0.08131) * rgb[2] + (1 << 9) - 1) >> 10) + 128)
   *
   * Two things about it are worth knowing rather than smoothing over.
   *
   * First, those are the FULL-range BT.601 coefficients, while the frame the
   * key is measured against is almost always limited-range video. ffmpeg does
   * not reconcile the two, so the key colour lands a few units away from where
   * the identical colour sits in the picture. That is a large part of why
   * `#00FF00` keys real footage badly and why the README tells you to use
   * "Pick colour from clip" first. We reproduce the quirk exactly rather than
   * fixing it, because matching the export is the whole point.
   *
   * Second, `>>` is an arithmetic shift, so it floors rather than truncating
   * toward zero. JavaScript's `>>` does the same thing on the same 32-bit
   * signed range, and every intermediate here fits well inside it, so the port
   * is exact and not merely close.
   */
  const FIX_U_R = Math.round(0.16874 * 1024); // 173
  const FIX_U_G = Math.round(0.33126 * 1024); // 339
  const FIX_UV_HALF = Math.round(0.50000 * 1024); // 512
  const FIX_V_G = Math.round(0.41869 * 1024); // 429
  const FIX_V_B = Math.round(0.08131 * 1024); // 83

  /** [r,g,b] 0..255 -> { u, v } 0..255, exactly as vf_chromakey.c computes it. */
  function rgbToKeyUV(rgb) {
    const r = rgb[0] | 0, g = rgb[1] | 0, b = rgb[2] | 0;
    const u = (((-FIX_U_R * r - FIX_U_G * g + FIX_UV_HALF * b + 511) >> 10) + 128);
    const v = (((FIX_UV_HALF * r - FIX_V_G * g - FIX_V_B * b + 511) >> 10) + 128);
    return { u, v };
  }

  /** Convenience: '#00FF00' -> { u: 44, v: 21 }. */
  function keyUVFromHex(hex) {
    return rgbToKeyUV(hexToRgb(hex));
  }

  // ------------------------------------------------------------------------
  // Frame RGB <-> YUV
  // ------------------------------------------------------------------------

  /*
   * APPROXIMATION, and the biggest one in the file.
   *
   * ffmpeg keys the decoder's actual chroma planes. A browser hands us a
   * <video> already converted to RGB, so to measure the same distance we have
   * to convert back — which means guessing the matrix and range the file was
   * encoded with. A <video> element does not expose either.
   *
   * We assume limited-range BT.601, which is what swscale itself assumes for
   * untagged input and what the great majority of phone and webcam footage
   * carries. On a BT.709-tagged 1080p file the reconstructed U and V drift by
   * a few units, which shifts the *effective* similarity slightly; the fix, if
   * it ever matters, is to probe the stream's colour tags in main.js and pass
   * the matrix name through, which is why this is a parameter and not baked in.
   *
   * Sampling the colour with "Pick colour from clip" makes the drift mostly
   * self-cancelling anyway: the eyedropper samples an RGB frame and the key
   * colour then travels through the same conversion the preview does.
   */

  /**
   * Each entry gives the forward RGB(0..255) -> YUV(0..255) transform as a
   * 3x3 matrix plus an offset. The inverse is derived from it at load time so
   * there is exactly one set of numbers to get wrong.
   */
  const MATRICES = {
    // ITU-R BT.601, limited range (Y 16..235, C 16..240). The default.
    'bt601': {
      m: [
        [65.481 / 255, 128.553 / 255, 24.966 / 255],
        [-37.797 / 255, -74.203 / 255, 112.000 / 255],
        [112.000 / 255, -93.786 / 255, -18.214 / 255]
      ],
      off: [16, 128, 128]
    },
    // ITU-R BT.709, limited range. Correct for most HD material.
    'bt709': {
      m: [
        [219 * 0.2126 / 255, 219 * 0.7152 / 255, 219 * 0.0722 / 255],
        [224 * -0.114572 / 255, 224 * -0.385428 / 255, 224 * 0.500000 / 255],
        [224 * 0.500000 / 255, 224 * -0.454153 / 255, 224 * -0.045847 / 255]
      ],
      off: [16, 128, 128]
    },
    // BT.601 full range (JPEG). What a PNG or a screen recording may carry.
    'bt601-full': {
      m: [
        [0.299, 0.587, 0.114],
        [-0.168736, -0.331264, 0.500000],
        [0.500000, -0.418688, -0.081312]
      ],
      off: [0, 128, 128]
    }
  };

  const DEFAULT_MATRIX = 'bt601';

  /** Inverse of a 3x3, by cofactors. Small enough that this is the clear way. */
  function invert3x3(m) {
    const [[a, b, c], [d, e, f], [g, h, i]] = m;
    const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if (!det) throw new Error('singular colour matrix');
    return [
      [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
      [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
      [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det]
    ];
  }

  for (const name of Object.keys(MATRICES)) {
    MATRICES[name].inv = invert3x3(MATRICES[name].m);
  }

  function matrixFor(name) {
    return MATRICES[name] || MATRICES[DEFAULT_MATRIX];
  }

  /**
   * RGB 0..255 -> YUV 0..255. Not clamped: chromakey measures a distance, and
   * clamping here would flatten out-of-gamut pixels into a false match.
   */
  function rgbToYuv(r, g, b, matrixName) {
    const { m, off } = matrixFor(matrixName);
    return {
      y: m[0][0] * r + m[0][1] * g + m[0][2] * b + off[0],
      u: m[1][0] * r + m[1][1] * g + m[1][2] * b + off[1],
      v: m[2][0] * r + m[2][1] * g + m[2][2] * b + off[2]
    };
  }

  /** YUV 0..255 -> RGB 0..255, clamped, because this one is going on screen. */
  function yuvToRgb(y, u, v, matrixName) {
    const { inv, off } = matrixFor(matrixName);
    const a = y - off[0], b = u - off[1], c = v - off[2];
    return {
      r: clamp(inv[0][0] * a + inv[0][1] * b + inv[0][2] * c, 0, 255),
      g: clamp(inv[1][0] * a + inv[1][1] * b + inv[1][2] * c, 0, 255),
      b: clamp(inv[2][0] * a + inv[2][1] * b + inv[2][2] * c, 0, 255)
    };
  }

  // ------------------------------------------------------------------------
  // eq
  // ------------------------------------------------------------------------

  /*
   * The obvious thing to port here is create_lut() at the top of vf_eq.c, and
   * it is the wrong one. check_values() picks between three paths:
   *
   *   contrast == 1 && brightness == 0 && gamma == 1  ->  plain copy
   *   gamma == 1 && |contrast| < 7.9                  ->  eq->process
   *   otherwise                                       ->  apply_lut
   *
   * `eq->process` is process_c, in vf_eq.h, and it is integer arithmetic that
   * does not agree with the float lookup:
   *
   *   int contrast   = (int)(param->contrast * 256 * 16);
   *   int brightness = ((int)(100.0 * param->brightness + 100.0) * 511) / 200
   *                    - 128 - contrast / 32;
   *   int pel = ((src[i] * contrast) >> 12) + brightness;
   *   if (pel & ~255) pel = (-pel) >> 31;      // 0 if negative, 255 if over
   *
   * The builder never emits a gamma and the sliders top out at contrast 2 and
   * saturation 2.5, so process_c is the path every clip in this app takes, and
   * the lookup is unreachable. Porting create_lut instead put the preview four
   * or five 8-bit codes off the export on any graded clip — caught by running
   * the real filter chain over a known frame and diffing, not by reading.
   *
   * Luma uses (contrast, brightness); both chroma planes use (saturation, 0).
   *
   * Every step is exact in a float32 shader too: the largest intermediate is
   * 255 * contrast, and contrast tops out around 10240, so the product stays
   * well inside a 24-bit mantissa.
   */
  function eqPlane(value, contrast, brightness) {
    // check_values(): at the defaults the plane is copied, not processed.
    if (contrast === 1 && brightness === 0) return value;

    const c = Math.trunc(contrast * 256 * 16);
    const b = Math.trunc(Math.trunc(100 * brightness + 100) * 511 / 200)
      - 128 - Math.trunc(c / 32);

    // >> 12 on a signed int floors; C's integer divisions above truncate
    // toward zero. They are different operations and both matter.
    const pel = Math.floor(value * c / 4096) + b;
    if (pel < 0) return 0;
    if (pel > 255) return 255;
    return pel;
  }

  const eqLuma = (y, filters) =>
    eqPlane(y, num(filters && filters.contrast, 1), num(filters && filters.brightness, 0));

  const eqChroma = (c, filters) =>
    eqPlane(c, num(filters && filters.saturation, 1), 0);

  function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  // ------------------------------------------------------------------------
  // chromakey
  // ------------------------------------------------------------------------

  /*
   * do_chromakey_pixel(), verbatim:
   *
   *   for (i = 0; i < 9; ++i) {
   *       du = u[i] - chromakey_uv[0];
   *       dv = v[i] - chromakey_uv[1];
   *       diff += sqrt((du * du + dv * dv) / (255.0 * 255.0 * 2));
   *   }
   *   diff /= 9.0;
   *
   * The nine samples are a 3x3 neighbourhood, and averaging the square roots
   * rather than the squares is what gives the filter its particular softness —
   * do it the other way and edges come out harder than the export's.
   *
   * ffmpeg reads the neighbourhood from the chroma planes of a yuva420p frame,
   * at pixel offsets x-1, x, x+1 that are then shifted right by one. So the
   * nine taps collapse onto four distinct chroma cells with weights 1, 2, 2, 4.
   * `chromaTaps` below reproduces that indexing; the shader does the same thing
   * against the video texture.
   *
   * Out-of-frame taps are left at the key colour itself (the arrays are memset
   * to chromakey_uv before the loop), so they contribute nothing to the sum —
   * the border of a clip keys slightly more eagerly than its middle. Callers
   * reproduce that by returning the key colour for samples outside the frame.
   */
  function chromakeyDiff(samples, keyUV) {
    let diff = 0;
    for (let i = 0; i < samples.length; i++) {
      const du = samples[i].u - keyUV.u;
      const dv = samples[i].v - keyUV.v;
      diff += Math.sqrt((du * du + dv * dv) / (255 * 255 * 2));
    }
    return diff / samples.length;
  }

  /** The matte, 0 (transparent, keyed out) .. 1 (opaque, kept). */
  function chromakeyAlpha(samples, keyUV, similarity, blend) {
    const diff = chromakeyDiff(samples, keyUV);
    return alphaFromDiff(diff, similarity, blend);
  }

  /** Split out because the shader needs the same branch on its own diff. */
  function alphaFromDiff(diff, similarity, blend) {
    // 0.0001 is ffmpeg's own threshold for "blend is effectively zero", not a
    // guess at one. Below it the key is a hard cut with no feathering at all.
    if (blend > 0.0001) return clamp((diff - similarity) / blend, 0, 1);
    return diff > similarity ? 1 : 0;
  }

  /**
   * The nine chroma taps ffmpeg reads for output pixel (x, y) of a 4:2:0
   * frame, as integer chroma-plane cells. Returned in ffmpeg's own order so a
   * test can compare tap for tap.
   */
  function chromaTaps(x, y) {
    const taps = [];
    for (let yo = 0; yo < 3; yo++) {
      for (let xo = 0; xo < 3; xo++) {
        taps.push({ cx: (x + xo - 1) >> 1, cy: (y + yo - 1) >> 1 });
      }
    }
    return taps;
  }

  // ------------------------------------------------------------------------
  // despill
  // ------------------------------------------------------------------------

  /*
   * do_despill_slice(), for `type=green`:
   *
   *   factor   = (1 - mix) * (1 - expand);
   *   spillmap = max(green - (red * mix + blue * factor), 0);
   *   red     += spillmap * redscale   + brightness * spillmap;
   *   green   += spillmap * greenscale + brightness * spillmap;
   *   blue    += spillmap * bluescale  + brightness * spillmap;
   *
   * The export uses the defaults for everything it does not name, so
   * redscale = 0, greenscale = -1, bluescale = 0, brightness = 0: green loses
   * exactly its excess over the red/blue average and nothing else moves.
   *
   * Works on 0..1 RGB, as the filter does.
   */
  function despillGreen(r, g, b, opts) {
    const mix = num(opts && opts.mix, 0.5);
    const expand = num(opts && opts.expand, 0);
    const redscale = num(opts && opts.redscale, 0);
    const greenscale = num(opts && opts.greenscale, -1);
    const bluescale = num(opts && opts.bluescale, 0);
    const brightness = num(opts && opts.brightness, 0);

    const factor = (1 - mix) * (1 - expand);
    const spill = Math.max(g - (r * mix + b * factor), 0);

    return {
      r: Math.max(r + spill * redscale + brightness * spill, 0),
      g: Math.max(g + spill * greenscale + brightness * spill, 0),
      b: Math.max(b + spill * bluescale + brightness * spill, 0)
    };
  }

  // ------------------------------------------------------------------------
  // scale / position, so the preview frames the clip the way the export will
  // ------------------------------------------------------------------------

  /*
   * `scale=w:h:force_original_aspect_ratio=decrease`, from vf_scale.c:
   *
   *   tmp_w = av_rescale(out_h, in_w, in_h);
   *   tmp_h = av_rescale(out_w, in_h, in_w);
   *   out_w = FFMIN(tmp_w, out_w);
   *   out_h = FFMIN(tmp_h, out_h);
   *
   * av_rescale rounds to nearest, so this is not the same as flooring a ratio.
   */
  function fitDecrease(srcW, srcH, boxW, boxH) {
    if (!srcW || !srcH) return { w: boxW, h: boxH };
    const tmpW = Math.round(boxH * srcW / srcH);
    const tmpH = Math.round(boxW * srcH / srcW);
    return { w: Math.min(tmpW, boxW), h: Math.min(tmpH, boxH) };
  }

  /**
   * Where the scaled clip lands on the canvas. The builder writes the overlay
   * position as `(W-w)/2+posX`, which ffmpeg evaluates as a double and then
   * truncates into an int — hence Math.trunc rather than round.
   */
  function overlayRect(clip, srcW, srcH, canvasW, canvasH) {
    const scale = num(clip && clip.scale, 1);
    const box = fitDecrease(srcW, srcH, Math.round(canvasW * scale), Math.round(canvasH * scale));
    return {
      x: Math.trunc((canvasW - box.w) / 2) + Math.round(num(clip && clip.posX, 0)),
      y: Math.trunc((canvasH - box.h) / 2) + Math.round(num(clip && clip.posY, 0)),
      w: box.w,
      h: box.h
    };
  }

  // ------------------------------------------------------------------------
  // The whole chain, for one pixel
  // ------------------------------------------------------------------------

  /**
   * Scalar reference implementation of what the fragment shader does. Nothing
   * in the app calls it — the shader is what runs — but it is the thing the
   * shader is checked against, so it is the definition of correct and the
   * place to read if you want to know what the preview is doing.
   *
   * @param {object} args
   * @param {number[]} args.rgb          the pixel being shaded, 0..255
   * @param {number[][]} [args.taps]     nine neighbour RGB triples in ffmpeg's
   *                                     order; defaults to nine copies of rgb,
   *                                     which is what a flat region gives
   * @param {object} [args.chroma]       clip.chroma
   * @param {object} [args.filters]      clip.filters
   * @param {string} [args.matrix]       a key of MATRICES
   * @returns {{r:number,g:number,b:number,a:number}} RGB 0..255, alpha 0..1
   */
  function shadeClipPixel(args) {
    const matrix = args.matrix || DEFAULT_MATRIX;
    const filters = args.filters || {};
    const chroma = args.chroma || {};
    const rgb = args.rgb;

    // 1. eq, on the YUV planes, before the key — the order the export uses.
    const c = rgbToYuv(rgb[0], rgb[1], rgb[2], matrix);
    const y = eqLuma(c.y, filters);
    const u = eqChroma(c.u, filters);
    const v = eqChroma(c.v, filters);

    const lit = yuvToRgb(y, u, v, matrix);
    let out = { r: lit.r, g: lit.g, b: lit.b };
    let alpha = 1;

    if (chroma.on) {
      // 2. chromakey, over the neighbourhood, against eq'd chroma.
      const keyUV = keyUVFromHex(chroma.color);
      const taps = args.taps || [rgb, rgb, rgb, rgb, rgb, rgb, rgb, rgb, rgb];
      const samples = taps.map(t => {
        const s = rgbToYuv(t[0], t[1], t[2], matrix);
        return { u: eqChroma(s.u, filters), v: eqChroma(s.v, filters) };
      });
      alpha = chromakeyAlpha(
        samples, keyUV,
        num(chroma.similarity, 0.1),
        num(chroma.blend, 0.05)
      );

      // 3. despill, in RGB, on whatever survived.
      const d = despillGreen(out.r / 255, out.g / 255, out.b / 255, {});
      out = { r: d.r * 255, g: d.g * 255, b: d.b * 255 };
    }

    return { r: out.r, g: out.g, b: out.b, a: alpha };
  }

  // ------------------------------------------------------------------------

  const api = {
    hexToRgb,
    rgbToKeyUV,
    keyUVFromHex,
    MATRICES,
    DEFAULT_MATRIX,
    matrixFor,
    invert3x3,
    rgbToYuv,
    yuvToRgb,
    eqPlane,
    eqLuma,
    eqChroma,
    chromakeyDiff,
    chromakeyAlpha,
    alphaFromDiff,
    chromaTaps,
    despillGreen,
    fitDecrease,
    overlayRect,
    shadeClipPixel,
    clamp
  };

  root.ChromaMath = api;

  if (typeof module !== 'undefined') module.exports = api;

})(typeof globalThis !== 'undefined' ? globalThis : this);
