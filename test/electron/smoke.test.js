'use strict';

/*
 * Drives the real Electron binary — the one thing the rest of this repo's
 * suite cannot do. jsdom can fake a DOM well enough to load app.js and click
 * things, but it has no `Menu`, no `dialog`, no real `win.close()` semantics
 * and no real filesystem writes from a real main process. Four separate PR
 * reviews only caught real bugs here (a stripped Edit menu that would have
 * killed clipboard support, close-guard ordering, an autosave race) by
 * launching Electron under Xvfb by hand. This file is that manual check made
 * permanent, kept narrow on purpose: it proves the same things those reviews
 * actually found broken, not a repeat of full manual QA. WebGL pixel output
 * and pointer-drag snapping are not covered here — see README.md.
 *
 * Deliberately outside test/*.test.js: `npm test` promises a couple of
 * seconds with no real browser, and this tier needs a downloaded ~100MB
 * Electron binary plus something to render into. `npm run test:electron`
 * runs it explicitly.
 *
 * Self-skip, matching test/ffmpeg-render.test.js's ffmpeg probe: this file
 * cannot assume the Electron binary was downloaded (CI's fast job sets
 * ELECTRON_SKIP_BINARY_DOWNLOAD, same reason the README gives) or that a
 * display exists to render into, so both are checked up front and every test
 * skips — never fails — when either is missing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const saveState = require('../../shared/save-state');
const { electronSkipReason, waitFor, sleep, launchApp, closeApp } = require('./harness');

const opts = electronSkipReason ? { skip: electronSkipReason } : {};

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------

test('the app boots without throwing', opts, async () => {
  const { app, page } = await launchApp();
  try {
    const errors = [];
    page.on('pageerror', err => errors.push(err));

    await page.waitForLoadState('domcontentloaded');
    // Give any synchronous boot-time exception a moment to surface as a
    // pageerror before we call the boot clean.
    await sleep(300);

    assert.equal(errors.length, 0, `renderer threw during boot: ${errors.map(String).join('; ')}`);
    assert.match(await page.title(), /Cutroom/);

    const destroyed = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.isDestroyed() ?? true);
    assert.equal(destroyed, false, 'the main window should exist and be open');
  } finally {
    await closeApp(app);
  }
});

// --------------------------------------------------------------------------
// The application menu
// --------------------------------------------------------------------------

test('the application menu carries the standard Edit roles', opts, async () => {
  const { app } = await launchApp();
  try {
    const menu = await app.evaluate(({ Menu }) => {
      const applied = Menu.getApplicationMenu();
      if (!applied) throw new Error('Menu.setApplicationMenu was never called');
      return applied.items.map(item => ({
        label: item.label,
        submenu: item.submenu ? item.submenu.items.map(sub => ({
          label: sub.label,
          role: sub.role || null
        })) : null
      }));
    });

    const topLevel = menu.map(m => m.label);
    // Menu.setApplicationMenu replaces Electron's default wholesale — this is
    // the check that would have caught the Edit menu going missing entirely.
    assert.ok(topLevel.includes('File'), `expected a File menu, got ${topLevel.join(', ')}`);
    assert.ok(topLevel.includes('Edit'), `expected an Edit menu, got ${topLevel.join(', ')}`);
    assert.ok(topLevel.includes('View'), `expected a View menu, got ${topLevel.join(', ')}`);

    const editMenu = menu.find(m => m.label === 'Edit');
    // Electron normalizes a MenuItem's role to lowercase once it is built
    // from a template ('selectAll' in main.js's template reads back as
    // 'selectall' here) — compare lowercase on both sides rather than
    // encode that quirk into the expected list itself.
    const roles = editMenu.submenu.map(item => item.role).filter(Boolean).map(r => r.toLowerCase());
    // The real risk this guards: setApplicationMenu silently drops Electron's
    // built-in Edit menu, which is where cut/copy/paste in text inputs comes
    // from on macOS. Losing any of these is a real, previously-seen bug.
    for (const role of ['cut', 'copy', 'paste', 'selectall']) {
      assert.ok(roles.includes(role), `Edit menu is missing the "${role}" role (has: ${roles.join(', ')})`);
    }
  } finally {
    await closeApp(app);
  }
});

// --------------------------------------------------------------------------
// Clip clipboard shortcuts
// --------------------------------------------------------------------------

/*
 * What this tier can and cannot prove about copy/paste. The Edit menu above
 * owns Cmd/Ctrl+C/V on every platform (its `copy`/`paste` roles have a real
 * accelerator) — the same situation that made Undo/Redo need their own
 * delivery path (see historyItem's comment in main.js) — and
 * wireClipboardShortcuts answers it for copy/paste with `before-input-event`
 * instead, which fires ahead of any menu accelerator.
 *
 * Driving that with Playwright was tried and abandoned: `_electron`'s
 * `page.keyboard.press()` dispatches through Chrome DevTools Protocol, and a
 * real Electron window under Xvfb, instrumented by hand, showed
 * before-input-event never fires at all for a CDP-dispatched key — not even
 * a plain, unmodified one — while the same window driven by a genuine
 * X11-level keystroke (`xdotool key ctrl+c` against the real window) fires
 * it correctly, `{ type: 'keyDown', control: true, key: 'c' }`, exactly what
 * shared/clipboard-shortcuts.js's `commandForInput` (unit-tested in
 * test/clipboard-shortcuts.test.js) expects. So this tier checks the one
 * thing it safely can: that a real BrowserWindow's webContents actually has
 * a before-input-event listener attached, which is what would go quietly
 * missing if createWindow ever stopped calling wireClipboardShortcuts.
 * Whether the event fires for a real keystroke is the one claim in this
 * feature resting on that by-hand check rather than an automated one.
 */
test('the window has a before-input-event listener wired up for clip copy/paste', opts, async () => {
  const { app } = await launchApp();
  try {
    const count = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.listenerCount('before-input-event'));
    assert.ok(count > 0, 'wireClipboardShortcuts should have attached a before-input-event listener');
  } finally {
    await closeApp(app);
  }
});

// --------------------------------------------------------------------------
// The close guard
// --------------------------------------------------------------------------

// Source of truth for which showMessageBox response index means what, so
// this file cannot quietly drift from shared/save-state.js's own mapping.
const CANCEL_RESPONSE = saveState.CLOSE_BUTTONS.indexOf('Cancel');

test('a dirty project prompts on close, and Cancel really leaves the window open', opts, async () => {
  const { app, page } = await launchApp();
  try {
    // Stub the main process's dialog so the close guard gets an answer
    // instead of hanging on a real modal nothing will click in CI.
    await app.evaluate(() => {
      globalThis.__cutroomTestCalls = 0;
    });
    await app.evaluate(({ dialog }, cancelResponse) => {
      dialog.showMessageBox = async () => {
        globalThis.__cutroomTestCalls++;
        return { response: cancelResponse };
      };
    }, CANCEL_RESPONSE);

    // Same shape preload.js exposes as `reportProjectState`, which app.js
    // calls whenever the renderer's dirty state changes.
    await page.evaluate(() => globalThis.cutroom.reportProjectState({ dirty: true, name: 'smoke-test' }));

    // main.js recomputes the window title on every project:state message —
    // waiting for the dirty mark to appear is waiting for that IPC round
    // trip to have actually landed before we ask for a close.
    await waitFor(
      () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()
        .includes('●')),
      { message: 'the title to pick up the dirty mark' }
    );

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());

    await waitFor(
      () => app.evaluate(() => globalThis.__cutroomTestCalls > 0),
      { message: 'the close guard to ask about unsaved changes' }
    );

    // The whole point of Cancel: the window has to still be there, not
    // merely "closing a little later than usual".
    await sleep(300);
    const stillOpen = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length === 1
      && !BrowserWindow.getAllWindows()[0].isDestroyed());
    assert.equal(stillOpen, true, 'Cancel should leave the window open, not just delay the close');

    const calls = await app.evaluate(() => globalThis.__cutroomTestCalls);
    assert.equal(calls, 1, 'the close guard should ask exactly once');
  } finally {
    await closeApp(app);
  }
});

test('closing a clean project does not prompt', opts, async () => {
  const { app } = await launchApp();
  try {
    // Deliberately no dialog stub here. If the close guard prompts when it
    // should not, the real dialog.showMessageBox opens a native modal that
    // nothing in this headless run will ever click, and 'closed' never
    // fires — the timeout below is what turns that hang into a failure
    // instead of the test itself hanging forever.
    const closed = await Promise.race([
      app.evaluate(({ BrowserWindow }) => new Promise(resolve => {
        const win = BrowserWindow.getAllWindows()[0];
        win.once('closed', () => resolve(true));
        win.close();
      })).catch(() => false),
      sleep(5000).then(() => false)
    ]);
    assert.equal(closed, true, 'a clean project should close immediately, with no dialog blocking it');
  } finally {
    await closeApp(app);
  }
});

// --------------------------------------------------------------------------
// Autosave
// --------------------------------------------------------------------------

test('autosave writes a real file to userData, containing the project as JSON', opts, async () => {
  const { app, page, userDataDir } = await launchApp();
  try {
    const fakeProject = {
      name: 'smoke-autosave',
      tracks: [{ id: 'v1', kind: 'video', name: 'Video 1', clips: [] }]
    };

    // Same call preload.js exposes as `autosave`, which app.js fires on its
    // debounce/ceiling timers — invoked directly here rather than waiting on
    // either timer.
    await page.evaluate((project) => globalThis.cutroom.autosave(project), fakeProject);

    const autosaveFile = path.join(userDataDir, saveState.AUTOSAVE_FILENAME);
    await waitFor(() => fs.existsSync(autosaveFile), { message: 'the autosave file to appear' });

    const raw = fs.readFileSync(autosaveFile, 'utf8');
    let record;
    assert.doesNotThrow(() => { record = JSON.parse(raw); }, 'autosave file should contain valid JSON');

    assert.equal(record.version, saveState.AUTOSAVE_VERSION);
    assert.equal(typeof record.savedAt, 'number');
    assert.deepEqual(record.project, fakeProject);
  } finally {
    await closeApp(app);
  }
});
