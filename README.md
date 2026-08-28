# Cutroom

A small video editor that does five things and nothing else: cut, layer, key,
speed, caption. Built as an Electron front end over ffmpeg — the UI manages a
timeline, ffmpeg does every frame of the actual work.

## Running it

You need Node 18+ and ffmpeg.

```bash
# ffmpeg
brew install ffmpeg                 # macOS
winget install ffmpeg               # Windows
sudo apt install ffmpeg             # Debian/Ubuntu

# the app
npm install
npm start
```

The pill in the top right turns teal when ffmpeg is found. If it stays red,
ffmpeg is not on your PATH and nothing will export.

Auto-captions need a local whisper as well. Either works:

```bash
brew install whisper-cpp            # faster
pip install -U openai-whisper       # easier
```

Without it, the Transcribe button explains itself and Import (.srt/.vtt) still
works.

## What it does

**Timeline.** Three tracks: two video, one audio. Drag clips to move, drag the
edges to trim, drag between lanes to reassign. Video 2 composites over Video 1.

**Split and trim.** Playhead + `S` splits. `I` and `O` set in and out points.
Every clip carries source-time and timeline-time separately, so trimming never
shifts anything downstream by accident.

**Green screen.** Per clip, two sliders. Use **Pick colour from clip** first —
a real green screen is never exactly `#00FF00`, and a mismatched key colour
fails silently rather than erroring. Then raise similarity until the green is
gone and blend until the edge stops looking cut out.

**Speed.** Per clip, 0.25× to 4×. Audio pitch-corrects automatically. For a
ramp, split the clip where the speed should change and set each piece.

**Captions.** Transcribe or import, edit the text and timings inline, then
style font, size, colour, box, position and animation. Burned in at export via
a generated ASS file.

**Templates.** Each one is a rhythm — a list of slot durations, speeds and
fades that your clips get poured into. The bars under each name are the slot
proportions drawn to scale, so you can see the rhythm before applying it.
Bauhaus Grid is beat-based: set your BPM first.

**Test 3s.** Renders the first three seconds only. Use it to check a key or a
caption instead of waiting for a full export.

## Keyboard

| | |
|---|---|
| `Space` | play / pause preview |
| `S` | split at playhead |
| `I` / `O` | set in / set out |
| `←` `→` | step one frame (hold Shift for one second) |
| `Delete` | remove selected clip |

## How it fits together

```
main.js              Electron main. Owns the filesystem and every child
                     process. Finds ffmpeg, probes media, spawns exports,
                     runs whisper.
preload.js           The only bridge to Node. Everything the UI can do to
                     your machine is listed here and nothing else is reachable.
shared/
  ffmpeg-builder.js  Project object -> ffmpeg argument array. The only file
                     that knows ffmpeg syntax exists. Pure functions, no I/O,
                     so it is the easiest thing here to test.
src/
  app.js             State, timeline rendering, pointer handling, inspector.
  templates.js       Edit rhythms. Pure data plus one function.
  index.html         Structure.
  styles.css         Tokens at the top.
```

### The data model

One clip:

```js
{
  inSec, outSec,   // the region of the SOURCE file
  startSec,        // where that region lands on the OUTPUT timeline
  speed            // playback multiplier
}
```

Timeline length is `(outSec - inSec) / speed`, starting at `startSec`.

Keeping source-time and timeline-time as separate fields is the single decision
the whole app rests on. Collapse them into one and export math drifts the
moment a speed change enters the picture. The only place they are deliberately
coupled is dragging a clip's left handle, where trimming the head has to move
the clip so the frame under your cursor stays put.

### Two export paths

`canStreamCopy()` checks whether the project is boring enough to copy the
bitstream directly — one clip, no speed change, no key, no captions, starting
at zero. That path takes about a second because nothing gets decoded.

Anything else builds a filter graph and re-encodes. The command strip at the
bottom of the window shows which path you are on and the exact command about
to run. Copy it and paste it in a terminal — the app is a front end for that
command, and hiding it would be a lie about what it is.

### Filter order matters

Inside `buildVideoClipChain` every step runs in **clip-local time** — zero is
the clip's first frame — and the shift onto the timeline is the last step
before `setsar`. Fades are written against local time for the same reason. Move
the shift earlier and `fps=` will try to generate frames from t=0 up to the
clip's start position, which is slow and wrong.

Clips are centred by the overlay expression `(W-w)/2`, not by padding, so a
keyed clip's transparent area stays transparent.

## Extending it

Reasonable next moves, roughly by effort:

- **More tracks.** `state.project.tracks` is an array; the builder already
  loops it. Adding a fourth is a one-line change plus a UI button.
- **Undo.** Structural clone `state.project` onto a stack before each mutating
  operation. The state is plain JSON, which makes this easy.
- **Live key preview.** Draw the video to a `<canvas>` and key per-frame in
  JS, or in a WebGL fragment shader. Export and preview are already separate
  concerns, so this touches nothing else.
- **Real crossfades.** Currently overlapping alpha fades on two tracks.
  `xfade` is cleaner but needs clips concatenated per track first.
- **Word-level captions.** whisper.cpp emits word timings with `-ml 1`. The
  ASS writer already supports karaoke tags.

## Licence

MIT. It's yours.
