/*
 * key-preview.js
 * ---------------------------------------------------------------------------
 * Draws a <video> into a <canvas> through a WebGL fragment shader that keys,
 * colour-corrects, scales and positions the frame the way the export will.
 *
 * The maths lives in chroma-math.js and is unit-tested there. This file is the
 * plumbing: a program, a quad, a texture per frame, and a set of uniforms. The
 * shader is a line-for-line mirror of `shadeClipPixel` in that module — if you
 * change one, change the other, and the comments in chroma-math.js are the
 * explanation for both.
 *
 * Why a shader at all: keying is a per-pixel job with a 3x3 neighbourhood, so
 * a 1080p frame is about twenty million square roots. Canvas 2D and a JS loop
 * cannot do that thirty times a second; a GPU does not notice it.
 *
 * Degrading. `create()` returns null when there is no WebGL context to be had
 * — a machine without it, a lost context, or jsdom in the test suite — and the
 * caller falls back to the plain <video> the preview used before. Nothing here
 * runs at import time, so loading the file is always safe.
 *
 * Content-Security-Policy. index.html sets `default-src 'self'` with no
 * script-src, so inline <script> and any CDN are silently dead. Shader source
 * as a JS string in a file loaded by <script src> is fine, which is why it is
 * written that way rather than in the <script type="x-shader"> block you would
 * normally see.
 */

'use strict';

(function (root) {

  // Looked up lazily rather than captured at load time: index.html loads
  // chroma-math.js first, but nothing here should break if a future edit to
  // the script order gets that wrong.
  const M = () => root.ChromaMath;

  // Projects are 1080p-ish, so the canvas is normally the project size exactly
  // and every pixel index in the shader matches the pixel index ffmpeg will
  // work on. Above this the backing store is scaled down: the key still looks
  // right, but the 4:2:0 chroma grid no longer lands on the same pixels, so a
  // 4K project's preview is very slightly softer than its export.
  const MAX_EDGE = 1920;

  // --------------------------------------------------------------------------
  // Shaders
  // --------------------------------------------------------------------------

  // vUv is 0..1 across the canvas with (0,0) at the TOP-left, which is also
  // where texture coordinate (0,0) lands for a texture uploaded from a video
  // element without UNPACK_FLIP_Y_WEBGL. Keeping both in the same orientation
  // is the whole reason the quad is written out by hand.
  const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

  const FRAG = `
precision highp float;

varying vec2 vUv;

uniform sampler2D uTex;
uniform vec2 uCanvasSize;   // backing-store size in pixels
uniform vec4 uClipRect;     // x, y, w, h of the scaled clip, canvas pixels

uniform mat3 uFwd;          // RGB(0..255) -> YUV(0..255), minus the offset
uniform mat3 uInv;          // and back
uniform vec3 uOff;          // the offset, shared by both directions

uniform vec2 uKeyUV;
uniform float uSimilarity;
uniform float uBlend;
uniform float uChromaOn;

uniform float uContrast;
uniform float uBrightness;
uniform float uSaturation;
uniform float uEqLumaOn;    // ffmpeg skips the LUT entirely at the defaults,
uniform float uEqChromaOn;  // so we skip it too rather than round-tripping

uniform float uDespillMix;
uniform float uDespillFactor;

vec3 toYuv(vec3 rgb255) { return uFwd * rgb255 + uOff; }
vec3 toRgb(vec3 yuv)    { return clamp(uInv * (yuv - uOff), 0.0, 255.0); }

// process_c() from vf_eq.h — the path vf_eq actually takes at the default
// gamma, NOT the create_lut() at the top of vf_eq.c, which only runs for a
// gamma this app never sets. Integer arithmetic, reproduced with floor(): the
// largest intermediate is 255 * contrast, which stays inside a float mantissa.
// floor() stands in for both C's >> and its truncating integer division, which
// agree here because the sliders cannot make contrast or brightness negative
// enough to send any of these intermediates below zero.
float eqPlane(float value, float contrast, float brightness, float on) {
  float c = floor(contrast * 4096.0);
  float b = floor(floor(100.0 * brightness + 100.0) * 511.0 / 200.0)
          - 128.0 - floor(c / 32.0);
  float pel = clamp(floor(value * c / 4096.0) + b, 0.0, 255.0);
  return mix(value, pel, on);
}

// The chroma pair ffmpeg would read for clip-local pixel pxy of a yuva420p
// frame. floor(pxy * 0.5) is the 4:2:0 cell; sampling the texture exactly on
// the boundary between the cell's two pixels makes the linear filter average
// them, which is close to how the chroma plane was subsampled in the first
// place. Taps outside the frame return the key colour, because vf_chromakey.c
// memsets its sample arrays to the key before reading and never overwrites an
// out-of-bounds one — so the edge of a clip keys slightly more eagerly.
vec2 sampleUV(vec2 pxy) {
  vec2 cell = floor(pxy * 0.5) * 2.0 + 1.0;
  vec3 rgb = texture2D(uTex, clamp(cell / uClipRect.zw, 0.0, 1.0)).rgb * 255.0;
  vec3 yuv = toYuv(rgb);
  vec2 uv = vec2(eqPlane(yuv.y, uSaturation, 0.0, uEqChromaOn),
                 eqPlane(yuv.z, uSaturation, 0.0, uEqChromaOn));
  float inside = step(0.0, pxy.x) * step(0.0, pxy.y)
               * step(pxy.x, uClipRect.z - 1.0) * step(pxy.y, uClipRect.w - 1.0);
  return mix(uKeyUV, uv, inside);
}

void main() {
  vec2 pxy = floor(vUv * uCanvasSize - uClipRect.xy);

  // Outside the scaled clip is canvas, and canvas is transparent — the same
  // thing the export gets from overlaying onto a black frame with alpha.
  float onClip = step(0.0, pxy.x) * step(0.0, pxy.y)
               * step(pxy.x, uClipRect.z - 1.0) * step(pxy.y, uClipRect.w - 1.0);

  vec3 rgb = texture2D(uTex, clamp((pxy + 0.5) / uClipRect.zw, 0.0, 1.0)).rgb * 255.0;

  // 1. eq, on the YUV planes, before the key. Raising saturation moves U and
  //    V, which moves what the key measures — same as the export.
  vec3 yuv = toYuv(rgb);
  yuv.x = eqPlane(yuv.x, uContrast, uBrightness, uEqLumaOn);
  yuv.y = eqPlane(yuv.y, uSaturation, 0.0, uEqChromaOn);
  yuv.z = eqPlane(yuv.z, uSaturation, 0.0, uEqChromaOn);
  vec3 lit = toRgb(yuv) / 255.0;

  float alpha = 1.0;

  if (uChromaOn > 0.5) {
    // 2. chromakey over the 3x3 neighbourhood. Averaging the square roots,
    //    not the squares — that is where the filter's softness comes from.
    float diff = 0.0;
    for (int yo = 0; yo < 3; yo++) {
      for (int xo = 0; xo < 3; xo++) {
        vec2 d = sampleUV(pxy + vec2(float(xo) - 1.0, float(yo) - 1.0)) - uKeyUV;
        diff += sqrt(dot(d, d) / (255.0 * 255.0 * 2.0));
      }
    }
    diff /= 9.0;

    alpha = uBlend > 0.0001
      ? clamp((diff - uSimilarity) / uBlend, 0.0, 1.0)
      : (diff > uSimilarity ? 1.0 : 0.0);

    // 3. despill=type=green:mix=..:expand=.., in RGB, on what survived.
    float spill = max(lit.g - (lit.r * uDespillMix + lit.b * uDespillFactor), 0.0);
    lit = max(lit - vec3(0.0, spill, 0.0), 0.0);
  }

  gl_FragColor = vec4(lit, alpha * onClip);
}
`;

  // --------------------------------------------------------------------------
  // Plumbing
  // --------------------------------------------------------------------------

  function compile(gl, type, source) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('shader compile failed: ' + log);
    }
    return sh;
  }

  function link(gl) {
    const prog = gl.createProgram();
    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error('shader link failed: ' + log);
    }
    return prog;
  }

  /** Row-major 3x3 from ChromaMath -> the column-major array WebGL wants. */
  function columnMajor(m) {
    return new Float32Array([
      m[0][0], m[1][0], m[2][0],
      m[0][1], m[1][1], m[2][1],
      m[0][2], m[1][2], m[2][2]
    ]);
  }

  function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  // --------------------------------------------------------------------------
  // Loop / speed
  // --------------------------------------------------------------------------

  /*
   * The preview draws whatever frame is currently decoded, so making it show
   * the clip's trim and speed is entirely a matter of driving the <video>
   * element's own playback rather than anything in the shader: play between
   * inSec and outSec, at playbackRate = clip.speed, and jump back to inSec
   * whenever playback reaches outSec.
   *
   * HTMLMediaElement.playbackRate has no clamp in the spec — a UA is free to
   * just ignore an unsupported value — but real browsers do clamp rather than
   * ignore. Chromium's HTMLMediaElement (kMinRate/kMaxRate in
   * html_media_element.cc) enforces exactly [0.0625, 16], and other engines
   * land in the same neighbourhood. The UI never offers a clip speed outside
   * 0.25-4x, so this is a defensive floor/ceiling for a value that should
   * never reach it, not a range normal use will hit.
   */
  const MIN_PLAYBACK_RATE = 0.0625;
  const MAX_PLAYBACK_RATE = 16;

  function clampPlaybackRate(speed) {
    return Math.min(MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, num(speed, 1)));
  }

  /**
   * Decide how to drive the <video> element for one tick of the loop, given
   * where its playback currently sits. Pure and DOM-free — no video element
   * touched here — so the decision can be tested without a real one; the
   * caller is the part that reads video.currentTime and writes the result
   * back.
   *
   * @param {number} currentTime  video.currentTime, source seconds
   * @param {object} clip         a timeline clip, for inSec/outSec/speed
   * @returns {{ seekTo: number|null, playbackRate: number }}
   *   seekTo is the source time to jump to when currentTime has left
   *   [inSec, outSec), or null when the current position is fine as is.
   */
  function stepClipLoop(currentTime, clip) {
    const inSec = num(clip && clip.inSec, 0);
    const outSecRaw = num(clip && clip.outSec, inSec);
    // A zero-length or inverted trim has no window to loop across; hold at
    // inSec rather than dividing the loop away to nothing.
    const outSec = outSecRaw > inSec ? outSecRaw : inSec;
    const playbackRate = clampPlaybackRate(clip && clip.speed);
    const t = num(currentTime, inSec);

    const inRange = outSec > inSec && t >= inSec && t < outSec;
    return { seekTo: inRange ? null : inSec, playbackRate };
  }

  /**
   * @param {HTMLCanvasElement} canvas
   * @returns {object|null} null when there is no WebGL to be had, which is the
   *   caller's cue to fall back to the plain <video>.
   */
  function createKeyPreview(canvas) {
    if (!canvas || typeof canvas.getContext !== 'function') return null;

    const attrs = {
      alpha: true,
      // Straight alpha, not premultiplied: it keeps the shader's last line
      // honest and makes a readPixels comparison against ChromaMath direct.
      premultipliedAlpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false
    };

    let gl = null;
    try {
      gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs);
    } catch (err) {
      gl = null;
    }
    if (!gl) return null;

    let prog;
    try {
      prog = link(gl);
    } catch (err) {
      // A driver that advertises WebGL and then cannot compile this is not
      // worth fighting; the plain video is a perfectly good fallback.
      return null;
    }

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    const aPos = gl.getAttribLocation(prog, 'aPos');
    const u = {};
    for (const name of [
      'uTex', 'uCanvasSize', 'uClipRect', 'uFwd', 'uInv', 'uOff',
      'uKeyUV', 'uSimilarity', 'uBlend', 'uChromaOn',
      'uContrast', 'uBrightness', 'uSaturation', 'uEqLumaOn', 'uEqChromaOn',
      'uDespillMix', 'uDespillFactor'
    ]) {
      u[name] = gl.getUniformLocation(prog, name);
    }

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // No mipmaps and clamped edges, because video frames are almost never a
    // power of two and WebGL1 refuses to sample such a texture otherwise.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    let lost = false;
    const onLost = (e) => { e.preventDefault(); lost = true; };
    canvas.addEventListener('webglcontextlost', onLost);

    /**
     * Size the backing store for a project, returning the canvas dimensions
     * actually used. Kept separate from draw() so the caller can lay out
     * before a frame is available.
     */
    function resize(width, height) {
      const w = Math.max(1, Math.round(width || 1));
      const h = Math.max(1, Math.round(height || 1));
      const shrink = Math.min(1, MAX_EDGE / Math.max(w, h));
      const cw = Math.max(1, Math.round(w * shrink));
      const ch = Math.max(1, Math.round(h * shrink));
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }
      return { width: cw, height: ch };
    }

    /**
     * Render one frame.
     *
     * @param {HTMLVideoElement} video  must have metadata; earlier than that
     *   there are no dimensions to fit against and nothing is drawn
     * @param {object} clip             a timeline clip, for its chroma/filters
     * @param {object} project          for width/height and the matrix name
     * @returns {boolean} whether anything was drawn
     */
    function draw(video, clip, project) {
      if (lost || !video) return false;
      const vw = video.videoWidth | 0;
      const vh = video.videoHeight | 0;
      if (!vw || !vh) return false;

      const size = resize(project && project.width, project && project.height);
      const scaleToCanvas = size.width / Math.max(1, num(project && project.width, size.width));

      // Where the scaled clip lands, in project pixels, then in canvas pixels.
      // Both are the same number unless MAX_EDGE shrank the backing store.
      const rect = M().overlayRect(
        clip || {}, vw, vh,
        num(project && project.width, size.width),
        num(project && project.height, size.height)
      );

      const chroma = (clip && clip.chroma) || {};
      const filters = (clip && clip.filters) || {};
      const matrix = M().matrixFor((project && project.colorMatrix) || M().DEFAULT_MATRIX);
      const keyUV = M().keyUVFromHex(chroma.color);

      const contrast = num(filters.contrast, 1);
      const brightness = num(filters.brightness, 0);
      const saturation = num(filters.saturation, 1);

      const mix = 0.5;    // despill=type=green:mix=0.5:expand=0, as the
      const expand = 0;   // builder writes it. Not exposed in the UI.

      gl.bindTexture(gl.TEXTURE_2D, tex);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      } catch (err) {
        // A frame that is not decodable yet throws rather than returning null.
        return false;
      }

      gl.viewport(0, 0, size.width, size.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(u.uTex, 0);

      gl.uniform2f(u.uCanvasSize, size.width, size.height);
      gl.uniform4f(
        u.uClipRect,
        rect.x * scaleToCanvas, rect.y * scaleToCanvas,
        Math.max(1, rect.w * scaleToCanvas), Math.max(1, rect.h * scaleToCanvas)
      );

      gl.uniformMatrix3fv(u.uFwd, false, columnMajor(matrix.m));
      gl.uniformMatrix3fv(u.uInv, false, columnMajor(matrix.inv));
      gl.uniform3f(u.uOff, matrix.off[0], matrix.off[1], matrix.off[2]);

      gl.uniform2f(u.uKeyUV, keyUV.u, keyUV.v);
      gl.uniform1f(u.uSimilarity, num(chroma.similarity, 0.1));
      gl.uniform1f(u.uBlend, num(chroma.blend, 0.05));
      gl.uniform1f(u.uChromaOn, chroma.on ? 1 : 0);

      gl.uniform1f(u.uContrast, contrast);
      gl.uniform1f(u.uBrightness, brightness);
      gl.uniform1f(u.uSaturation, saturation);
      // Mirror vf_eq.c's check_values: at the defaults the plane is copied,
      // not run through a lookup that would shift it by a code or two.
      gl.uniform1f(u.uEqLumaOn, contrast === 1 && brightness === 0 ? 0 : 1);
      gl.uniform1f(u.uEqChromaOn, saturation === 1 ? 0 : 1);

      gl.uniform1f(u.uDespillMix, mix);
      gl.uniform1f(u.uDespillFactor, (1 - mix) * (1 - expand));

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return true;
    }

    function destroy() {
      canvas.removeEventListener('webglcontextlost', onLost);
      try {
        gl.deleteTexture(tex);
        gl.deleteBuffer(quad);
        gl.deleteProgram(prog);
      } catch (err) { /* context already gone; nothing to release */ }
    }

    return {
      gl,
      draw,
      resize,
      destroy,
      isLost: () => lost
    };
  }

  root.createKeyPreview = createKeyPreview;
  // Exported so the shader can be compiled and compared against ChromaMath
  // outside the app.
  root.KEY_PREVIEW_SHADERS = { VERT, FRAG };
  root.stepClipLoop = stepClipLoop;

  if (typeof module !== 'undefined') {
    module.exports = {
      createKeyPreview, VERT, FRAG, MAX_EDGE,
      stepClipLoop, clampPlaybackRate, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE
    };
  }

})(typeof globalThis !== 'undefined' ? globalThis : this);
