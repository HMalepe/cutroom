'use strict';

/*
 * Flat config. Two environments in this repo:
 *   - Node (CommonJS): main.js, preload.js, shared/**, test/**
 *   - Browser: src/*.js, loaded via <script> tags with no bundler, so no
 *     import/export — CommonJS-style module.exports guarded by a
 *     typeof check, for the node:test suite to require() the same file.
 *
 * Kept deliberately small: catch real bugs (undefined globals, unreachable
 * code, unused variables) without imposing a style the existing code
 * doesn't already follow. No stylistic rules (quotes, semicolons, spacing) —
 * this is a lint pass, not a reformat.
 */

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  {
    ignores: ['node_modules/**']
  },
  {
    files: ['main.js', 'preload.js', 'shared/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules: {
      // main.js's temp-file cleanup is deliberately catch-and-ignore
      // ("best effort, do not fail the operation over a stray temp file").
      'no-empty': ['error', { allowEmptyCatch: true }]
    }
  },
  {
    // shared/ffmpeg-builder.js is being actively rewritten by a concurrent
    // PR (claude/xfade-crossfades). Deferring this one pre-existing finding
    // rather than editing the file out from under that work: an unused
    // `const path = require('path')` at the top of the file. Revisit once
    // that PR lands and re-run the linter on the merged result.
    files: ['shared/ffmpeg-builder.js'],
    rules: {
      'no-unused-vars': 'off'
    }
  },
  {
    files: ['src/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        // These files run in the renderer (browser globals) but are also
        // require()'d directly by test/*.test.js under Node, hence both.
        ...globals.browser,
        ...globals.node,
        // Loaded as separate <script> tags before app.js in index.html, so
        // they share one global scope. ESLint lints one file at a time and
        // can't see the declarations in history.js / templates.js, so they
        // have to be listed here instead.
        createHistory: 'readonly',
        TEMPLATES: 'readonly',
        applyTemplate: 'readonly'
      }
    },
    rules: {
      // app.js's own `history` (the undo/redo instance, in src/history.js)
      // deliberately shares the name of the browser's window.history. A
      // top-level `const` in a classic (non-module) script creates a
      // lexical binding that shadows access to the same-named window
      // property without touching window.history itself — legal, and
      // exactly what is intended here. Not a bug.
      'no-redeclare': ['error', { builtinGlobals: false }]
    }
  }
];
