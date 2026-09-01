/*
 * media-relink.js
 * ---------------------------------------------------------------------------
 * `clip.src` and bin `media.path` are absolute filesystem paths with no
 * indirection — move the source file, rename it, or open the project on a
 * machine where the drive isn't mounted, and the path just stops resolving.
 * This module is the pure half of noticing and fixing that: which paths a
 * project and bin currently point at, which clips/bin items share a given
 * path, and the one heuristic offered for finding a moved file automatically.
 *
 * It does no I/O and knows nothing about `fs` or Electron on purpose — same
 * split as shared/project-schema.js and shared/ffmpeg-builder.js — but it
 * lives in src/, not shared/, because timeline-preview.js's header explains
 * why: shared/ is main-process-only and never reaches the renderer, and this
 * module is loaded by both main.js (`require`, to build the file-existence
 * check and the filename match) and app.js (as a plain script, to decide
 * what a relink actually rewrites). chroma-math.js is the existing example
 * of a src/ module used both ways.
 *
 * What matchByFilename does NOT do, stated plainly because it is the part
 * most likely to be over-trusted: it matches on name alone, not content. A
 * folder containing a same-named-but-different file matches just as
 * confidently as the real one, and a file that exists but now has an
 * incompatible codec is not caught here at all — that failure still shows up
 * at export or preview time, just against a path that no longer flags as
 * missing. Content-hash matching would catch the first case but means
 * reading every candidate file up front for a feature about paths; that
 * trade was judged not worth it here.
 */

'use strict';

(function (root) {

  function basename(p) {
    return String(p).split(/[\\/]/).pop();
  }

  /**
   * Every path this project's clips and this bin currently reference, deduped
   * and in first-seen order. This is the list a caller checks for existence —
   * collecting it is the only part of "which files might be missing" pure
   * enough to live here; the actual disk check is main.js's job.
   */
  function collectSourcePaths(project, bin) {
    const seen = new Set();
    const out = [];
    for (const track of ((project && project.tracks) || [])) {
      for (const clip of ((track && track.clips) || [])) {
        if (clip && clip.src && !seen.has(clip.src)) { seen.add(clip.src); out.push(clip.src); }
      }
    }
    for (const m of (bin || [])) {
      if (m && m.path && !seen.has(m.path)) { seen.add(m.path); out.push(m.path); }
    }
    return out;
  }

  /**
   * How much is riding on one path — for the relink panel's "used by N
   * clips" line, not for the relink itself (relinkProject/relinkBin below
   * don't need to know the count in advance, they just do the rewrite).
   */
  function countReferences(project, bin, targetPath) {
    let clips = 0;
    for (const track of ((project && project.tracks) || [])) {
      for (const clip of ((track && track.clips) || [])) {
        if (clip && clip.src === targetPath) clips++;
      }
    }
    const inBin = (bin || []).some(m => m && m.path === targetPath);
    return { clips, inBin };
  }

  /**
   * Every clip across every track whose `src` is `oldPath` gets `newPath`
   * instead — a source file can back more than one clip, and relinking it
   * once has to fix all of them, not just the first one found. Returns a new
   * project rather than mutating the one passed in, so app.js can assign the
   * result inside history's edit() the same way undo/redo already write a
   * whole project back; tracks and clips are only rebuilt where something
   * actually changed, so an unaffected track keeps its original object.
   */
  function relinkProject(project, oldPath, newPath) {
    let count = 0;
    const tracks = (project.tracks || []).map(track => {
      let touched = false;
      const clips = (track.clips || []).map(clip => {
        if (!clip || clip.src !== oldPath) return clip;
        touched = true;
        count++;
        return { ...clip, src: newPath };
      });
      return touched ? { ...track, clips } : track;
    });
    return { project: count ? { ...project, tracks } : project, count };
  }

  /** Same idea as relinkProject, for the media bin. */
  function relinkBin(bin, oldPath, newPath) {
    let count = 0;
    const next = (bin || []).map(m => {
      if (!m || m.path !== oldPath) return m;
      count++;
      return { ...m, path: newPath };
    });
    return { bin: count ? next : (bin || []), count };
  }

  /**
   * The one-click convenience: for every missing path, is there a file with
   * the exact same name somewhere in `availablePaths`? First match wins when
   * a folder has two files sharing a name, since there is no better signal
   * than order to break the tie with — see the header for why this stops at
   * filename rather than reaching for content hashing.
   */
  function matchByFilename(missingPaths, availablePaths) {
    const byName = new Map();
    for (const p of (availablePaths || [])) {
      const name = basename(p);
      if (!byName.has(name)) byName.set(name, p);
    }
    const matches = [];
    for (const old of (missingPaths || [])) {
      const found = byName.get(basename(old));
      if (found && found !== old) matches.push({ oldPath: old, newPath: found });
    }
    return matches;
  }

  root.MediaRelink = { collectSourcePaths, countReferences, relinkProject, relinkBin, matchByFilename, basename };

  if (typeof module !== 'undefined') {
    module.exports = root.MediaRelink;
  }

})(typeof globalThis !== 'undefined' ? globalThis : this);
