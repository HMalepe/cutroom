/*
 * app.js — the renderer.
 * ---------------------------------------------------------------------------
 * Holds the project state, draws the timeline, and hands the project object to
 * the main process when it is time to export. It never touches disk itself.
 *
 * Read order if you are picking this apart:
 *   1. state + the clip factory      — the data model
 *   2. renderTimeline                — how state becomes pixels
 *   3. pointer handlers              — how pixels become state again
 * Everything else hangs off those three.
 */

'use strict';

const api = window.cutroom;

// ==========================================================================
// State
// ==========================================================================

/**
 * A fresh project. A function rather than a literal because File > New needs
 * to build a second one, and two clips of a shared literal would be the same
 * object — editing the new project would edit the template it came from.
 */
function defaultProject() {
  return {
    name: 'untitled',
    width: 1080,
    height: 1920,
    fps: 30,
    bpm: 120,
    preset: 'medium',
    crf: 20,
    captionsEnabled: false,
    captions: [],
    captionStyle: {
      font: 'Arial',
      size: 54,
      color: '#FFFFFF',
      bold: true,
      background: false,
      bgColor: '#000000',
      bgOpacity: 0.7,
      outlineColor: '#000000',
      outlineWidth: 3,
      position: 'bottom',
      marginV: 220,
      animation: 'pop'
    },
    tracks: [
      { id: 'v1', kind: 'video', name: 'Video 1', clips: [] },
      { id: 'v2', kind: 'video', name: 'Video 2', clips: [] },
      { id: 'a1', kind: 'audio', name: 'Audio 1', clips: [] }
    ]
  };
}

const state = {
  project: defaultProject(),
  bin: [],
  binSelection: [],
  selectedClipId: null,
  selectedClipIds: [],
  playhead: 0,
  pxPerSec: 40,
  snapBeats: false,
  env: null,
  exporting: false
};

let clipSeq = 0;
const uid = (p) => `${p}${Date.now().toString(36)}${(clipSeq++).toString(36)}`;

// ==========================================================================
// Small utilities
// ==========================================================================

const $ = (id) => document.getElementById(id);

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function fmtTime(sec) {
  const s = Math.max(0, sec);
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(Math.floor(s % 60)).padStart(2, '0');
  const ff = String(Math.floor((s % 1) * 100)).padStart(2, '0');
  return { main: `${h}:${m}:${ss}`, frac: ff };
}

function fileUrl(p) {
  return 'file://' + p.split(/[\\/]/).map(encodeURIComponent).join('/');
}

function toast(msg, kind = 'ok', detail = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  if (detail) {
    const pre = document.createElement('pre');
    pre.textContent = detail;
    el.appendChild(pre);
  }
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 14000 : 5000);
}

const beatSec = () => 60 / (state.project.bpm || 120);

function snap(sec) {
  if (!state.snapBeats) return sec;
  const b = beatSec();
  return Math.round(sec / b) * b;
}

// Edge snapping — always on, unlike beat-snap, because "line these two clips
// up exactly" is not an optional editing style the way a BPM grid is. The
// threshold lives in screen pixels and is converted at call time rather than
// stored in seconds, because pxPerSec changes with zoom: a fixed-seconds
// threshold would reach clear across the visible timeline when zoomed out
// and never fire at all zoomed in.
const SNAP_PX = 8;
const snapThresholdSec = () => SNAP_PX / state.pxPerSec;

/**
 * Every position worth lining a dragged edge up with, other than the clip
 * being dragged itself: 0, the playhead, and every other clip's start and
 * end on every track — not just the one the dragged clip lives on, since
 * snapping a keyed clip on Video 2 to a cut on Video 1 is ordinary.
 */
function snapCandidates(excludeClipId) {
  const candidates = TimelineSnapping.edgeCandidates(state.project.tracks, excludeClipId);
  candidates.push(0, state.playhead);
  return candidates;
}

/** Single-edge snap — the left/right trim case, where only one point on the clip moves. */
function snapEdge(pos, excludeClipId) {
  const candidates = snapCandidates(excludeClipId);
  if (state.snapBeats) candidates.push(Math.round(pos / beatSec()) * beatSec());
  return TimelineSnapping.snapTarget(candidates, pos, snapThresholdSec());
}

/** Whole-clip move — both edges are candidates for snapping; see snapMoveStart's own comment. */
function snapMove(rawStart, durationSec, excludeClipId) {
  const candidates = snapCandidates(excludeClipId);
  if (state.snapBeats) {
    const b = beatSec();
    candidates.push(Math.round(rawStart / b) * b, Math.round((rawStart + durationSec) / b) * b);
  }
  return TimelineSnapping.snapMoveStart(rawStart, durationSec, candidates, snapThresholdSec());
}

// ==========================================================================
// Data model
// ==========================================================================

/** Build a timeline clip from a bin item. */
function makeClip(media, startSec) {
  return {
    id: uid('c'),
    src: media.path,
    name: media.name,
    sourceDuration: media.duration,
    hasAudio: media.hasAudio,
    hasVideo: media.hasVideo,
    colorMatrix: media.colorMatrix,
    inSec: 0,
    outSec: media.duration || 5,
    startSec: startSec,
    speed: 1,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
    scale: 1,
    posX: 0,
    posY: 0,
    chroma: { on: false, color: '#00FF00', similarity: 0.1, blend: 0.05 },
    filters: { brightness: 0, contrast: 1, saturation: 1 }
  };
}

const clipDur = (c) => Math.max(0, (c.outSec - c.inSec) / (c.speed || 1));
const clipEnd = (c) => c.startSec + clipDur(c);

function projectDuration() {
  let max = 0;
  for (const t of state.project.tracks) {
    for (const c of t.clips) max = Math.max(max, clipEnd(c));
  }
  return max;
}

function findClip(id) {
  for (const t of state.project.tracks) {
    const c = t.clips.find(x => x.id === id);
    if (c) return { clip: c, track: t };
  }
  return { clip: null, track: null };
}

function selectedClip() { return findClip(state.selectedClipId).clip; }

/**
 * The full multi-selection, resolved against the current project so a clip
 * removed by some other path (undo landing on an older project, say) can
 * never leave a stale id sitting in state.selectedClipIds.
 */
function selectedClips() {
  return state.selectedClipIds.map(id => findClip(id)).filter(x => x.clip);
}

/**
 * Replace the selection outright. `primary` is who the inspector, Split, Set
 * In/Out and Transcribe act on — see the pointerdown handler's own comment
 * for why those stay single-clip even after multi-select landed. Defaults to
 * the last id in the new set, which is "whatever was just clicked" for every
 * caller here.
 */
function setSelection(ids, primary) {
  state.selectedClipIds = [...ids];
  state.selectedClipId = primary !== undefined ? primary
    : (ids.length ? ids[ids.length - 1] : null);
}

function clearSelection() { setSelection([]); }

/** Shift/Ctrl/Cmd-click on a clip: add it if absent, drop it if present. */
function toggleClipSelection(id) {
  const ids = [...state.selectedClipIds];
  const i = ids.indexOf(id);
  if (i >= 0) ids.splice(i, 1); else ids.push(id);
  setSelection(ids);
}

/** Next free position on a track, so new clips land after existing ones. */
function trackTail(track) {
  return track.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
}

// ==========================================================================
// Undo / redo
// ==========================================================================

/*
 * What a snapshot covers is a judgement about what an undo should feel like.
 *
 * The project is in, obviously. Selection is in too: undoing a delete that
 * does not give you the clip back selected feels like it only half worked.
 *
 * Everything else is deliberately out. The media bin is not an edit — undoing
 * a trim should not un-import a file. Playhead, zoom and beat-snap are where
 * you are looking, not what you have made; rewinding them under the user is
 * disorienting rather than helpful.
 */
const history = createHistory({
  read: () => ({
    project: state.project,
    selectedClipId: state.selectedClipId,
    selectedClipIds: state.selectedClipIds
  }),
  write: (snap) => {
    state.project = snap.project;
    state.selectedClipId = snap.selectedClipId;
    // Falls back to the single id if a snapshot somehow lacks the array, so
    // a subtly different history shape can never crash the write path.
    state.selectedClipIds = snap.selectedClipIds || (snap.selectedClipId ? [snap.selectedClipId] : []);
    // A restored project can be shorter than where the playhead was left.
    state.playhead = Math.min(state.playhead, Math.max(projectDuration(), 0));
    syncProjectInputs();
    renderAll();
    renderCaptions();
    renderCaptionStyle();
    renderTemplates();
  },
  limit: 100
});

/** Convenience for the common case: one discrete edit, one undo entry. */
function edit(label, fn) {
  history.run(label, fn);
  updateHistoryButtons();
}

/**
 * The project panel and caption checkbox are plain HTML inputs rather than
 * re-rendered markup, so they need pushing back into sync after an undo.
 */
function syncProjectInputs() {
  const p = state.project;
  $('projectName').value = p.name || 'untitled';
  $('projW').value = p.width;
  $('projH').value = p.height;
  $('projFps').value = p.fps;
  $('projBpm').value = p.bpm;
  $('projPreset').value = p.preset || 'medium';
  $('capEnabled').checked = Boolean(p.captionsEnabled);
}

function updateHistoryButtons() {
  const u = $('btnUndo');
  const r = $('btnRedo');
  u.disabled = !history.canUndo();
  r.disabled = !history.canRedo();
  u.title = history.canUndo() ? `Undo ${history.undoLabel()}` : 'Nothing to undo';
  r.title = history.canRedo() ? `Redo ${history.redoLabel()}` : 'Nothing to redo';
  // Every path that changes the project passes through here, which makes this
  // the one hook that cannot fall out of step with the edits. See
  // notifyProjectChanged.
  notifyProjectChanged();
}

/**
 * Undo feedback replaces itself instead of stacking. Naming the edit is
 * useful — an undo whose effect is off-screen otherwise looks like nothing
 * happened — but holding the shortcut down would otherwise bury the window
 * in a column of near-identical toasts.
 */
let lastHistoryToast = null;
function historyToast(msg, kind = 'ok') {
  if (lastHistoryToast) lastHistoryToast.remove();
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('toasts').appendChild(el);
  lastHistoryToast = el;
  setTimeout(() => {
    el.remove();
    if (lastHistoryToast === el) lastHistoryToast = null;
  }, 2500);
}

/*
 * Both of these close any edit still open first. Pressing undo halfway
 * through typing a caption should undo that typing, not skip over it to the
 * edit before — and without the commit, the half-finished edit would be lost
 * silently rather than recorded.
 */
function doUndo(source = 'ui') {
  if (!commandGuard.allow('undo', source, Date.now())) return;
  history.commit();
  const label = history.undo();
  updateHistoryButtons();
  historyToast(label ? `Undid ${label}.` : 'Nothing left to undo.', label ? 'ok' : 'warn');
}

function doRedo(source = 'ui') {
  if (!commandGuard.allow('redo', source, Date.now())) return;
  history.commit();
  const label = history.redo();
  updateHistoryButtons();
  historyToast(label ? `Redid ${label}.` : 'Nothing to redo.', label ? 'ok' : 'warn');
}

/*
 * Copy and paste can each arrive from two sources on a given platform, the
 * same way undo/redo above can: the Edit menu's own `copy`/`paste` roles
 * already own Cmd/Ctrl+C/V everywhere a real text field needs them (see
 * wireClipboardShortcuts in main.js for how that keystroke also reaches the
 * renderer here), and this file's own keydown listener is the other path.
 * Whichever one actually delivers the keystroke is a platform question this
 * code does not have to be right about, because commandGuard drops
 * whichever arrives second within the window — same guard, same reasoning,
 * just extended to two more commands.
 */
function doCopy(source = 'ui') {
  if (!commandGuard.allow('copy', source, Date.now())) return;
  copySelected();
}

function doPaste(source = 'ui') {
  if (!commandGuard.allow('paste', source, Date.now())) return;
  pasteClipboard();
}

/**
 * Wire a control whose value changes continuously — a slider, or a text box
 * typed into character by character — so the whole gesture becomes one entry.
 *
 * Grabbing the control opens the edit; releasing it or leaving the field
 * closes it. If the value ends up where it started, commit discards it.
 */
function trackContinuous(el, label) {
  el.addEventListener('pointerdown', () => history.begin(label));
  el.addEventListener('focus', () => history.begin(label));
  el.addEventListener('change', () => { history.commit(); updateHistoryButtons(); });
  el.addEventListener('blur', () => { history.commit(); updateHistoryButtons(); });
  return el;
}

// ==========================================================================
// Save state — dirty tracking, autosave, and the file we came from
// ==========================================================================

/*
 * Dirty is a comparison against the last-saved content, not a flag any edit
 * sets — dirty-state.js has the reasoning, and the short version is that an
 * edit followed by its own undo leaves you clean, because you are.
 */
const dirtyTracker = createDirtyTracker({ read: () => state.project });
const commandGuard = createCommandGuard();

/*
 * Autosave timing. `pendingSince` is when the oldest unsaved change arrived
 * and `lastChangeAt` the newest; autosaveDue() reads both, so a pause in
 * editing writes an autosave and so does editing for long enough without one.
 */
let pendingSince = null;
let lastChangeAt = null;
let lastSeenSnapshot = null;
let reported = { dirty: false, name: null };

/**
 * Notice that the project may have changed, and tell main if the answer moved.
 *
 * Hooked into updateHistoryButtons() rather than into each edit site, because
 * every path that changes the project already ends there — edit(), undo, redo,
 * and the change/blur handlers trackContinuous puts on the static controls. A
 * per-site hook is a list to keep in step with; this is one that maintains
 * itself. The interval below is the backstop for anything that ever escapes it.
 *
 * @returns {boolean} whether the project differs from the file.
 */
function notifyProjectChanged() {
  const snapshot = dirtyTracker.snapshot();
  const dirty = dirtyTracker.isDirty(snapshot);

  if (snapshot !== lastSeenSnapshot) {
    lastSeenSnapshot = snapshot;
    lastChangeAt = Date.now();
    if (pendingSince === null) pendingSince = lastChangeAt;
  }

  // Clean means the file on disk already has everything, so whatever was
  // pending is not worth writing to an autosave any more. This is the gate
  // that stops a project undone back to its saved state from going on
  // autosaving. Stated unconditionally, above the report check below, because
  // the invariant is about the project rather than about whether the report
  // moved — the two coincide today, and this way it does not matter if they
  // ever stop.
  if (!dirty) pendingSince = null;

  const name = state.project.name || 'untitled';
  if (dirty === reported.dirty && name === reported.name) return dirty;
  reported = { dirty, name };
  // Main deletes the autosave whenever it hears "clean", so the next launch
  // has nothing stale to offer.
  api.reportProjectState({ dirty, name });
  return dirty;
}

/**
 * Polled rather than scheduled. A timer set per edit has to be cancelled and
 * re-armed correctly on every path that can change or save the project; a tick
 * that asks a pure function whether anything is due cannot get that wrong, and
 * once a second is imperceptible against a two-second quiet window.
 */
const AUTOSAVE_TICK_MS = 1000;
function autosaveTick() {
  notifyProjectChanged();
  if (!autosaveDue({ pendingSince, lastChangeAt, now: Date.now() })) return;
  // Cleared before the write, not after: it is what marks these changes as
  // dealt with, and leaving it set would autosave the same project on every
  // subsequent tick for as long as the app sat idle.
  pendingSince = null;
  api.autosave(state.project);
}

/**
 * Save, or Save As. Returns the result so the callers that have to know
 * whether it actually happened — the close guard, and the confirm before New
 * or Open — can act on a cancelled dialog rather than assume a success.
 */
async function doSave(saveAs = false) {
  // Any half-finished edit is part of what is being saved.
  history.commit();
  updateHistoryButtons();

  // Captured before the await, so the baseline records what was written rather
  // than whatever the project drifted to while the dialog was open.
  const snapshot = dirtyTracker.snapshot();
  const res = await api.saveProject(state.project, saveAs);

  if (!res || res.canceled) return { canceled: true };
  if (!res.ok) {
    toast('Could not save the project', 'err',
      res.detail ? `${res.error}\n${res.detail}` : (res.error || ''));
    return { ok: false };
  }

  dirtyTracker.markSaved(snapshot);
  notifyProjectChanged();
  toast('Project saved.');
  return res;
}

/**
 * The prompt before anything that walks away from unsaved work. Resolves true
 * if the caller may go ahead.
 *
 * Cancelling the Save dialog has to stop the whole thing, not fall through to
 * the discard it was standing in front of — which is the bug this shape exists
 * to make impossible to write by accident.
 */
async function confirmDiscard() {
  // Recomputed rather than read off the last report: this is the moment the
  // answer decides whether work survives, and it also pushes the fresh value
  // to main, which re-checks its own mirror before showing the dialog.
  if (!notifyProjectChanged()) return true;
  const choice = await api.confirmDiscard();
  if (choice === 'cancel') return false;
  if (choice === 'save') {
    const res = await doSave(false);
    return Boolean(res && res.ok);
  }
  return true;
}

/**
 * Put a project on screen. Shared by Open and by an autosave restore, because
 * the seven things that have to happen are the same either way and the one
 * that gets forgotten — clearing the undo stack — is the one whose absence
 * lets an undo reach back into a project that is no longer open.
 */
function adoptProject(project) {
  state.project = project;
  state.selectedClipId = null;
  state.selectedClipIds = [];
  state.playhead = 0;
  history.clear();
  updateHistoryButtons();
  syncProjectInputs();
  renderAll(); renderCaptions(); renderCaptionStyle(); renderTemplates();
}

async function doOpen() {
  if (!await confirmDiscard()) return;
  const res = await api.openProject();
  if (!res) return;
  if (!res.ok) {
    // Nothing has been touched yet, so the project on screen is still the one
    // that was open before the dialog — which is the point of checking the
    // file's shape in main.js before any of the replacement below runs.
    toast('Could not open that project', 'err', res.detail ? `${res.error}\n${res.detail}` : res.error);
    return;
  }
  adoptProject(res.project);
  // Opened means saved: what is on screen is exactly what is in the file.
  dirtyTracker.markSaved();
  notifyProjectChanged();
  toast('Project opened.');
}

async function doNew() {
  if (!await confirmDiscard()) return;
  await api.newProject();
  adoptProject(defaultProject());
  // The media bin survives, for the reason undo leaves it alone: importing a
  // file is not an edit, and making someone re-find their footage to start a
  // second cut of it would be a strange thing to call New.
  dirtyTracker.markSaved();
  notifyProjectChanged();
  toast('New project.');
}

// ==========================================================================
// Environment
// ==========================================================================

async function checkEnv() {
  state.env = await api.checkEnv();
  const ok = Boolean(state.env.ffmpeg);
  $('envDot').classList.toggle('ok', ok);
  $('envText').textContent = ok
    ? (state.env.whisper ? 'ffmpeg + whisper' : 'ffmpeg')
    : 'ffmpeg missing';
  $('envPill').title = ok
    ? `ffmpeg: ${state.env.ffmpeg}\nwhisper: ${state.env.whisper || 'not installed'}`
    : 'Install ffmpeg, then restart Cutroom.';
  if (!ok) {
    toast('ffmpeg not found. Nothing will export until it is installed.', 'err',
      'macOS:  brew install ffmpeg\nWindows: winget install ffmpeg\nLinux:  sudo apt install ffmpeg');
  }
}

// ==========================================================================
// Media bin
// ==========================================================================

async function addPaths(paths) {
  if (!paths || !paths.length) return;
  let added = 0;
  for (const p of paths) {
    if (state.bin.some(m => m.path === p)) continue;
    try {
      const media = await api.probe(p);
      // A still image probes as zero duration. Give it a sane default so it
      // can sit on the timeline like anything else.
      if (!media.duration || media.duration < 0.02) media.duration = 4;
      state.bin.push(media);
      added++;
    } catch (err) {
      toast(`Could not read ${p.split(/[\\/]/).pop()}`, 'err', String(err.message || err));
    }
  }
  if (added) renderBin();
}

function renderBin() {
  const list = $('binList');
  list.innerHTML = '';
  for (const m of state.bin) {
    const el = document.createElement('div');
    el.className = 'bin-item' + (state.binSelection.includes(m.path) ? ' selected' : '');

    const kind = document.createElement('div');
    kind.className = 'bin-kind' + (m.hasVideo ? '' : ' audio');
    el.appendChild(kind);

    const meta = document.createElement('div');
    meta.className = 'bin-meta';
    const name = document.createElement('div');
    name.className = 'bin-name';
    name.textContent = m.name;
    name.title = m.path;
    const sub = document.createElement('div');
    sub.className = 'bin-sub';
    sub.textContent = m.hasVideo
      ? `${m.width}×${m.height} · ${m.duration.toFixed(1)}s${m.hasAudio ? '' : ' · silent'}`
      : `audio · ${m.duration.toFixed(1)}s`;
    meta.append(name, sub);
    el.appendChild(meta);

    el.onclick = (e) => {
      const i = state.binSelection.indexOf(m.path);
      if (e.metaKey || e.ctrlKey || e.shiftKey) {
        if (i >= 0) state.binSelection.splice(i, 1); else state.binSelection.push(m.path);
      } else {
        state.binSelection = i >= 0 && state.binSelection.length === 1 ? [] : [m.path];
      }
      renderBin();
      loadPreviewFromBin(m.path);
    };
    list.appendChild(el);
  }

  $('binHint').textContent = state.binSelection.length
    ? `${state.binSelection.length} selected — order of selection is the order they land.`
    : 'Select clips in the bin, then send them to a track. Order of selection is the order they land.';
}

function sendToTrack(trackId) {
  const track = state.project.tracks.find(t => t.id === trackId);
  if (!track) return;
  if (!state.binSelection.length) { toast('Select something in the bin first.', 'warn'); return; }

  edit('add clips', () => {
    let cursor = trackTail(track);
    for (const p of state.binSelection) {
      const media = state.bin.find(m => m.path === p);
      if (!media) continue;
      if (track.kind === 'audio' && !media.hasAudio) {
        toast(`${media.name} has no audio stream.`, 'warn');
        continue;
      }
      const clip = makeClip(media, cursor);
      // On a video track, a clip's own audio is on by default. On an audio
      // track only the audio matters.
      if (track.kind === 'audio') clip.hasVideo = false;
      track.clips.push(clip);
      cursor = clipEnd(clip);
    }
  });
  state.binSelection = [];
  // The clip just landed on the timeline — show that, not whatever bin item
  // happened to be previewing plain a moment ago (often the very same file).
  binPreviewPath = null;
  renderBin();
  renderAll();
}

// ==========================================================================
// Preview
// ==========================================================================

/*
 * The pane has three modes.
 *
 * Bin — a bin item played plain, own controls, no compositing. Set by
 * clicking the bin rather than the timeline; binPreviewPath !== null is what
 * marks it, and any timeline interaction (the ruler, a clip, an arrow key)
 * clears it and hands the pane back to the timeline.
 *
 * Composited — the pane shows whatever is actually on the timeline at
 * state.playhead: the active clip on each video track, keyed and graded
 * exactly as the old per-clip preview did, Video 2 over Video 1. This is
 * driven by the playhead, not by clip selection — selecting a clip only
 * changes what the inspector edits, and those edits show up here the moment
 * the playhead is sitting over that clip, same as it always could. A layer
 * pool of canvas+<video> pairs (layerPool, below) supplies one pair per
 * active layer: normally one per video track, up to POOL_SIZE at once if
 * both tracks happen to be mid-crossfade together. Pressing play now
 * advances a timeline clock (stepTimelineClock, in timeline-preview.js) that
 * seeks every active layer's <video> to keep pace with it, rather than the
 * old design where a single <video>'s own playback WAS the clock.
 *
 * Fallback — composited mode needs a working WebGL context; without one this
 * degrades to the plain <video> again, showing whichever clip is topmost at
 * the playhead. It does not attempt the timeline clock or the per-clip trim
 * loop the keyed pane used to run — same as before this feature existed, it
 * quietly plays the source file at 1x, start to end, and the playhead does
 * not track it. That gap is deliberate: driving several <video> elements off
 * one JS clock is the part of this feature only a real browser can prove out
 * (nothing here launches one), so the degraded path is kept exactly as small
 * and well-understood as it already was rather than guessing at a second
 * un-testable clock implementation for a case meant to be rare.
 *
 * Neither the composited nor the fallback path plays audio: every layer
 * <video> is muted. Mixing several clips' audio live was ruled out of scope
 * — see the README — and playing just one of several simultaneous layers
 * unmuted would be arbitrary about which. The bin-preview path is unaffected
 * and keeps its audio, same as before.
 *
 * Crossfades get an explicit, honest approximation rather than either the
 * real xfade curve (out of scope — this is not a fragment-shader port of
 * fifty transition types) or nothing: the outgoing and incoming clips both
 * draw, cross-dissolved by canvas opacity, and a badge under the pane names
 * the export's real transition so a wipe or slide never gets mistaken for
 * the dissolve standing in for it here. See timeline-preview.js's
 * trackStateAt for exactly where that window and its progress come from.
 *
 * Captions are not drawn here at all, same gap the old preview had — Test 3s
 * remains the way to check those. Rendering the caption style panel's font,
 * colour, position and background as an HTML overlay was considered and cut:
 * everything else in this feature already needs proving out in a real
 * browser this harness cannot launch, and a second unverified approximation
 * layered on top of the first was worse than being honest that this PR ends
 * at the video layers.
 */

// One canvas+<video> pair per concurrent layer. #keyCanvas (pool[0]) always
// exists in the markup; the rest are created lazily and kept for the life of
// the session rather than torn down at every clip boundary — recreating a
// WebGL context is real work, and a fixed pool of four hidden, paused
// elements is not the kind of growth "leaking" means. Two video tracks each
// mid-crossfade is the most layers layersAt can ever hand back at once; a
// third clip overlapping *inside* an active crossfade on one track (a
// same-track triple overlap) is not resolved by trackStateAt either, and is
// not attempted here — see that function's own comment.
const POOL_SIZE = 4;
const layerPool = [];

// A decoder free-running at 1x still drifts a frame or two from wall-clock
// time; correcting on every tick would fight the decoder instead of letting
// it run, so a layer is only reseeked once it has drifted past this.
const DRIFT_THRESHOLD = 0.15;

let binPreviewPath = null;   // non-null while a bin item, not the timeline, is showing
let fallbackClipId = null;   // which clip #video is playing in the no-WebGL fallback
let compositedActive = false; // whether togglePlay should drive the timeline clock
let timelinePlaying = false;
let lastTickAt = null;
let previewRaf = 0;
let previewDirty = false;
// Which clips are on screen right now, so crossing a clip or crossfade
// boundary forces a draw even while paused and otherwise clean — the same
// job requestPreviewFrame() does for an edit, but for a change nothing
// called requestPreviewFrame() for: the playhead simply arriving somewhere
// new.
let lastLayerSignature = null;

function layerSignature(layers) {
  return layers.map(({ trackId, state: s }) => (
    s.kind === 'solo' ? `${trackId}:${s.clip.id}` : `${trackId}:${s.outgoing.id}>${s.incoming.id}`
  )).join('|');
}

function createLayerCanvas() {
  const c = document.createElement('canvas');
  c.className = 'key-canvas layer';
  c.style.display = 'none';
  return c;
}

function makePoolEntry(idx) {
  const canvas = idx === 0 ? $('keyCanvas') : createLayerCanvas();
  if (idx !== 0) $('previewStage').appendChild(canvas);
  // Muted per the header comment; texture-only keeps it decoding without
  // showing its own frame (display:none can throttle decode — see the CSS).
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.className = 'texture-only';
  // A fresh src has no decoded frame yet, so the very first draw() attempt
  // for a clip the pane has never shown before can land before the browser
  // has metadata (see draw()'s own vw/vh guard). Nothing else asks for a
  // redraw purely because time passed while paused -- scrubbing within the
  // SAME clip never changes layerSignature, so previewDirty stays false and
  // drawComposited() is never called again on its own. Left alone, the pane
  // can come up blank and stay blank. loadeddata is the fix: once the video
  // actually has a frame to hand the shader, ask for one more draw.
  video.addEventListener('loadeddata', requestPreviewFrame);
  $('viewer').appendChild(video);
  return { canvas, video, keyer: null, keyerTried: false, currentSrc: null };
}

function poolEntry(i) {
  while (layerPool.length <= i) layerPool.push(makePoolEntry(layerPool.length));
  return layerPool[i];
}

/** Lazy and sticky per entry, the same shape the old single getKeyer() was. */
function keyerFor(entry) {
  if (!entry.keyerTried) {
    entry.keyerTried = true;
    try {
      entry.keyer = typeof createKeyPreview === 'function' ? createKeyPreview(entry.canvas) : null;
    } catch (err) {
      entry.keyer = null;
    }
  }
  return entry.keyer;
}

function pauseAllLayers() {
  for (const entry of layerPool) {
    if (entry.video && !entry.video.paused) entry.video.pause();
  }
}

/**
 * play() returns a promise a real browser can reject under an autoplay
 * policy, but some engines — jsdom among them, since it has no decoder at
 * all — throw synchronously instead of returning anything. Both are the
 * same "could not play, and that is fine" outcome to this pane, which never
 * carries audio (see the header comment) and has nothing riding on it.
 */
function safePlay(video) {
  try {
    const p = video.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (err) { /* see above */ }
}

/**
 * Drive one layer's <video> toward where the timeline clock says its clip's
 * source should be. Playing lets the decoder run and only corrects once it
 * drifts (see DRIFT_THRESHOLD); paused parks it exactly, the way scrubbing
 * always has.
 */
function syncVideoToTime(video, clip, expected, playing) {
  video.playbackRate = clampPlaybackRate(clip.speed);
  if (playing) {
    const seek = TimelinePreview.driftSeek(video.currentTime, expected, DRIFT_THRESHOLD);
    if (seek !== null) video.currentTime = seek;
    if (video.paused) safePlay(video);
  } else {
    if (!video.paused) video.pause();
    if (Math.abs((video.currentTime || 0) - expected) > 1e-3) video.currentTime = expected;
  }
}

function showEmptyPane() {
  $('previewStage').style.display = 'none';
  $('video').style.display = 'none';
  $('video').controls = false;
  $('scrub').style.display = 'none';
  $('xfadeBadge').style.display = 'none';
  $('viewerEmpty').style.display = 'block';
  pauseAllLayers();
}

/** Point the pane at a bin item, plain, own controls — no compositing. */
function loadPreviewFromBin(path) {
  binPreviewPath = path || null;
  const v = $('video');
  if (!path) {
    v.removeAttribute('src');
    v.style.display = 'none';
    $('viewerEmpty').style.display = 'block';
    return;
  }
  v.src = fileUrl(path);
  v.style.display = 'block';
  v.controls = true;
  v.classList.remove('texture-only');
  $('previewStage').style.display = 'none';
  $('scrub').style.display = 'none';
  $('xfadeBadge').style.display = 'none';
  $('viewerEmpty').style.display = 'none';
  syncTimelinePreview();
}

/**
 * The no-WebGL degraded path: whichever clip is topmost at the playhead,
 * plain, no loop, no timeline clock — see the header comment for why.
 */
function drawPlainFallback(layers) {
  const top = layers[layers.length - 1].state;
  const clip = top.kind === 'crossfade' ? top.incoming : top.clip;

  $('previewStage').style.display = 'none';
  $('scrub').style.display = 'none';
  $('xfadeBadge').style.display = 'none';
  $('viewerEmpty').style.display = 'none';

  const v = $('video');
  v.style.display = 'block';
  v.controls = true;
  v.classList.remove('texture-only');

  const changed = fallbackClipId !== clip.id;
  if (changed) {
    fallbackClipId = clip.id;
    v.src = fileUrl(clip.src);
  }
  // Only force the frame while paused: fighting an already-playing native
  // element with a seek on every sync is exactly what this path is meant to
  // avoid running a clock to prevent.
  if (changed || v.paused) v.currentTime = TimelinePreview.sourceTimeFor(clip, state.playhead);
}

/** Composite every active layer onto the stage through its own pool entry. */
function drawComposited(layers, t) {
  $('viewerEmpty').style.display = 'none';
  $('video').style.display = 'none';
  $('previewStage').style.display = 'inline-block';
  $('scrub').style.display = '';

  const slots = [];
  let transition = null;
  for (const { state: layerState } of layers) {
    if (layerState.kind === 'solo') {
      slots.push({ clip: layerState.clip, opacity: 1 });
    } else {
      transition = layerState.transition;
      slots.push({ clip: layerState.outgoing, opacity: 1 - layerState.progress });
      slots.push({ clip: layerState.incoming, opacity: layerState.progress });
    }
  }

  const badge = $('xfadeBadge');
  if (transition) {
    badge.textContent = `crossfade preview: dissolve (export uses "${transition}")`;
    badge.style.display = 'block';
  } else {
    badge.style.display = 'none';
  }

  const used = Math.min(slots.length, POOL_SIZE);
  for (let i = 0; i < used; i++) {
    const entry = poolEntry(i);
    const slot = slots[i];
    const srcTime = TimelinePreview.sourceTimeFor(slot.clip, t);

    if (entry.currentSrc !== slot.clip.src) {
      entry.currentSrc = slot.clip.src;
      entry.video.src = fileUrl(slot.clip.src);
    }
    syncVideoToTime(entry.video, slot.clip, srcTime, timelinePlaying);

    entry.canvas.style.display = 'block';
    entry.canvas.style.opacity = String(slot.opacity);

    const keyer = keyerFor(entry);
    // A keyer that fails only for this one entry (a context limit, say) just
    // leaves its canvas blank rather than pulling the whole pane back to the
    // fallback — pool[0] having worked is what got us into this branch.
    if (keyer && !keyer.isLost()) keyer.draw(entry.video, slot.clip, state.project);
  }
  for (let i = used; i < layerPool.length; i++) {
    layerPool[i].canvas.style.display = 'none';
    if (!layerPool[i].video.paused) layerPool[i].video.pause();
  }
}

/**
 * The single entry point: decide bin vs. composited vs. fallback vs. empty,
 * and draw whichever it is. Called from renderAll (so undo, edits and
 * selection all reach it), from every place that moves state.playhead, and
 * once a tick from the preview loop while that loop is running.
 */
function syncTimelinePreview() {
  if (binPreviewPath !== null) {
    stopPreviewLoop();
    compositedActive = false;
    lastLayerSignature = null;
    return;
  }

  const t = state.playhead;
  const layers = TimelinePreview.layersAt(state.project.tracks, t, TimelinePreview.minOverlapFor(state.project));

  // Nothing at the playhead and nothing running — leave WebGL untouched.
  // Building a context costs something, and a project that never keys never
  // needs one; checked again below once there is actually a reason to ask.
  if (!layers.length && !timelinePlaying) {
    showEmptyPane();
    stopPreviewLoop();
    compositedActive = false;
    lastLayerSignature = null;
    return;
  }

  const entry0 = poolEntry(0);
  const keyer0 = keyerFor(entry0);

  if (keyer0 && keyer0.isLost()) {
    // The GPU took the context away — a driver reset, a laptop waking up.
    // Give up on it for the session, same as the old single-canvas pane did.
    entry0.keyer = null;
    toast('Lost the graphics context — the preview is back to the plain player.', 'warn');
    syncTimelinePreview();
    return;
  }

  if (!keyer0) {
    compositedActive = false;
    lastLayerSignature = null;
    stopPreviewLoop();
    if (layers.length) drawPlainFallback(layers); else showEmptyPane();
    return;
  }

  compositedActive = true;

  if (!layers.length) {
    // A gap mid-playback: nothing to draw this instant, but the clock keeps
    // running so the next clip picks the preview back up on its own.
    showEmptyPane();
    lastLayerSignature = null;
    startPreviewLoop();
    return;
  }

  // The playhead landing on a different clip, or crossing into or out of a
  // crossfade, is not itself an "edit" — nothing called requestPreviewFrame()
  // for it — but it still has to draw the first time, not wait for one.
  const sig = layerSignature(layers);
  if (sig !== lastLayerSignature) previewDirty = true;
  lastLayerSignature = sig;

  if (timelinePlaying || previewDirty) {
    previewDirty = false;
    drawComposited(layers, t);
  }
  startPreviewLoop();
}

/** Ask for one more frame. Cheap, and safe to call from anywhere. */
function requestPreviewFrame() { previewDirty = true; }

function startPreviewLoop() {
  if (previewRaf || typeof requestAnimationFrame !== 'function') return;
  const tick = () => {
    previewRaf = requestAnimationFrame(tick);
    tickTimeline();
  };
  previewRaf = requestAnimationFrame(tick);
}

function stopPreviewLoop() {
  if (previewRaf) cancelAnimationFrame(previewRaf);
  previewRaf = 0;
  lastTickAt = null;
}

function nowMs() {
  return (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now() : Date.now();
}

/** One frame of the timeline clock, then a redraw. Pure decision, DOM side —
 *  see stepTimelineClock in timeline-preview.js for the part that is tested
 *  without a loop around it. */
function tickTimeline() {
  if (timelinePlaying) {
    const now = nowMs();
    const dt = lastTickAt === null ? 0 : Math.max(0, (now - lastTickAt) / 1000);
    lastTickAt = now;
    const result = TimelinePreview.stepTimelineClock({
      playhead: state.playhead, playing: true, dt, duration: projectDuration()
    });
    state.playhead = result.playhead;
    if (!result.playing) { timelinePlaying = false; $('btnPlay').textContent = 'Play'; }
    updatePlayheadUI();
  }
  syncTimelinePreview();
}

/** Start or stop the timeline clock, or fall back to the old plain toggle
 *  when there is nothing for a clock to drive. */
function togglePlay() {
  const v = $('video');
  if (binPreviewPath !== null || !compositedActive) {
    if (v.paused) safePlay(v); else v.pause();
    $('btnPlay').textContent = v.paused ? 'Play' : 'Pause';
    return;
  }
  if (timelinePlaying) {
    timelinePlaying = false;
    pauseAllLayers();
  } else {
    timelinePlaying = true;
    lastTickAt = null; // first tick supplies dt=0, so playback does not jump
    startPreviewLoop();
  }
  $('btnPlay').textContent = timelinePlaying ? 'Pause' : 'Play';
}

// ==========================================================================
// Timeline rendering
// ==========================================================================

function renderHeads() {
  const heads = $('tlHeads');
  heads.innerHTML = '<div class="tl-heads-pad"></div>';
  for (const track of state.project.tracks) {
    const el = document.createElement('div');
    el.className = 'track-head';

    const name = document.createElement('div');
    name.className = 'track-head-name';
    name.textContent = track.name;

    const btns = document.createElement('div');
    btns.className = 'track-head-btns';

    const mute = document.createElement('button');
    mute.className = 'chip' + (track.muted ? ' on' : '');
    mute.textContent = 'M';
    mute.title = 'Mute this track in the export';
    mute.onclick = () => { edit('mute', () => { track.muted = !track.muted; }); renderAll(); };

    const hide = document.createElement('button');
    hide.className = 'chip' + (track.hidden ? ' on' : '');
    hide.textContent = 'H';
    hide.title = 'Hide this track in the export';
    hide.onclick = () => { edit('hide track', () => { track.hidden = !track.hidden; }); renderAll(); };

    btns.append(mute);
    if (track.kind === 'video') btns.append(hide);
    el.append(name, btns);
    heads.appendChild(el);
  }
}

function renderRuler(width) {
  const ruler = $('ruler');
  ruler.innerHTML = '';
  ruler.style.width = width + 'px';

  // Pick a tick interval that keeps labels roughly 70px apart at any zoom.
  const targetPx = 74;
  const candidates = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const step = candidates.find(c => c * state.pxPerSec >= targetPx) || 600;

  const total = width / state.pxPerSec;
  for (let t = 0; t <= total; t += step) {
    const tick = document.createElement('div');
    tick.className = 'ruler-tick';
    tick.style.left = (t * state.pxPerSec) + 'px';
    const label = document.createElement('span');
    const f = fmtTime(t);
    label.textContent = f.main.replace(/^00:/, '');
    tick.appendChild(label);
    ruler.appendChild(tick);
  }

  // Beat grid, drawn only when it will not turn into a solid block.
  if (state.snapBeats) {
    const b = beatSec();
    if (b * state.pxPerSec > 5) {
      for (let t = 0; t <= total; t += b) {
        const line = document.createElement('div');
        line.className = 'beat-line';
        line.style.left = (t * state.pxPerSec) + 'px';
        ruler.appendChild(line);
      }
    }
  }
}

function renderClipEl(clip, track) {
  const el = document.createElement('div');
  el.className = 'clip'
    + (track.kind === 'audio' ? ' audio' : '')
    + (state.selectedClipIds.includes(clip.id) ? ' selected' : '');
  el.style.left = (clip.startSec * state.pxPerSec) + 'px';
  el.style.width = Math.max(14, clipDur(clip) * state.pxPerSec) + 'px';
  el.dataset.clipId = clip.id;

  const label = document.createElement('div');
  label.className = 'clip-label';
  label.textContent = clip.name;

  const badges = document.createElement('div');
  badges.className = 'clip-badges';

  const dur = document.createElement('span');
  dur.className = 'badge';
  dur.textContent = clipDur(clip).toFixed(2) + 's';
  badges.appendChild(dur);

  if ((clip.speed || 1) !== 1) {
    const s = document.createElement('span');
    s.className = 'badge spd';
    s.textContent = clip.speed + '×';
    badges.appendChild(s);
  }
  if (clip.chroma && clip.chroma.on) {
    const k = document.createElement('span');
    k.className = 'badge key';
    k.textContent = 'KEY';
    badges.appendChild(k);
  }
  if (clip.fadeIn || clip.fadeOut) {
    const f = document.createElement('span');
    f.className = 'badge';
    f.textContent = 'FADE';
    badges.appendChild(f);
  }

  el.append(label, badges);

  const hl = document.createElement('div');
  hl.className = 'clip-handle left';
  hl.dataset.handle = 'left';
  const hr = document.createElement('div');
  hr.className = 'clip-handle right';
  hr.dataset.handle = 'right';
  el.append(hl, hr);

  return el;
}

function renderLanes(width) {
  const lanes = $('lanes');
  lanes.innerHTML = '';
  for (const track of state.project.tracks) {
    const lane = document.createElement('div');
    lane.className = 'track-lane';
    lane.style.width = width + 'px';
    lane.dataset.trackId = track.id;
    for (const clip of track.clips) lane.appendChild(renderClipEl(clip, track));
    lanes.appendChild(lane);
  }
}

function renderTimeline() {
  const dur = Math.max(projectDuration(), 12);
  // Always leave a screen of empty room to the right so you can drag past the
  // end of the last clip.
  const width = Math.max(($('tlScroll').clientWidth || 800), (dur + 6) * state.pxPerSec);
  $('tlInner').style.width = width + 'px';
  renderRuler(width);
  renderLanes(width);
  $('zoomLabel').textContent = Math.round(state.pxPerSec) + ' px/s';
  updatePlayheadUI();
}

/**
 * Just the playhead marker, timecode and scrub — split out of renderTimeline
 * so the preview clock's per-frame tick (tickTimeline, above) can keep those
 * in sync during playback without re-laying out the whole lane list sixty
 * times a second.
 */
function updatePlayheadUI() {
  $('playhead').style.left = (state.playhead * state.pxPerSec) + 'px';

  const f = fmtTime(state.playhead);
  $('timecode').innerHTML = `${f.main}<span class="frac">.${f.frac}</span>`;
  $('timecodeTotal').textContent = '/ ' + fmtTime(projectDuration()).main;

  const scrub = $('scrub');
  // Leave it alone while it is being dragged, or it fights the pointer.
  if (document.activeElement === scrub) return;
  const dur = projectDuration();
  scrub.value = dur > 0 ? String(Math.round((state.playhead / dur) * 1000)) : '0';
}

// ==========================================================================
// Timeline interaction
// ==========================================================================

let drag = null;

$('tlScroll').addEventListener('pointerdown', (e) => {
  const scroll = $('tlScroll');
  const rect = $('tlInner').getBoundingClientRect();
  const x = e.clientX - rect.left;

  const clipEl = e.target.closest('.clip');

  // Clicking the ruler or empty lane space moves the playhead, which is what
  // now drives the preview — and hands the pane back from a bin item, if one
  // was showing, to the timeline.
  if (!clipEl) {
    // Clamped above as well as below: clicking past the last clip used to
    // leave the playhead wherever the ruler was clicked, arbitrarily far
    // past anything actually on the timeline.
    state.playhead = clamp(snap(x / state.pxPerSec), 0, projectDuration());
    binPreviewPath = null;
    requestPreviewFrame();
    renderTimeline();
    syncTimelinePreview();
    return;
  }

  const id = clipEl.dataset.clipId;

  // Shift or Ctrl/Cmd toggles a clip in and out of the selection rather than
  // replacing it — the same convention the bin list above already uses for
  // its own multi-select, so there is one rule to learn rather than two.
  // A Shift-click range instead would need a defined order across BOTH axes
  // a timeline has, time and track, and there is no single obviously-right
  // reading of "everything between" two clips on different tracks, so it is
  // left out rather than guessed at. A modifier-click only ever changes the
  // selection — it never starts a drag, so multi-selecting cannot also move
  // the clip you were trying to add.
  if (e.metaKey || e.ctrlKey || e.shiftKey) {
    toggleClipSelection(id);
    renderTimeline();
    renderInspector();
    return;
  }

  setSelection([id]);
  const { clip, track } = findClip(id);
  // Selecting a clip no longer points the preview at it directly — the
  // playhead does that. It still has to give up a bin item that was showing,
  // the same way clicking empty timeline space above does.
  binPreviewPath = null;
  syncTimelinePreview();

  const handle = e.target.dataset.handle;
  // Opened whether or not the pointer ends up moving. A click that only
  // selects a clip leaves the project untouched, and commit drops it.
  history.begin(handle ? 'trim' : 'move');
  drag = {
    mode: handle || 'move',
    id,
    startX: e.clientX,
    origStart: clip.startSec,
    origIn: clip.inSec,
    origOut: clip.outSec,
    trackId: track.id,
    moved: false
  };
  clipEl.classList.add('dragging');
  scroll.setPointerCapture(e.pointerId);
  renderInspector();
});

$('tlScroll').addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.startX;
  if (Math.abs(dx) > 2) drag.moved = true;
  const dSec = dx / state.pxPerSec;
  const { clip } = findClip(drag.id);
  if (!clip) return;

  if (drag.mode === 'move') {
    const rawStart = Math.max(0, drag.origStart + dSec);
    clip.startSec = Math.max(0, snapMove(rawStart, clipDur(clip), clip.id));
  } else if (drag.mode === 'left') {
    // Dragging the left handle trims into the source AND moves the clip, so
    // the frame under the cursor stays put. Source time and timeline time
    // move together here — this is the one place they are coupled, which is
    // why the snap runs on the timeline-space rawStart below rather than on
    // newIn directly: newIn is source seconds, and the other clips' edges
    // this is snapping against are timeline seconds. The two only agree when
    // speed is 1.
    const speed = clip.speed || 1;
    const rawIn = clamp(drag.origIn + dSec * speed, 0, clip.outSec - 0.05);
    const rawStart = Math.max(0, drag.origStart + (rawIn - drag.origIn) / speed);
    const snappedStart = snapEdge(rawStart, clip.id);
    const delta = snappedStart - drag.origStart;
    clip.inSec = clamp(drag.origIn + delta * speed, 0, clip.outSec - 0.05);
    clip.startSec = Math.max(0, snappedStart);
  } else if (drag.mode === 'right') {
    // The right handle's visible edge is the clip's timeline END, not
    // outSec itself — same speed-coupling reason as the left handle above,
    // mirrored: convert to timeline space, snap, convert back.
    const speed = clip.speed || 1;
    const maxOut = clip.sourceDuration || drag.origOut;
    const rawOut = clamp(drag.origOut + dSec * speed, clip.inSec + 0.05, maxOut);
    const rawEnd = clip.startSec + (rawOut - clip.inSec) / speed;
    const snappedEnd = snapEdge(rawEnd, clip.id);
    const newOut = clip.inSec + (snappedEnd - clip.startSec) * speed;
    clip.outSec = clamp(newOut, clip.inSec + 0.05, maxOut);
  }
  renderTimeline();
});

function endDrag(e) {
  if (!drag) return;
  const wasMove = drag.mode === 'move';
  const id = drag.id;
  drag = null;
  document.querySelectorAll('.clip.dragging').forEach(el => el.classList.remove('dragging'));

  // Dropping a clip onto a different lane moves it between tracks. This is
  // part of the same gesture as the drag, so it lands in the same undo entry.
  if (wasMove && e) {
    const lane = document.elementFromPoint(e.clientX, e.clientY)?.closest('.track-lane');
    if (lane) {
      const targetId = lane.dataset.trackId;
      const { clip, track } = findClip(id);
      if (clip && track && track.id !== targetId) {
        const target = state.project.tracks.find(t => t.id === targetId);
        if (target) {
          track.clips = track.clips.filter(c => c.id !== id);
          target.clips.push(clip);
        }
      }
    }
  }
  history.commit();
  updateHistoryButtons();
  renderAll();
}

$('tlScroll').addEventListener('pointerup', endDrag);
$('tlScroll').addEventListener('pointercancel', () => endDrag(null));

// ==========================================================================
// Editing operations
// ==========================================================================

/*
 * Split, Set In, Set Out and Transcribe (below) all still act on exactly one
 * clip — state.selectedClipId, the last clip the selection touched — even
 * with a multi-select on the timeline now. None of the four has an obvious
 * multi-clip meaning: splitting several clips at once would put the cut at a
 * different source position in each, and Set In/Out would have to decide
 * whether "the playhead" means the same timeline instant for every clip or
 * something per-clip. Delete, Duplicate, Copy and Paste don't have that
 * problem — removing or copying a clip means the same thing regardless of
 * how many others go with it — which is the actual line this file draws
 * between "acts on the selection" and "acts on the primary clip".
 */
function splitAtPlayhead() {
  const { clip, track } = findClip(state.selectedClipId);
  if (!clip) { toast('Select a clip first.', 'warn'); return; }

  const t = state.playhead;
  if (t <= clip.startSec + 0.02 || t >= clipEnd(clip) - 0.02) {
    toast('Put the playhead inside the selected clip.', 'warn');
    return;
  }

  edit('split', () => {
    // Convert timeline position back into source position through the speed.
    const offsetIntoClip = (t - clip.startSec) * (clip.speed || 1);
    const cutPoint = clip.inSec + offsetIntoClip;

    const right = { ...clip, id: uid('c'), inSec: cutPoint, startSec: t, fadeIn: 0 };
    right.chroma = { ...clip.chroma };
    right.filters = { ...clip.filters };
    clip.outSec = cutPoint;
    clip.fadeOut = 0;

    track.clips.push(right);
    setSelection([right.id]);
  });
  renderAll();
}

function setInAtPlayhead() {
  const { clip } = findClip(state.selectedClipId);
  if (!clip) return;
  const t = state.playhead;
  if (t <= clip.startSec || t >= clipEnd(clip)) { toast('Playhead is outside the clip.', 'warn'); return; }
  edit('set in', () => {
    const offset = (t - clip.startSec) * (clip.speed || 1);
    clip.inSec += offset;
    clip.startSec = t;
  });
  renderAll();
}

function setOutAtPlayhead() {
  const { clip } = findClip(state.selectedClipId);
  if (!clip) return;
  const t = state.playhead;
  if (t <= clip.startSec || t >= clipEnd(clip)) { toast('Playhead is outside the clip.', 'warn'); return; }
  edit('set out', () => {
    clip.outSec = clip.inSec + (t - clip.startSec) * (clip.speed || 1);
  });
  renderAll();
}

/**
 * Delete every selected clip as one undo step, not one per clip — a
 * multi-select delete that took N undos to reverse would be worse than no
 * multi-select at all.
 *
 * `ripple` closes the gap each deletion leaves behind, per track: every
 * remaining clip on the SAME track that started at or after a deleted
 * clip's own start slides left by that clip's duration. That is deliberately
 * narrower than closeGaps() below, which repacks every clip on a track from
 * zero — this only closes the gap(s) this delete itself made, so a gap that
 * was already there before the delete is left exactly where it was. A track
 * nothing here was deleted from is never touched, the same per-track scope
 * closeGaps() already has.
 */
function deleteSelected(ripple = false) {
  const ids = new Set(state.selectedClipIds);
  if (!ids.size) return;

  edit(ripple ? 'ripple delete' : 'delete', () => {
    for (const track of state.project.tracks) {
      const removed = track.clips.filter(c => ids.has(c.id));
      if (!removed.length) continue;
      const remaining = track.clips.filter(c => !ids.has(c.id));
      if (ripple) {
        // Each remaining clip's shift is computed from the ORIGINAL
        // positions of every removed clip that started at or before it, not
        // applied removed-clip-by-removed-clip — the latter would compare a
        // clip already shifted by an earlier removal against a later
        // removed clip's untouched startSec, under-shifting anything sitting
        // between two deleted clips.
        for (const c of remaining) {
          let shift = 0;
          for (const r of removed) if (r.startSec <= c.startSec) shift += clipDur(r);
          c.startSec = Math.max(0, c.startSec - shift);
        }
      }
      track.clips = remaining;
    }
    clearSelection();
  });
  renderAll();
}

// Manual and whole-track, unlike deleteSelected's ripple option above: this
// still packs every gap on the target track from zero, not just whichever
// gap a delete just made. Still keyed off the single primary clip — closing
// gaps for a multi-select spanning several tracks at once is not something
// this command has ever done, and nothing here asks it to start.
function closeGaps() {
  const { track } = findClip(state.selectedClipId);
  const target = track || state.project.tracks[0];
  edit('close gaps', () => {
    const sorted = [...target.clips].sort((a, b) => a.startSec - b.startSec);
    let cursor = 0;
    for (const c of sorted) { c.startSec = cursor; cursor = clipEnd(c); }
  });
  renderAll();
}

// ==========================================================================
// Clipboard — copy, paste, duplicate
// ==========================================================================

/*
 * A deep-cloned snapshot of whatever was selected when Copy last ran: one
 * entry per clip, each remembering which track it came from and its own
 * startSec, so Paste can rebuild the same relative spacing between several
 * copied clips wherever the playhead lands. Cloned rather than referenced —
 * pasting twice, or editing the clips still on the timeline afterward, must
 * not alias the objects the clipboard is holding onto, the same reasoning
 * history.js's own clone() is built on.
 *
 * Lives outside `state` on purpose: unlike selection, undoing past a copy
 * should not empty the clipboard — that would make "undo one step" destroy
 * something Ctrl+Z has never in this app been able to touch.
 */
let clipboard = null;

const cloneClip = (c) => (
  typeof structuredClone === 'function' ? structuredClone(c) : JSON.parse(JSON.stringify(c))
);

function copySelected() {
  const items = selectedClips();
  if (!items.length) return;
  clipboard = items.map(({ clip, track }) => (
    { trackId: track.id, trackKind: track.kind, clip: cloneClip(clip) }
  ));
}

/**
 * Lay cloned clips onto the project at `anchorSec`, preserving their
 * original relative offsets and each getting a fresh id — shared by Paste
 * (anchor = playhead) and Duplicate (anchor = right after the originals).
 * Returns the new clips' ids so the caller can select them.
 */
function placeClipboardClips(items, anchorSec) {
  if (!items.length) return [];
  const minStart = Math.min(...items.map(i => i.clip.startSec));
  const newIds = [];
  let skipped = false;
  for (const item of items) {
    // The track a clip was copied from is gone. Not reachable today — this
    // app has no way to delete a track — but paste has to answer the
    // question rather than assume it can't happen. Falls back to the first
    // track of the same kind, video or audio, rather than the first track
    // outright: landing a video clip on the audio track would silently drop
    // its picture, the same distinction sendToTrack already enforces for a
    // fresh drop from the bin.
    const target = state.project.tracks.find(t => t.id === item.trackId)
      || state.project.tracks.find(t => t.kind === item.trackKind);
    if (!target) { skipped = true; continue; }
    const clip = cloneClip(item.clip);
    clip.id = uid('c');
    clip.startSec = Math.max(0, anchorSec + (item.clip.startSec - minStart));
    target.clips.push(clip);
    newIds.push(clip.id);
  }
  if (skipped) toast('Nowhere to paste one or more clips — their track is gone.', 'warn');
  return newIds;
}

function pasteClipboard() {
  if (!clipboard || !clipboard.length) { toast('Nothing to paste.', 'warn'); return; }
  let newIds = [];
  edit('paste', () => {
    newIds = placeClipboardClips(clipboard, state.playhead);
    setSelection(newIds);
  });
  renderAll();
}

function duplicateSelected() {
  const items = selectedClips();
  if (!items.length) return;
  // Right after the originals, not exactly on top of them: an exact overlap
  // on the same track is groupTrackRuns' own definition of a crossfade
  // (shared/ffmpeg-builder.js), so "duplicate in place" would quietly become
  // a transition nobody asked for rather than a plain copy. The whole
  // selection moves by the same amount — the gap after whichever original
  // ends last — so a multi-clip duplicate keeps the group's own layout
  // instead of each clip landing right after only itself.
  const anchor = Math.max(...items.map(({ clip }) => clipEnd(clip)));
  let newIds = [];
  edit('duplicate', () => {
    newIds = placeClipboardClips(
      items.map(({ clip, track }) => ({ trackId: track.id, trackKind: track.kind, clip })),
      anchor
    );
    setSelection(newIds);
  });
  renderAll();
}

// ==========================================================================
// Inspector
// ==========================================================================

function field(labelText, control) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const l = document.createElement('label');
  l.className = 'field-label';
  l.textContent = labelText;
  // Every field wraps a control that writes into the project, so undo tracking
  // belongs here rather than repeated at each of the twenty-odd call sites.
  trackContinuous(control, labelText.toLowerCase());
  wrap.append(l, control);
  return wrap;
}

function slider(labelText, value, min, max, step, format, onInput) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const l = document.createElement('label');
  l.className = 'field-label';
  l.textContent = labelText;

  const row = document.createElement('div');
  row.className = 'slider-row';
  const input = document.createElement('input');
  input.type = 'range';
  input.min = min; input.max = max; input.step = step; input.value = value;
  const val = document.createElement('span');
  val.className = 'slider-val';
  val.textContent = format(value);

  input.oninput = () => {
    const v = Number(input.value);
    val.textContent = format(v);
    onInput(v);
  };
  // A slider drag is one edit, however many input events it fires.
  trackContinuous(input, labelText.split('—')[0].trim().toLowerCase());
  row.append(input, val);
  wrap.append(l, row);
  return wrap;
}

function renderInspector() {
  const box = $('inspector');
  box.innerHTML = '';

  // Multiple clips selected: showing one clip's settings would be wrong (it
  // is only one of several), and showing every selected clip's settings at
  // once — different lengths, different speeds, fields that may or may not
  // agree — is a bigger feature than a single-clip inspector panel. Delete,
  // Duplicate, Copy and Paste still work on the whole selection; only the
  // panel itself narrows back to one clip.
  if (state.selectedClipIds.length > 1) {
    $('clipName').textContent = `${state.selectedClipIds.length} clips selected`;
    const note = document.createElement('div');
    note.className = 'empty-note';
    note.textContent = 'Multiple clips selected. Select just one to edit its settings — Delete, Duplicate, Copy and Paste still act on all of them.';
    box.appendChild(note);
    return;
  }

  const clip = selectedClip();
  $('clipName').textContent = clip ? clip.name : 'nothing selected';

  if (!clip) {
    const note = document.createElement('div');
    note.className = 'empty-note';
    note.textContent = 'Select a clip on the timeline to trim it, change its speed, or key out a background.';
    box.appendChild(note);
    return;
  }

  // --- Timing -------------------------------------------------------------
  const timingRow = document.createElement('div');
  timingRow.className = 'row';
  for (const [label, key, max] of [
    ['In (source)', 'inSec', clip.sourceDuration],
    ['Out (source)', 'outSec', clip.sourceDuration],
    ['Start (timeline)', 'startSec', 9999]
  ]) {
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'input';
    input.step = '0.05';
    input.min = '0';
    input.max = String(max);
    input.value = clip[key].toFixed(2);
    input.onchange = () => {
      clip[key] = clamp(Number(input.value) || 0, 0, max);
      if (clip.outSec <= clip.inSec) clip.outSec = clip.inSec + 0.1;
      renderAll();
    };
    timingRow.appendChild(field(label, input));
  }
  box.appendChild(timingRow);

  // --- Speed --------------------------------------------------------------
  const speedWrap = document.createElement('div');
  speedWrap.className = 'field';
  const sl = document.createElement('label');
  sl.className = 'field-label';
  sl.textContent = `Speed — clip runs ${clipDur(clip).toFixed(2)}s on the timeline`;
  const chips = document.createElement('div');
  chips.className = 'speed-chips';
  for (const s of [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4]) {
    const b = document.createElement('button');
    b.className = 'chip' + (clip.speed === s ? ' on' : '');
    b.textContent = s + '×';
    b.onclick = () => { edit('speed', () => { clip.speed = s; }); renderAll(); };
    chips.appendChild(b);
  }
  speedWrap.append(sl, chips);
  box.appendChild(speedWrap);

  const rampNote = document.createElement('div');
  rampNote.className = 'empty-note';
  rampNote.style.marginBottom = '10px';
  rampNote.textContent = 'For a ramp: split the clip where you want the speed to change, then set each piece separately.';
  box.appendChild(rampNote);

  // --- Transitions --------------------------------------------------------
  const fadeRow = document.createElement('div');
  fadeRow.className = 'row';
  for (const [label, key] of [['Fade in (s)', 'fadeIn'], ['Fade out (s)', 'fadeOut']]) {
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'input';
    input.step = '0.05';
    input.min = '0';
    input.value = (clip[key] || 0).toFixed(2);
    input.onchange = () => { clip[key] = Math.max(0, Number(input.value) || 0); renderAll(); };
    fadeRow.appendChild(field(label, input));
  }
  box.appendChild(fadeRow);

  const xfNote = document.createElement('div');
  xfNote.className = 'empty-note';
  xfNote.style.marginBottom = '10px';
  xfNote.textContent = 'Overlap two clips on the SAME video track — that is a crossfade. Overlap them on different tracks instead to layer one over the other.';
  box.appendChild(xfNote);

  // Only the clip on the incoming side of a transition uses this — the same
  // side whose alpha fade-in gets suppressed by the run it joins. It has no
  // effect on a clip that never ends up as the second half of an xfade fold,
  // so there is no harm in always offering it. Keep this list in step with
  // TRANSITION_TYPES in shared/ffmpeg-builder.js.
  const xfSelect = document.createElement('select');
  xfSelect.className = 'input';
  for (const [v, label] of [
    ['fade', 'fade'], ['dissolve', 'dissolve'],
    ['fadeblack', 'dip to black'], ['fadewhite', 'dip to white'],
    ['wipeleft', 'wipe left'], ['wiperight', 'wipe right'],
    ['slideleft', 'slide left'], ['slideright', 'slide right'],
    ['circleopen', 'circle open'], ['circleclose', 'circle close']
  ]) {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    if ((clip.transitionType || 'fade') === v) o.selected = true;
    xfSelect.appendChild(o);
  }
  xfSelect.onchange = () => { clip.transitionType = xfSelect.value; scheduleCommandPreview(); };
  box.appendChild(field('Crossfade style — used when this clip is the incoming side', xfSelect));

  // --- Volume -------------------------------------------------------------
  if (clip.hasAudio) {
    box.appendChild(slider('Volume', clip.volume, 0, 2, 0.05,
      v => Math.round(v * 100) + '%', v => { clip.volume = v; scheduleCommandPreview(); }));
  }

  // --- Green screen -------------------------------------------------------
  const keyCheck = document.createElement('div');
  keyCheck.className = 'check';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.id = 'chromaOn';
  cb.checked = clip.chroma.on;
  cb.onchange = () => { edit('key', () => { clip.chroma.on = cb.checked; }); renderAll(); };
  const cl = document.createElement('label');
  cl.htmlFor = 'chromaOn';
  cl.textContent = 'Key out background';
  keyCheck.append(cb, cl);
  box.appendChild(keyCheck);

  if (clip.chroma.on) {
    const colour = document.createElement('input');
    colour.type = 'color';
    colour.className = 'input';
    colour.style.height = '28px';
    colour.value = clip.chroma.color;
    colour.onchange = () => { clip.chroma.color = colour.value; scheduleCommandPreview(); };
    box.appendChild(field('Key colour', colour));

    // Eyedropper. Grabs a real frame and lets you click the background.
    // Without this you are guessing a hex value against footage that is never
    // the pure colour you assume, and a wrong guess keys nothing at all.
    const pick = document.createElement('button');
    pick.className = 'btn btn-sm';
    pick.textContent = 'Pick colour from clip';
    const canvas = document.createElement('canvas');
    canvas.className = 'eyedrop';
    canvas.style.display = 'none';

    pick.onclick = async () => {
      try {
        const atSec = clip.inSec + Math.min(0.5, (clip.outSec - clip.inSec) / 2);
        const dataUrl = await api.grabFrame(clip.src, atSec);
        const img = new Image();
        img.onload = () => {
          canvas.width = img.width;
          canvas.height = img.height;
          canvas.getContext('2d').drawImage(img, 0, 0);
          canvas.style.display = 'block';
          pick.textContent = 'Click the background above';
        };
        img.src = dataUrl;
      } catch (err) {
        toast('Could not grab a frame', 'err', String(err.message || err));
      }
    };

    canvas.onclick = (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = Math.floor((e.clientX - rect.left) * (canvas.width / rect.width));
      const y = Math.floor((e.clientY - rect.top) * (canvas.height / rect.height));
      const [r, g, b] = canvas.getContext('2d').getImageData(x, y, 1, 1).data;
      const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
      edit('key colour', () => { clip.chroma.color = hex; });
      colour.value = hex;
      pick.textContent = `Sampled ${hex} — pick again`;
      scheduleCommandPreview();
    };

    box.append(pick, canvas);

    box.appendChild(slider('Similarity — how much of the colour to remove',
      clip.chroma.similarity, 0.01, 0.5, 0.005, v => v.toFixed(3),
      v => { clip.chroma.similarity = v; scheduleCommandPreview(); }));

    box.appendChild(slider('Blend — edge softness',
      clip.chroma.blend, 0, 0.4, 0.005, v => v.toFixed(3),
      v => { clip.chroma.blend = v; scheduleCommandPreview(); }));

    const tip = document.createElement('div');
    tip.className = 'empty-note';
    tip.style.marginBottom = '10px';
    tip.textContent = 'Raise similarity until the green is gone, then raise blend just enough to soften the edge. Check it with Test 3s.';
    box.appendChild(tip);

    const posRow = document.createElement('div');
    posRow.className = 'row';
    for (const [label, key] of [['X offset', 'posX'], ['Y offset', 'posY']]) {
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'input';
      input.step = '10';
      input.value = clip[key] || 0;
      input.onchange = () => { clip[key] = Number(input.value) || 0; scheduleCommandPreview(); };
      posRow.appendChild(field(label, input));
    }
    box.appendChild(posRow);

    box.appendChild(slider('Scale', clip.scale ?? 1, 0.2, 2, 0.05,
      v => Math.round(v * 100) + '%', v => { clip.scale = v; scheduleCommandPreview(); }));
  }

  // --- Colour -------------------------------------------------------------
  box.appendChild(slider('Brightness', clip.filters.brightness, -0.5, 0.5, 0.01,
    v => v.toFixed(2), v => { clip.filters.brightness = v; scheduleCommandPreview(); }));
  box.appendChild(slider('Contrast', clip.filters.contrast, 0.5, 2, 0.01,
    v => v.toFixed(2), v => { clip.filters.contrast = v; scheduleCommandPreview(); }));
  box.appendChild(slider('Saturation', clip.filters.saturation, 0, 2.5, 0.01,
    v => v.toFixed(2), v => { clip.filters.saturation = v; scheduleCommandPreview(); }));
}

// ==========================================================================
// Captions
// ==========================================================================

function renderCaptionStyle() {
  const box = $('capStyle');
  box.innerHTML = '';
  const st = state.project.captionStyle;

  const row1 = document.createElement('div');
  row1.className = 'row';

  const fontInput = document.createElement('input');
  fontInput.className = 'input';
  fontInput.value = st.font;
  fontInput.onchange = () => { st.font = fontInput.value; scheduleCommandPreview(); };
  row1.appendChild(field('Font (must be installed)', fontInput));

  const sizeInput = document.createElement('input');
  sizeInput.type = 'number';
  sizeInput.className = 'input';
  sizeInput.value = st.size;
  sizeInput.onchange = () => { st.size = Number(sizeInput.value) || 54; };
  row1.appendChild(field('Size', sizeInput));
  box.appendChild(row1);

  const row2 = document.createElement('div');
  row2.className = 'row';

  const colour = document.createElement('input');
  colour.type = 'color';
  colour.className = 'input';
  colour.style.height = '28px';
  colour.value = st.color;
  colour.onchange = () => { st.color = colour.value; };
  row2.appendChild(field('Text colour', colour));

  const pos = document.createElement('select');
  pos.className = 'input';
  for (const p of ['bottom', 'middle', 'top']) {
    const o = document.createElement('option');
    o.value = p; o.textContent = p;
    if (st.position === p) o.selected = true;
    pos.appendChild(o);
  }
  pos.onchange = () => { st.position = pos.value; };
  row2.appendChild(field('Position', pos));
  box.appendChild(row2);

  const anim = document.createElement('select');
  anim.className = 'input';
  for (const [v, label] of [
    ['none', 'none'], ['fade', 'fade'], ['pop', 'pop in'],
    ['slide', 'slide up'], ['typewriter', 'typewriter']
  ]) {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    if (st.animation === v) o.selected = true;
    anim.appendChild(o);
  }
  anim.onchange = () => { st.animation = anim.value; renderCaptionStyle(); };
  box.appendChild(field('Animation', anim));

  if (st.animation === 'typewriter') {
    const karaokeRow = document.createElement('div');
    karaokeRow.className = 'row';
    const karaoke = document.createElement('input');
    karaoke.type = 'color';
    karaoke.className = 'input';
    karaoke.style.height = '28px';
    // Only the "already sung" state has a colour of its own (st.color);
    // "not yet sung" has no separate field until the user picks one, so the
    // swatch previews the same dimmed default buildAssFile falls back to.
    karaoke.value = st.secondaryColor || st.color;
    karaoke.onchange = () => { st.secondaryColor = karaoke.value; };
    karaokeRow.appendChild(field('Karaoke colour (not yet spoken)', karaoke));
    box.appendChild(karaokeRow);
  }

  const bgCheck = document.createElement('div');
  bgCheck.className = 'check';
  const bcb = document.createElement('input');
  bcb.type = 'checkbox';
  bcb.id = 'capBg';
  bcb.checked = st.background;
  bcb.onchange = () => { edit('caption box', () => { st.background = bcb.checked; }); renderCaptionStyle(); };
  const bl = document.createElement('label');
  bl.htmlFor = 'capBg';
  bl.textContent = 'Box behind text';
  bgCheck.append(bcb, bl);
  box.appendChild(bgCheck);

  if (st.background) {
    const bgRow = document.createElement('div');
    bgRow.className = 'row';
    const bg = document.createElement('input');
    bg.type = 'color';
    bg.className = 'input';
    bg.style.height = '28px';
    bg.value = st.bgColor;
    bg.onchange = () => { st.bgColor = bg.value; };
    bgRow.appendChild(field('Box colour', bg));
    box.appendChild(bgRow);
  }

  const marginInput = document.createElement('input');
  marginInput.type = 'number';
  marginInput.className = 'input';
  marginInput.value = st.marginV;
  marginInput.onchange = () => { st.marginV = Number(marginInput.value) || 0; };
  box.appendChild(field('Distance from edge (px)', marginInput));
}

function renderCaptions() {
  const list = $('capList');
  list.innerHTML = '';
  const caps = state.project.captions;

  if (!caps.length) {
    const note = document.createElement('div');
    note.className = 'empty-note';
    note.textContent = 'No captions yet. Transcribe the selected clip, import an .srt, or add lines by hand.';
    list.appendChild(note);
    return;
  }

  caps.sort((a, b) => a.start - b.start);
  caps.forEach((cap, i) => {
    const row = document.createElement('div');
    row.className = 'cap-row';

    const times = document.createElement('div');
    const start = document.createElement('input');
    start.className = 'cap-time';
    start.value = cap.start.toFixed(2);
    // A hand-set time no longer matches the real per-word timestamps this
    // row may have carried in from transcription, so it goes back to the
    // even-split estimate buildAssFile falls back to — the same rule the
    // text edit below follows.
    start.onchange = () => { cap.start = Number(start.value) || 0; delete cap.words; renderCaptions(); };
    const end = document.createElement('input');
    end.className = 'cap-time';
    end.value = cap.end.toFixed(2);
    end.onchange = () => { cap.end = Number(end.value) || 0; delete cap.words; renderCaptions(); };
    trackContinuous(start, 'caption timing');
    trackContinuous(end, 'caption timing');
    times.append(start, end);

    const text = document.createElement('textarea');
    text.className = 'cap-text';
    text.rows = 1;
    text.value = cap.text;
    // Editing the words a row carries real per-word timing for makes that
    // timing describe a caption that no longer exists, so it is dropped
    // rather than left to silently mislabel whatever text replaces it.
    text.oninput = () => { cap.text = text.value; delete cap.words; };
    // A whole burst of typing collapses into one entry, closed on blur —
    // undo per keystroke would take a dozen presses to clear one line.
    trackContinuous(text, 'caption text');

    const del = document.createElement('button');
    del.className = 'chip';
    del.textContent = '×';
    del.title = 'Remove this line';
    del.onclick = () => { edit('remove caption', () => { caps.splice(i, 1); }); renderCaptions(); };

    row.append(times, text, del);
    list.appendChild(row);
  });
}

async function transcribeSelected() {
  const clip = selectedClip();
  const source = clip ? clip.src : (state.binSelection[0] || state.bin[0]?.path);
  if (!source) { toast('Select a clip or a bin item to transcribe.', 'warn'); return; }

  toast('Transcribing. This runs locally and can take a while on long clips.');
  const res = await api.transcribe(source, 'auto');
  if (!res.ok) { toast('Transcription failed', 'err', res.error); return; }

  edit('transcribe', () => {
    // Whisper timestamps are relative to the source file. If the clip starts
    // later on the timeline, shift them so captions land in the right place.
    const shift = clip ? (clip.startSec - clip.inSec / (clip.speed || 1)) : 0;
    const shiftTime = (t) => Math.max(0, t / (clip?.speed || 1) + shift);
    state.project.captions = res.captions.map(c => ({
      start: shiftTime(c.start),
      end: shiftTime(c.end),
      text: c.text,
      // Real per-word timing, when the transcription produced it (see
      // main.js's captions:transcribe) — the same shift/speed remap applies
      // per word so the karaoke sweep in buildAssFile lines up with the rest
      // of the caption.
      ...(Array.isArray(c.words) && c.words.length
        ? { words: c.words.map(w => ({ start: shiftTime(w.start), end: shiftTime(w.end), text: w.text })) }
        : {})
    }));
    state.project.captionsEnabled = true;
  });
  $('capEnabled').checked = true;
  renderCaptions();
  toast(`${res.captions.length} caption lines. Edit the timings below if any drift.`);
}

// ==========================================================================
// Templates
// ==========================================================================

function renderTemplates() {
  const box = $('tplList');
  box.innerHTML = '';

  for (const tpl of TEMPLATES) {
    const el = document.createElement('div');
    el.className = 'tpl';

    const top = document.createElement('div');
    top.className = 'tpl-top';
    const name = document.createElement('span');
    name.className = 'tpl-name';
    name.textContent = tpl.name;
    const tag = document.createElement('span');
    tag.className = 'tpl-tag';
    tag.textContent = tpl.tag;
    top.append(name, tag);

    const note = document.createElement('div');
    note.className = 'tpl-note';
    note.textContent = tpl.note;

    // Draw the slot lengths to scale so the rhythm is visible before applying.
    const bars = document.createElement('div');
    bars.className = 'tpl-bars';
    const lengths = tpl.slots.map(s => s.beats ? s.beats * beatSec() : s.dur);
    const total = lengths.reduce((a, b) => a + b, 0);
    tpl.slots.forEach((s, i) => {
      const bar = document.createElement('div');
      bar.className = 'tpl-bar' + ((s.speed || 1) > 1 ? ' fast' : (s.speed || 1) < 1 ? ' slow' : '');
      bar.style.flex = String(lengths[i] / total);
      bars.appendChild(bar);
    });

    const apply = document.createElement('button');
    apply.className = 'btn btn-sm';
    apply.textContent = 'Apply';
    apply.onclick = () => {
      const track = state.project.tracks[0];
      if (!track.clips.length) { toast('Put some clips on Video 1 first.', 'warn'); return; }
      edit(tpl.name, () => {
        const sorted = [...track.clips].sort((a, b) => a.startSec - b.startSec);
        track.clips = applyTemplate(tpl, sorted, state.project.bpm);
      });
      renderAll();
      toast(`${tpl.name} applied to ${track.clips.length} clips.`);
    };

    el.append(top, note, bars, apply);
    box.appendChild(el);
  }
}

// ==========================================================================
// Command preview
// ==========================================================================

let cmdTimer = null;
function scheduleCommandPreview() {
  // Every control that writes into the project already calls this, which makes
  // it the one hook a live preview needs. A new inspector row gets a redraw
  // for free, the same way it gets undo for free from field() and slider().
  requestPreviewFrame();
  clearTimeout(cmdTimer);
  cmdTimer = setTimeout(async () => {
    try {
      const { mode, command } = await api.previewCommand(state.project);
      $('cmdBody').textContent = command;
      const badge = $('cmdMode');
      badge.textContent = mode === 'copy' ? 'stream copy — no re-encode' : 'filter graph — re-encodes';
      badge.className = 'cmd-mode ' + mode;
    } catch (err) {
      $('cmdBody').textContent = 'Could not build command: ' + err.message;
    }
  }, 200);
}

// ==========================================================================
// Export
// ==========================================================================

async function runExport(previewSeconds) {
  if (state.exporting) return;
  if (!projectDuration()) { toast('Timeline is empty.', 'warn'); return; }

  state.exporting = true;
  $('progress').style.display = 'block';
  $('btnCancelExport').style.display = 'inline-block';
  $('btnExport').disabled = true;

  const stop = api.onExportProgress(({ percent }) => {
    $('progressFill').style.width = percent + '%';
  });

  try {
    const res = await api.runExport(state.project, previewSeconds || null);
    if (res.canceled) { toast('Export cancelled.'); }
    else if (res.ok) {
      toast(previewSeconds ? 'Test render done.' : 'Export done.');
      api.reveal(res.path);
    } else {
      toast('Export failed', 'err', res.error);
    }
  } catch (err) {
    toast('Export failed', 'err', String(err.message || err));
  } finally {
    stop();
    state.exporting = false;
    $('progress').style.display = 'none';
    $('progressFill').style.width = '0';
    $('btnCancelExport').style.display = 'none';
    $('btnExport').disabled = false;
  }
}

// ==========================================================================
// Wiring
// ==========================================================================

function renderAll() {
  renderHeads();
  renderTimeline();
  renderInspector();
  syncTimelinePreview();
  scheduleCommandPreview();
}

// Media
$('btnAddVideo').onclick = async () => addPaths(await api.pickMedia('video'));
$('btnAddAudio').onclick = async () => addPaths(await api.pickMedia('audio'));

const dz = $('dropzone');
['dragenter', 'dragover'].forEach(ev =>
  dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('hot'); }));
['dragleave', 'drop'].forEach(ev =>
  dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('hot'); }));

// The whole window accepts drops, not just the small zone.
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  dz.classList.remove('hot');
  const paths = [...e.dataTransfer.files].map(f => api.pathForFile(f)).filter(Boolean);
  if (paths.length) addPaths(paths);
});

$('btnSendV1').onclick = () => sendToTrack('v1');
$('btnSendV2').onclick = () => sendToTrack('v2');
$('btnSendA1').onclick = () => sendToTrack('a1');

// Transport — togglePlay itself lives in the Preview section, above, next to
// the timeline clock it drives.
$('btnPlay').onclick = togglePlay;
// The composited stage covers the video's own controls, so it takes over the
// click-to-play everyone expects of a video. One listener on the stage
// covers every layer canvas stacked inside it, however many there are.
$('previewStage').onclick = togglePlay;

$('scrub').oninput = () => {
  const dur = projectDuration();
  if (!dur) return;
  binPreviewPath = null;
  state.playhead = (Number($('scrub').value) / 1000) * dur;
  requestPreviewFrame();
  updatePlayheadUI();
  syncTimelinePreview();
};

$('btnSplit').onclick = splitAtPlayhead;
$('btnSetIn').onclick = setInAtPlayhead;
$('btnSetOut').onclick = setOutAtPlayhead;
// Wrapped rather than assigned directly: onclick hands the handler a
// MouseEvent, which deleteSelected would otherwise read as a truthy
// `ripple` argument and ripple-delete on every plain click.
$('btnDeleteClip').onclick = () => deleteSelected();
$('btnDuplicateClip').onclick = duplicateSelected;
$('btnCloseGaps').onclick = closeGaps;

// Zoom
$('btnZoomIn').onclick = () => { state.pxPerSec = clamp(state.pxPerSec * 1.4, 4, 600); renderTimeline(); };
$('btnZoomOut').onclick = () => { state.pxPerSec = clamp(state.pxPerSec / 1.4, 4, 600); renderTimeline(); };
$('snapBeats').onchange = (e) => { state.snapBeats = e.target.checked; renderTimeline(); };

// Captions
$('capEnabled').onchange = (e) => {
  edit('burn captions', () => { state.project.captionsEnabled = e.target.checked; });
  scheduleCommandPreview();
};
$('btnTranscribe').onclick = transcribeSelected;
$('btnImportSrt').onclick = async () => {
  const caps = await api.importCaptions();
  if (!caps) return;
  edit('import captions', () => {
    state.project.captions = caps;
    state.project.captionsEnabled = true;
  });
  $('capEnabled').checked = true;
  renderCaptions();
  toast(`${caps.length} caption lines imported.`);
};
$('btnAddCaption').onclick = () => {
  edit('add caption', () => {
    state.project.captions.push({ start: state.playhead, end: state.playhead + 2, text: 'New line' });
  });
  renderCaptions();
};

// Project settings. These are static markup rather than built by field(), so
// they get their undo tracking wired explicitly.
$('projectName').onchange = (e) => { state.project.name = e.target.value || 'untitled'; };
$('projW').onchange = (e) => { state.project.width = Number(e.target.value) || 1080; scheduleCommandPreview(); };
$('projH').onchange = (e) => { state.project.height = Number(e.target.value) || 1920; scheduleCommandPreview(); };
$('projFps').onchange = (e) => { state.project.fps = Number(e.target.value) || 30; scheduleCommandPreview(); };
$('projBpm').onchange = (e) => { state.project.bpm = Number(e.target.value) || 120; renderAll(); renderTemplates(); };
$('projPreset').onchange = (e) => { state.project.preset = e.target.value; scheduleCommandPreview(); };

trackContinuous($('projectName'), 'rename');
trackContinuous($('projW'), 'width');
trackContinuous($('projH'), 'height');
trackContinuous($('projFps'), 'fps');
trackContinuous($('projBpm'), 'bpm');
trackContinuous($('projPreset'), 'encode speed');

function setSize(w, h) {
  edit('canvas size', () => { state.project.width = w; state.project.height = h; });
  $('projW').value = w; $('projH').value = h;
  scheduleCommandPreview();
}
$('btnPortrait').onclick = () => setSize(1080, 1920);
$('btnSquare').onclick = () => setSize(1080, 1080);
$('btnLandscape').onclick = () => setSize(1920, 1080);

// Export
$('btnExport').onclick = () => runExport(null);
$('btnPreviewExport').onclick = () => runExport(3);
$('btnCancelExport').onclick = () => api.cancelExport();

// Command panel
$('cmdHead').onclick = (e) => {
  if (e.target.id === 'btnCopyCmd') return;
  const panel = $('cmdPanel');
  panel.classList.toggle('collapsed');
  $('cmdToggle').textContent = panel.classList.contains('collapsed') ? 'show' : 'hide';
};
$('btnCopyCmd').onclick = () => {
  navigator.clipboard.writeText($('cmdBody').textContent);
  toast('Command copied. Paste it in a terminal to run it yourself.');
};

// Save / open. The toolbar buttons and the File menu run the same functions,
// so there is one behaviour to get right rather than two to keep in step.
$('btnSave').onclick = () => doSave(false);
$('btnOpen').onclick = () => doOpen();

// Undo / redo
$('btnUndo').onclick = () => doUndo('ui');
$('btnRedo').onclick = () => doRedo('ui');

/*
 * The File and Edit menus live in main.js — they have to, an application menu
 * is not the renderer's to build — so they arrive here as commands.
 *
 * `reply` marks a save main is waiting on: the close guard cannot let the
 * window go until it knows whether the save happened or the user backed out of
 * the dialog, and a cancelled Save has to abort the close rather than fall
 * through it. Every other command answers to nobody.
 */
api.onMenuCommand(async ({ command, reply } = {}) => {
  switch (command) {
    case 'new': await doNew(); break;
    case 'open': await doOpen(); break;
    case 'save-as': {
      const res = await doSave(true);
      if (reply) api.saveFinished(res);
      break;
    }
    case 'save': {
      const res = await doSave(false);
      if (reply) api.saveFinished(res);
      break;
    }
    case 'undo': doUndo('menu'); break;
    case 'redo': doRedo('menu'); break;
    // Sent alongside the Edit menu's own native copy/paste (see
    // wireClipboardShortcuts in main.js) rather than instead of it — a text
    // field's Cmd/Ctrl+C or +V should still just copy or paste text, so this
    // only runs the clip-clipboard logic when focus is somewhere else.
    case 'copy-clips': if (!isTypingTarget()) doCopy('menu'); break;
    case 'paste-clips': if (!isTypingTarget()) doPaste('menu'); break;
  }
});

/*
 * A project recovered from an autosave. It is adopted exactly like an opened
 * one except for the last line: recovered work is unsaved by definition, so
 * the tracker is left with no baseline and the project stays dirty until the
 * user puts it somewhere. Marking it saved here would be a lie that costs the
 * work the second time.
 */
api.onRestoreProject(({ project } = {}) => {
  if (!project) return;
  adoptProject(project);
  dirtyTracker.markUnsaved();
  notifyProjectChanged();
  toast('Recovered unsaved work from the last session. Save it somewhere.', 'warn');
});

// Shared by the keydown listener below and the 'copy-clips'/'paste-clips'
// menu commands above: a text field's own Cmd/Ctrl+C or +V should behave
// like any other browser text field, not reach into the timeline clipboard.
function isTypingTarget() {
  return /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
}

// Keyboard
document.addEventListener('keydown', (e) => {
  // Undo is checked before the typing guard: inside a caption box it should
  // still undo the edit, which is what every other editor does.
  if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    if (e.shiftKey) doRedo('key'); else doUndo('key');
    return;
  }
  if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || e.key === 'Y')) {
    e.preventDefault();
    doRedo('key');
    return;
  }

  if (isTypingTarget()) return;

  if (e.code === 'Space') { e.preventDefault(); $('btnPlay').click(); }
  if (e.key === 's' || e.key === 'S') splitAtPlayhead();
  if (e.key === 'i') setInAtPlayhead();
  if (e.key === 'o') setOutAtPlayhead();
  // These also arrive from the Edit menu's own copy/paste accelerator (see
  // wireClipboardShortcuts in main.js and doCopy/doPaste's own comment) —
  // this is the other half of that same belt-and-braces pair, same as
  // undo/redo above; commandGuard, inside doCopy/doPaste, drops whichever of
  // the two arrives second.
  if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); doCopy('key'); }
  if ((e.metaKey || e.ctrlKey) && (e.key === 'v' || e.key === 'V')) { e.preventDefault(); doPaste('key'); }
  // Nothing else in this app claims Cmd/Ctrl+D, so unlike copy/paste this
  // needs no menu-side counterpart — the keydown listener is the only path.
  if ((e.metaKey || e.ctrlKey) && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); duplicateSelected(); }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    // Shift is the Avid convention for "delete, but also close the gap" —
    // Extract vs. plain Delete's Lift — picked because the bare key already
    // has tested, relied-on behaviour (leave a gap) that nothing here should
    // change, the same reason Shift modifies the arrow-key step below
    // instead of replacing it.
    deleteSelected(e.shiftKey);
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const step = (e.shiftKey ? 1 : 1 / state.project.fps) * (e.key === 'ArrowLeft' ? -1 : 1);
    // Clamped above too — holding the key used to walk the playhead
    // arbitrarily far past the end of everything on the timeline.
    state.playhead = clamp(state.playhead + step, 0, projectDuration());
    binPreviewPath = null;
    requestPreviewFrame();
    renderTimeline();
    syncTimelinePreview();
  }
});

window.addEventListener('resize', () => renderTimeline());

// Boot
checkEnv();
renderBin();
renderAll();
renderCaptions();
renderCaptionStyle();
renderTemplates();
// The empty project is what is "saved" at boot: an untouched app must not ask
// to save anything on the way out.
dirtyTracker.markSaved();
updateHistoryButtons();
setInterval(autosaveTick, AUTOSAVE_TICK_MS);
