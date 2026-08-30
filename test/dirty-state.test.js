'use strict';

/*
 * Unit tests over src/dirty-state.js.
 *
 * The undo case below is the one this file exists for. "Edit, then undo back
 * to where you saved" is the state where a flag and a comparison disagree, and
 * it is also the state a person is most sure about: they can see that nothing
 * has changed, so being asked to save is the app telling them something they
 * know is false.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  stableStringify,
  createDirtyTracker,
  autosaveDue,
  createCommandGuard
} = require('../src/dirty-state.js');

// --------------------------------------------------------------------------
// stableStringify
// --------------------------------------------------------------------------

test('the same content in a different key order compares equal', () => {
  assert.equal(
    stableStringify({ a: 1, b: { c: 2, d: 3 } }),
    stableStringify({ b: { d: 3, c: 2 }, a: 1 })
  );
});

test('array order is content and is preserved', () => {
  // Clip order, track order and caption order all mean something. Sorting
  // these the way keys are sorted would call a re-ordered timeline unchanged.
  assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]));
  assert.notEqual(
    stableStringify({ clips: [{ id: 'a' }, { id: 'b' }] }),
    stableStringify({ clips: [{ id: 'b' }, { id: 'a' }] })
  );
});

test('different content compares different', () => {
  assert.notEqual(stableStringify({ speed: 1 }), stableStringify({ speed: 2 }));
  assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: 1, b: 1 }));
  assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: '1' }));
});

test('an absent key and an undefined one are the same thing', () => {
  // JSON.stringify drops undefined properties, so a project round-tripped
  // through a file loses them. Treating the two differently would report a
  // project dirty the instant it was opened.
  assert.equal(stableStringify({ a: 1, b: undefined }), stableStringify({ a: 1 }));
});

test('nested structures sort all the way down', () => {
  assert.equal(
    stableStringify({ t: [{ z: 1, a: { y: 2, b: 3 } }] }),
    stableStringify({ t: [{ a: { b: 3, y: 2 }, z: 1 }] })
  );
});

// --------------------------------------------------------------------------
// The dirty question
// --------------------------------------------------------------------------

/** A tracker over a mutable project, the way app.js uses one. */
function tracked(project) {
  const box = { project };
  return { box, tracker: createDirtyTracker({ read: () => box.project }) };
}

test('a project just saved is clean', () => {
  const { tracker } = tracked({ name: 'a', tracks: [] });
  tracker.markSaved();
  assert.equal(tracker.isDirty(), false);
});

test('an edit makes it dirty', () => {
  const { box, tracker } = tracked({ name: 'a', tracks: [{ clips: [] }] });
  tracker.markSaved();
  box.project.tracks[0].clips.push({ id: 'c1' });
  assert.equal(tracker.isDirty(), true);
});

test('undoing back to the saved state is CLEAN, not dirty', () => {
  // The whole reason dirty is a comparison. A flag would still say dirty here,
  // and would then prompt on close to save a file that is already on disk.
  const { box, tracker } = tracked({ name: 'a', tracks: [{ clips: [] }] });
  tracker.markSaved();

  box.project.tracks[0].clips.push({ id: 'c1' });
  assert.equal(tracker.isDirty(), true, 'set-up: the edit registered');

  // What history.undo() does: writes back a structural clone of the snapshot.
  box.project = structuredClone({ name: 'a', tracks: [{ clips: [] }] });
  assert.equal(tracker.isDirty(), false, 'back where it was saved means saved');
});

test('undo to a DIFFERENT state is still dirty', () => {
  // The other half of the same claim: the comparison has to be able to say yes.
  const { box, tracker } = tracked({ name: 'a', tracks: [{ clips: [{ id: 'c1' }] }] });
  tracker.markSaved();
  box.project = { name: 'a', tracks: [{ clips: [] }] };
  assert.equal(tracker.isDirty(), true);
});

test('a whole new object with identical content is clean', () => {
  // The tracker must compare content, not object identity — opening replaces
  // state.project outright, and undo hands back a clone every time.
  const { box, tracker } = tracked({ name: 'a', tracks: [{ kind: 'video', clips: [] }] });
  tracker.markSaved();
  box.project = { tracks: [{ clips: [], kind: 'video' }], name: 'a' };
  assert.equal(tracker.isDirty(), false);
});

test('markSaved records the snapshot it was given, not the project now', () => {
  // The save race: the project can move while the Save dialog is open, and the
  // baseline has to describe what was written rather than what it drifted to.
  const { box, tracker } = tracked({ name: 'a', tracks: [] });
  const written = tracker.snapshot();
  box.project = { name: 'edited while the dialog was open', tracks: [] };
  tracker.markSaved(written);
  assert.equal(tracker.isDirty(), true, 'the later edit is still unsaved');
});

test('recovered work has no baseline and stays dirty', () => {
  const { tracker } = tracked({ name: 'a', tracks: [] });
  tracker.markSaved();
  tracker.markUnsaved();
  assert.equal(tracker.isDirty(), true, 'restored-from-autosave is unsaved by definition');
});

// --------------------------------------------------------------------------
// Autosave timing
// --------------------------------------------------------------------------

const due = (o) => autosaveDue({ quietMs: 2000, maxWaitMs: 30000, ...o });

test('nothing pending is never due', () => {
  assert.equal(due({ pendingSince: null, lastChangeAt: null, now: 99999 }), false);
  assert.equal(due({ pendingSince: null, lastChangeAt: 100, now: 99999 }), false);
});

test('a pause in editing triggers an autosave', () => {
  assert.equal(due({ pendingSince: 0, lastChangeAt: 0, now: 2000 }), true);
  assert.equal(due({ pendingSince: 0, lastChangeAt: 0, now: 1999 }), false);
});

test('editing without pausing still autosaves, at the ceiling', () => {
  // The hole a debounce alone has: someone typing captions for ten minutes
  // never stops long enough to trigger the quiet branch, so without this they
  // would autosave zero times — a promise kept only when it is not needed.
  assert.equal(due({ pendingSince: 0, lastChangeAt: 29500, now: 29999 }), false);
  assert.equal(due({ pendingSince: 0, lastChangeAt: 30000, now: 30000 }), true);
});

test('the ceiling is measured from the oldest pending change, not the newest', () => {
  // Measuring from lastChangeAt would make maxWait a second debounce, and the
  // continuous editor would never reach it.
  assert.equal(due({ pendingSince: 0, lastChangeAt: 40000, now: 40100 }), true);
});

// --------------------------------------------------------------------------
// The one-keypress-two-paths guard
// --------------------------------------------------------------------------

test('a menu and a keydown for one keypress run the command once', () => {
  const g = createCommandGuard({ windowMs: 50 });
  assert.equal(g.allow('undo', 'menu', 1000), true);
  assert.equal(g.allow('undo', 'key', 1001), false, 'the same keypress arriving twice');
});

test('holding the key down is not a duplicate', () => {
  // Key repeat is ~15/sec at its fastest, so same-source repeats inside the
  // window are real. Swallowing those would turn a held undo into a stuttering
  // one — a worse bug than the one being prevented.
  const g = createCommandGuard({ windowMs: 50 });
  assert.equal(g.allow('undo', 'key', 1000), true);
  assert.equal(g.allow('undo', 'key', 1010), true);
  assert.equal(g.allow('undo', 'key', 1020), true);
});

test('two real presses further apart both run', () => {
  const g = createCommandGuard({ windowMs: 50 });
  assert.equal(g.allow('undo', 'menu', 1000), true);
  assert.equal(g.allow('undo', 'key', 1060), true, 'past the window is a second press');
});

test('a blocked duplicate does not shift the window forward', () => {
  // Otherwise a blocked event would extend the dead time and could swallow a
  // genuine second press.
  const g = createCommandGuard({ windowMs: 50 });
  g.allow('undo', 'menu', 1000);
  g.allow('undo', 'key', 1001);          // blocked
  // 1040 is inside the window if it is measured from the blocked event and
  // outside it if measured from the one that actually ran. A user's second
  // press must not be swallowed by the echo of their first.
  assert.equal(g.allow('undo', 'menu', 1040), true, 'measured from the press that ran');
});

test('undo and redo are guarded separately', () => {
  const g = createCommandGuard({ windowMs: 50 });
  assert.equal(g.allow('undo', 'menu', 1000), true);
  assert.equal(g.allow('redo', 'key', 1001), true, 'a different command is not a duplicate');
});
