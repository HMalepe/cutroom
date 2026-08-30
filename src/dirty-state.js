/*
 * dirty-state.js
 * ---------------------------------------------------------------------------
 * "Has this project changed since it was last saved?", and the two timing
 * questions that hang off it.
 *
 * Pure, no DOM, so it is testable — and it needs to be, because every one of
 * these answers is wrong in a way that is invisible until it costs somebody
 * their afternoon.
 *
 * ---------------------------------------------------------------------------
 * Why dirty is a comparison and not a flag
 *
 * The obvious implementation is a boolean that every edit sets and a save
 * clears. It gets the undo case wrong: edit a clip, undo it, and the project
 * in memory is byte-for-byte the file on disk, but the flag still says dirty.
 * Close the window and you are asked whether to save a project that is
 * already saved — and the cost of that is not the extra keystroke, it is that
 * the prompt starts appearing when nothing is at stake, which is how people
 * learn to dismiss it without reading.
 *
 * So dirty is asked of the content: serialise the project, compare it against
 * the serialisation taken at the last save. Undo back to the saved state and
 * you are clean, because you *are* clean.
 *
 * This is also the answer history.js already gives to its own version of the
 * question. `commit()` compares before against after and discards the entry if
 * they match, so a gesture that changed nothing leaves no undo step. Dirty is
 * the same question asked about the file rather than the stack, and answering
 * it the same way keeps the two from contradicting each other: an edit history
 * refuses to record cannot make the title grow a dot.
 *
 * The cost is a serialisation per check rather than a boolean read. A project
 * is small plain JSON and the check runs at most a few times a second, so this
 * is not a real cost — and the version that is cheap is the version that is
 * wrong.
 */

'use strict';

(function (root) {

  /**
   * JSON.stringify with object keys in a fixed order.
   *
   * Key order is not *supposed* to matter here: the baseline is taken from the
   * same live object the comparison is made against, and structuredClone (what
   * undo restores through) preserves insertion order. But that argument holds
   * only as long as every path into the project preserves order, and a project
   * arriving from JSON.parse of a hand-edited file is one that does not have
   * to. Sorting removes the assumption instead of relying on it, and makes the
   * comparison mean what it says: the same content, not the same history of
   * how the object was built.
   *
   * Arrays keep their order — clip order, track order and caption order are
   * all content, not incidental.
   */
  function stableStringify(value) {
    if (value === undefined) return 'null';
    if (value === null || typeof value !== 'object') {
      const out = JSON.stringify(value);
      // Functions and symbols stringify to undefined. A project never holds
      // one, but a comparison that silently produced the literal string
      // "undefined" would be a strange way to find that out.
      return out === undefined ? 'null' : out;
    }
    if (Array.isArray(value)) {
      return '[' + value.map(stableStringify).join(',') + ']';
    }
    const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }

  /**
   * @param {object} opts
   * @param {() => any} opts.read  Returns the project to compare.
   */
  function createDirtyTracker({ read }) {
    // The serialisation as it was at the last save or open. `null` means there
    // is no saved state to compare against, which is not the same as "matches
    // nothing yet" — see markUnsaved.
    let baseline = null;

    return {
      /**
       * The project as it stands. Callers hold on to this across the await of
       * a save so the baseline records what was actually written, not whatever
       * the project drifted to while the dialog was open.
       */
      snapshot() { return stableStringify(read()); },

      /**
       * The project now matches what is on disk.
       * @param {string} [snapshot] The serialisation that was written, if it
       *   was captured before the write (it should be).
       */
      markSaved(snapshot) {
        baseline = snapshot === undefined ? stableStringify(read()) : snapshot;
      },

      /**
       * There is no saved state — this project exists only in memory. Used
       * after restoring an autosave: recovered work is unsaved by definition,
       * and stays that way until the user actually saves it somewhere.
       */
      markUnsaved() { baseline = null; },

      isDirty(snapshot) {
        if (baseline === null) return true;
        return (snapshot === undefined ? stableStringify(read()) : snapshot) !== baseline;
      }
    };
  }

  /**
   * Is an autosave due?
   *
   * Two triggers, because either one alone has a hole in it:
   *
   *   quiet    — fire once the edits stop. Catches the overwhelmingly common
   *              shape of editing, and costs nothing while the user is idle.
   *              On its own it never fires for someone who keeps working: a
   *              debounce that resets on every change is a promise that is
   *              kept only when it is not needed.
   *   maxWait  — fire anyway once changes have been pending this long. This is
   *              the ceiling on how much work a crash can take, and it is the
   *              number that actually matters: without it, an hour of
   *              uninterrupted editing autosaves zero times.
   *
   * @param {object} opts
   * @param {number|null} opts.pendingSince  When the oldest unsaved change
   *   arrived, or null if there is nothing pending.
   * @param {number|null} opts.lastChangeAt  When the newest one arrived.
   * @param {number} opts.now
   */
  function autosaveDue({ pendingSince, lastChangeAt, now, quietMs = 2000, maxWaitMs = 30000 }) {
    if (pendingSince === null || pendingSince === undefined) return false;
    if (lastChangeAt === null || lastChangeAt === undefined) return false;
    if (now - lastChangeAt >= quietMs) return true;
    if (now - pendingSince >= maxWaitMs) return true;
    return false;
  }

  /**
   * Stop one keypress from being handled twice.
   *
   * Undo is reachable two ways once there is an application menu: the menu
   * item's accelerator, and app.js's own keydown listener. Which of those
   * fires is a platform question — macOS's menu bar claims a key equivalent
   * before the web contents ever sees it, while on Windows and Linux the menu
   * item is given `registerAccelerator: false` precisely so the keydown stays
   * the only path. Both arrangements are correct, and neither is something
   * this repo can run to confirm, so the code does not depend on being right
   * about it: if both ever fire, the second is dropped here.
   *
   * Only a *different* source counts as a duplicate. Repeats from one source
   * are a user holding the key down, and every one of those has to land —
   * swallowing those would turn a held-down undo into a stuttering one, which
   * is a worse bug than the one this prevents.
   */
  function createCommandGuard({ windowMs = 50 } = {}) {
    const last = new Map();
    return {
      allow(command, source, now) {
        const prev = last.get(command);
        if (prev && prev.source !== source && now - prev.at < windowMs) return false;
        last.set(command, { source, at: now });
        return true;
      }
    };
  }

  root.stableStringify = stableStringify;
  root.createDirtyTracker = createDirtyTracker;
  root.autosaveDue = autosaveDue;
  root.createCommandGuard = createCommandGuard;

  if (typeof module !== 'undefined') {
    module.exports = { stableStringify, createDirtyTracker, autosaveDue, createCommandGuard };
  }

})(typeof globalThis !== 'undefined' ? globalThis : this);
