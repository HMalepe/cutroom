'use strict';

/*
 * Pure-module tests for src/thumbnail-render.js — no DOM. Feeds a synthetic
 * cached frame list (shaped like main.js's media:thumbnails response) into
 * filmstripFrames and checks which frames it selects and where it places
 * them, the same DOM-free split waveform-render.test.js uses.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { filmstripFrames } = require('../src/thumbnail-render.js');

const FRAMES = [
  { atSec: 0, dataUrl: 'a' },
  { atSec: 4, dataUrl: 'b' },
  { atSec: 8, dataUrl: 'c' },
  { atSec: 12, dataUrl: 'd' },
  { atSec: 16, dataUrl: 'e' }
];

test('places each in-range frame at its proportional x position', () => {
  const out = filmstripFrames(FRAMES, { fromSec: 0, toSec: 16, width: 160, frameWidth: 10 });
  const bySec = Object.fromEntries(out.map(f => [f.atSec, f.x]));
  assert.equal(bySec[0], 0);
  assert.equal(bySec[4], 40);
  assert.equal(bySec[8], 80);
  assert.equal(bySec[16], 160);
});

test('respects the clip\'s trim: only frames inside fromSec..toSec are candidates', () => {
  const out = filmstripFrames(FRAMES, { fromSec: 3, toSec: 13, width: 100, frameWidth: 5 });
  const secs = out.map(f => f.atSec).sort((a, b) => a - b);
  assert.deepEqual(secs, [4, 8, 12]);
});

test('thins frames closer together than frameWidth rather than overlapping them', () => {
  const dense = [
    { atSec: 0, dataUrl: 'a' }, { atSec: 1, dataUrl: 'b' }, { atSec: 2, dataUrl: 'c' },
    { atSec: 3, dataUrl: 'd' }, { atSec: 10, dataUrl: 'e' }
  ];
  // width=100 over a 10s span -> 10px/sec. frameWidth=25 needs >=25px gaps.
  const out = filmstripFrames(dense, { fromSec: 0, toSec: 10, width: 100, frameWidth: 25 });
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i].x - out[i - 1].x >= 25, `gap between ${out[i - 1].atSec} and ${out[i].atSec} was ${out[i].x - out[i - 1].x}`);
  }
  // The first candidate at each 25px stretch wins, not the last.
  assert.deepEqual(out.map(f => f.atSec), [0, 3, 10]);
});

test('falls back to the single closest cached frame when the clip is narrower than one frame', () => {
  const out = filmstripFrames(FRAMES, { fromSec: 5, toSec: 7, width: 8, frameWidth: 48 });
  assert.equal(out.length, 1);
  assert.equal(out[0].atSec, 4); // closer to midpoint 6 than 8 is
  assert.equal(out[0].x, 0);
});

test('falls back to the closest frame when none of the cached timestamps fall in range', () => {
  // A short clip trimmed entirely between two cached frames.
  const out = filmstripFrames(FRAMES, { fromSec: 5, toSec: 6, width: 80, frameWidth: 10 });
  assert.equal(out.length, 1);
  assert.equal(out[0].atSec, 4);
  assert.equal(out[0].x, 0);
});

test('returns nothing for an empty cache or a zero-width clip, rather than throwing', () => {
  assert.deepEqual(filmstripFrames([], { fromSec: 0, toSec: 10, width: 100, frameWidth: 10 }), []);
  assert.deepEqual(filmstripFrames(FRAMES, { fromSec: 0, toSec: 10, width: 0, frameWidth: 10 }), []);
  assert.deepEqual(filmstripFrames(FRAMES, { fromSec: 5, toSec: 5, width: 100, frameWidth: 10 }), []);
  assert.deepEqual(filmstripFrames(null, { fromSec: 0, toSec: 10, width: 100, frameWidth: 10 }), []);
});
