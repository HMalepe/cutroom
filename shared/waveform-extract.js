/*
 * waveform-extract.js
 * ---------------------------------------------------------------------------
 * The one piece of the waveform feature that is not pure: actually spawning
 * ffmpeg and turning its stdout into a peaks array. Kept out of
 * shared/media-cache.js on purpose — that file's whole reason to exist is
 * being testable without a child process, and this function cannot be. Kept
 * out of main.js instead of inlined into the IPC handler so it can be
 * exercised directly, with a real ffmpeg, from a plain node:test file rather
 * than only through the full Electron IPC round trip — which is what lets a
 * test prove the streaming path never buffers the whole decode in memory,
 * not just that it eventually produces the right numbers.
 */

'use strict';

const { spawn } = require('child_process');
const { waveformExtractArgs, createPeaksAccumulator } = require('./media-cache');

/**
 * Spawns ffmpeg with its raw PCM piped to stdout (waveformExtractArgs's
 * outPath of `'-'`) and feeds each stdout chunk straight into a peaks
 * accumulator as it arrives, instead of collecting chunks into one Buffer
 * first. This function's own memory use never grows with the source's
 * duration: at any moment it holds only the current chunk plus the
 * accumulator's O(bucket count) running state, not the whole decode.
 *
 * `onChunk`, if given, is called with each stdout chunk's byte length before
 * that chunk is consumed — a hook for tests to prove the streaming behavior
 * above; production callers have no use for it.
 */
function extractWaveformPeaks(ffmpegBin, filePath, { sampleRate, peaksPerSecond, onChunk } = {}) {
  return new Promise((resolve, reject) => {
    const args = waveformExtractArgs(filePath, '-', { sampleRate });
    const acc = createPeaksAccumulator({ sampleRate, peaksPerSecond });
    let p;
    try {
      p = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (err) {
      reject(err);
      return;
    }

    p.stdout.on('data', chunk => {
      if (onChunk) onChunk(chunk.length);
      acc.push(chunk);
    });
    p.on('error', reject);
    p.on('close', code => {
      if (code === 0) resolve(acc.finish());
      else reject(new Error('Could not read audio for the waveform.'));
    });
  });
}

module.exports = { extractWaveformPeaks };
