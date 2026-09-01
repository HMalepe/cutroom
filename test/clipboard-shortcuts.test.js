'use strict';

/*
 * Unit tests over shared/clipboard-shortcuts.js — the decision main.js's
 * wireClipboardShortcuts makes about a before-input-event keystroke.
 *
 * Nothing here launches Electron, so what is proven is the mapping — which
 * command a given { type, control, meta, key } shape produces — not that
 * before-input-event actually fires for a real keystroke. That half was
 * confirmed by hand; see this module's own header comment for why it is not
 * something test/electron/smoke.test.js's Playwright-driven suite can prove.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { commandForInput } = require('../shared/clipboard-shortcuts');

test('ctrl+c maps to copy-clips', () => {
  assert.equal(commandForInput({ type: 'keyDown', control: true, key: 'c' }), 'copy-clips');
});

test('meta+v (Cmd+V on macOS) maps to paste-clips', () => {
  assert.equal(commandForInput({ type: 'keyDown', meta: true, key: 'v' }), 'paste-clips');
});

test('the key is matched case-insensitively', () => {
  assert.equal(commandForInput({ type: 'keyDown', control: true, key: 'C' }), 'copy-clips');
  assert.equal(commandForInput({ type: 'keyDown', control: true, key: 'V' }), 'paste-clips');
});

test('a bare keyUp is ignored, even with the modifier and key held', () => {
  assert.equal(commandForInput({ type: 'keyUp', control: true, key: 'c' }), null);
});

test('c or v without Ctrl or Cmd held maps to nothing — plain typing stays plain typing', () => {
  assert.equal(commandForInput({ type: 'keyDown', key: 'c' }), null);
  assert.equal(commandForInput({ type: 'keyDown', key: 'v' }), null);
});

test('an unrelated key with the modifier held maps to nothing', () => {
  assert.equal(commandForInput({ type: 'keyDown', control: true, key: 'x' }), null);
  // Duplicate (Ctrl/Cmd+D) deliberately has no menu-side counterpart — see
  // its own comment in app.js's keydown listener — so it must not appear
  // here even though it is a real app shortcut.
  assert.equal(commandForInput({ type: 'keyDown', control: true, key: 'd' }), null);
});

test('neither control nor meta held maps to nothing, even if one is explicitly false', () => {
  assert.equal(commandForInput({ type: 'keyDown', control: false, meta: false, key: 'c' }), null);
});

test('a missing or malformed input object maps to nothing rather than throwing', () => {
  assert.equal(commandForInput(null), null);
  assert.equal(commandForInput(undefined), null);
  assert.equal(commandForInput({}), null);
});
