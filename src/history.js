/*
 * history.js
 * ---------------------------------------------------------------------------
 * Undo / redo, as a pair of stacks of whole-project snapshots.
 *
 * The project is plain JSON with no cycles and no live references, so a
 * structural clone of it is a complete, independent record of the edit state.
 * That makes snapshotting the entire project cheaper to reason about than
 * tracking individual operations and their inverses — there is no per-command
 * undo logic to get wrong, and no way for the two to drift apart.
 *
 * Two shapes of edit have to be handled differently:
 *
 *   Discrete — split, delete, apply template. One action, one entry.
 *   Continuous — dragging a clip, sliding a similarity slider. Hundreds of
 *     mutations that should collapse into one entry.
 *
 * Both go through begin/commit. `begin` records where the edit started;
 * `commit` pushes that record only if the project actually ended up different.
 * A continuous edit calls `begin` once when the gesture starts and `commit`
 * when it ends. Because commit compares before against after, a gesture that
 * changes nothing — a click that selects a clip without moving it, a slider
 * grabbed and released on the same value — leaves no entry behind, so the
 * stack holds only edits a person would recognise as edits.
 *
 * This file knows nothing about the DOM. It is handed a `read` that returns
 * the state to snapshot and a `write` that puts one back.
 */

'use strict';

(function (root) {

  const clone = typeof structuredClone === 'function'
    ? structuredClone
    : (v) => JSON.parse(JSON.stringify(v));

  /** Cheap deep-equality for plain JSON. Used only to skip no-op edits. */
  function same(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  /**
   * @param {object} opts
   * @param {() => any} opts.read   Return the current state (will be cloned).
   * @param {(s: any) => void} opts.write  Apply a snapshot back onto the app.
   * @param {number} [opts.limit]   Max undo entries kept. Oldest are dropped.
   */
  function createHistory({ read, write, limit = 100 }) {
    const undos = [];
    const redos = [];

    // An edit that has started but not yet finished. Holds the state from
    // before the edit, which is exactly what an undo needs to restore.
    let pending = null;

    function entry(label) {
      return { label: label || 'edit', state: clone(read()) };
    }

    return {
      /**
       * Mark the start of an edit. Safe to call repeatedly — an already-open
       * edit keeps its original starting point, so overlapping gestures (a
       * slider dragged while a pointer drag is somehow still open) collapse
       * into a single entry rather than splitting into two.
       */
      begin(label) {
        if (pending) return;
        pending = entry(label);
      },

      /**
       * Finish the edit opened by `begin`. Pushes an undo entry only if the
       * state actually changed. Returns true if something was pushed.
       */
      commit() {
        if (!pending) return false;
        const before = pending;
        pending = null;

        if (same(before.state, read())) return false;

        undos.push(before);
        if (undos.length > limit) undos.shift();
        redos.length = 0;
        return true;
      },

      /** Abandon the open edit without recording it. */
      cancel() {
        pending = null;
      },

      /** begin + mutate + commit, for edits that happen all at once. */
      run(label, fn) {
        this.begin(label);
        try {
          fn();
        } catch (err) {
          this.cancel();
          throw err;
        }
        return this.commit();
      },

      undo() {
        if (!undos.length) return null;
        const back = undos.pop();
        // Where we are now becomes the redo target, labelled with the same
        // edit — redoing "split" should say "split", not the edit before it.
        redos.push({ label: back.label, state: clone(read()) });
        write(clone(back.state));
        return back.label;
      },

      redo() {
        if (!redos.length) return null;
        const forward = redos.pop();
        undos.push({ label: forward.label, state: clone(read()) });
        write(clone(forward.state));
        return forward.label;
      },

      canUndo: () => undos.length > 0,
      canRedo: () => redos.length > 0,
      undoLabel: () => (undos.length ? undos[undos.length - 1].label : null),
      redoLabel: () => (redos.length ? redos[redos.length - 1].label : null),

      /** Forget everything. Used when a different project is opened. */
      clear() {
        undos.length = 0;
        redos.length = 0;
        pending = null;
      },

      /** Exposed for tests and for the button tooltips. */
      depth: () => ({ undo: undos.length, redo: redos.length })
    };
  }

  root.createHistory = createHistory;

  if (typeof module !== 'undefined') module.exports = { createHistory };

})(typeof globalThis !== 'undefined' ? globalThis : this);
