'use strict';

/*
 * Pure logic behind the missing-media relink feature: which paths a project
 * and bin reference (collectSourcePaths), how many places point at one path
 * (countReferences), rewriting every one of them at once (relinkProject /
 * relinkBin), and the filename-only auto-match heuristic (matchByFilename).
 * No I/O, no DOM — main.js and app.js both use the real thing, this just
 * proves the decisions it makes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const MR = require('../src/media-relink.js');

function project(tracks) {
  return { name: 'p', width: 1080, height: 1920, fps: 30, tracks };
}

function clip(over) {
  return Object.assign({ id: 'c', src: '/old/a.mp4', inSec: 0, outSec: 5, startSec: 0, speed: 1 }, over);
}

function track(id, clips) {
  return { id, kind: 'video', name: id, clips };
}

// ==========================================================================
// collectSourcePaths
// ==========================================================================

test('no tracks and no bin gives no paths', () => {
  assert.deepEqual(MR.collectSourcePaths(project([]), []), []);
  assert.deepEqual(MR.collectSourcePaths(project(null), null), []);
});

test('collects clip.src and bin media.path, deduped, first-seen order', () => {
  const p = project([
    track('v1', [clip({ id: 'a', src: '/x/a.mp4' }), clip({ id: 'b', src: '/x/b.mp4' })]),
    track('v2', [clip({ id: 'c', src: '/x/a.mp4' })]) // shares a path with clip a
  ]);
  const bin = [{ path: '/x/b.mp4' }, { path: '/x/c.mp4' }];
  assert.deepEqual(MR.collectSourcePaths(p, bin), ['/x/a.mp4', '/x/b.mp4', '/x/c.mp4']);
});

test('a clip or bin item with no path contributes nothing', () => {
  const p = project([track('v1', [clip({ src: undefined }), null])]);
  assert.deepEqual(MR.collectSourcePaths(p, [{ path: '' }, null]), []);
});

// ==========================================================================
// countReferences
// ==========================================================================

test('counts every clip referencing a path across every track, and whether the bin has it', () => {
  const p = project([
    track('v1', [clip({ id: 'a', src: '/x/a.mp4' }), clip({ id: 'b', src: '/x/z.mp4' })]),
    track('v2', [clip({ id: 'c', src: '/x/a.mp4' })])
  ]);
  const bin = [{ path: '/x/a.mp4' }];
  assert.deepEqual(MR.countReferences(p, bin, '/x/a.mp4'), { clips: 2, inBin: true });
  assert.deepEqual(MR.countReferences(p, bin, '/x/z.mp4'), { clips: 1, inBin: false });
  assert.deepEqual(MR.countReferences(p, bin, '/nowhere.mp4'), { clips: 0, inBin: false });
});

// ==========================================================================
// relinkProject
// ==========================================================================

test('relinkProject rewrites every clip on every track sharing the old path', () => {
  const p = project([
    track('v1', [clip({ id: 'a', src: '/old/x.mp4' }), clip({ id: 'b', src: '/old/y.mp4' })]),
    track('v2', [clip({ id: 'c', src: '/old/x.mp4' })])
  ]);
  const { project: next, count } = MR.relinkProject(p, '/old/x.mp4', '/new/x.mp4');
  assert.equal(count, 2);
  assert.equal(next.tracks[0].clips[0].src, '/new/x.mp4');
  assert.equal(next.tracks[0].clips[1].src, '/old/y.mp4', 'a different path is left alone');
  assert.equal(next.tracks[1].clips[0].src, '/new/x.mp4');
});

test('relinkProject does not mutate the project it was handed', () => {
  const p = project([track('v1', [clip({ id: 'a', src: '/old/x.mp4' })])]);
  const before = JSON.parse(JSON.stringify(p));
  MR.relinkProject(p, '/old/x.mp4', '/new/x.mp4');
  assert.deepEqual(p, before);
});

test('relinkProject leaves an unaffected track as the same object', () => {
  // Not load-bearing for correctness, but it is what keeps a relink cheap on
  // a big project — only the track that actually changed gets a new array.
  const untouched = track('v2', [clip({ id: 'z', src: '/old/other.mp4' })]);
  const p = project([track('v1', [clip({ id: 'a', src: '/old/x.mp4' })]), untouched]);
  const { project: next } = MR.relinkProject(p, '/old/x.mp4', '/new/x.mp4');
  assert.equal(next.tracks[1], untouched);
});

test('relinkProject with no matching clip changes nothing and reports zero', () => {
  const p = project([track('v1', [clip({ id: 'a', src: '/old/x.mp4' })])]);
  const { project: next, count } = MR.relinkProject(p, '/nope.mp4', '/new.mp4');
  assert.equal(count, 0);
  assert.equal(next, p, 'no rewrite means the same object back');
});

// ==========================================================================
// relinkBin
// ==========================================================================

test('relinkBin rewrites every bin item sharing the old path', () => {
  const bin = [{ path: '/old/x.mp4', name: 'x.mp4' }, { path: '/old/y.mp4', name: 'y.mp4' }];
  const { bin: next, count } = MR.relinkBin(bin, '/old/x.mp4', '/new/x.mp4');
  assert.equal(count, 1);
  assert.equal(next[0].path, '/new/x.mp4');
  assert.equal(next[0].name, 'x.mp4', 'other fields ride along untouched');
  assert.equal(next[1].path, '/old/y.mp4');
});

test('relinkBin does not mutate the bin it was handed', () => {
  const bin = [{ path: '/old/x.mp4' }];
  MR.relinkBin(bin, '/old/x.mp4', '/new/x.mp4');
  assert.equal(bin[0].path, '/old/x.mp4');
});

// ==========================================================================
// matchByFilename
// ==========================================================================

test('matches missing paths to available paths sharing a basename', () => {
  const missing = ['/old/a.mp4', '/old/b.mp4', '/old/c.mp4'];
  const available = ['/new/folder/a.mp4', '/new/folder/b.mov', '/new/folder/z.mp4'];
  assert.deepEqual(MR.matchByFilename(missing, available), [
    { oldPath: '/old/a.mp4', newPath: '/new/folder/a.mp4' }
  ]);
});

test('a missing path with no name match in the folder is left out', () => {
  assert.deepEqual(MR.matchByFilename(['/old/a.mp4'], ['/new/b.mp4']), []);
});

test('the first file wins when the folder has two files sharing a name', () => {
  const missing = ['/old/a.mp4'];
  const available = ['/new/1/a.mp4', '/new/2/a.mp4'];
  assert.deepEqual(MR.matchByFilename(missing, available), [
    { oldPath: '/old/a.mp4', newPath: '/new/1/a.mp4' }
  ]);
});

test('a path that already resolves to itself is not offered as its own match', () => {
  // Windows paths differing only by backslash/forward-slash could otherwise
  // "match" a missing path to the exact path already on the clip.
  assert.deepEqual(MR.matchByFilename(['/same/a.mp4'], ['/same/a.mp4']), []);
});

test('empty inputs produce no matches', () => {
  assert.deepEqual(MR.matchByFilename([], ['/a.mp4']), []);
  assert.deepEqual(MR.matchByFilename(['/a.mp4'], []), []);
  assert.deepEqual(MR.matchByFilename(null, null), []);
});
