/*
 * save-state.js
 * ---------------------------------------------------------------------------
 * The decisions behind "do not lose the user's work", as pure functions.
 *
 * Everything this file describes happens in main.js: the window title, the
 * Save/Don't Save/Cancel dialog, the autosave file, the offer to restore it.
 * None of that can be exercised here — nothing in this repo launches Electron,
 * and adding something that does is a bigger change than this one.
 *
 * So the split is the same one project-schema.js was extracted for: the
 * *decisions* live here, pure and tested, and main.js is left holding only the
 * calls whose behaviour belongs to Electron rather than to us. When a close
 * guard misbehaves, the question "did we decide the wrong thing" and the
 * question "did we call Electron wrongly" then have different answers in
 * different files, instead of one untestable tangle.
 */

'use strict';

const { validateProject } = require('./project-schema');

/**
 * Bumped if the autosave wrapper ever changes shape. An autosave written by a
 * newer build is not offered rather than half-read: unlike a project file the
 * user chose to open, nobody asked for this one, so the safe failure is to
 * stay quiet.
 */
const AUTOSAVE_VERSION = 1;

/** Lives in app.getPath('userData'), which main.js supplies. */
const AUTOSAVE_FILENAME = 'autosave.cutroom.json';

const APP_NAME = 'Cutroom';

/**
 * The dirty marker. `●` rather than the word "Edited" because it survives a
 * narrow title bar, and because the title is not the only signal on macOS —
 * main.js also calls setDocumentEdited, which puts the same dot in the close
 * button where a Mac user already looks for it.
 */
const DIRTY_MARK = '●';

// --------------------------------------------------------------------------
// Window title
// --------------------------------------------------------------------------

/**
 * Strip the extensions a project file carries so the title shows the name the
 * user typed rather than the plumbing. `holiday.cutroom.json` -> `holiday`.
 * Only the exact suffixes are stripped, so a project genuinely called
 * `notes.json.cutroom.json` still reads `notes.json`.
 */
function documentName(filePath) {
  const base = String(filePath).split(/[\\/]/).pop();
  return base.replace(/\.json$/i, '').replace(/\.cutroom$/i, '') || base;
}

/**
 * @param {object} opts
 * @param {string|null} [opts.filePath]     The file the project came from, if any.
 * @param {string} [opts.projectName]       Used when there is no file yet.
 * @param {boolean} [opts.dirty]
 * @returns {string} e.g. `● holiday — Cutroom`
 */
function titleFor({ filePath = null, projectName = '', dirty = false } = {}) {
  const name = filePath
    ? documentName(filePath)
    : (String(projectName || '').trim() || 'untitled');
  return `${dirty ? DIRTY_MARK + ' ' : ''}${name} — ${APP_NAME}`;
}

// --------------------------------------------------------------------------
// Save vs Save As
// --------------------------------------------------------------------------

/**
 * Save writes back to the file it came from; Save As always asks; Save with
 * nowhere to write is Save As. One function so the three cases cannot drift
 * apart across the two call sites (the menu and the toolbar button).
 *
 * @returns {{needsDialog: boolean, path: string|null}}
 *   `path` is where to write when no dialog is needed, and the directory-ish
 *   starting point to offer when one is.
 */
function savePlan({ filePath = null, saveAs = false } = {}) {
  if (saveAs || !filePath) return { needsDialog: true, path: filePath || null };
  return { needsDialog: false, path: filePath };
}

// --------------------------------------------------------------------------
// The close guard
// --------------------------------------------------------------------------

const CLOSE_BUTTONS = ['Save', "Don't Save", 'Cancel'];

/**
 * Options for dialog.showMessageBox. Pure, so the two indices that decide
 * whether this dialog can lose work are checkable without a window:
 *
 *   defaultId  the button Enter presses — Save, the choice that keeps the work
 *   cancelId   what Escape, the window's own close box, or a dialog dismissed
 *              by the OS resolves to. Electron returns `cancelId` for all of
 *              those, so pointing it at Cancel is what makes "get this dialog
 *              off my screen" mean "don't close" rather than "discard".
 */
function closeDialogOptions({ projectName = 'untitled' } = {}) {
  return {
    type: 'warning',
    buttons: CLOSE_BUTTONS.slice(),
    defaultId: CLOSE_BUTTONS.indexOf('Save'),
    cancelId: CLOSE_BUTTONS.indexOf('Cancel'),
    title: APP_NAME,
    message: `Save changes to ${projectName || 'untitled'}?`,
    detail: 'Your changes will be lost if you don’t save them.',
    noLink: true
  };
}

/**
 * Turn showMessageBox's `response` index into an intent.
 *
 * Anything unrecognised reads as 'cancel'. That is the only safe direction:
 * an index we did not expect must never be the one that throws work away.
 *
 * @returns {'save'|'discard'|'cancel'}
 */
function closeChoice(response) {
  switch (CLOSE_BUTTONS[response]) {
    case 'Save': return 'save';
    case "Don't Save": return 'discard';
    default: return 'cancel';
  }
}

// --------------------------------------------------------------------------
// Autosave
// --------------------------------------------------------------------------

/**
 * The autosave file wraps the project rather than being one, because recovery
 * needs two things the project itself cannot say: when this was written, and
 * which file (if any) it belongs to. Without the first there is nothing to
 * compare against the saved file's mtime; without the second a restore cannot
 * put the user back on the document they were editing.
 */
function autosaveRecord({ project, filePath = null, savedAt = Date.now() }) {
  return { version: AUTOSAVE_VERSION, savedAt, filePath: filePath || null, project };
}

/**
 * Check a parsed autosave file before anything reads it. The project inside
 * goes through the same gate as a project the user opened deliberately —
 * a corrupt autosave is exactly the file most likely to be half-written,
 * since the thing that stopped the app may well have stopped it mid-write.
 *
 * @returns {{ok: true, record: object} | {ok: false, error: string}}
 */
function readAutosaveRecord(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'not an autosave record' };
  }
  const version = Number(parsed.version);
  if (!Number.isInteger(version) || version < 1) {
    return { ok: false, error: 'unreadable autosave version' };
  }
  if (version > AUTOSAVE_VERSION) {
    return { ok: false, error: 'autosave written by a newer Cutroom' };
  }
  if (!Number.isFinite(Number(parsed.savedAt))) {
    return { ok: false, error: 'autosave has no timestamp' };
  }
  const check = validateProject(parsed.project);
  if (!check.ok) return { ok: false, error: check.error };

  return {
    ok: true,
    record: {
      version,
      savedAt: Number(parsed.savedAt),
      filePath: typeof parsed.filePath === 'string' && parsed.filePath ? parsed.filePath : null,
      project: check.project
    }
  };
}

/**
 * Is this autosave worth interrupting a launch for?
 *
 * A clean quit deletes the autosave, so in the normal case there is nothing
 * here to ask about and this never fires. What is left is the case it exists
 * for: the app or the machine died with unsaved work in it.
 *
 * The stale branch is the one that decides whether this feature is tolerable.
 * A recovery prompt that appears on a launch where nothing was actually lost
 * teaches people to dismiss it without reading, and a prompt nobody reads is
 * worse than no prompt at all — so an autosave that its own file has since
 * caught up with is dropped silently rather than offered.
 *
 * @param {object} opts
 * @param {object|null} opts.record        From readAutosaveRecord.
 * @param {number|null} opts.fileMtimeMs   mtime of record.filePath, or null if
 *   there is no such file (never saved, moved, or deleted).
 * @returns {{offer: boolean, reason: string}}
 */
function shouldOfferRestore({ record = null, fileMtimeMs = null } = {}) {
  if (!record) return { offer: false, reason: 'none' };

  // Work that was never saved anywhere has no file to have caught up with it,
  // so it is always worth offering — this is the case with the most to lose.
  if (!record.filePath) return { offer: true, reason: 'never-saved' };

  // The file it belongs to is gone or unreadable. Offering is the only way the
  // work survives; refusing because we cannot compare would discard it on a
  // technicality.
  if (fileMtimeMs === null || fileMtimeMs === undefined) {
    return { offer: true, reason: 'file-missing' };
  }
  if (!Number.isFinite(Number(fileMtimeMs))) {
    return { offer: true, reason: 'file-missing' };
  }

  if (record.savedAt > Number(fileMtimeMs)) return { offer: true, reason: 'newer' };
  return { offer: false, reason: 'stale' };
}

const RESTORE_BUTTONS = ['Restore', 'Discard'];

/**
 * Same shape of care as closeDialogOptions: `cancelId` points at Discard here
 * rather than at the work-preserving button, and that is deliberate — this
 * dialog's cancel is not "put it back", it is "I did not ask for this". But
 * main.js only deletes the autosave on an explicit Discard, so a dismissed
 * dialog leaves the file where it is and offers again next launch. Escape
 * therefore costs nothing, which is the point.
 */
function restoreDialogOptions({ reason = 'newer', filePath = null } = {}) {
  const what = filePath
    ? `unsaved changes to ${documentName(filePath)}`
    : 'unsaved work';
  return {
    type: 'question',
    buttons: RESTORE_BUTTONS.slice(),
    defaultId: RESTORE_BUTTONS.indexOf('Restore'),
    cancelId: RESTORE_BUTTONS.indexOf('Discard'),
    title: APP_NAME,
    message: `Cutroom closed with ${what}.`,
    detail: reason === 'file-missing'
      ? 'The file it came from could not be found. Restoring opens the recovered version so you can save it somewhere.'
      : 'Restoring opens the recovered version. Discarding keeps the last version you saved.',
    noLink: true
  };
}

/** @returns {'restore'|'discard'} — anything unrecognised keeps the autosave. */
function restoreChoice(response) {
  return RESTORE_BUTTONS[response] === 'Restore' ? 'restore' : 'discard';
}

module.exports = {
  AUTOSAVE_VERSION,
  AUTOSAVE_FILENAME,
  APP_NAME,
  DIRTY_MARK,
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
};
