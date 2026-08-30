'use strict';

/*
 * Drives save protection against the real index.html and app.js in a DOM.
 *
 * save-state.test.js and dirty-state.test.js prove the decisions. This proves
 * they are wired to something: that an edit actually reaches the dirty report
 * main's close guard reads, that a cancelled Save dialog comes back as a
 * cancel rather than a success, that a restored autosave is not quietly
 * treated as saved.
 *
 * What it cannot reach is anything on the other side of the preload bridge.
 * The close dialog, the menu accelerators and the quit sequencing are Electron
 * behaviour, and nothing in this repo launches Electron — so `menu()` below
 * stands in for main.js sending a menu command, and what happens after
 * `saveFinished` is checked by reading main.js rather than by running it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { opts, boot, seedBin, flush, clipCount } = require('./dom-harness.js');

/** app.js reads the clock through the window it runs in. */
const setNow = (win, t) => { win.Date.now = () => t; };

/**
 * Select everything in the bin and send it to Video 1 — two more clips, and
 * one undo entry. Sending clears the bin selection, so re-selecting is part of
 * doing it a second time.
 */
function addClips(app) {
  app.doc.querySelectorAll('#binList .bin-item').forEach(el => {
    el.dispatchEvent(new app.win.MouseEvent('click', { bubbles: true, ctrlKey: true }));
  });
  app.doc.getElementById('btnSendV1').click();
}

/**
 * Boot with two clips on Video 1, so there is unsaved work to protect.
 * `at` freezes the clock before the edit, for the tests that then move it
 * forward to reach the autosave window.
 */
async function bootWithWork(at) {
  const app = boot();
  if (at !== undefined) setNow(app.win, at);
  seedBin(app.win, app.doc);
  await flush();
  addClips(app);
  assert.equal(clipCount(app.doc), 2, 'set-up: two clips on the timeline');
  return app;
}

const toasts = (doc) => [...doc.querySelectorAll('#toasts .toast')].map(t => t.textContent).join('\n');

/** A project shaped like one main.js would hand back from a file. */
const savedProject = (name = 'opened') => ({
  name, width: 1080, height: 1920, fps: 30, bpm: 120, preset: 'medium', crf: 20,
  captionsEnabled: false, captions: [],
  captionStyle: { font: 'Arial', size: 54, color: '#FFFFFF', position: 'bottom' },
  tracks: [
    { id: 'v1', kind: 'video', name: 'Video 1', clips: [
      { id: 'c9', src: '/tmp/z.mp4', name: 'z.mp4', inSec: 0, outSec: 4, startSec: 0,
        speed: 1, volume: 1, scale: 1, posX: 0, posY: 0, fadeIn: 0, fadeOut: 0,
        hasVideo: true, hasAudio: false }
    ] },
    { id: 'v2', kind: 'video', name: 'Video 2', clips: [] },
    { id: 'a1', kind: 'audio', name: 'Audio 1', clips: [] }
  ]
});

// --------------------------------------------------------------------------
// Dirty tracking, end to end
// --------------------------------------------------------------------------

test('an untouched app reports clean, so quitting it asks nothing', opts, async () => {
  const app = boot();
  await flush();
  app.tick();
  assert.equal(app.dirty(), false);
});

test('an edit reports dirty to main', opts, async () => {
  const app = await bootWithWork();
  assert.equal(app.dirty(), true, 'the close guard has something to guard');
});

test('undoing back to the saved state reports CLEAN again', opts, async () => {
  // The end-to-end version of the claim dirty-state.test.js makes in isolation:
  // through the real history stack, the real undo button, the real project.
  const app = await bootWithWork();
  assert.equal(app.dirty(), true, 'set-up');

  app.doc.getElementById('btnUndo').click();
  assert.equal(clipCount(app.doc), 0, 'set-up: the edit was undone');
  assert.equal(app.dirty(), false, 'back where it was saved means saved');
});

test('redoing forward again reports dirty', opts, async () => {
  const app = await bootWithWork();
  app.doc.getElementById('btnUndo').click();
  app.doc.getElementById('btnRedo').click();
  assert.equal(clipCount(app.doc), 2);
  assert.equal(app.dirty(), true);
});

// --------------------------------------------------------------------------
// Save and Save As
// --------------------------------------------------------------------------

test('Save clears dirty and says so', opts, async () => {
  const app = await bootWithWork();
  app.win.cutroom.saveProject = async () => ({ ok: true, path: '/tmp/a.cutroom.json' });

  app.doc.getElementById('btnSave').click();
  await flush();

  assert.equal(app.dirty(), false, 'saved work is not unsaved work');
  assert.match(toasts(app.doc), /Project saved/);
});

test('the toolbar Save is a Save, not a Save As', opts, async () => {
  // The whole point of current-file tracking: the second save must not prompt.
  const app = await bootWithWork();
  const asked = [];
  app.win.cutroom.saveProject = async (_p, saveAs) => {
    asked.push(saveAs);
    return { ok: true, path: '/tmp/a.cutroom.json' };
  };
  app.doc.getElementById('btnSave').click();
  await flush();
  assert.deepEqual(asked, [false]);
});

test('Save As asks for a path even when there is one', opts, async () => {
  const app = await bootWithWork();
  const asked = [];
  app.win.cutroom.saveProject = async (_p, saveAs) => {
    asked.push(saveAs);
    return { ok: true, path: '/tmp/b.cutroom.json' };
  };
  app.menu('save-as');
  await flush();
  assert.deepEqual(asked, [true]);
});

test('cancelling the Save dialog leaves the work unsaved and unannounced', opts, async () => {
  const app = await bootWithWork();
  app.win.cutroom.saveProject = async () => ({ canceled: true });

  app.doc.getElementById('btnSave').click();
  await flush();
  app.tick();

  assert.equal(app.dirty(), true, 'a cancelled save has saved nothing');
  assert.ok(!/Project saved/.test(toasts(app.doc)), 'and must not claim it did');
});

test('a save that failed to write is reported and stays dirty', opts, async () => {
  const app = await bootWithWork();
  app.win.cutroom.saveProject = async () => ({
    ok: false, error: 'Could not save a.cutroom.json.', detail: 'EACCES: permission denied'
  });

  app.doc.getElementById('btnSave').click();
  await flush();
  app.tick();

  assert.equal(app.dirty(), true, 'a failed write must not look like a save');
  assert.match(toasts(app.doc), /Could not save/);
  assert.match(toasts(app.doc), /permission denied/, 'the reason reaches the user');
});

test('the project saved is the one on screen when the dialog opened', opts, async () => {
  // The save race. An edit made while the dialog is open belongs to the next
  // save, not this one — the baseline has to record what was written.
  const app = await bootWithWork();
  let release;
  const held = new Promise(r => { release = r; });
  app.win.cutroom.saveProject = async () => { await held; return { ok: true, path: '/tmp/a.json' }; };

  app.doc.getElementById('btnSave').click();
  await flush();

  // Another edit lands while the save is in flight.
  addClips(app);
  assert.equal(clipCount(app.doc), 4, 'set-up: the edit really happened');
  release({ ok: true, path: '/tmp/a.json' });
  await flush();
  await flush();
  app.tick();

  assert.equal(app.dirty(), true, 'the edit made during the save is still unsaved');
});

// --------------------------------------------------------------------------
// Saves that main is waiting on
// --------------------------------------------------------------------------

test('a save main asked for reports success back to main', opts, async () => {
  // main.js holds the window open on this answer. Silence would leave a window
  // that never closes.
  const app = await bootWithWork();
  app.win.cutroom.saveProject = async () => ({ ok: true, path: '/tmp/a.cutroom.json' });

  app.menu('save', { reply: true });
  await flush();

  assert.equal(app.calls.saveFinished.length, 1);
  assert.equal(app.calls.saveFinished[0].ok, true);
});

test('a cancelled save reports the cancel, so the close is aborted', opts, async () => {
  // The bug this shape prevents: treating "the user backed out of the Save
  // dialog" as a save, and closing over the top of the work.
  const app = await bootWithWork();
  app.win.cutroom.saveProject = async () => ({ canceled: true });

  app.menu('save', { reply: true });
  await flush();

  assert.equal(app.calls.saveFinished.length, 1);
  assert.ok(!app.calls.saveFinished[0].ok, 'main must not read this as saved');
});

test('an ordinary save does not report back', opts, async () => {
  // Only a save main is waiting on answers, or a later close could be resolved
  // by an unrelated Cmd+S.
  const app = await bootWithWork();
  app.win.cutroom.saveProject = async () => ({ ok: true, path: '/tmp/a.cutroom.json' });

  app.menu('save');
  await flush();

  assert.equal(app.calls.saveFinished.length, 0);
});

// --------------------------------------------------------------------------
// Autosave
// --------------------------------------------------------------------------

test('a pause after an edit writes an autosave', opts, async () => {
  const app = await bootWithWork(100000);
  app.calls.autosaves.length = 0;

  setNow(app.win, 100000 + 2500);   // past the quiet window
  app.tick();

  assert.equal(app.calls.autosaves.length, 1, 'the work was written somewhere');
  assert.equal(app.calls.autosaves[0].tracks[0].clips.length, 2, 'and it is the real project');
});

test('an idle dirty project is not autosaved over and over', opts, async () => {
  const app = await bootWithWork(200000);
  setNow(app.win, 205000);
  app.tick();
  assert.equal(app.calls.autosaves.length, 1, 'set-up: one autosave landed');
  app.calls.autosaves.length = 0;

  setNow(app.win, 210000);
  app.tick();
  setNow(app.win, 220000);
  app.tick();

  assert.equal(app.calls.autosaves.length, 0, 'nothing changed, nothing to write');
});

test('a project undone back to its saved state stops autosaving', opts, async () => {
  // Without this, an autosave stays pending after the work it described has
  // been undone away, and the next launch offers to restore a project the
  // file already matches — the prompt that teaches people to stop reading.
  const app = await bootWithWork(600000);
  setNow(app.win, 603000);
  app.tick();
  assert.equal(app.calls.autosaves.length, 1, 'set-up: one autosave landed');

  setNow(app.win, 604000);
  app.doc.getElementById('btnUndo').click();
  assert.equal(app.dirty(), false, 'set-up: back to the saved state');

  setNow(app.win, 610000);
  app.tick();
  assert.equal(app.calls.autosaves.length, 1, 'nothing further was written');
});

test('a clean project is never autosaved', opts, async () => {
  const app = boot();
  await flush();
  // Advanced from the real clock rather than set to a small fixed number:
  // rewinding time behind the app's own boot-time stamp would make every
  // interval look not-yet-due, and the test would pass for the wrong reason.
  const t0 = app.win.Date.now();
  setNow(app.win, t0 + 5000);
  app.tick();
  setNow(app.win, t0 + 100000);
  app.tick();
  assert.equal(app.calls.autosaves.length, 0);
});

test('a further edit is autosaved again', opts, async () => {
  const app = await bootWithWork(500000);
  setNow(app.win, 503000);
  app.tick();
  assert.equal(app.calls.autosaves.length, 1, 'set-up: the first one landed');

  setNow(app.win, 504000);
  addClips(app);                                 // a new edit
  setNow(app.win, 507000);
  app.tick();

  assert.equal(app.calls.autosaves.length, 2);
});

// --------------------------------------------------------------------------
// Crash recovery
// --------------------------------------------------------------------------

test('a restored autosave lands on screen and stays DIRTY', opts, async () => {
  // Recovered work has never been written anywhere. Marking it saved would be
  // a lie that costs the user the same work a second time.
  const app = boot();
  await flush();
  app.restore({ project: savedProject('recovered'), filePath: '/tmp/a.cutroom.json' });
  await flush();

  assert.equal(clipCount(app.doc), 1, 'the recovered project is what is on screen');
  assert.equal(app.doc.getElementById('projectName').value, 'recovered');
  assert.equal(app.dirty(), true, 'still unsaved');
  assert.match(toasts(app.doc), /Recovered unsaved work/);
});

test('a restore clears the undo stack of the project it replaced', opts, async () => {
  const app = await bootWithWork();
  assert.equal(app.doc.getElementById('btnUndo').disabled, false, 'set-up: there is history');

  app.restore({ project: savedProject('recovered') });
  await flush();

  assert.equal(app.doc.getElementById('btnUndo').disabled, true,
    'undo must not reach back into a project that is no longer open');
});

test('saving recovered work makes it clean', opts, async () => {
  const app = boot();
  await flush();
  app.restore({ project: savedProject('recovered') });
  await flush();
  app.win.cutroom.saveProject = async () => ({ ok: true, path: '/tmp/r.cutroom.json' });

  app.doc.getElementById('btnSave').click();
  await flush();

  assert.equal(app.dirty(), false);
});

// --------------------------------------------------------------------------
// The guard in front of New and Open
// --------------------------------------------------------------------------

test('cancelling the prompt aborts New and keeps the work', opts, async () => {
  const app = await bootWithWork();
  app.win.cutroom.confirmDiscard = async () => 'cancel';

  app.menu('new');
  await flush();

  assert.equal(clipCount(app.doc), 2, 'cancel means cancel');
});

test('discarding at the prompt lets New through', opts, async () => {
  const app = await bootWithWork();
  app.win.cutroom.confirmDiscard = async () => 'discard';

  app.menu('new');
  await flush();

  assert.equal(clipCount(app.doc), 0);
  assert.equal(app.dirty(), false, 'a fresh project is not unsaved work');
  assert.equal(app.doc.getElementById('projectName').value, 'untitled');
});

test('New tells main to forget the file it was saving to', opts, async () => {
  // Otherwise the first Save of a new project writes over the last one.
  const app = await bootWithWork();
  let forgot = false;
  app.win.cutroom.confirmDiscard = async () => 'discard';
  app.win.cutroom.newProject = async () => { forgot = true; return { ok: true }; };

  app.menu('new');
  await flush();

  assert.equal(forgot, true);
});

test('choosing Save at the prompt saves before New proceeds', opts, async () => {
  const app = await bootWithWork();
  const order = [];
  app.win.cutroom.confirmDiscard = async () => 'save';
  app.win.cutroom.saveProject = async () => { order.push('saved'); return { ok: true, path: '/tmp/a.json' }; };
  app.win.cutroom.newProject = async () => { order.push('new'); return { ok: true }; };

  app.menu('new');
  await flush();

  assert.deepEqual(order, ['saved', 'new'], 'the work is on disk before it leaves the screen');
  assert.equal(clipCount(app.doc), 0);
});

test('a Save cancelled at the prompt aborts New instead of discarding', opts, async () => {
  // The sharp edge: "Save" followed by backing out of the Save dialog must not
  // fall through into the discard it was standing in front of.
  const app = await bootWithWork();
  app.win.cutroom.confirmDiscard = async () => 'save';
  app.win.cutroom.saveProject = async () => ({ canceled: true });

  app.menu('new');
  await flush();

  assert.equal(clipCount(app.doc), 2, 'the work is still here');
  assert.equal(app.dirty(), true);
});

test('Open is guarded the same way', opts, async () => {
  const app = await bootWithWork();
  let opened = false;
  app.win.cutroom.confirmDiscard = async () => 'cancel';
  app.win.cutroom.openProject = async () => { opened = true; return null; };

  app.menu('open');
  await flush();

  assert.equal(opened, false, 'cancelling stops the dialog appearing at all');
  assert.equal(clipCount(app.doc), 2);
});

test('a clean project opens without a prompt', opts, async () => {
  // The guard must not nag when there is nothing at stake.
  const app = boot();
  await flush();
  let asked = false;
  app.win.cutroom.confirmDiscard = async () => { asked = true; return 'discard'; };
  app.win.cutroom.openProject = async () => ({ ok: true, project: savedProject(), filePath: '/tmp/a.json' });

  app.menu('open');
  await flush();

  assert.equal(asked, false);
  assert.equal(clipCount(app.doc), 1);
});

test('an opened project is clean', opts, async () => {
  const app = await bootWithWork();
  app.win.cutroom.confirmDiscard = async () => 'discard';
  app.win.cutroom.openProject = async () => ({ ok: true, project: savedProject(), filePath: '/tmp/a.json' });

  app.menu('open');
  await flush();
  app.tick();

  assert.equal(app.dirty(), false, 'what is on screen is what is in the file');
});

// --------------------------------------------------------------------------
// Menu commands reach the same code as the buttons
// --------------------------------------------------------------------------

test('the menu Undo and Redo drive the app history, not the browser', opts, async () => {
  const app = await bootWithWork();

  app.menu('undo');
  assert.equal(clipCount(app.doc), 0, 'project-level undo, not text undo');

  app.menu('redo');
  assert.equal(clipCount(app.doc), 2);
});

test('one keypress delivered as both a menu item and a keydown undoes once', opts, async () => {
  // On macOS the menu claims Cmd+Z; on Windows and Linux the keydown does.
  // Neither can be run here, so the code does not depend on being right about
  // which: if both ever arrive, the second is dropped.
  const app = await bootWithWork(700000);
  addClips(app);
  assert.equal(clipCount(app.doc), 4, 'set-up: two edits to undo');

  app.menu('undo');
  app.doc.dispatchEvent(new app.win.KeyboardEvent('keydown', {
    key: 'z', ctrlKey: true, bubbles: true
  }));

  assert.equal(clipCount(app.doc), 2, 'one keypress, one undo');
});

test('two separate presses of undo both land', opts, async () => {
  // The other half: the guard must not turn a held-down undo into a
  // stuttering one.
  const app = await bootWithWork(800000);
  addClips(app);
  assert.equal(clipCount(app.doc), 4);

  const press = () => app.doc.dispatchEvent(new app.win.KeyboardEvent('keydown', {
    key: 'z', ctrlKey: true, bubbles: true
  }));
  press();
  setNow(app.win, 800010);
  press();

  assert.equal(clipCount(app.doc), 0, 'both undos ran');
});
