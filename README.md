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
(`ffmpeg-builder`, `history`, `templates`, `chroma-math`, `timeline-preview`,
`save-state`, `dirty-state`), integration tests
that load the real `index.html` and `app.js` into jsdom and drive actual
buttons and pointer events, and render tests that put the built ffmpeg command
through a real ffmpeg and inspect the pixels. The second kind is what stops
the undo wiring rotting when someone adds an edit and forgets to record it.
The third is there because a filter string that reads correctly and a filter
string ffmpeg accepts are different things, and `xfade` is fussy about both.

`chroma-math` is the one to read if you are changing the key. Its expected
values are either derived by hand from the ffmpeg filter source or captured
from a real ffmpeg run — never from what the code happened to return — because
a preview that quietly disagrees with the export is worse than no preview.

Nothing launches Electron. The render tests skip themselves when ffmpeg is not
installed, so the suite still runs in a couple of seconds without it — which is
how CI runs it, on Node 22.12, 22 and 24.

```bash
npm run lint
```

ESLint, flat config in `eslint.config.js`. Deliberately small — undefined
globals, unreachable code, unused variables, nothing stylistic. CI runs it
alongside the tests.

## What it does

**Timeline.** Three tracks: two video, one audio. Drag clips to move, drag the
edges to trim, drag between lanes to reassign. Video 2 composites over Video 1.

**Split and trim.** Playhead + `S` splits. `I` and `O` set in and out points.
Every clip carries source-time and timeline-time separately, so trimming never
shifts anything downstream by accident.

**Crossfades.** Overlap two clips on the same track and the overlap becomes a
real transition — drag one further over its neighbour to make the dissolve
longer. Overlapping on *different* tracks still layers rather than transitions,
which is what you want for a keyed clip over a background. The inspector's
**Crossfade style** dropdown, shown on the incoming clip, picks which of ten
curated `xfade` effects plays — dissolve, a dip to black or white, a wipe or
slide either way, or a circle reveal either way. It defaults to `fade`, so
every project made before this existed still renders exactly as it did.

**Green screen.** Per clip, two sliders. Use **Pick colour from clip** first —
a real green screen is never exactly `#00FF00`, and a mismatched key colour
fails silently rather than erroring. Then raise similarity until the green is
gone and blend until the edge stops looking cut out. The preview keys live as
you drag, so you can see both happening instead of rendering to find out.

**Speed.** Per clip, 0.25× to 4×. Audio pitch-corrects automatically. For a
ramp, split the clip where the speed should change and set each piece.

**Captions.** Transcribe or import, edit the text and timings inline, then
style font, size, colour, box, position and animation. Burned in at export via
a generated ASS file. Your text is escaped on the way into that file: libass
reads `{` as the start of an override block, so a caption that mentions
`{50}` used to lose it silently, and `\N`, `\n` and `\h` are all live, so a
caption reading `C:\Notes` used to wrap onto two lines. Transcribing asks whisper for real per-word timestamps
and regroups them into sentence-sized rows for editing — see "Word-level
captions and karaoke" below — so the **typewriter** animation is a real
per-word karaoke sweep rather than one line advancing all at once. Editing a
row's text or timing by hand, or importing an `.srt`/`.vtt`, falls back to the
old even-split-by-character estimate for that row, exactly as it rendered
before word-level timing existed.

**Templates.** Each one is a rhythm — a list of slot durations, speeds and
fades that your clips get poured into. The bars under each name are the slot
proportions drawn to scale, so you can see the rhythm before applying it.
Bauhaus Grid is beat-based: set your BPM first.

**Preview.** Shows the timeline itself, not a clip you happened to select:
whatever is under the playhead, keyed, colour-corrected, scaled and
positioned — the same maths the export runs, per frame, on the GPU — with
Video 2 composited over Video 1, exactly the order the export uses. Drag the
playhead and the composite updates live; press Play and a timeline clock
advances it, seeking every active clip's own hidden `<video>` to keep pace
rather than the old design, where a single `<video>`'s own playback *was*
the clock. Trims and speed still show live, now driven by the clock instead
of a clip looping on its own. A crossfade shows both clips cross-dissolving
by opacity for the overlap, with a small label naming the export's real
`xfade` transition underneath — the dissolve is a stand-in for whichever of
the ten curated effects is actually picked, not a reproduction of its curve,
and the label exists so nobody mistakes one for the other. Captions still do
not show here — for those, Test 3s. On a machine with no WebGL it quietly
falls back to whichever clip is topmost at the playhead, plain, at 1x, start
to end, same as it always did; it does not attempt the clock or the trim
loop in that state, on the theory that a feature this dependent on a real
GPU is better served by keeping its one un-provable fallback exactly as
small as it already was. See "How the composited preview works" below.

**Test 3s.** Renders the first three seconds only. Use it to check speed or a
caption instead of waiting for a full export. It clamps on both export paths.
On the copy path the clamp is an input-side `-to`, which is a position in the
source rather than a length from `-ss`, so it is written as `inSec + 3`; and
because stream copy can only start at a keyframe, a source with a sparse GOP
still comes out somewhat longer than three seconds. That is stream copy's
nature rather than something the builder can correct.

**Undo.** Every edit, back a hundred steps. A drag or a slider counts as one
step, not one per pixel, and an action that changed nothing — clicking a clip
to select it, grabbing a slider and letting go — leaves no step at all. What
gets restored is the project and the selection; your media bin, playhead and
zoom stay where they are, because those are where you are looking rather than
what you have made.

**Saving.** The title bar shows the file you are editing and a `●` when it
has changes that are not in it (on macOS, the same dot appears in the close
button). **Save** writes back to that file without asking; **Save As** always
asks; the first save of a new project asks, because there is nowhere yet to
write. Closing the window with unsaved changes asks Save / Don't Save /
Cancel, and Cancel genuinely cancels — including a Cmd-Q that got there.
New and Open ask the same question, for the same reason.

Undoing back to exactly the state you last saved leaves you *not* dirty: the
dot goes away, and closing asks nothing. See "Dirty is a comparison" below.

**Autosave.** Every couple of seconds after you stop editing, and at least
every thirty seconds if you never do, the project is written to a recovery
file in the app's own data folder. If Cutroom or the machine dies, the next
launch offers it back. A normal quit deletes it, so a launch after an
ordinary session never asks — that is the whole difference between a recovery
feature people keep and one they turn off.

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
| `Ctrl/Cmd N` | new project |
| `Ctrl/Cmd O` | open |
| `Ctrl/Cmd S` | save |
| `Ctrl/Cmd Shift S` | save as |

The last four come from the application menu, which also carries the standard
Edit roles — cut, copy, paste, select all. That is not decoration: setting an
application menu at all replaces Electron's default one, and the default is
where clipboard support in text fields comes from. Drop those roles and typing
in the caption editor quietly loses cut and paste on macOS.

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
  project-schema.js  What a saved project has to look like before it will be
                     opened. Pure, no Electron, for the same reason.
  save-state.js      The window title, the Save/Don't Save/Cancel dialog's
                     button indices, Save vs Save As, and whether an autosave
                     is worth offering. Pure, no Electron — main.js is left
                     holding only the calls, not the decisions.
src/
  app.js             State, timeline rendering, pointer handling, inspector.
  history.js         Undo/redo stacks. Pure, no DOM, so it is testable.
  dirty-state.js     Whether the project differs from the file, when an
                     autosave is due, and the guard that stops one keypress
                     being handled twice. Pure, no DOM, same reason.
  chroma-math.js     The key/colour maths, ported from ffmpeg's filters.
                     Pure, no DOM, no WebGL, so it is testable — and it is,
                     hard, because this is where being wrong costs most.
  key-preview.js     The WebGL plumbing that runs that maths per frame.
  timeline-preview.js  Which clip (or crossfading pair) is active on a video
                     track at a given timeline time, and how the timeline
                     clock advances. Pure, no DOM — app.js is the layer-pool
                     lifecycle and the <video>/<canvas> wiring on top of it.
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
  speed,           // playback multiplier
  transitionType   // xfade effect used when this clip is the incoming side
                    // of a crossfade; defaults to 'fade'
}
```

Timeline length is `(outSec - inSec) / speed`, starting at `startSec`.

Keeping source-time and timeline-time as separate fields is the single decision
the whole app rests on. Collapse them into one and export math drifts the
moment a speed change enters the picture. The only place they are deliberately
coupled is dragging a clip's left handle, where trimming the head has to move
the clip so the frame under your cursor stays put.

### Opening a project

`project:open` checks the shape of a file before the app accepts it. It used to
be `JSON.parse` and nothing else, with the result assigned straight to
`state.project` — so a truncated, hand-edited or simply foreign JSON file threw
somewhere inside `renderAll()`, *after* the project that was open had already
been replaced, leaving a half-drawn window and no message.

`shared/project-schema.js` holds the check, pure and separate so it is testable
without Electron. It is a gate, not a full schema: the file has to be an object
with a `tracks` array, and every track needs a `kind` of `video` or `audio` and
a `clips` array. A file that fails comes back as `{ ok: false, error }`, the
error is toasted, and the project on screen is left exactly as it was.

Saving now writes a `version` field. Nothing reads it yet — it exists so a
later change to the project shape has somewhere to branch, which is only worth
anything if it is already being written by the time that change arrives. A file
*without* it loads normally and always will, because every project saved before
this existed lacks it. A file with a version this build does not know is
refused by name rather than half-loaded.

Being a gate rather than a schema has a limit worth knowing: a hand-edited file
can satisfy every rule above and still be missing something the UI reads
without checking — `captionStyle`, for one, which `renderCaptionStyle`
dereferences directly. Widening the check to a full schema is a bigger change
than this one.

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

### Dirty is a comparison, not a flag

"Are there unsaved changes" is asked of the project's *content*: `dirty-state.js`
serialises `state.project` with its object keys sorted, and compares that
against the serialisation taken at the last save or open.

The obvious alternative is a boolean that every edit sets and a save clears. It
gets one case wrong, and it is a case the user can see: edit a clip, undo it,
and the project in memory is byte-for-byte the file on disk while the flag
still says dirty. Closing then asks whether to save something already saved.
The cost of that is not the extra keystroke — it is that the prompt starts
appearing when nothing is at stake, which is exactly how people learn to
dismiss it without reading, and the one time it matters they dismiss that too.

It is also the answer `history.js` already gives to its own version of the
question. `commit()` compares before against after and drops the entry if they
match, so a gesture that changed nothing leaves no undo step. Dirty is the same
question asked about the file rather than the stack, and answering it the same
way keeps the two from contradicting each other: an edit history refuses to
record cannot make the title grow a dot.

The cost is a serialisation per check instead of a boolean read. A project is
small plain JSON and the check runs about once a second, so that is not a real
cost — and the version that is cheap is the version that is wrong.

Keys are sorted rather than left in insertion order because a project arriving
from `JSON.parse` of a hand-edited file does not have to preserve it. Arrays are
not sorted: clip, track and caption order are all content.

### Where save protection lives

The renderer owns the project; main owns the window. That split decides
everything else here.

Main never keeps a copy of the project, because a copy is a copy that can be
stale, and the one moment it would be read — saving on the way out of a close
dialog — is exactly the moment being a few hundred milliseconds behind would
write the wrong file silently. So main asks the renderer to save and waits for
it to report back, including reporting that the Save dialog was cancelled,
which has to abort the close rather than fall through it.

What main *does* keep is the current file path and a mirror of the dirty flag,
pushed by the renderer whenever either moves. Both are needed by things only
main can do: the window title, and a `close` handler that has to decide whether
to interrupt before any renderer round-trip could answer.

The Electron mechanics of that handler are the fiddly part, and both halves
have to be right. `close` is synchronous and the dialog is not, so
`preventDefault()` has to happen before any `await` — otherwise the prompt
appears over a window that is already closing — and the close then has to be
started again by hand once the answer arrives, behind a flag that makes the
second pass fall straight through. Miss the first and the guard does nothing;
miss the second and the window can never be shut at all. `before-quit` records
that a Cmd-Q is in flight, because otherwise the re-close would close the
window and leave the app running on macOS: a quit that quietly became a close.

Everything in that paragraph is Electron behaviour, and nothing in this repo
launches Electron. So the *decisions* were pushed into `shared/save-state.js` —
which button index means discard, whether Save needs a dialog, whether an
autosave is worth offering — where they are pure and tested, the same split
`project-schema.js` was extracted for. What is left in `main.js` is the calls.

### Autosave, and not being annoying

Autosaves go to `app.getPath('userData')`, not next to the project: there may
be no project file yet, which is the case with the most to lose. They are
written to a temp path and renamed, because the event this exists for is the
app dying, and dying midway through a write leaves a recovery file that cannot
be recovered from.

Two triggers, because each alone has a hole. A debounce fires two seconds after
the edits stop — which is most editing, and costs nothing while idle — but it
resets on every change, so someone who keeps working never reaches it. A
thirty-second ceiling from the oldest pending change is therefore the number
that actually bounds how much a crash can take.

The part that decides whether any of this is tolerable is when the app does
*not* ask. A clean close deletes the autosave — and so does Don't Save, since
restoring what someone just chose to throw away is the single most annoying
thing a recovery feature can do. On launch, an autosave whose file has since
caught up with it is deleted rather than offered. Between them, an ordinary
session never produces a recovery prompt, which is the only reason the prompt
means anything when it does appear.

### The menu, and one keypress arriving twice

`Menu.setApplicationMenu` replaces Electron's default menu wholesale, and the
default is where cut/copy/paste in text fields come from. The Edit menu
therefore carries the standard roles explicitly; without them, typing in the
caption editor silently loses clipboard support on macOS. `appMenu` restores
the About/Hide/Quit block for the same reason.

Undo and Redo are wired to this app's history, not to the `undo`/`redo` roles —
those undo typing inside the focused field, and a user who splits a clip and
presses Cmd-Z wants the split back.

That leaves undo reachable two ways: the menu accelerator, and `app.js`'s own
keydown listener. Which one fires is a platform question. macOS's menu bar
claims a key equivalent before the page sees it; on Windows and Linux the menu
item is given `registerAccelerator: false` so the keydown stays the only path.
Neither arrangement can be run here, so the code does not depend on being right
about it: `createCommandGuard` drops a second arrival of the same command from
a *different* source within 50ms. Same-source repeats always run — that is a
held-down key, and swallowing those would be a worse bug than the one being
prevented.

### Two export paths

`canStreamCopy()` checks whether the project is boring enough to copy the
bitstream directly — one clip, no speed change, no key, no captions, starting
at zero, and none of the settings the filter graph is what applies: no scale,
no position nudge, no volume change, no muted or hidden track. That path takes
about a second because nothing gets decoded.

Every one of those has to be in the list, because the copy path cannot half-
honour a setting: it either re-encodes or it writes the source's bitstream out
untouched. A clip scaled to 50% that stream-copies is not a fast export of the
right thing, it is a fast export of the wrong thing, with nothing on screen to
say so. The defaults are compared through `num()` so a clip that never touched
any of them — including one saved before the field existed, where it reads
`undefined` — still takes the fast path, which is the entire point of having
one.

`hidden` is in that list for a sharper reason than the rest. The other settings
make the copy path merely incomplete; this one makes the two paths disagree in
opposite directions. The filter graph drops a hidden track before it reaches
the canvas, so a project whose only video track is hidden renders black —
whereas `-c copy` has no way to express "show nothing" and would hand back the
exact footage that was hidden. Same project, two commands, opposite pictures,
no error on either.

One thing the check still cannot see is resolution. A 720p clip in a 1080p
project stream-copies out at 720p, ignoring the project size. The clip object
carries no width or height — `makeClip` copies duration, audio, video and
colour matrix off the bin item and stops there — so a pure function over the
project genuinely cannot tell. Fixing it means either putting the source
dimensions on the clip or probing from the builder, and the builder does no
I/O by design.

Anything else builds a filter graph and re-encodes. The command strip at the
bottom of the window shows which path you are on and the exact command about
to run. Copy it and paste it in a terminal — the app is a front end for that
command, and hiding it would be a lie about what it is.

### Why the preview can be trusted

The preview is a port of `chromakey`, `despill` and `eq` into a fragment
shader, not an impression of them. It measures chroma distance in YUV the way
`vf_chromakey.c` does, including the 4:2:0 neighbourhood and the quirk where
the key colour is converted with full-range coefficients while the picture it
is compared against is limited-range. It runs the three filters in the order
`buildVideoClipChain` runs them — `eq` before the key, so raising saturation
moves the matte in the preview exactly as it will in the render.

The one thing it cannot reproduce exactly is the source's chroma planes: a
browser hands over RGB that has already been upsampled from them, and the
shader reconstructs the 4:2:0 cells with a box filter. Measured against the
real chain over a frame already in `yuv420p`, the matte agrees within 4/255
of alpha at every pixel.

Reconstructing that RGB back into YUV needs the source's real colour matrix,
not a guess: `main.js` reads it from ffprobe on import and carries it through
`state.bin` to the clip, and `chroma-math.js` uses it for every clip
individually, falling back to limited-range BT.601 only when the file is
genuinely untagged (matching what ffmpeg itself assumes for untagged input).
A real headless Chromium confirmed this is the only place that still needed
fixing: fed a controlled BT.709-tagged frame, both `<canvas>` 2D and the
`texImage2D` call this preview actually uses already returned the correct,
colour-managed RGB — a BT.709-tagged frame and the same bytes tagged BT.601
came back as two different, individually-correct colours, not one fixed
interpretation. The export side needed no matching change: `eq` and
`chromakey` never leave YUV, and `despill` — the one filter here that does
briefly touch RGB — already gets it right from swscale's own automatic,
tag-aware conversion, confirmed by running a BT.709/BT.601-tagged pair
through the real filter chain and diffing the output.

### How the composited preview works

Until this feature, "preview" meant one clip: whichever was selected,
looping between its own trim points on the pane's single `<video>`, with
`state.playhead` — the timeline ruler's own position — connected to none of
it. Scrubbing the ruler did nothing to the pane; playing the pane did
nothing to the ruler; nothing ever showed two tracks composited, a
crossfade, or the export's actual maths at a specific instant rather than
across one clip's whole loop. The only way to see the real edit was a full
Test 3s.

`timeline-preview.js`'s `trackStateAt` answers one question per video track,
pure and DOM-free: given a timeline time `t`, is anything active there, and
is it one clip (`solo`) or two mid-crossfade (`crossfade`, with a 0..1
`progress`)? The crossfade rule is a deliberate re-derivation of
`groupTrackRuns` in `shared/ffmpeg-builder.js` — same-track overlap, the
later clip outlasting the earlier one — rather than an import of it, because
`shared/` is main-process-only and never reaches the renderer;
`test/timeline-preview.test.js` pins the two files' `TRANSITION_TYPES` lists
against each other so they cannot quietly drift apart. `layersAt` runs that
per video track, bottom to top — `project.tracks[0]` first, same order
`buildExportCommand` composites in — so Video 2 landing over Video 1 in the
preview is a property of iteration order, not a separate compositing step
that could disagree with the export's.

app.js turns those answers into pixels through a small, fixed **layer
pool** (`layerPool`, capped at `POOL_SIZE = 4`): each entry owns one
`<canvas>` and one hidden `<video>`, reused for the life of the session
rather than created and torn down at every clip or crossfade boundary.
Recreating a WebGL context is real work and browsers cap how many can be
live at once, so a fixed pool of four hidden, paused elements — enough for
both video tracks to be mid-crossfade at the same instant, which is the
most `layersAt` can ever ask for — is the more defensible choice than
churning contexts every time the playhead crosses a cut. `#keyCanvas` is
pool entry 0 and is the only one that exists in `index.html`; the rest are
created lazily and stacked into `#previewStage` with plain CSS (each
non-base layer positioned to fill the base layer's box exactly), so Video 2
drawing over Video 1 — and the two halves of a crossfade dissolving into
each other — is ordinary DOM paint order, not anything the shader itself
had to learn. **The shader in `key-preview.js` is untouched**: every layer
reuses the exact single-clip `createKeyPreview`/`draw` this preview already
had, once per canvas.

A **crossfade** draws both clips and cross-dissolves them by canvas
`opacity` for the overlap's duration, with a small label
(`#xfadeBadge`) naming the export's real `xfade` transition underneath.
This is a deliberate, bounded approximation, not the real curve: reproducing
`xfade`'s per-transition-type maths (a wipe's edge, a slide's motion, a
circle reveal's radius) pixel-for-pixel in a fragment shader is a
significantly larger effort than this preview otherwise needed, for a
detail — the shape of a transition mid-scrub — that a plain dissolve
communicates well enough to edit by, as long as nobody mistakes it for the
real thing. The badge is what stops that: it names the actual effect so a
`wipeleft` reads as "will wipe" even though what's on screen right now is
fading.

**Captions are not drawn in the preview at all**, the same gap the old
single-clip pane had — Test 3s remains the way to check them. Rendering the
caption style panel's font, colour, position and background as a positioned
HTML overlay was considered for this PR and cut: everything above it already
needed proving out in a real browser this repository's test harness cannot
launch, and stacking a second unverified approximation — an HTML
approximation of an ASS/libass render, on top of a canvas approximation of
an `xfade` curve — was worse than shipping the video layers honestly and
leaving captions exactly where they already were.

**Audio is muted on every layer.** Mixing several simultaneously-active
clips' audio live was ruled out of scope from the start — a browser has no
built-in multi-track audio mixer, and building one was a separate feature —
so rather than pick one layer's audio arbitrarily to play (which one, when
two tracks are both audible in the export?), every layer `<video>` in the
composited and no-WebGL-fallback paths is muted. This is new: the old
single-clip pane did play its one `<video>`'s own audio. A silent preview
that never mixes wrongly was judged better than a preview that sounds right
only by accident of which track happened to be selected.

**Pressing Play** now advances a timeline clock
(`stepTimelineClock`) — a wall-clock-driven `state.playhead`, ticking on
`requestAnimationFrame` — rather than a single `<video>`'s own playback
being the clock, which is what made driving more than one `<video>` off it
impossible before. Each active layer's `<video>` is seeked to keep pace with
that clock, correcting only once it drifts past a threshold
(`driftSeek`, `DRIFT_THRESHOLD` — 150ms) rather than on every tick, so a
decoder that is merely running a frame or two behind wall-clock time is left
alone instead of fought.

**On a machine with no WebGL**, the pane falls back to the plain `<video>`
showing whichever clip is topmost at the playhead — playhead-driven clip
*selection* still works — but that fallback does not run the timeline clock
or the per-clip trim loop the single-clip pane used to run: it plays the
source file plain, at 1x, start to end, same as it always did. This is a
deliberate, smaller scope than the composited path, not an oversight.
Driving several `<video>` elements off one JS clock and proving it does not
drift is exactly the part of this feature only a real browser can verify,
and nothing in this repository's test suite launches one; keeping the
degraded path exactly as small and already-understood as it was before this
PR was judged better than shipping a second, differently-shaped clock
implementation with no way to check it here either.

**What is and is not verified.** `test/timeline-preview.test.js` covers
`trackStateAt`, `layersAt`, `sourceTimeFor`, `stepTimelineClock` and
`driftSeek` as pure functions, mutation-tested by hand against the code they
cover. `test/key-preview.test.js` drives the real `app.js` in jsdom to prove
the *wiring*: a second active track gets a second canvas stacked above the
first, a same-track overlap gets two pool entries split by dissolve
progress with the badge shown, scrubbing across a clip or track boundary
swaps which `<video>` is playing and where, Play advances the clock and
Pause leaves it parked, and a layer that drops out of the composite is
hidden and paused rather than left decoding off-screen. jsdom has no real
WebGL context, no real video decoder and no real frame timing, so none of
that proves a pixel lands correctly, that a real decoder's drift behaves the
way `DRIFT_THRESHOLD` assumes, or that four concurrent WebGL contexts behave
inside a real browser's limits — those are the claims this PR states rather
than demonstrates.

Since none of that ran in a real browser here, it was run in one separately:
Electron itself under Xvfb, with `--use-angle=swiftshader` for a software
WebGL context, driven by Playwright. That caught a real bug jsdom cannot see.
`draw()` bails when a `<video>`'s `videoWidth`/`videoHeight` are still 0 —
correct, a frame with no dimensions has nothing to upload — but a fresh
layer's video does not always have them yet at the instant its first draw is
attempted, and nothing asked for a second one. Scrubbing *within* the same
clip never changes `layerSignature`, so the RAF loop's own redraw gate
(`previewDirty`) has no reason to open again on its own: the layer's canvas
was left at the browser's default 300×150 backing store, blank, until the
playhead happened to cross into a genuinely different clip or crossfade. A
project could open with its own first frame never drawn. The fix is one
listener in `makePoolEntry` — `video.addEventListener('loadeddata',
requestPreviewFrame)` — so the moment a layer's video actually has a frame to
give the shader, the pane asks for one more. Confirmed by hand in the same
real-Electron harness afterward: a fresh two-clip project (a full-frame base
layer plus a scaled, repositioned second layer, deliberately picked to prove
compositing and not just single-clip drawing) now paints correctly on the
first attempt, and a same-track crossfade's dissolve blends the right two
colours in the right proportion. `test/key-preview.test.js` pins the fix
itself — a stub keyer that fails until told otherwise, proving the pane asks
again once `loadeddata` fires rather than staying stuck — since that much
does not need a real decoder to prove, only a `<video>` that can dispatch the
event.

One thing surfaced by the same harness and deliberately **not** treated as a
bug: the very first successful `draw()` on a brand-new WebGL context
occasionally painted solid black under `swiftshader` specifically — correct
canvas size, correct video dimensions, `gl.getError()` clean, and an
immediate second call with byte-identical inputs painted correctly. Nothing
in this codebase's control flow distinguishes a first draw from a second one,
so a bug here would have to live in application logic that does not exist;
this reads as a software-rasteriser warm-up artefact of the test environment,
not the app, and is noted rather than "fixed" because there is nothing in
`key-preview.js` to change that would not be pure superstition.

### Filter order matters

Inside `buildVideoClipChain` every step runs in **clip-local time** — zero is
the clip's first frame — and the shift onto the timeline is the last step
before `setsar`. Fades are written against local time for the same reason. Move
the shift earlier and `fps=` will try to generate frames from t=0 up to the
clip's start position, which is slow and wrong.

Clips are centred by the overlay expression `(W-w)/2`, not by padding, so a
keyed clip's transparent area stays transparent.

The audio chain does the same shift with `adelay`, and that one has a trap in
it: `adelay` leaves any channel its delay list does not name completely
undelayed, so a two-entry list silently desyncs everything past stereo — on a
5.1 source it moves the front pair and leaves the centre, LFE and both
surrounds sitting at zero. It is written `adelay=<ms>:all=1`, which reuses the
last delay for the remaining channels.

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

`xfade`'s own `transition` option picks the effect, and the builder reads it
from `transitionType` on the clip joining the run — the same clip whose
`fadeIn` is suppressed by `noFadeIn`, since it is the one on the incoming side
of the fold. `transitionFor` in `ffmpeg-builder.js` falls back to `'fade'` for
a missing or unrecognised name rather than handing ffmpeg one it might reject,
the same defensive shape `matrixFor` uses in `chroma-math.js`. `xfade` ships
around fifty transitions of uneven reliability; `TRANSITION_TYPES` is a
curated ten — the dissolve family (`fade`, `dissolve`, `fadeblack`,
`fadewhite`), a directional wipe and slide each way, and a circle reveal each
way — every one proven against a real ffmpeg in `test/ffmpeg-render.test.js`
rather than trusted from `xfade`'s documentation.

### Word-level captions and karaoke

Transcribing asks whisper for one SRT cue per **word**, not whisper's own
sentence segmentation:

- whisper.cpp: `-ml 1 -sow`. `-ml 1` (max segment length 1 character) alone is
  not enough — whisper.cpp's default is to split wherever the length limit is
  hit, which is frequently mid-word, because its tokens are BPE sub-word
  pieces rather than whole words. `-sow` (`--split-on-word`) restricts split
  points to tokens that actually begin a new word, which is what turns that
  into one whole word per line. This is read out of whisper.cpp's own source
  (`should_split_on_word` / `whisper_wrap_segment` in `src/whisper.cpp`), not
  a real binary — there was none available while building this — so it has
  not been independently re-driven against real audio. If you have
  whisper.cpp installed and see it disagree with this, that is the thing to
  check first.
- openai-whisper: `--word_timestamps True --max_words_per_line 1`. Also read
  out of source (`whisper/utils.py`'s `SubtitlesWriter.iterate_result`): with
  no `--max_line_width` set, every word starts a new subtitle cue. Same
  caveat — verified from source, not from a real run.

`groupWordsIntoCaptions` in `ffmpeg-builder.js` then re-assembles those
one-word cues into sentence/phrase-sized rows for the caption list — a couple
hundred one-word rows for a minute of speech is not a usable editor — using
two triggers to end a row: sentence-ending punctuation (`.`, `!`, `?`,
optionally followed by a closing quote or bracket) or a gap of 0.6s or more
before the next word. A row is also capped at 12 words regardless, so a
transcript with neither punctuation nor pauses for a long stretch still
breaks into readable lines. Each word's own real start/end rides along on the
row (`cap.words`) for the ASS writer to use.

`buildAssFile`'s `typewriter` animation uses that per-word timing when a row
has it: one `{\k}` tag per word rather than one for the whole line, each
tag's duration running from that word's own start to the *next* word's
start — not to its own end — so a pause between words is charged to the word
before it and the highlight lands exactly when the next word starts. The
`[V4+ Styles]` line's `SecondaryColour` (the "not yet spoken" state karaoke
reveals against) now actually differs from `PrimaryColour` — it used to be
set to the same value, which made a karaoke sweep invisible even once the
`\k` tags were real. It defaults to the caption's text colour at reduced
opacity, so "not yet spoken" stays visibly distinct from "spoken" whatever
text colour is chosen (a fixed hue, picked once, could land on or near the
user's own colour and vanish); the caption style panel's **Karaoke colour**
field overrides it directly when animation is set to typewriter.

A row falls back to the old behaviour — one `\k` tag over the whole line,
its duration split evenly by character count — whenever it has no per-word
timing: a hand-typed line, an imported `.srt`/`.vtt`, or a transcribed row
whose text or timing was subsequently hand-edited (`renderCaptions` in
`app.js` drops `words` the moment a row is touched, since an edited row's
text no longer matches what the stored per-word timestamps describe).

Verification: `test/ffmpeg-builder.test.js` hand-computes the grouping
triggers and the `\k` values, including the case a naive implementation gets
wrong — a pause between two words has to be charged to the word *before* it.
`test/ffmpeg-render.test.js` burns a real two-word karaoke line onto a black
canvas through actual ffmpeg/libass and samples a pixel inside each word's
glyphs before and after its `\k` window closes, so the sweep is proven on
screen and not just in the string the builder produced.

## Extending it

Reasonable next moves, roughly by effort:

- **More tracks.** `state.project.tracks` is an array; the builder already
  loops it, and so does `layersAt`. Adding a second audio track is a one-line
  change plus a UI button. A third *video* track needs one more thing: the
  preview's layer pool (`POOL_SIZE` in app.js) is sized for two video tracks
  each possibly mid-crossfade at once — a third would need a bigger pool, or
  an explicit decision about what happens when a fourth-and-up simultaneous
  layer is asked for.

- **Captions in the preview.** Left out of this PR on purpose — see "How the
  composited preview works". Whenever this is picked up, a positioned
  HTML/CSS overlay reading the caption style panel's font, size, colour,
  position and background is the reasonable next approximation, clearly
  short of real libass rendering.

## Licence

MIT. It's yours.
