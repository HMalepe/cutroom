/*
 * project-schema.js
 * ---------------------------------------------------------------------------
 * What a .cutroom.json file has to look like before the app will load it.
 *
 * Opening a project used to be a bare JSON.parse whose result went straight to
 * the renderer, so a truncated, hand-edited or simply foreign JSON file threw
 * somewhere inside renderAll() — after `state.project` had already been
 * replaced. That leaves the window half-drawn, the project that was open gone,
 * and nothing on screen saying what happened. Checking the shape up front
 * means a bad file is refused before anything is replaced.
 *
 * Pure, no I/O and no Electron, so main.js and the tests can both use it.
 */

'use strict';

/**
 * Written into every saved project from now on. It exists so a later change to
 * the project shape has somewhere to branch on, which is only worth anything
 * if it is being written before that change is needed.
 *
 * Every project saved before this field existed has no version at all, so a
 * missing version is read as "pre-versioning" and loads normally. Refusing
 * those would break every file anyone already has.
 */
const PROJECT_VERSION = 1;

const TRACK_KINDS = ['video', 'audio'];

/**
 * @param {unknown} value  Whatever JSON.parse returned.
 * @returns {{ok: true, project: object} | {ok: false, error: string}}
 *   `error` is written to be shown to the user unchanged.
 */
function validateProject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'That file does not contain a Cutroom project.' };
  }

  // A version we have never heard of means the file was written by a newer
  // Cutroom. Loading it would be a guess, and the failure would show up later
  // as something inexplicable rather than here as something clear.
  if (value.version !== undefined) {
    const v = Number(value.version);
    if (!Number.isInteger(v) || v < 1) {
      return { ok: false, error: 'That project has an unreadable version number.' };
    }
    if (v > PROJECT_VERSION) {
      return { ok: false, error: `That project was saved by a newer version of Cutroom (format ${v}, this build reads ${PROJECT_VERSION}).` };
    }
  }

  if (!Array.isArray(value.tracks)) {
    return { ok: false, error: 'That project has no track list.' };
  }

  for (let i = 0; i < value.tracks.length; i++) {
    const track = value.tracks[i];
    const where = `Track ${i + 1}`;
    if (!track || typeof track !== 'object' || Array.isArray(track)) {
      return { ok: false, error: `${where} is not readable.` };
    }
    if (!TRACK_KINDS.includes(track.kind)) {
      return { ok: false, error: `${where} has no valid kind (expected ${TRACK_KINDS.join(' or ')}).` };
    }
    if (!Array.isArray(track.clips)) {
      return { ok: false, error: `${where} has no clip list.` };
    }
  }

  return { ok: true, project: value };
}

module.exports = { validateProject, PROJECT_VERSION, TRACK_KINDS };
