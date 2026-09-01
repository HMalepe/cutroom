'use strict';

/*
 * Drives the missing-media relink panel against the real app.js in jsdom, a
 * stubbed win.cutroom standing in for main.js — the same shape
 * project-open-integration.test.js uses for Open itself.
 * media-relink.test.js proves the pure decisions (which paths, which clips,
 * the filename match); this proves they are actually wired to the panel and
 * to the export/preview guards, not just callable in isolation.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { opts, boot, flush } = require('./dom-harness.js');

const toasts = (doc) => [...doc.querySelectorAll('#toasts .toast')].map(t => t.textContent);
const relinkRows = (doc) => [...doc.querySelectorAll('#relinkList .relink-item')];

/** A minimal valid project (see project-open-integration.test.js) with one clip. */
function projectWithClip(src, extra = {}) {
  return {
    name: 'p', width: 1080, height: 1920, fps: 30,
    captionsEnabled: false, captions: [],
    captionStyle: { font: 'Arial', size: 54, color: '#FFFFFF', position: 'bottom' },
    tracks: [
      { id: 'v1', kind: 'video', name: 'Video 1', clips: [
        { id: 'c1', src, name: 'clip.mp4', inSec: 0, outSec: 4, startSec: 0, speed: 1,
          volume: 1, scale: 1, posX: 0, posY: 0, fadeIn: 0, fadeOut: 0,
          hasVideo: true, hasAudio: false,
          // renderInspector dereferences both without checking, the same
          // way renderCaptionStyle does for captionStyle (see
          // project-open-integration.test.js's fixture) — a real clip
          // always has them, made by makeClip(), so a fixture without them
          // would be testing selection against a clip the app cannot
          // actually select.
          chroma: { on: false, color: '#00FF00', similarity: 0.1, blend: 0.05 },
          filters: { brightness: 0, contrast: 1, saturation: 1 },
          ...extra }
      ] },
      { id: 'v2', kind: 'video', name: 'Video 2', clips: [] },
      { id: 'a1', kind: 'audio', name: 'Audio 1', clips: [] }
    ]
  };
}

/** Open `project`, with main.js reporting `missing` as gone from disk. */
async function openProject(win, doc, project, missing = []) {
  win.cutroom.openProject = async () => ({ ok: true, project, filePath: '/proj/p.cutroom.json' });
  win.cutroom.checkMissing = async (paths) => paths.filter(p => missing.includes(p));
  doc.getElementById('btnOpen').click();
  await flush();
}

function selectFirstClip(win, doc) {
  doc.querySelector('#lanes .clip').dispatchEvent(
    new win.MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 })
  );
}

/** Drop one file into the bin at an exact path, unlike seedBin's fixed /tmp/name mapping. */
async function dropAt(win, doc, absolutePath) {
  const name = absolutePath.split('/').pop();
  win.cutroom.pathForFile = () => absolutePath;
  // The default probe stub reports /tmp/<name> regardless of what path was
  // asked about (see dom-harness's fakeMedia); this needs the bin item's
  // path to be the exact one being tested against.
  win.cutroom.probe = async () => ({
    path: absolutePath, name, duration: 10, width: 1920, height: 1080,
    fps: 30, hasVideo: true, hasAudio: true, colorMatrix: 'bt601'
  });
  const ev = new win.Event('drop', { bubbles: true, cancelable: true });
  ev.dataTransfer = { files: [{ name }] };
  doc.dispatchEvent(ev);
  await flush();
}

// ==========================================================================
// Detection on open
// ==========================================================================

test('a project whose clip source exists opens with no relink panel', opts, async () => {
  const { win, doc } = boot();
  await openProject(win, doc, projectWithClip('/media/there.mp4'), []);
  assert.equal(doc.getElementById('relinkPanel').style.display, 'none');
});

test('a project whose clip source is gone shows the panel, named and counted', opts, async () => {
  const { win, doc } = boot();
  await openProject(win, doc, projectWithClip('/media/gone.mp4'), ['/media/gone.mp4']);

  assert.equal(doc.getElementById('relinkPanel').style.display, 'block');
  assert.equal(doc.getElementById('relinkCount').textContent, '1');
  const row = relinkRows(doc)[0];
  assert.match(row.textContent, /gone\.mp4/);
  assert.match(row.textContent, /used by 1 clip/);
});

test('two clips sharing one missing source are reported as one entry', opts, async () => {
  const { win, doc } = boot();
  const project = projectWithClip('/media/gone.mp4');
  project.tracks[0].clips.push({ ...project.tracks[0].clips[0], id: 'c2', startSec: 4 });
  await openProject(win, doc, project, ['/media/gone.mp4']);

  assert.equal(doc.getElementById('relinkCount').textContent, '1');
  assert.match(relinkRows(doc)[0].textContent, /used by 2 clips/);
});

test('opening a second, clean project clears the panel from the first', opts, async () => {
  const { win, doc } = boot();
  await openProject(win, doc, projectWithClip('/media/gone.mp4'), ['/media/gone.mp4']);
  assert.equal(doc.getElementById('relinkPanel').style.display, 'block');

  await openProject(win, doc, projectWithClip('/media/fine.mp4'), []);
  assert.equal(doc.getElementById('relinkPanel').style.display, 'none');
});

// ==========================================================================
// Relinking one file
// ==========================================================================

test('Locate… relinks every clip sharing that path, and the panel clears', opts, async () => {
  const { win, doc } = boot();
  const project = projectWithClip('/media/gone.mp4');
  project.tracks[0].clips.push({ ...project.tracks[0].clips[0], id: 'c2', startSec: 4 });
  await openProject(win, doc, project, ['/media/gone.mp4']);

  win.cutroom.locateMedia = async () => '/media/found.mp4';
  relinkRows(doc)[0].querySelector('button').click();
  await flush();

  assert.equal(doc.getElementById('relinkPanel').style.display, 'none', 'nothing left missing');
  assert.match(toasts(doc).join('\n'), /Relinked gone\.mp4 to found\.mp4/);

  // Both clips actually moved, not just the first one found — checked by
  // selecting each in turn and reading what the (no-WebGL) fallback pane
  // loaded, since the app's own state is private to it.
  const clips = doc.querySelectorAll('#lanes .clip');
  for (const el of clips) {
    el.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }));
    assert.match(doc.getElementById('video').src, /found\.mp4$/);
  }
});

test('cancelling Locate… leaves the file missing', opts, async () => {
  const { win, doc } = boot();
  await openProject(win, doc, projectWithClip('/media/gone.mp4'), ['/media/gone.mp4']);

  win.cutroom.locateMedia = async () => null; // the OS dialog was cancelled
  relinkRows(doc)[0].querySelector('button').click();
  await flush();

  assert.equal(doc.getElementById('relinkPanel').style.display, 'block');
  assert.equal(doc.getElementById('relinkCount').textContent, '1');
});

test('a path shared by a clip and a bin item is reported once and relinks both', opts, async () => {
  const { win, doc } = boot();
  await dropAt(win, doc, '/media/gone.mp4'); // already in the bin from an earlier drag
  await openProject(win, doc, projectWithClip('/media/gone.mp4'), ['/media/gone.mp4']);

  assert.equal(doc.getElementById('relinkCount').textContent, '1', 'one entry, not one per reference');
  assert.match(relinkRows(doc)[0].textContent, /used by 1 clip, media bin/);

  win.cutroom.locateMedia = async () => '/media/found.mp4';
  relinkRows(doc)[0].querySelector('button').click();
  await flush();

  assert.equal(doc.getElementById('relinkPanel').style.display, 'none');
  // The bin item itself moved, not just the clip — visible through its own
  // name/title, the only way a test outside the app can see bin state.
  const binItem = doc.querySelector('#binList .bin-item .bin-name');
  assert.equal(binItem.title, '/media/found.mp4');
});

test('a relink is undoable, same as any other edit', opts, async () => {
  const { win, doc } = boot();
  await openProject(win, doc, projectWithClip('/media/gone.mp4'), ['/media/gone.mp4']);

  win.cutroom.locateMedia = async () => '/media/found.mp4';
  relinkRows(doc)[0].querySelector('button').click();
  await flush();
  selectFirstClip(win, doc);
  assert.match(doc.getElementById('video').src, /found\.mp4$/);

  doc.getElementById('btnUndo').click();
  await flush();
  selectFirstClip(win, doc);
  assert.match(doc.getElementById('video').src, /gone\.mp4$/, 'the clip is back on the old path');
});

// ==========================================================================
// Folder matching
// ==========================================================================

test('a same-folder-as-project match is offered, not applied automatically', opts, async () => {
  const { win, doc } = boot();
  win.cutroom.relinkFolder = async ({ projectFilePath }) =>
    projectFilePath ? { dir: '/proj', matches: [{ oldPath: '/media/gone.mp4', newPath: '/proj/gone.mp4' }] } : null;

  await openProject(win, doc, projectWithClip('/media/gone.mp4'), ['/media/gone.mp4']);

  const auto = doc.getElementById('relinkAuto');
  assert.equal(auto.style.display, 'flex');
  assert.match(auto.textContent, /Found 1 matching filename/);

  auto.querySelector('button').click();
  await flush();

  assert.equal(doc.getElementById('relinkPanel').style.display, 'none');
  selectFirstClip(win, doc);
  assert.match(doc.getElementById('video').src, /\/proj\/gone\.mp4$/);
});

test('Locate folder… applies every filename match it finds', opts, async () => {
  const { win, doc } = boot();
  const project = projectWithClip('/media/gone.mp4');
  await openProject(win, doc, project, ['/media/gone.mp4']);

  win.cutroom.relinkFolder = async ({ dir, projectFilePath }) => {
    if (projectFilePath) return { dir: '/proj', matches: [] }; // the silent auto-check finds nothing
    return { dir: dir || '/picked', matches: [{ oldPath: '/media/gone.mp4', newPath: '/picked/gone.mp4' }] };
  };

  doc.getElementById('btnRelinkFolder').click();
  await flush();

  assert.equal(doc.getElementById('relinkPanel').style.display, 'none');
  selectFirstClip(win, doc);
  assert.match(doc.getElementById('video').src, /\/picked\/gone\.mp4$/);
});

test('Locate folder… with no matches warns instead of pretending to fix anything', opts, async () => {
  const { win, doc } = boot();
  await openProject(win, doc, projectWithClip('/media/gone.mp4'), ['/media/gone.mp4']);
  win.cutroom.relinkFolder = async () => ({ dir: '/picked', matches: [] });

  doc.getElementById('btnRelinkFolder').click();
  await flush();

  assert.equal(doc.getElementById('relinkPanel').style.display, 'block', 'still missing');
  assert.match(toasts(doc).join('\n'), /No matching filenames/);
});

// ==========================================================================
// The project stays usable, and export/preview refuse cleanly
// ==========================================================================

test('collapsing the panel does not stop the timeline working', opts, async () => {
  const { win, doc } = boot();
  await openProject(win, doc, projectWithClip('/media/gone.mp4'), ['/media/gone.mp4']);

  doc.getElementById('relinkHead').click(); // collapse
  assert.ok(doc.getElementById('relinkPanel').classList.contains('collapsed'));

  // Splitting the (missing-source) clip is still an ordinary edit — the
  // playhead has to move off the clip's own start first, or a split there
  // has nothing on one side to create.
  selectFirstClip(win, doc);
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
  doc.getElementById('btnSplit').click();
  assert.equal(doc.querySelectorAll('#lanes .clip').length, 2, 'split still works with the panel collapsed');
});

test('selecting a clip with a missing source shows an error instead of a broken video', opts, async () => {
  const { win, doc } = boot();
  await openProject(win, doc, projectWithClip('/media/gone.mp4'), ['/media/gone.mp4']);

  selectFirstClip(win, doc);
  assert.equal(doc.getElementById('video').getAttribute('src'), null, 'never handed a dead path to load');
  assert.match(toasts(doc).join('\n'), /Missing source: gone\.mp4/);
});

test('Export refuses with a clear message rather than handing ffmpeg a dead path', opts, async () => {
  const { win, doc } = boot();
  await openProject(win, doc, projectWithClip('/media/gone.mp4'), ['/media/gone.mp4']);

  let exportRan = false;
  win.cutroom.runExport = async () => { exportRan = true; return { ok: true, path: '/out.mp4' }; };

  doc.getElementById('btnExport').click();
  await flush();

  assert.equal(exportRan, false, 'ffmpeg was never invoked');
  const shown = toasts(doc).join('\n');
  assert.match(shown, /source file is missing/);
  assert.match(shown, /gone\.mp4/);
});

test('Export re-checks disk rather than trusting a stale relink', opts, async () => {
  // The scenario a cache alone gets wrong: relink, then undo the relink —
  // the clip is back on the missing path, but nothing re-ran the open-time
  // detection. Export has to catch it anyway.
  const { win, doc } = boot();
  await openProject(win, doc, projectWithClip('/media/gone.mp4'), ['/media/gone.mp4']);

  win.cutroom.locateMedia = async () => '/media/found.mp4';
  relinkRows(doc)[0].querySelector('button').click();
  await flush();
  assert.equal(doc.getElementById('relinkPanel').style.display, 'none');

  doc.getElementById('btnUndo').click();
  await flush();

  // main.js is asked again at export time and still says gone.mp4 is missing.
  win.cutroom.checkMissing = async (paths) => paths.filter(p => p === '/media/gone.mp4');
  let exportRan = false;
  win.cutroom.runExport = async () => { exportRan = true; return { ok: true, path: '/out.mp4' }; };

  doc.getElementById('btnExport').click();
  await flush();

  assert.equal(exportRan, false, 'the stale cache did not wave a still-missing file through');
  assert.match(toasts(doc).join('\n'), /gone\.mp4/);
});

test('Export proceeds normally once nothing is missing', opts, async () => {
  const { win, doc } = boot();
  await openProject(win, doc, projectWithClip('/media/there.mp4'), []);

  let exportRan = false;
  win.cutroom.runExport = async () => { exportRan = true; return { ok: true, path: '/out.mp4' }; };

  doc.getElementById('btnExport').click();
  await flush();

  assert.equal(exportRan, true);
});
