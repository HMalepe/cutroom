'use strict';

/*
 * Unit tests over shared/save-state.js — the decisions main.js makes about
 * losing work.
 *
 * Nothing here launches Electron, so what is proven is the decision and not
 * the call: that Cancel is what an escaped dialog resolves to, that a stale
 * autosave is not offered, that Save with a known path asks nobody. Whether
 * main.js then wires those answers into the right Electron event is a separate
 * question that this harness genuinely cannot answer — see the PR.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AUTOSAVE_VERSION,
  CLOSE_BUTTONS,
  RESTORE_BUTTONS,
  documentName,
  titleFor,
  savePlan,
  closeDialogOptions,
  closeChoice,
  autosaveRecord,
  readAutosaveRecord,
  shouldOfferRestore,
  restoreDialogOptions,
  restoreChoice
} = require('../shared/save-state.js');

/** The smallest thing validateProject accepts, so these tests are about this file. */
const okProject = () => ({ name: 'holiday', tracks: [{ kind: 'video', clips: [] }] });

// --------------------------------------------------------------------------
// Window title
// --------------------------------------------------------------------------

test('the title names the file, not the path or the extensions', () => {
  assert.equal(
    titleFor({ filePath: '/Users/h/Documents/holiday.cutroom.json' }),
    'holiday — Cutroom'
  );
  // Windows separators reach here too, from a Windows save dialog.
  assert.equal(titleFor({ filePath: 'C:\\Users\\h\\holiday.cutroom.json' }), 'holiday — Cutroom');
  // A project saved as a plain .json is still a project.
  assert.equal(titleFor({ filePath: '/tmp/rough.json' }), 'rough — Cutroom');
});

test('only the real suffixes come off the name', () => {
  // The strip is two exact suffixes, not "everything after the first dot" —
  // a name with dots in it has to survive intact.
  assert.equal(documentName('/tmp/holiday.v2.final.cutroom.json'), 'holiday.v2.final');
  assert.equal(documentName('/tmp/notes.json.cutroom.json'), 'notes.json');
});

test('with no file the title falls back to the project name', () => {
  assert.equal(titleFor({ projectName: 'reel' }), 'reel — Cutroom');
  assert.equal(titleFor({}), 'untitled — Cutroom');
  assert.equal(titleFor({ projectName: '   ' }), 'untitled — Cutroom', 'blank is not a name');
});

test('the dirty marker is a prefix, and only present when dirty', () => {
  assert.equal(titleFor({ projectName: 'reel', dirty: true }), '● reel — Cutroom');
  assert.equal(titleFor({ projectName: 'reel', dirty: false }), 'reel — Cutroom');
  // The file wins over the project name whichever way dirty falls.
  assert.equal(titleFor({ filePath: '/tmp/a.cutroom.json', projectName: 'reel', dirty: true }),
    '● a — Cutroom');
});

// --------------------------------------------------------------------------
// Save vs Save As
// --------------------------------------------------------------------------

test('Save with a known path writes back without asking', () => {
  assert.deepEqual(
    savePlan({ filePath: '/tmp/a.cutroom.json', saveAs: false }),
    { needsDialog: false, path: '/tmp/a.cutroom.json' }
  );
});

test('Save As always asks, even with a known path', () => {
  const plan = savePlan({ filePath: '/tmp/a.cutroom.json', saveAs: true });
  assert.equal(plan.needsDialog, true);
  // The known path rides along as where the dialog should start — Save As on
  // an open file should open next to it, not in the default documents folder.
  assert.equal(plan.path, '/tmp/a.cutroom.json');
});

test('Save with nowhere to write is Save As', () => {
  assert.deepEqual(savePlan({ filePath: null, saveAs: false }), { needsDialog: true, path: null });
  assert.deepEqual(savePlan({}), { needsDialog: true, path: null });
});

// --------------------------------------------------------------------------
// The close dialog
// --------------------------------------------------------------------------

test('the close dialog defaults to Save and cancels to Cancel', () => {
  const o = closeDialogOptions({ projectName: 'holiday' });
  assert.equal(o.buttons[o.defaultId], 'Save', 'Enter keeps the work');
  assert.equal(o.buttons[o.cancelId], 'Cancel', 'Escape does not discard it');
  assert.match(o.message, /holiday/, 'it says which project');
});

test('every close button maps to the intent it reads as', () => {
  assert.equal(closeChoice(CLOSE_BUTTONS.indexOf('Save')), 'save');
  assert.equal(closeChoice(CLOSE_BUTTONS.indexOf("Don't Save")), 'discard');
  assert.equal(closeChoice(CLOSE_BUTTONS.indexOf('Cancel')), 'cancel');
});

test('an unrecognised close response cancels rather than discards', () => {
  // showMessageBox resolves with cancelId for a dismissed dialog, but an index
  // we did not expect must never be the one that throws work away.
  for (const bad of [-1, 3, 99, undefined, null, NaN, 'Save']) {
    assert.equal(closeChoice(bad), 'cancel', `${String(bad)} must not discard`);
  }
});

// --------------------------------------------------------------------------
// Autosave records
// --------------------------------------------------------------------------

test('an autosave record carries what recovery needs and the project itself', () => {
  const rec = autosaveRecord({ project: okProject(), filePath: '/tmp/a.json', savedAt: 1000 });
  assert.equal(rec.version, AUTOSAVE_VERSION);
  assert.equal(rec.savedAt, 1000);
  assert.equal(rec.filePath, '/tmp/a.json');
  assert.equal(rec.project.name, 'holiday');
});

test('an autosave with no file records that rather than inventing one', () => {
  // main.js passes whatever `currentPath` holds, and "no file" has reached it
  // as all three of these. The record has to say null for every one, because
  // shouldOfferRestore branches on exactly that.
  assert.equal(autosaveRecord({ project: okProject() }).filePath, null);
  assert.equal(autosaveRecord({ project: okProject(), filePath: undefined }).filePath, null);
  assert.equal(autosaveRecord({ project: okProject(), filePath: '' }).filePath, null);
});

test('a good autosave reads back', () => {
  const read = readAutosaveRecord(autosaveRecord({ project: okProject(), savedAt: 5 }));
  assert.equal(read.ok, true);
  assert.equal(read.record.savedAt, 5);
  assert.equal(read.record.project.name, 'holiday');
});

test('a half-written autosave is refused, not half-read', () => {
  // The thing that stopped the app may well have stopped it mid-write, so
  // this is the likeliest file in the app to be broken.
  const bad = [
    null,
    'not an object',
    [],
    { savedAt: 1, project: okProject() },                       // no version
    { version: 0, savedAt: 1, project: okProject() },           // nonsense version
    { version: 'x', savedAt: 1, project: okProject() },
    { version: 1, project: okProject() },                       // no timestamp
    { version: 1, savedAt: 'soon', project: okProject() },
    { version: 1, savedAt: 1 },                                 // no project
    { version: 1, savedAt: 1, project: { tracks: 'nope' } }     // fails the project gate
  ];
  for (const value of bad) {
    assert.equal(readAutosaveRecord(value).ok, false, `${JSON.stringify(value)} must be refused`);
  }
});

test('an autosave from a newer Cutroom is left alone', () => {
  const future = { version: AUTOSAVE_VERSION + 1, savedAt: 1, project: okProject() };
  assert.equal(readAutosaveRecord(future).ok, false);
});

// --------------------------------------------------------------------------
// Whether to offer a restore
// --------------------------------------------------------------------------

const record = (over = {}) => ({ version: 1, savedAt: 1000, filePath: null, project: okProject(), ...over });

test('no autosave means no prompt', () => {
  assert.deepEqual(shouldOfferRestore({ record: null }), { offer: false, reason: 'none' });
  assert.equal(shouldOfferRestore({}).offer, false);
});

test('work that was never saved anywhere is always offered', () => {
  const v = shouldOfferRestore({ record: record({ filePath: null }), fileMtimeMs: null });
  assert.equal(v.offer, true);
  assert.equal(v.reason, 'never-saved');
});

test('an autosave newer than its file is offered', () => {
  const v = shouldOfferRestore({ record: record({ filePath: '/tmp/a.json', savedAt: 2000 }), fileMtimeMs: 1000 });
  assert.equal(v.offer, true);
  assert.equal(v.reason, 'newer');
});

test('an autosave its file has caught up with is NOT offered', () => {
  // This is the branch that decides whether the feature is tolerable. A prompt
  // on a launch where nothing was lost teaches people to dismiss it unread.
  assert.equal(
    shouldOfferRestore({ record: record({ filePath: '/tmp/a.json', savedAt: 1000 }), fileMtimeMs: 2000 }).offer,
    false
  );
  assert.equal(
    shouldOfferRestore({ record: record({ filePath: '/tmp/a.json', savedAt: 1000 }), fileMtimeMs: 1000 }).offer,
    false,
    'saved at the same instant is not newer'
  );
});

test('an autosave whose file has gone is offered rather than dropped', () => {
  for (const mtime of [null, undefined, NaN]) {
    const v = shouldOfferRestore({ record: record({ filePath: '/tmp/gone.json' }), fileMtimeMs: mtime });
    assert.equal(v.offer, true, `mtime ${String(mtime)} must not silently discard the work`);
    assert.equal(v.reason, 'file-missing');
  }
});

// --------------------------------------------------------------------------
// The restore dialog
// --------------------------------------------------------------------------

test('the restore dialog defaults to keeping the work', () => {
  const o = restoreDialogOptions({ reason: 'newer', filePath: '/tmp/holiday.cutroom.json' });
  assert.equal(o.buttons[o.defaultId], 'Restore');
  assert.match(o.message, /holiday/, 'it says which document');
});

test('a restore of never-saved work does not claim a filename', () => {
  const o = restoreDialogOptions({ reason: 'never-saved', filePath: null });
  assert.match(o.message, /unsaved work/);
});

test('a missing file is explained rather than left as a surprise', () => {
  const o = restoreDialogOptions({ reason: 'file-missing', filePath: '/tmp/gone.cutroom.json' });
  assert.match(o.detail, /could not be found/);
});

test('only Restore restores; anything else keeps the last saved version', () => {
  assert.equal(restoreChoice(RESTORE_BUTTONS.indexOf('Restore')), 'restore');
  assert.equal(restoreChoice(RESTORE_BUTTONS.indexOf('Discard')), 'discard');
  for (const bad of [-1, 5, undefined, null]) {
    assert.equal(restoreChoice(bad), 'discard', `${String(bad)} must not silently restore`);
  }
});
