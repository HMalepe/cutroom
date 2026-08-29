# Cutroom

A small video editor that does five things and nothing else: cut, layer, key,
speed, caption. Built as an Electron front end over ffmpeg — the UI manages a
timeline, ffmpeg does every frame of the actual work.

## Running it

You need Node 22.12+ and ffmpeg. (Electron 44 fetches its binary through
`@electron/get`, which is ESM-only, so `npm start` needs a Node that can
`require()` an ES module — 22.12 is where that landed.)

Electron 44 also needs macOS 13+, and no longer ships 32-bit Windows or Linux
prebuilts.

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

## Tests

```bash
npm test
```

`node --test`, no framework. Three kinds: unit tests over the pure modules
(`ffmpeg-builder`, `history`), integration tests that load the real
`index.html` and `app.js` into jsdom and drive actual buttons and pointer
events, and render tests that put the built ffmpeg command through a real
ffmpeg and inspect the pixels. The second kind is what stops the undo wiring
rotting when someone adds an edit and forgets to record it. The third is there
because a filter string that reads correctly and a filter string ffmpeg
accepts are different things, and `xfade` is fussy about both.

Nothing launches Electron. The render tests skip themselves when ffmpeg is not
installed, so the suite still runs in a couple of seconds without it — which is
how CI runs it, on Node 22.12, 22 and 24.

## What it does

**Timeline.** Three tracks: two video, one audio. Drag clips to move, drag the
edges to trim, drag between lanes to reassign. Video 2 composites over Video 1.

**Split and trim.** Playhead + `S` splits. `I` and `O` set in and out points.
Every clip carries source-time and timeline-time separately, so trimming never
shifts anything downstream by accident.

**Crossfades.** Overlap two clips on the same track and the overlap becomes a
real transition — drag one further over its neighbour to make the dissolve
longer. Overlapping on *different* tracks still layers rather than transitions,
which is what you want for a keyed clip over a background.

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

**Undo.** Every edit, back a hundred steps. A drag or a slider counts as one
step, not one per pixel, and an action that changed nothing — clicking a clip
to select it, grabbing a slider and letting go — leaves no step at all. What
gets restored is the project and the selection; your media bin, playhead and
zoom stay where they are, because those are where you are looking rather than
what you have made.

## Keyboard

| | |
|---|---|
| `Space` | play / pause preview |
| `S` | split at playhead |
| `I` / `O` | set in / set out |
| `←` `→` | step one frame (hold Shift for one second) |
| `Delete` | remove selected clip |
| `Ctrl/Cmd Z` | undo |
| `Ctrl/Cmd Shift Z` | redo |

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
  history.js         Undo/redo stacks. Pure, no DOM, so it is testable.
  templates.js       Edit rhythms. Pure data plus one function.
  index.html         Structure.
  styles.css         Tokens at the top.
test/
  *.test.js          node --test, no framework. `npm test`.
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

### How undo works

Because a clip is plain JSON with no live references, a structural clone of
`state.project` is a complete record of the edit state. So undo stores whole
snapshots rather than per-operation inverses — there is no undo logic per
command to write, and therefore none to get out of step with the command
itself.

Edits open with `history.begin()` and close with `history.commit()`. A
discrete edit does both at once (`edit('split', …)`); a drag or a slider calls
`begin` when the gesture starts and `commit` when it ends, which is what makes
a hundred pointermove events collapse into one step. `commit` compares the
before and after and discards the entry if they match, so gestures that
changed nothing never reach the stack.

The inspector wires this in `field()` and `slider()` rather than at each
control, so a new inspector row is undoable without anyone remembering to make
it so. Controls built outside those two helpers — the static project panel,
the caption rows — are wired by hand with `trackContinuous`.

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

A clip inside a crossfade bends both of those, and the next section is why.

### Crossfades

Overlap two clips **on the same video track** and the overlap is a crossfade,
rendered by `xfade`. However long the overlap, that is how long the transition
takes.

`xfade` does not fit the one-clip-at-a-time shape of the rest of the video
path. It takes two streams and returns one, and its `offset` is measured in the
joined stream's own time rather than the timeline's — so the clips either side
of a transition have to be folded together *before* anything reaches the
canvas. `groupTrackRuns` finds the stretches of a track that need it: a clip
joins the run in front of it when it overlaps that run **and carries on past
it**, and anything else starts a new one.

That leaves most projects where they were. A run of one clip is the old path
untouched, byte for byte, which is every clip that abuts its neighbour, sits
after a gap, or stands alone. Two clips on **different** tracks that overlap
are layering — a keyed face over a background — and stay on the overlay path,
because reading those as transitions would rewrite what existing projects mean.

Inside a run, two of the rules above are suspended. Each clip is padded to one
shared box, because `xfade` refuses inputs that disagree on size, pixel format,
frame rate, SAR or timebase, and `force_original_aspect_ratio=decrease` hands
every clip a different size. That padding is transparent, so the point of the
no-padding rule survives — a letterboxed or keyed clip still shows the layer
underneath — and each clip's `posX`/`posY` rides in its own pad offset, because
one overlay now serves the whole run. The timeline shift moves off the clips
onto the run, which does it once after the last fold.

The alpha fades facing a transition are dropped. `xfade` is doing that blend
now, and running both takes the picture down through the canvas on the way
across — which is exactly what overlapping alpha fades used to do, and the
reason this replaced them. The *audio* fades stay: overlapping `afade`s under
`amix` are what crossfades the sound.

## Extending it

Reasonable next moves, roughly by effort:

- **More tracks.** `state.project.tracks` is an array; the builder already
  loops it. Adding a fourth is a one-line change plus a UI button.
- **Live key preview.** Draw the video to a `<canvas>` and key per-frame in
  JS, or in a WebGL fragment shader. Export and preview are already separate
  concerns, so this touches nothing else.
- **Other transitions.** `xfade` has about fifty; the builder always asks for
  `fade`. Choosing per overlap is a couple of lines in `buildVideoRun` plus
  somewhere in the inspector to put the control.
- **Word-level captions.** whisper.cpp emits word timings with `-ml 1`. The
  ASS writer already supports karaoke tags.

## Licence

MIT. It's yours.
