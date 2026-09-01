'use strict';

/*
 * Which clip-clipboard menu:command, if any, a `before-input-event`
 * keystroke maps to. Pure and Electron-free, the same reason
 * shared/save-state.js is: main.js's wireClipboardShortcuts is left holding
 * only the `on('before-input-event', …)` call, not the decision inside it.
 *
 * Why this needs its own delivery path at all, rather than the renderer's
 * own keydown listener: the Edit menu's `copy`/`paste` roles already own
 * Cmd/Ctrl+C/V on every platform (real clipboard support in text fields
 * depends on it — see the Edit menu's own comment in main.js), the same way
 * the `undo`/`redo` roles would if Undo/Redo used them instead of their own
 * accelerators. `before-input-event` fires before Electron dispatches to
 * either the page or a menu accelerator, so it sees the keystroke regardless
 * of who else claims it.
 *
 * What this file cannot prove on its own: that `before-input-event` actually
 * fires for a real keystroke in the first place. Confirmed by hand — a real
 * Electron window under Xvfb, driven with `xdotool key ctrl+c` for a genuine
 * X11-level keypress rather than a synthetic one — that it does, arriving as
 * `{ type: 'keyDown', control: true, key: 'c' }` exactly as this function
 * expects. That check is not part of `npm run test:electron`: Playwright's
 * `_electron` keyboard dispatches through Chrome DevTools Protocol, which
 * this same by-hand check showed does NOT trigger `before-input-event` at
 * all (confirmed against a plain, unmodified key too, so it is not specific
 * to a modifier combo) — the CDP-synthesized event reaches Chromium's input
 * pipeline at a different point than a real OS keystroke does, and only the
 * latter is what before-input-event hooks into. A Playwright-driven test of
 * this delivery path would therefore either never fire (a false failure) or
 * need to shell out to xdotool against a real X server, which is a much
 * larger, more fragile addition than this narrow smoke tier takes on
 * elsewhere — so the mapping below is what's automated, and the delivery
 * mechanism above it is the one claim in this feature resting on a by-hand
 * check rather than a test.
 */
function commandForInput(input) {
  if (!input || input.type !== 'keyDown') return null;
  if (!(input.control || input.meta)) return null;
  const key = String(input.key || '').toLowerCase();
  if (key === 'c') return 'copy-clips';
  if (key === 'v') return 'paste-clips';
  return null;
}

module.exports = { commandForInput };
