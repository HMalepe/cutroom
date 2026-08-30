'use strict';

/*
 * Opening a project used to be JSON.parse and nothing else. These pin the
 * shape check that now stands between a file on disk and state.project —
 * including the case that made it necessary, a file that parses as JSON
 * perfectly well and is simply not a Cutroom project.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateProject, PROJECT_VERSION } = require('../shared/project-schema');

/** The smallest thing that should load. */
function minimal(overrides = {}) {
  return {
    name: 'test',
    width: 1080,
    height: 1920,
    fps: 30,
    tracks: [
      { id: 'v1', kind: 'video', name: 'Video 1', clips: [] },
      { id: 'a1', kind: 'audio', name: 'Audio 1', clips: [] }
    ],
    ...overrides
  };
}

test('a well-formed project is accepted and handed back unchanged', () => {
  const project = minimal();
  const res = validateProject(project);
  assert.equal(res.ok, true);
  assert.equal(res.project, project);
});

test('a project saved before the version field existed still opens', () => {
  // Every project anyone has saved to date has no version at all. Treating a
  // missing version as a reason to refuse would break all of them, which is
  // the one thing this check must not do.
  const old = minimal();
  assert.equal('version' in old, false);
  assert.equal(validateProject(old).ok, true);
});

test('a project carrying the current version opens', () => {
  assert.equal(validateProject(minimal({ version: PROJECT_VERSION })).ok, true);
});

test('a project from a newer Cutroom is refused with a version-specific message', () => {
  // This is what writing the field buys: a file we cannot read is named as
  // such here rather than failing later as something inexplicable.
  const res = validateProject(minimal({ version: PROJECT_VERSION + 1 }));
  assert.equal(res.ok, false);
  assert.match(res.error, /newer version/i);
});

test('a nonsense version is refused rather than ignored', () => {
  for (const version of ['banana', 0, -1, 1.5, {}]) {
    assert.equal(validateProject(minimal({ version })).ok, false, `version ${JSON.stringify(version)}`);
  }
});

test('anything that is not an object is refused', () => {
  // JSON.parse is happy to return all of these, and every one of them used to
  // be assigned straight to state.project.
  for (const value of [null, undefined, 42, 'a string', true, []]) {
    const res = validateProject(value);
    assert.equal(res.ok, false, JSON.stringify(value));
    assert.equal(typeof res.error, 'string');
    assert.ok(res.error.length > 0);
  }
});

test('an object with no track list is refused', () => {
  // A foreign JSON file — a package.json, a tsconfig — lands here.
  assert.equal(validateProject({}).ok, false);
  assert.equal(validateProject({ name: 'x', dependencies: {} }).ok, false);
  assert.equal(validateProject(minimal({ tracks: 'not an array' })).ok, false);
  assert.equal(validateProject(minimal({ tracks: {} })).ok, false);
});

test('a track without a valid kind is refused, and the message says which track', () => {
  const res = validateProject(minimal({
    tracks: [
      { id: 'v1', kind: 'video', clips: [] },
      { id: '??', kind: 'sparkle', clips: [] }
    ]
  }));
  assert.equal(res.ok, false);
  assert.match(res.error, /Track 2/);

  assert.equal(validateProject(minimal({ tracks: [{ id: 'v1', clips: [] }] })).ok,
    false, 'missing kind');
});

test('a track without a clip list is refused', () => {
  assert.equal(validateProject(minimal({ tracks: [{ kind: 'video' }] })).ok, false);
  assert.equal(validateProject(minimal({ tracks: [{ kind: 'video', clips: {} }] })).ok, false);
  assert.equal(validateProject(minimal({ tracks: [{ kind: 'video', clips: null }] })).ok, false);
});

test('a track that is not an object at all is refused', () => {
  // What a truncated file tends to leave behind.
  for (const track of [null, 'video', 7, []]) {
    assert.equal(validateProject(minimal({ tracks: [track] })).ok, false, JSON.stringify(track));
  }
});

test('an empty track list is fine', () => {
  // An empty timeline is a real project, just not an interesting one.
  assert.equal(validateProject(minimal({ tracks: [] })).ok, true);
});
