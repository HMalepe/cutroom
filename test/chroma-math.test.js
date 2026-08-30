'use strict';

/*
 * The colour maths behind the live key preview.
 *
 * This is the file that matters. The WebGL plumbing can only ever be
 * smoke-tested, but a preview whose maths disagrees with ffmpeg is worse than
 * no preview at all — it teaches you the wrong slider values and you find out
 * three minutes into a render. So the expected numbers here are not "whatever
 * the code returned when it was written". They are either
 *
 *   - derived by hand from the ffmpeg source the module claims to port
 *     (libavfilter/vf_chromakey.c, vf_despill.c, vf_eq.c, vf_scale.c), or
 *   - computed independently, outside JavaScript, and pasted in.
 *
 * A test that recomputes the answer with the same expression it is checking
 * proves only that the expression is deterministic, so there is none of that
 * below.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const M = require('../src/chroma-math.js');

/** Assert to a tolerance, with a message that shows both numbers. */
function near(actual, expected, eps, what) {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${what || 'value'}: expected ${expected} ± ${eps}, got ${actual}`
  );
}

/** Nine identical taps, which is what a flat patch of colour gives. */
const flat = (u, v) => Array.from({ length: 9 }, () => ({ u, v }));

// ==========================================================================
// hex parsing
// ==========================================================================

test('hex colours parse in every form the app can produce', () => {
  // The inspector's <input type="color"> writes #rrggbb...
  assert.deepEqual(M.hexToRgb('#00FF00'), [0, 255, 0]);
  assert.deepEqual(M.hexToRgb('#00ff00'), [0, 255, 0]);
  // ...the ffmpeg builder writes 0xRRGGBB...
  assert.deepEqual(M.hexToRgb('0x00FF00'), [0, 255, 0]);
  // ...and a hand-edited project file might hold either of these.
  assert.deepEqual(M.hexToRgb('00FF00'), [0, 255, 0]);
  assert.deepEqual(M.hexToRgb('#0f0'), [0, 255, 0]);
  assert.deepEqual(M.hexToRgb('#1a7a2f'), [0x1a, 0x7a, 0x2f]);
});

test('an unparseable colour falls back to green rather than to black', () => {
  // Black is a legitimate key colour, so defaulting to it would silently key
  // out every shadow in the shot. Green is the safe wrong answer here.
  assert.deepEqual(M.hexToRgb('nonsense'), [0, 255, 0]);
  assert.deepEqual(M.hexToRgb(''), [0, 255, 0]);
  assert.deepEqual(M.hexToRgb(null), [0, 255, 0]);
  assert.deepEqual(M.hexToRgb(undefined), [0, 255, 0]);
});

// ==========================================================================
// key colour -> U, V  (vf_chromakey.c RGB_TO_U / RGB_TO_V)
// ==========================================================================

test('the key colour converts exactly as vf_chromakey.c converts it', () => {
  // Computed outside JS from the macros in the filter source:
  //   U = ((-173*r - 339*g + 512*b + 511) >> 10) + 128
  //   V = (( 512*r - 429*g -  83*b + 511) >> 10) + 128
  const cases = [
    ['#00FF00', 44, 21],
    ['#FF0000', 85, 255],
    ['#0000FF', 255, 107],
    ['#000000', 128, 128],
    ['#FFFFFF', 128, 128],
    ['#1a7a2f', 107, 86]
  ];
  for (const [hex, u, v] of cases) {
    assert.deepEqual(M.keyUVFromHex(hex), { u, v }, hex);
  }
});

test('black and white land on the same key, which is why neither keys well', () => {
  // Both are chroma-neutral, so chromakey cannot tell them apart. Worth
  // pinning: it is the reason "key out the white background" does not work,
  // and someone will eventually try to "fix" the conversion over it.
  assert.deepEqual(M.keyUVFromHex('#000000'), M.keyUVFromHex('#FFFFFF'));
});

test('the fixed-point shift floors, it does not truncate toward zero', () => {
  // >> in C on a signed int is an arithmetic shift, so -85934 >> 10 is -84 and
  // not -83. Math.trunc(x / 1024) would give -83, and every green key would
  // land one chroma unit off. JavaScript's >> agrees with C, so the port is
  // exact rather than merely close — this checks that it stayed that way.
  for (const g of [1, 17, 64, 129, 200, 255]) {
    const { u } = M.rgbToKeyUV([0, g, 0]);
    const exact = Math.floor((-339 * g + 511) / 1024) + 128;
    assert.equal(u, exact, `g=${g}`);
    if (g >= 17) assert.notEqual(u, Math.trunc((-339 * g + 511) / 1024) + 128, `g=${g}`);
  }
});

test('the fixed-point coefficients are the ones the filter rounds to', () => {
  // FIXNUM(x) is lrint(x * 1024). If someone recomputes these from the float
  // coefficients with a different rounding, the key moves.
  assert.equal(Math.round(0.16874 * 1024), 173);
  assert.equal(Math.round(0.33126 * 1024), 339);
  assert.equal(Math.round(0.50000 * 1024), 512);
  assert.equal(Math.round(0.41869 * 1024), 429);
  assert.equal(Math.round(0.08131 * 1024), 83);
});

// ==========================================================================
// frame RGB <-> YUV
// ==========================================================================

test('limited-range BT.601 puts black at 16 and white at 235', () => {
  const black = M.rgbToYuv(0, 0, 0, 'bt601');
  near(black.y, 16, 1e-9, 'black Y');
  near(black.u, 128, 1e-9, 'black U');
  near(black.v, 128, 1e-9, 'black V');

  const white = M.rgbToYuv(255, 255, 255, 'bt601');
  near(white.y, 235, 1e-9, 'white Y');
  near(white.u, 128, 1e-9, 'white U');
  near(white.v, 128, 1e-9, 'white V');
});

test('every matrix round-trips RGB through YUV and back', () => {
  // The inverse is derived from the forward matrix at load time rather than
  // written out, so this is really a check on invert3x3 — but it is also the
  // guarantee the shader relies on when it converts back for despill.
  for (const name of Object.keys(M.MATRICES)) {
    for (const rgb of [[0, 0, 0], [255, 255, 255], [12, 200, 40], [128, 64, 199], [255, 0, 127]]) {
      const c = M.rgbToYuv(rgb[0], rgb[1], rgb[2], name);
      const back = M.yuvToRgb(c.y, c.u, c.v, name);
      near(back.r, rgb[0], 1e-9, `${name} r`);
      near(back.g, rgb[1], 1e-9, `${name} g`);
      near(back.b, rgb[2], 1e-9, `${name} b`);
    }
  }
});

test('an unknown matrix name falls back to the default rather than throwing', () => {
  assert.equal(M.matrixFor('bt2020-nonsense'), M.MATRICES[M.DEFAULT_MATRIX]);
  assert.equal(M.matrixFor(undefined), M.MATRICES[M.DEFAULT_MATRIX]);
});

test('rgbToYuv does not clamp, because chromakey measures a distance', () => {
  // Clamping an out-of-gamut pixel back into range would drag it toward the
  // key and key out something that should have survived, so the conversion
  // stays linear past both ends.
  const inGamut = M.rgbToYuv(0, 255, 0, 'bt601');
  const beyond = M.rgbToYuv(0, 400, 0, 'bt601');
  assert.ok(beyond.u < inGamut.u, 'greener than green keeps going');
  near(128 - beyond.u, (400 / 255) * (128 - inGamut.u), 1e-9, 'and does so linearly');

  // The way back does clamp: that result is going on a screen.
  const rgb = M.yuvToRgb(300, 0, 0, 'bt601');
  assert.ok(rgb.r <= 255 && rgb.r >= 0, `expected a displayable red, got ${rgb.r}`);
});

test('matrixNameFromTags reads ffprobe tags the way main.js will hand them over', () => {
  assert.equal(M.matrixNameFromTags({ colorSpace: 'bt709' }), 'bt709');
  assert.equal(M.matrixNameFromTags({ colorSpace: 'BT709' }), 'bt709', 'case-insensitive');
  assert.equal(M.matrixNameFromTags({ colorSpace: 'smpte170m' }), 'bt601');
  assert.equal(M.matrixNameFromTags({ colorSpace: 'bt470bg' }), 'bt601');
  assert.equal(M.matrixNameFromTags({ colorSpace: 'smpte170m', colorRange: 'pc' }), 'bt601-full');
});

test('matrixNameFromTags falls through to primaries when matrix coefficients are unset', () => {
  // A real pattern: some encoders tag primaries/transfer as bt709 and leave
  // matrix coefficients unspecified, because the three are independent flags.
  assert.equal(
    M.matrixNameFromTags({ colorSpace: 'unknown', colorPrimaries: 'bt709' }),
    'bt709'
  );
});

test('matrixNameFromTags defaults untagged or unrecognised input to DEFAULT_MATRIX', () => {
  assert.equal(M.matrixNameFromTags(undefined), M.DEFAULT_MATRIX);
  assert.equal(M.matrixNameFromTags({}), M.DEFAULT_MATRIX);
  assert.equal(M.matrixNameFromTags({ colorSpace: 'unknown' }), M.DEFAULT_MATRIX);
  assert.equal(M.matrixNameFromTags({ colorSpace: 'bt2020nc' }), M.DEFAULT_MATRIX);
});

test('the matrix assumption is what it claims to be, and it matters', () => {
  // Both of these are "pure green" as far as the picture is concerned, but
  // BT.709 puts its chroma much closer to the key colour, so the same
  // similarity slider keys differently. This is the documented approximation
  // in the module, pinned so its size is visible rather than folklore.
  const key = M.keyUVFromHex('#00FF00');
  const g601 = M.rgbToYuv(0, 255, 0, 'bt601');
  const g709 = M.rgbToYuv(0, 255, 0, 'bt709');
  const d601 = M.chromakeyDiff(flat(g601.u, g601.v), key);
  const d709 = M.chromakeyDiff(flat(g709.u, g709.v), key);
  near(d601, 0.0456, 5e-4, 'bt601 green');
  near(d709, 0.0160, 5e-4, 'bt709 green');
  assert.equal(M.DEFAULT_MATRIX, 'bt601');
});

// ==========================================================================
// chromakey  (do_chromakey_pixel)
// ==========================================================================

test('the distance is ffmpeg\'s, computed independently', () => {
  // Values from a separate implementation of
  //   diff = mean over 9 of sqrt((du^2 + dv^2) / (255^2 * 2))
  const key = { u: 44, v: 21 };
  near(M.chromakeyDiff(flat(54, 34), key), 0.04548005295977726, 1e-12, 'near green');
  near(M.chromakeyDiff(flat(44, 21), key), 0, 1e-15, 'exactly the key');
  near(M.chromakeyDiff(flat(128, 128), key), 0.3772153580840411, 1e-12, 'neutral grey');
});

test('the nine taps are averaged after the square root, not before', () => {
  // Averaging the squares first would give a different (harder) matte. The
  // mixed case below distinguishes the two: five taps exactly on the key and
  // four on neutral grey.
  const key = { u: 44, v: 21 };
  const samples = [...flat(44, 21).slice(0, 5), ...flat(128, 128).slice(0, 4)];
  near(M.chromakeyDiff(samples, key), 0.16765127025957383, 1e-12, 'mixed neighbourhood');

  // Which is 4/9 of the all-grey distance — the mean of the roots. The mean of
  // the squares would be sqrt(4/9) = 2/3 of it, and visibly different.
  near(M.chromakeyDiff(samples, key), (4 / 9) * 0.3772153580840411, 1e-12, 'mean of roots');
});

test('blend feathers the matte, and a blend of zero is a hard cut', () => {
  // alpha = clip((diff - similarity) / blend, 0, 1), or a step when blend is
  // effectively zero.
  near(M.alphaFromDiff(0.10, 0.1, 0.05), 0, 1e-12, 'at the threshold');
  near(M.alphaFromDiff(0.125, 0.1, 0.05), 0.5, 1e-12, 'half way up the ramp');
  near(M.alphaFromDiff(0.15, 0.1, 0.05), 1, 1e-12, 'top of the ramp');
  near(M.alphaFromDiff(0.40, 0.1, 0.05), 1, 1e-12, 'clamped above');
  near(M.alphaFromDiff(0.01, 0.1, 0.05), 0, 1e-12, 'clamped below');

  assert.equal(M.alphaFromDiff(0.0999, 0.1, 0), 0, 'hard cut, below');
  assert.equal(M.alphaFromDiff(0.1001, 0.1, 0), 1, 'hard cut, above');
});

test('0.0001 is the blend threshold, and it is not inclusive', () => {
  // ffmpeg tests `blend > 0.0001`, so exactly 0.0001 takes the hard-cut
  // branch. The UI's slider step is 0.005 so it cannot land here, but a saved
  // project or a template can.
  assert.equal(M.alphaFromDiff(0.1001, 0.1, 0.0001), 1, 'hard cut at the threshold');
  // A hair above it and the ramp is back, and so steep it is nearly a cut.
  near(M.alphaFromDiff(0.100005, 0.1, 0.00011), 0.0454, 1e-3, 'just over the threshold');
});

test('the 4:2:0 neighbourhood collapses nine taps onto four chroma cells', () => {
  // vf_chromakey.c reads x-1, x, x+1 in luma coordinates and then shifts right
  // by one for the chroma plane, so the taps are lopsided and the weights are
  // 1, 2, 2, 4 rather than nine distinct samples. Reproducing the shape is
  // what keeps the preview's edge softness the same as the export's.
  const weigh = (x, y) => {
    const counts = new Map();
    for (const t of M.chromaTaps(x, y)) {
      const k = `${t.cx},${t.cy}`;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    return [...counts.entries()].sort();
  };

  assert.equal(M.chromaTaps(4, 4).length, 9);
  // An even pixel reaches back and up; an odd one reaches forward and down.
  assert.deepEqual(weigh(4, 4), [['1,1', 1], ['1,2', 2], ['2,1', 2], ['2,2', 4]]);
  assert.deepEqual(weigh(5, 5), [['2,2', 4], ['2,3', 2], ['3,2', 2], ['3,3', 1]]);
});

// ==========================================================================
// eq
// ==========================================================================

test('eq at its defaults is an exact copy, not a near-identity round trip', () => {
  // check_values() in vf_eq.c drops the lookup entirely when contrast is 1 and
  // brightness is 0. Running the LUT anyway would shift most values by a code,
  // and every clip would pick up a tint from a filter the export never
  // inserted — the builder only writes eq= when something is non-default.
  for (const value of [0, 1, 16, 77, 128, 235, 254, 255]) {
    assert.equal(M.eqPlane(value, 1, 0), value, `value ${value}`);
  }
});

test('eq is process_c\'s integer arithmetic, checked against real ffmpeg', () => {
  // These four are what `ffmpeg -vf format=yuv420p,eq=...` actually wrote for
  // a plane value of 126 and 128, read back out of the raw yuv420p output.
  //
  // The obvious port — create_lut() at the top of vf_eq.c — gives 128.75,
  // 107.92 and 128.40 for these, four or five codes out. check_values() only
  // reaches that lookup when gamma is not 1, and the builder never sets one.
  assert.equal(M.eqPlane(128, 1.6, 0), 127, 'saturation 1.6 on neutral chroma');
  assert.equal(M.eqPlane(126, 0.8, -0.08), 105, 'contrast and brightness together');
  assert.equal(M.eqPlane(126, 0.8, 0), 125, 'contrast alone');
  assert.equal(M.eqPlane(126, 1, -0.08), 105, 'brightness alone');
});

/*
 * Captured from a real `ffmpeg -vf format=yuv420p,eq=contrast=C:brightness=B`
 * over a grey ramp, reading the Y plane straight back out. ffmpeg 6.1.1.
 *
 * Pasted rather than generated at test time on purpose: CI runs plain Node on
 * three versions with no ffmpeg installed, and the point of these numbers is
 * that they came from somewhere other than this codebase. The full sweep they
 * were sampled from covered every plane value 0..255 against 49 combinations
 * of contrast and brightness, and every one of the 12,544 agreed exactly; a
 * separate 8,192-sample chroma sweep over eight saturations did too.
 */
const FFMPEG_EQ = [
  { contrast: 0.5, brightness: -0.5, pairs: [[16,0], [17,0], [30,0], [50,0], [71,0], [102,0], [124,0], [126,0], [145,7], [171,20], [196,33], [218,44], [234,52], [235,52]] },
  { contrast: 0.5, brightness: -0.08, pairs: [[16,51], [17,51], [30,58], [50,68], [71,78], [102,94], [124,105], [126,106], [145,115], [171,128], [196,141], [218,152], [234,160], [235,160]] },
  { contrast: 0.5, brightness: 0.15, pairs: [[16,109], [17,109], [30,116], [50,126], [71,136], [102,152], [124,163], [126,164], [145,173], [171,186], [196,199], [218,210], [234,218], [235,218]] },
  { contrast: 0.5, brightness: 0.5, pairs: [[16,199], [17,199], [30,206], [50,216], [71,226], [102,242], [124,253], [126,254], [145,255], [171,255], [196,255], [218,255], [234,255], [235,255]] },
  { contrast: 0.8, brightness: -0.5, pairs: [[16,0], [17,0], [30,0], [50,0], [71,0], [102,0], [124,0], [126,0], [145,12], [171,33], [196,53], [218,71], [234,84], [235,84]] },
  { contrast: 0.8, brightness: -0.08, pairs: [[16,17], [17,18], [30,28], [50,44], [71,61], [102,86], [124,104], [126,105], [145,120], [171,141], [196,161], [218,179], [234,192], [235,192]] },
  { contrast: 0.8, brightness: 0.15, pairs: [[16,75], [17,76], [30,86], [50,102], [71,119], [102,144], [124,162], [126,163], [145,178], [171,199], [196,219], [218,237], [234,250], [235,250]] },
  { contrast: 0.8, brightness: 0.5, pairs: [[16,165], [17,166], [30,176], [50,192], [71,209], [102,234], [124,252], [126,253], [145,255], [171,255], [196,255], [218,255], [234,255], [235,255]] },
  { contrast: 1.2, brightness: -0.5, pairs: [[16,0], [17,0], [30,0], [50,0], [71,0], [102,0], [124,0], [126,0], [145,19], [171,51], [196,81], [218,107], [234,126], [235,127]] },
  { contrast: 1.2, brightness: -0.08, pairs: [[16,0], [17,0], [30,0], [50,13], [71,39], [102,76], [124,102], [126,105], [145,127], [171,159], [196,189], [218,215], [234,234], [235,235]] },
  { contrast: 1.2, brightness: 0.15, pairs: [[16,31], [17,32], [30,47], [50,71], [71,97], [102,134], [124,160], [126,163], [145,185], [171,217], [196,247], [218,255], [234,255], [235,255]] },
  { contrast: 1.2, brightness: 0.5, pairs: [[16,121], [17,122], [30,137], [50,161], [71,187], [102,224], [124,250], [126,253], [145,255], [171,255], [196,255], [218,255], [234,255], [235,255]] },
  { contrast: 1.6, brightness: -0.5, pairs: [[16,0], [17,0], [30,0], [50,0], [71,0], [102,0], [124,0], [126,0], [145,26], [171,68], [196,108], [218,143], [234,169], [235,170]] },
  { contrast: 1.6, brightness: -0.08, pairs: [[16,0], [17,0], [30,0], [50,0], [71,16], [102,66], [124,101], [126,104], [145,134], [171,176], [196,216], [218,251], [234,255], [235,255]] },
  { contrast: 1.6, brightness: 0.15, pairs: [[16,0], [17,0], [30,8], [50,40], [71,74], [102,124], [124,159], [126,162], [145,192], [171,234], [196,255], [218,255], [234,255], [235,255]] },
  { contrast: 1.6, brightness: 0.5, pairs: [[16,76], [17,78], [30,98], [50,130], [71,164], [102,214], [124,249], [126,252], [145,255], [171,255], [196,255], [218,255], [234,255], [235,255]] },
  { contrast: 2, brightness: -0.5, pairs: [[16,0], [17,0], [30,0], [50,0], [71,0], [102,0], [124,0], [126,0], [145,33], [171,85], [196,135], [218,179], [234,211], [235,213]] },
  { contrast: 2, brightness: -0.08, pairs: [[16,0], [17,0], [30,0], [50,0], [71,0], [102,55], [124,99], [126,103], [145,141], [171,193], [196,243], [218,255], [234,255], [235,255]] },
  { contrast: 2, brightness: 0.15, pairs: [[16,0], [17,0], [30,0], [50,9], [71,51], [102,113], [124,157], [126,161], [145,199], [171,251], [196,255], [218,255], [234,255], [235,255]] },
  { contrast: 2, brightness: 0.5, pairs: [[16,31], [17,33], [30,59], [50,99], [71,141], [102,203], [124,247], [126,251], [145,255], [171,255], [196,255], [218,255], [234,255], [235,255]] }
];

test('eq agrees with real ffmpeg, value for value', () => {
  let checked = 0;
  for (const g of FFMPEG_EQ) {
    for (const [input, expected] of g.pairs) {
      assert.equal(
        M.eqPlane(input, g.contrast, g.brightness), expected,
        `eq=contrast=${g.contrast}:brightness=${g.brightness} on ${input}`
      );
      checked++;
    }
  }
  assert.ok(checked >= 250, `expected a real sample, checked ${checked}`);
});

test('eq comes back as whole codes, because ffmpeg\'s does', () => {
  // process_c writes into a uint8 plane. Keeping the preview continuous here
  // would look smoother and be wrong.
  for (const [value, c, b] of [[77, 1.4, 0.1], [128, 0.6, -0.2], [200, 2, 0.05]]) {
    assert.equal(M.eqPlane(value, c, b) % 1, 0, `eqPlane(${value}, ${c}, ${b})`);
  }
});

test('eq clamps at both ends the way process_c does', () => {
  // `if (pel & ~255) pel = (-pel) >> 31` — zero when it went negative, 255
  // when it went over, with no wrap in between.
  assert.equal(M.eqPlane(0, 2, 0), 0, 'bottomed out');
  assert.equal(M.eqPlane(255, 1, 0.5), 255, 'topped out');
  assert.equal(M.eqPlane(200, 1, -1), 0, 'brightness can bottom it out');
  assert.equal(M.eqPlane(250, 2, 0.5), 255, 'and contrast can top it out');
});

test('saturation drives the chroma planes and brightness never does', () => {
  // vf_eq.c sets param[1] and param[2] contrast to `saturation` and leaves
  // their brightness at zero, so brightness must not move U or V.
  const filters = { brightness: 0.4, contrast: 1.8, saturation: 2 };
  assert.equal(M.eqChroma(90, filters), M.eqPlane(90, 2, 0));
  assert.notEqual(M.eqLuma(90, filters), M.eqChroma(90, filters));
});

test('neutral chroma is not a fixed point of saturation, and that is ffmpeg', () => {
  // process_c's brightness term carries a `- contrast / 32` that does not
  // cancel, so neutral chroma drifts a code as saturation moves. Small, but it
  // is the reason the key shifts at all when nothing green is on screen.
  assert.equal(M.eqChroma(128, { saturation: 2 }), 127, 'a code low at 2x');
  assert.equal(M.eqChroma(128, { saturation: 0.5 }), 127, 'and at 0.5x');
  assert.equal(M.eqChroma(128, { saturation: 1 }), 128, 'untouched only at 1x');
});

// ==========================================================================
// despill
// ==========================================================================

test('despill removes green\'s excess over the red/blue average, and nothing else', () => {
  // type=green:mix=0.5:expand=0 gives factor 0.5, so
  //   spill = max(g - 0.5r - 0.5b, 0);  g -= spill;  r and b are untouched.
  const d = M.despillGreen(0.5, 0.8, 0.4, {});
  near(d.r, 0.5, 1e-12, 'red untouched');
  near(d.g, 0.45, 1e-12, 'green loses its 0.35 excess');
  near(d.b, 0.4, 1e-12, 'blue untouched');
});

test('despill leaves a pixel with no green excess exactly alone', () => {
  const d = M.despillGreen(0.6, 0.3, 0.7, {});
  assert.deepEqual(d, { r: 0.6, g: 0.3, b: 0.7 });
});

test('despill takes pure green to black', () => {
  // Which is fine: those pixels are keyed transparent in the same pass. It is
  // the near-green fringe the filter is actually for.
  const d = M.despillGreen(0, 1, 0, {});
  near(d.g, 0, 1e-12, 'green');
});

test('despill never drives a channel negative', () => {
  const d = M.despillGreen(0, 0.2, 0, { greenscale: -10 });
  assert.ok(d.g >= 0, `expected clamping at zero, got ${d.g}`);
});

test('expand widens the spill map, mix moves what counts as spill', () => {
  // factor = (1 - mix) * (1 - expand). Pinning the arithmetic so the export's
  // literal `mix=0.5:expand=0` can be changed later without guesswork.
  //   mix 0.5, expand 0.5 -> factor 0.25 -> spill = 0.8 - 0.25 - 0.1 = 0.45
  near(M.despillGreen(0.5, 0.8, 0.4, { expand: 0.5 }).g, 0.35, 1e-12, 'expand 0.5');
  //   mix 0, expand 0 -> factor 1 -> spill = 0.8 - 0 - 0.4 = 0.4
  near(M.despillGreen(0.5, 0.8, 0.4, { mix: 0 }).g, 0.4, 1e-12, 'mix 0');
});

// ==========================================================================
// scale and position
// ==========================================================================

test('force_original_aspect_ratio=decrease fits inside the box', () => {
  // vf_scale.c: tmp_w = round(out_h * in_w / in_h), tmp_h = round(out_w * in_h
  // / in_w), then take the minimum against the requested size on each axis.
  assert.deepEqual(M.fitDecrease(1920, 1080, 1080, 1920), { w: 1080, h: 608 });
  assert.deepEqual(M.fitDecrease(1080, 1920, 1920, 1080), { w: 608, h: 1080 });
  assert.deepEqual(M.fitDecrease(1000, 1000, 1080, 1920), { w: 1080, h: 1080 });
  assert.deepEqual(M.fitDecrease(1080, 1920, 1080, 1920), { w: 1080, h: 1920 }, 'exact fit');
});

test('the fit rounds to nearest rather than flooring', () => {
  // av_rescale rounds; 1080 * 1080 / 1449 is 804.97, which floors to 804 and
  // rounds to 805. One pixel, but it is one pixel of offset between the
  // preview's grid and the export's.
  assert.deepEqual(M.fitDecrease(1449, 1080, 1080, 1920), { w: 1080, h: 805 });
});

test('a clip with no source dimensions yet fills the canvas instead of vanishing', () => {
  assert.deepEqual(M.fitDecrease(0, 0, 1080, 1920), { w: 1080, h: 1920 });
});

test('the overlay rect centres the clip and then applies the offsets', () => {
  // The builder writes overlay=x=(W-w)/2+posX, evaluated as a double and
  // truncated into an int.
  const centred = M.overlayRect({ scale: 1 }, 1920, 1080, 1080, 1920);
  assert.deepEqual(centred, { x: 0, y: 656, w: 1080, h: 608 });

  const nudged = M.overlayRect({ scale: 1, posX: 40, posY: -100 }, 1920, 1080, 1080, 1920);
  assert.equal(nudged.x, 40);
  assert.equal(nudged.y, 556);
});

test('scale shrinks the box the clip is fitted into, not the clip', () => {
  // scale=W*s:H*s, so half scale on a landscape clip in a portrait project
  // halves both dimensions and keeps it centred.
  const half = M.overlayRect({ scale: 0.5 }, 1920, 1080, 1080, 1920);
  assert.deepEqual(half, { x: 270, y: 808, w: 540, h: 304 });
});

test('a clip with no scale or position set is treated as 1x at the centre', () => {
  assert.deepEqual(
    M.overlayRect({}, 1920, 1080, 1080, 1920),
    M.overlayRect({ scale: 1, posX: 0, posY: 0 }, 1920, 1080, 1080, 1920)
  );
});

// ==========================================================================
// the whole chain
// ==========================================================================

test('pure green keys out at the default slider positions', () => {
  const chroma = { on: true, color: '#00FF00', similarity: 0.1, blend: 0.05 };
  const out = M.shadeClipPixel({ rgb: [0, 255, 0], chroma });
  assert.equal(out.a, 0, 'fully transparent');
});

test('white stays fully opaque against a green key', () => {
  const chroma = { on: true, color: '#00FF00', similarity: 0.1, blend: 0.05 };
  const out = M.shadeClipPixel({ rgb: [255, 255, 255], chroma });
  assert.equal(out.a, 1);
  near(out.r, 255, 0.5, 'red');
  near(out.g, 255, 0.5, 'green');
});

test('keying off leaves the pixel alone entirely', () => {
  const out = M.shadeClipPixel({ rgb: [0, 255, 0], chroma: { on: false } });
  assert.equal(out.a, 1, 'opaque');
  near(out.g, 255, 1e-6, 'and not despilled');
});

test('sampling the real screen colour is the difference between keying and not', () => {
  // What "Pick colour from clip" is for, in numbers. A real green screen is
  // nothing like #00FF00, and at the default slider positions the difference
  // is total rather than a matter of degree.
  const screen = '#3f9a52';
  const rgb = M.hexToRgb(screen);
  const chroma = { on: true, color: screen, similarity: 0.1, blend: 0.05 };

  assert.equal(M.shadeClipPixel({ rgb, chroma }).a, 0, 'the sampled colour comes out');
  assert.equal(
    M.shadeClipPixel({ rgb, chroma: { ...chroma, color: '#00FF00' } }).a, 1,
    'assuming pure green leaves the whole screen in shot'
  );
});

test('a sampled colour lands near the key but not exactly on it', () => {
  // The residual is worth pinning because it looks like a bug and is not.
  // vf_chromakey.c converts the key colour with FULL-range BT.601 coefficients
  // while the frame it measures against holds limited-range chroma, and it
  // never reconciles the two. The eyedropper feeds the export the same hex it
  // feeds the preview, so both carry the same offset — which is exactly what
  // makes the preview trustworthy. "Fixing" it here would break the match.
  const screen = '#3f9a52';
  const rgb = M.hexToRgb(screen);
  const frame = M.rgbToYuv(rgb[0], rgb[1], rgb[2], 'bt601');
  const diff = M.chromakeyDiff(flat(frame.u, frame.v), M.keyUVFromHex(screen));

  assert.ok(diff > 0, 'not zero: the two conversions disagree by design');
  near(diff, 0.0164, 5e-4, 'and by this much');
});

test('too wide a blend eats into the subject, not just the edge', () => {
  // Found while checking the shader against a synthetic green-screen frame.
  // The subject's own distance from a real screen colour is only about 0.18,
  // so a blend of 0.12 on top of a similarity of 0.1 puts the top of the ramp
  // past it and leaves skin at 65% alpha. Nothing is wrong — it is what the
  // export does — and it is precisely the thing that used to cost a render to
  // discover. Pinned so the preview keeps showing it.
  const skin = M.rgbToYuv(220, 170, 140, 'bt601');
  const diff = M.chromakeyDiff(flat(skin.u, skin.v), M.keyUVFromHex('#3f9a52'));
  near(diff, 0.1778, 5e-4, 'skin against a green screen');

  assert.equal(M.alphaFromDiff(diff, 0.1, 0.05), 1, 'a tight blend leaves it alone');
  near(M.alphaFromDiff(diff, 0.1, 0.12), 0.648, 1e-3, 'a wide one makes it translucent');
});

test('saturation is applied before the key, so it changes the matte', () => {
  // The whole reason chroma-math.js documents the filter order. In
  // buildVideoClipChain, eq runs at step 5 and chromakey at step 6, so raising
  // saturation pushes a greenish pixel toward the key colour and it drops out.
  // Key first and this pixel would survive both ways, and the preview would
  // disagree with the export exactly when someone is grading a keyed clip.
  const chroma = { on: true, color: '#00FF00', similarity: 0.1, blend: 0.05 };
  const rgb = [40, 200, 60];

  assert.equal(M.shadeClipPixel({ rgb, chroma }).a, 1, 'opaque at neutral saturation');
  assert.equal(
    M.shadeClipPixel({ rgb, chroma, filters: { saturation: 1.6, contrast: 1, brightness: 0 } }).a,
    0,
    'keyed out once saturation pushes it toward the key'
  );
});

test('explicit default filters and no filters at all give the same pixel', () => {
  const chroma = { on: true, color: '#00FF00', similarity: 0.2, blend: 0.1 };
  const a = M.shadeClipPixel({ rgb: [90, 160, 110], chroma });
  const b = M.shadeClipPixel({
    rgb: [90, 160, 110], chroma,
    filters: { brightness: 0, contrast: 1, saturation: 1 }
  });
  assert.deepEqual(a, b);
});

test('a neighbourhood straddling an edge keys more softly than either side', () => {
  const chroma = { on: true, color: '#00FF00', similarity: 0.05, blend: 0.3 };
  const green = [0, 255, 0];
  const skin = [220, 170, 140];

  const allGreen = M.shadeClipPixel({ rgb: green, chroma, taps: Array(9).fill(green) });
  const allSkin = M.shadeClipPixel({ rgb: skin, chroma, taps: Array(9).fill(skin) });
  const edge = M.shadeClipPixel({
    rgb: skin,
    chroma,
    taps: [green, green, green, green, skin, skin, skin, skin, skin]
  });

  assert.ok(edge.a > allGreen.a, 'more opaque than the green side');
  assert.ok(edge.a < allSkin.a, 'less opaque than the skin side');
});

test('taps default to the pixel itself, which is what a flat patch gives', () => {
  const chroma = { on: true, color: '#00FF00', similarity: 0.15, blend: 0.2 };
  const rgb = [60, 180, 80];
  assert.deepEqual(
    M.shadeClipPixel({ rgb, chroma }),
    M.shadeClipPixel({ rgb, chroma, taps: Array(9).fill(rgb) })
  );
});

test('brightness and contrast move the picture without moving the matte', () => {
  // eq's luma lookup does not touch U or V, so grading exposure must not
  // change what is keyed. Saturation is the only one of the three that does.
  const chroma = { on: true, color: '#00FF00', similarity: 0.15, blend: 0.2 };
  const rgb = [60, 180, 80];
  const plain = M.shadeClipPixel({ rgb, chroma });
  const graded = M.shadeClipPixel({
    rgb, chroma, filters: { brightness: 0.2, contrast: 1.4, saturation: 1 }
  });

  near(graded.a, plain.a, 1e-12, 'matte unchanged');
  assert.ok(graded.r !== plain.r, 'but the picture did change');
});
