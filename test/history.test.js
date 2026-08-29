'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHistory } = require('../src/history');

/**
 * Stand-in for the app: a mutable state object plus the read/write pair the
 * history is constructed with. Mirrors how app.js wires it to `state`.
 */
function harness(initial = { project: { clips: [] }, selectedClipId: null }) {
  const box = { state: initial };
  const history = createHistory({
    read: () => box.state,
    write: (snap) => { box.state = snap; },
    limit: 100
  });
  return { box, history };
}

test('a discrete edit becomes one undoable entry', () => {
  const { box, history } = harness();

  history.run('add clip', () => { box.state.project.clips.push('a'); });

  assert.equal(history.canUndo(), true);
  assert.equal(history.undoLabel(), 'add clip');
  assert.deepEqual(box.state.project.clips, ['a']);

  history.undo();
  assert.deepEqual(box.state.project.clips, []);
  assert.equal(history.canUndo(), false);
  assert.equal(history.canRedo(), true);

  history.redo();
  assert.deepEqual(box.state.project.clips, ['a']);
});

test('an edit that changes nothing records no entry', () => {
  const { box, history } = harness();

  // A pointerdown that selects a clip without dragging it: begin, then commit
  // with the project untouched.
  history.begin('move');
  const pushed = history.commit();

  assert.equal(pushed, false);
  assert.equal(history.canUndo(), false);
  assert.equal(box.state.project.clips.length, 0);
});

test('a continuous gesture collapses into a single entry', () => {
  const { box, history } = harness({ project: { speed: 1 }, selectedClipId: null });

  // One slider drag: begin once, many mutations, commit once.
  history.begin('speed');
  for (const v of [1.1, 1.4, 1.8, 2.0]) box.state.project.speed = v;
  history.commit();

  assert.equal(history.depth().undo, 1);
  assert.equal(box.state.project.speed, 2.0);

  history.undo();
  assert.equal(box.state.project.speed, 1);
});

test('begin is idempotent while an edit is open, keeping the original start', () => {
  const { box, history } = harness({ project: { speed: 1 }, selectedClipId: null });

  history.begin('speed');
  box.state.project.speed = 2;
  // A second begin must not move the restore point to the halfway value.
  history.begin('speed again');
  box.state.project.speed = 3;
  history.commit();

  assert.equal(history.depth().undo, 1);
  assert.equal(history.undoLabel(), 'speed');
  history.undo();
  assert.equal(box.state.project.speed, 1);
});

test('cancel abandons the open edit without recording it', () => {
  const { box, history } = harness();

  history.begin('move');
  box.state.project.clips.push('a');
  history.cancel();

  assert.equal(history.canUndo(), false);
  // cancel does not roll the state back; it only forgets the restore point.
  assert.deepEqual(box.state.project.clips, ['a']);
});

test('snapshots are independent of the live state', () => {
  const { box, history } = harness();

  history.run('add clip', () => { box.state.project.clips.push('a'); });
  // Mutating the live object must not reach back into the stored snapshot.
  box.state.project.clips.push('b');
  history.undo();

  assert.deepEqual(box.state.project.clips, []);
});

test('a new edit clears the redo stack', () => {
  const { box, history } = harness();

  history.run('first', () => { box.state.project.clips.push('a'); });
  history.undo();
  assert.equal(history.canRedo(), true);

  history.run('second', () => { box.state.project.clips.push('z'); });
  assert.equal(history.canRedo(), false);
  assert.equal(history.undoLabel(), 'second');
});

test('undo and redo walk a multi-step stack in order', () => {
  const { box, history } = harness();

  for (const name of ['a', 'b', 'c']) {
    history.run(name, () => { box.state.project.clips.push(name); });
  }
  assert.deepEqual(box.state.project.clips, ['a', 'b', 'c']);

  history.undo();
  history.undo();
  assert.deepEqual(box.state.project.clips, ['a']);

  history.redo();
  assert.deepEqual(box.state.project.clips, ['a', 'b']);
  assert.equal(history.redoLabel(), 'c');

  history.redo();
  assert.deepEqual(box.state.project.clips, ['a', 'b', 'c']);
  assert.equal(history.canRedo(), false);
});

test('redo keeps the label of the edit it replays', () => {
  const { box, history } = harness();

  history.run('split', () => { box.state.project.clips.push('a'); });
  history.undo();

  assert.equal(history.redoLabel(), 'split');
});

test('selection is restored along with the project', () => {
  const { box, history } = harness({ project: { clips: ['a'] }, selectedClipId: 'a' });

  history.run('delete', () => {
    box.state.project.clips = [];
    box.state.selectedClipId = null;
  });
  history.undo();

  assert.deepEqual(box.state.project.clips, ['a']);
  assert.equal(box.state.selectedClipId, 'a');
});

test('the stack is capped, dropping the oldest entries', () => {
  const box = { state: { project: { n: 0 } } };
  const history = createHistory({
    read: () => box.state,
    write: (s) => { box.state = s; },
    limit: 3
  });

  for (let i = 1; i <= 5; i++) {
    history.run(`edit ${i}`, () => { box.state.project.n = i; });
  }

  assert.equal(history.depth().undo, 3);
  // Five edits, three kept: unwinding all of them lands on the state after
  // edit 2 rather than back at zero.
  history.undo(); history.undo(); history.undo();
  assert.equal(box.state.project.n, 2);
  assert.equal(history.canUndo(), false);
});

test('clear forgets everything, including an open edit', () => {
  const { box, history } = harness();

  history.run('one', () => { box.state.project.clips.push('a'); });
  history.undo();
  history.begin('open');
  history.clear();

  assert.equal(history.canUndo(), false);
  assert.equal(history.canRedo(), false);
  assert.equal(history.commit(), false);
});

test('a throwing edit cancels rather than leaving the edit open', () => {
  const { box, history } = harness();

  assert.throws(() => {
    history.run('bad', () => {
      box.state.project.clips.push('a');
      throw new Error('boom');
    });
  }, /boom/);

  assert.equal(history.canUndo(), false);
  // The next edit starts clean instead of inheriting the abandoned one.
  history.run('good', () => { box.state.project.clips.push('b'); });
  assert.equal(history.undoLabel(), 'good');
});

test('undo and redo are no-ops on empty stacks', () => {
  const { history } = harness();

  assert.equal(history.undo(), null);
  assert.equal(history.redo(), null);
});
