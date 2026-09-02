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
`caption-preview`, `timeline-snapping`, `save-state`, `dirty-state`,
`media-relink`), integration tests
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

`npm test` itself launches nothing but Node and jsdom. The render tests skip
themselves when ffmpeg is not installed, so the suite still runs in a couple
of seconds without it — which is how CI runs it, on Node 22.12, 22 and 24.

```bash
npm run test:electron
```

A fourth kind, kept out of `npm test` on purpose and living in `test/electron/`
instead of alongside the rest: it launches the real Electron binary and drives
it with Playwright's `_electron`. jsdom can load `index.html` and `app.js`
well enough to click things, but it has no `Menu`, no `dialog`, no real
`win.close()` semantics and no real filesystem writes from a real main
process — and four separate PR reviews on this repo only turned up real bugs
in exactly those places (a stripped Edit menu that would have killed
clipboard support, close-guard ordering, an autosave race) by launching
Electron under Xvfb by hand. This tier is that manual check made permanent.

It is deliberately narrow — a smoke tier, not a repeat of full manual QA.
Covered: the app boots without throwing, the application menu is installed
with the standard Edit roles (`cut`/`copy`/`paste`/`selectAll`) rather than a
silently-stripped one, the close guard actually blocks a dirty window and
Cancel genuinely leaves it open, a clean project's close does not prompt, and
autosave writes a real, valid project file to `userData`. Not covered, on
purpose: real WebGL/compositing pixel output and real pointer-drag snapping —
both need a lot more than this tier's flat assertions to verify honestly (see
"How the composited preview works" above for how the WebGL side was last
checked, by hand), and are natural next candidates for their own tier rather
than something to fold in here.

It skips itself, the same way the render tests skip without ffmpeg, whenever
the Electron binary has not been downloaded (CI's fast job above sets
`ELECTRON_SKIP_BINARY_DOWNLOAD` for exactly the reason this paragraph used to
give) or there is no display to render into — never fails for either. CI runs
it in its own job, under Xvfb, separately from and not blocking the fast job.

```bash
npm run lint
```

ESLint, flat config in `eslint.config.js`. Deliberately small — undefined
globals, unreachable code, unused variables, nothing stylistic. CI runs it
alongside the tests.

## What it does

**Timeline.** Two video tracks and one audio track to start. **+ Video
track** / **+ Audio track**, in the timeline's own header, add more of
either: a new video track always lands directly above the ones already
there, so it composites over everything below it the same way Video 2
already composited over Video 1; a new audio track is simply appended,
since audio tracks have no compositing order to preserve. Each track head
carries a **✕** to remove it again — refused, with a toast, while the
track still has clips on it, and — for video only — refused once more for
a project's last remaining video track, since a project with none has
nothing for the preview or the export to composite. There is no floor at
the two video tracks a project boots with, though: trimming back down to
one is allowed, and is if anything the cheaper project to export
(`canStreamCopy`'s fast path is exactly one video track). Audio has no
floor at all, not even one — a video clip's own synced sound plays
regardless of whether any audio-kind track exists, so a project can
legitimately drop to zero audio tracks; **+ Audio track** is always there
to add one back. Track numbers, video or audio, are never reused or
renumbered when one is removed — deleting Video 2 leaves Video 3 exactly
"Video 3", the same way deleting a clip never renumbers the clips after it.
Drag clips to move, drag the edges to trim, drag between lanes to reassign.
Moving or trimming a clip snaps the edge under the drag to nearby edges of
*other* clips (any track — keying a clip on Video 2 to a cut on Video 1 is
ordinary), the playhead, and zero. Unlike the timeline's own beat-snap
checkbox (grid lines at the project's BPM, for the beat-based templates
below), this is not optional — it is always on, the way every mainstream NLE
does it, because lining two clips up exactly is not an editing style anyone
would want to turn off. With beat-snap also on, both kinds of target are
candidates and whichever is closer wins. The threshold is a fixed number of
screen pixels rather than seconds, converted at the current zoom: a
fixed-seconds threshold would reach across the whole visible timeline zoomed
out and never fire zoomed in. This is also what makes the
crossfade rule below trustworthy — missing a butt join by a couple of pixels
used to read as an overlap, and silently became a transition nobody asked
for; see `src/timeline-snapping.js` for the decision logic and its own
header for why it is a separate, DOM-free module.

Click a clip to select it, replacing whatever was selected before. Shift-click
or Ctrl/Cmd-click instead toggles a clip into or out of the selection — the
same modifier the media bin above already uses for its own multi-select, kept
for one convention rather than two. A Shift-click *range* (click one clip,
Shift-click another, get everything between) is not implemented: a timeline
has two axes, time and track, and there is no single obviously-right reading
of "everything between" two clips on different tracks, so toggling one clip
at a time is what's here instead. Delete, Duplicate, Copy and Paste act on
the whole selection; the inspector, Split, Set In/Out and Transcribe still
act on one clip — whichever the selection last touched — because none of
those four has an obvious multi-clip meaning (see "Split, Set In, Set Out and
Transcribe" in `src/app.js`), and an inspector showing several clips' settings
at once, possibly disagreeing, is a bigger feature than this one. A
modifier-click only ever changes the selection; it never starts a drag, and
multi-selected clips do not drag as a group — only single-clip drag exists
today.

**Split and trim.** Playhead + `S` splits. `I` and `O` set in and out points.
Every clip carries source-time and timeline-time separately, so trimming never
shifts anything downstream by accident.

**Copy, paste, duplicate.** `Ctrl/Cmd C` copies the selected clip(s) — their
full settings, deep-cloned rather than referenced, so pasting twice or editing
the original afterward can never alias what's on the clipboard.
`Ctrl/Cmd V` pastes at the playhead, keeping whatever spacing the copied
clips had relative to each other, back onto the tracks they came from (or the
first track of the same kind, video or audio, if that exact track is somehow
gone — defensive rather than reachable, since nothing in the UI can delete a
track today). `Ctrl/Cmd D` duplicates the selection in place: copy and paste
in one step, offset to land right after the originals rather than exactly on
top of them — an exact overlap on the same track is what turns two clips into
a crossfade (see Crossfades, below), so "in place" means adjacent, not
identical. A caption text field's own copy/paste is unaffected; these three
shortcuts only reach the timeline clipboard when a text field is not focused.

**Delete and ripple delete.** `Delete`/`Backspace` removes the selected
clip(s) and leaves a gap, same as it always has. `Shift Delete` removes them
and closes the gap behind them — Avid's convention for the same distinction
(Extract vs. Lift) — shifting only the later clips on the SAME track, per
track, the way Close gaps (below) already scopes itself; a gap that was
already there before the delete is left exactly where it was, since ripple
delete closes only the gap this delete itself made, not every gap on the
track the way Close gaps does by hand.

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
every video track composited over the ones below it, exactly the order the
export uses. Drag the
playhead and the composite updates live; press Play and a timeline clock
advances it, seeking every active clip's own hidden `<video>` to keep pace
rather than the old design, where a single `<video>`'s own playback *was*
the clock. Trims and speed still show live, now driven by the clock instead
of a clip looping on its own. A crossfade shows both clips cross-dissolving
by opacity for the overlap, with a small label naming the export's real
`xfade` transition underneath — the dissolve is a stand-in for whichever of
the ten curated effects is actually picked, not a reproduction of its curve,
and the label exists so nobody mistakes one for the other. Captions show as
an approximate HTML/CSS overlay — font, size, colour, background and
position from the caption style panel, plus a rough stand-in for the entry
animations — while the composited view itself is showing; it is not a real
libass render, and Test 3s remains the way to check the actual burned-in
result. On a machine with no WebGL it quietly falls back to whichever clip
is topmost at the playhead, plain, at 1x, start to end, same as it always
did; it does not attempt the clock, the trim loop, or captions in that
state, on the theory that a feature this dependent on a real GPU is better
served by keeping its one un-provable fallback exactly as small as it
already was. See "How the composited preview works" and "Captions in the
preview" below.

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

**Missing media.** `clip.src` and a bin item's path are absolute filesystem
paths with no indirection, so moving a source file, renaming it, or opening
the project with a drive unmounted breaks the link. Opening a project checks
every path it and the current media bin reference; anything gone shows up in
a panel — bottom right, and it stays up rather than fading like a toast,
because losing track of which of several clips is affected is worse than the
panel being in the way. **Locate…** relinks one file by hand and fixes every
clip and bin item that shared it, not just the first one found. **Locate
folder…**, and an automatic check of the project file's own folder, offer
the same fix by filename for everything at once — see "Missing media" below
for exactly what that heuristic does and does not catch. Nothing else about
the project is blocked while a file is missing; only using that particular
clip is, with an error in place of a raw ffmpeg failure or a silently broken
preview.

## Keyboard

| | |
|---|---|
| `Space` | play / pause preview |
| `S` | split at playhead |
| `I` / `O` | set in / set out |
| `←` `→` | step one frame (hold Shift for one second), clamped to the project's length |
| `Ctrl/Cmd C` | copy selected clip(s) |
| `Ctrl/Cmd V` | paste at the playhead |
| `Ctrl/Cmd D` | duplicate selected clip(s) in place |
| `Delete` | remove selected clip(s), leaving a gap |
| `Shift Delete` | remove selected clip(s) and close the gap |
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

`Ctrl/Cmd C`/`V` for clips ride alongside those same roles rather than
replacing them: the Edit menu's own `copy`/`paste` already own that key combo
everywhere a text field needs it, on every platform, so main.js listens for
the keystroke a second way — `before-input-event`, which sees it regardless
of who else claims it — and tells the renderer, which runs the clip-clipboard
logic only when a text field is not what has focus. See
`wireClipboardShortcuts` in `main.js` and `doCopy`/`doPaste` in `src/app.js`.

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
  clipboard-shortcuts.js  Which clip-clipboard command, if any, a
                     before-input-event keystroke maps to. Pure, no
                     Electron, same reason as save-state.js.
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
  caption-preview.js  Which caption row is active at a timeline time, the
                     fade/pop/slide entry-animation state, per-word karaoke
                     spoken/unspoken state, and the ASS-space-to-CSS-pixel
                     scaling the overlay's sizing rides on. Pure, no DOM —
                     app.js's syncCaptionOverlay/applyCaptionOverlay are the
                     <div> wiring on top of it. See "Captions in the
                     preview".
  timeline-snapping.js  Where a dragged clip edge lands: candidate positions
                     (other clips' edges, the playhead, zero) and the
                     closest-within-threshold pick. Pure, no DOM — app.js
                     converts pixels to seconds and calls it from the
                     pointermove handlers.
  media-relink.js    Which paths a project and bin currently reference,
                     rewriting every clip/bin item that shares one path, and
                     the filename-only auto-match heuristic. Pure, no I/O —
                     used by both main.js (`require`, to build the
                     existence check and the folder match) and app.js
                     (script tag, to decide what a relink rewrites), the
                     same two-user split chroma-math.js already has.
  templates.js       Edit rhythms. Pure data plus one function.
  index.html         Structure.
  styles.css         Tokens at the top.
test/
  *.test.js          node --test, no framework. `npm test`.
  electron/*.test.js  Drives a real Electron under Playwright's `_electron`.
                     Separate from `npm test` on purpose — `npm run
                     test:electron`, its own CI job. See "Tests" above.
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

### Missing media

A validated project can still be unusable in one specific way `validateProject`
was never meant to catch: every `clip.src` and bin `media.path` is an absolute
filesystem path with no indirection, so a source file that got moved, renamed,
or lives on a drive that is not mounted right now breaks the moment anything
tries to read it. Before this, that moment was buried inside an export or a
preview, surfacing as a raw ffmpeg failure or, on the preview's no-WebGL
fallback path, nothing at all — a `<video>` handed a dead `src` just sits
there blank. Contrast with the gate above: a malformed project is unusable
regardless of what a user does next, but a valid project with one moved file
is usable for everything except that file, and refusing the whole project
over it would be a worse failure than the one being fixed.

`src/media-relink.js` is the pure half: which paths a project and bin
currently reference (`collectSourcePaths`), how many clips and whether the
bin share a given one (`countReferences`), rewriting every clip and bin item
pointing at one path (`relinkProject` / `relinkBin`), and the one heuristic
offered for finding a moved file automatically (`matchByFilename`). No I/O,
same as `shared/project-schema.js` — but it lives in `src/`, not `shared/`,
because it has two users on two sides of the process boundary: main.js
`require`s it to build the existence check and the folder match, and app.js
loads it as a plain `<script>` to decide what a relink actually rewrites.
`chroma-math.js` is the existing example of a `src/` module used both ways;
`shared/` stays main-only, per its own section above.

Detection runs before a project is put on screen, not after — `app.js`'s
`detectMissingMedia` is called ahead of `adoptProject`, on Open, New (in case
a bin item carried over from the last project is what's missing) and restoring
an autosave. Ahead, specifically, of the render that follows: the composited
and no-WebGL fallback preview paths both only reload a clip's video element
when the active clip *changes* (by id in the fallback, by path in the
composited view — see "How the composited preview works" below for why the two
differ), so a check that landed after that first draw would find an unguarded
load already attempted, with nothing to give the guard a second chance at it.

The panel this feeds is deliberately not a toast: several clips can share one
missing file, a toast fades on its own schedule regardless of whether anything
was done about it, and losing track of which clips are still broken is worse
than a small panel staying in view. **Locate…** opens a single-file picker and
relinks every clip and bin item that shared the old path in one action — a
source file backing more than one clip is ordinary, and fixing it once has to
fix all of them, wired through the same `edit()`/history path any other change
to a clip uses, so a bad relink is undoable like anything else. The bin half
is not wired to undo, for the same reason `addPaths` never is — the bin sits
outside the edit history entirely (see "How undo works" below).

**Locate folder…**, and an automatic check of the project file's own folder
that runs silently right after detection and only surfaces if it finds
anything, both go through the same `matchByFilename` — filename equality,
nothing else. That is a deliberate ceiling, not a first pass at something
smarter: a folder containing a same-named-but-different file matches with the
same confidence as the real one, and content-hash matching would close that
gap at the cost of reading every candidate file up front, for a feature that
is otherwise about paths and never touches file contents. Neither this nor
the plain existence check catches a file that exists but is no longer right
— wrong codec, swapped content under the same name — a known, stated blind
spot rather than a caught case, the same honesty the "Two export paths"
section below states for stream copy's own inability to see a clip's
resolution.

The bin's own gap is worth being explicit about, because it shapes what
detection can promise: `state.bin` is renderer-only session state that never
round-trips through a saved project file (nothing in `project-schema.js`'s
shape describes it), so main.js's `project:open` handler cannot check it —
only the renderer knows what's currently in the bin. `media:checkMissing` is
therefore a general-purpose "which of these paths exist" primitive rather
than something folded into `project:open` itself; app.js calls it with every
path the newly-opened project *and* the bin already hold, in one round trip,
right before that project goes on screen.

The cached result, `state.missingSources`, is what the preview guards check —
cheap, because a preview redraws every frame and cannot afford a round trip
to main on each one — but it can go stale: undoing a relink puts a clip back
on a path this session already crossed off as fixed, and the cache has no way
to hear about that on its own. Export does not trust it: `runExport` re-asks
main for a fresh answer against every path actually on the timeline
immediately before running ffmpeg, which is the one moment a stale "looks
fine" would cost the most to act on.

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

Everything in that paragraph is Electron behaviour, which `npm test` cannot
exercise — jsdom has no `close` event or real `dialog`. So the *decisions*
were pushed into `shared/save-state.js` — which button index means discard,
whether Save needs a dialog, whether an autosave is worth offering — where
they are pure and tested, the same split `project-schema.js` was extracted
for. What is left in `main.js` is the calls. `test/electron/` now drives this
guard end to end under a real Electron — dirty blocks and Cancel really
cancels, clean does not prompt — but only that behaviour, not a substitute
for `save-state.js`'s own pure tests of the decisions themselves.

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
`buildExportCommand` composites in — so a later video track landing over an
earlier one in the preview is a property of iteration order, not a separate
compositing step that could disagree with the export's. Nothing about that
order assumes exactly two video tracks; a third landing over the first two
is the same iteration doing what it already did.

app.js turns those answers into pixels through a small **layer pool**
(`layerPool`): each entry owns one `<canvas>` and one hidden `<video>`,
reused for the life of the session rather than created and torn down at
every clip or crossfade boundary. Recreating a WebGL context is real work
and browsers cap how many can be live at once, so reusing a bounded set of
hidden, paused elements is the more defensible choice than churning
contexts every time the playhead crosses a cut. The bound itself
(`poolSize()`) used to be the fixed `POOL_SIZE = 4` — enough for exactly
two video tracks to be mid-crossfade at the same instant, which was the
most `layersAt` could ever ask for while the project shape was fixed at
two. Now that video tracks are not fixed, it is `videoTrackCount * 2`,
recomputed on every call rather than cached, since a track can be added
mid-session — but the pool below it still only grows: `poolEntry()` creates
entries lazily and `layerPool` itself is never shrunk, so adding a track
never tears down or recreates a context that already exists, it only asks
for a couple more the next time one is actually needed. `#keyCanvas` is
pool entry 0 and is the only one that exists in `index.html`; the rest are
created lazily and stacked into `#previewStage` with plain CSS (each
non-base layer positioned to fill the base layer's box exactly), so a video
track drawing over the ones below it — and the two halves of a crossfade
dissolving into each other — is ordinary DOM paint order, not anything the
shader itself had to learn. **The shader in `key-preview.js` is
untouched**: every layer reuses the exact single-clip
`createKeyPreview`/`draw` this preview already had, once per canvas.

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

**Captions** draw as a positioned HTML/CSS overlay on top of this stage —
see "Captions in the preview", below, for what that overlay does and does
not attempt, and why it was left out of the PR that built everything above
it.

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

### When scrubbing the preview is slow, and why this only warns about it

The preview seeks the real source `<video>` directly — no proxy file, no
partial decode, just `currentTime` set on the browser's own element (see
`syncVideoToTime`/`drawComposited` in `app.js`). That is what makes it trust
the export's own numbers instead of a second, separately-maintained
rendering path, but it also means scrub latency is Chromium's decoder's
problem, not this codebase's, and Chromium's decoder has a real limit: a
seek can only start from a keyframe, and on `<video>.currentTime` it
re-renders from that GOP's own start regardless of how small the jump is.

That was measured, not assumed. Two synthetic 10-minute fixtures of
identical duration, one keyframe every 1 second and one every 30 seconds
(`ffmpeg -f lavfi -i testsrc2=duration=600:... -g <N> -keyint_min <N>
-sc_threshold 0`), driven through real Electron under Xvfb with
`--use-angle=swiftshader` for a real WebGL context. With a 1-second GOP,
every seek tried — small, large, forward, backward — landed under 70ms. With
a 30-second GOP, *every* seek cost 200–960ms, including a 1-second forward
jump landing in the same GOP as the playhead's current position. Duration
did not predict this at all: the two fixtures were the same length. Keyframe
spacing is the entire story — a beautifully-encoded 3-hour interview has none
of this problem, and a badly-transcoded 90-second clip can have all of it.

What this feature does about it is exactly one thing: says so, at import.
`main.js`'s `media:probe` handler (`probeKeyframeInterval`) runs a second,
bounded ffprobe pass — keyframes only (`-skip_frame nokey`), and only the
first `KEYFRAME_PROBE_WINDOW_SEC` (60) seconds of the stream
(`-read_intervals`), so this stays a cheap early read rather than the
whole-file packet scan that made `media:waveform` slow before it was fixed to
stream (see "Tests", above, on that fix) — and returns the source's average
keyframe interval as `keyframeIntervalSec`, or `null` if the sampled window
did not contain two keyframes to measure a gap from. `app.js`'s `addPaths`
is what decides whether that number is worth mentioning:
`SPARSE_KEYFRAME_THRESHOLD_SEC` (8 seconds, next to `addPaths` itself) is
picked the same way `DRIFT_THRESHOLD` and `WAVEFORM_SAMPLE_RATE` were —
most delivery-format encodes keyframe every 1–4 seconds, so 8 gives real
margin above ordinary footage without flagging it, while still catching the
30-second-and-up encodes the profiling above actually measured as slow. A
toast names the file and warns that scrubbing it may be slow; the import
proceeds exactly as it would otherwise. Nothing is blocked, transcoded, or
silently absorbed — the same posture the ffmpeg-missing and missing-media
toasts already take elsewhere in this app for a real problem this codebase
has decided not to hide.

What this does *not* do is fix the problem. A proxy/transcode pipeline —
generating a densely-keyframed stand-in for the preview to scrub, the export
still cutting the original — was considered and rejected, for now: it is
real, ongoing infrastructure (storage, invalidation, a second encode per
import) for a problem that, so far, only some sources have, and that a toast
already makes visible rather than mysterious. If sparse-keyframe sources turn
out to be common enough that "scrub, wince, remember why" stops being
acceptable, that pipeline is the next step — `keyframeIntervalSec` already
being a real, per-source number on every bin item is what would let it decide
which sources actually need transcoding rather than paying for all of them.

### Captions in the preview

Captions were left out of the composited preview when it first landed — see
"How the composited preview works", above, for exactly why: everything else
in that PR already needed proving out in a real browser this repository's
test harness cannot launch, and stacking a second unverified approximation
on top of the first (an HTML approximation of an ASS/libass render, on top
of a canvas approximation of an `xfade` curve) was worse than shipping the
video layers honestly. That PR's own "Extending it" section named the shape
this would take in advance: "a positioned HTML/CSS overlay reading the
caption style panel's font, size, colour, position and background". This is
that overlay.

`src/caption-preview.js`'s `activeCaptionAt` answers one question, pure and
DOM-free, the same split `timeline-preview.js`'s `trackStateAt` makes for
video layers: given a timeline time `t`, which caption row (if any) is on
screen. `end` is exclusive, the same convention `trackStateAt` uses for a
clip's own window. Caption rows are a flat, independently-timed list —
nothing in the caption editor stops two from overlapping — so more than one
can be active at once; this does not stack them the way a real libass
render would, it picks the later-starting one, the same tie-break
`trackStateAt`'s own `'solo'` case uses for overlapping clips. That is a
stated approximation, not an attempt at real collision layout.

`app.js`'s `syncCaptionOverlay`/`applyCaptionOverlay` turn that answer into
a styled `<div>` (`#captionOverlay`, `#captionOverlayText`), absolutely
positioned inside `#previewStage` the same way `#xfadeBadge` already is —
font, weight and colour straight from `captionStyle`; position (top/middle/
bottom) as a flex alignment class, mirroring the `{bottom:2, middle:5,
top:8}` Alignment map `buildAssFile` uses, with middle ignoring `marginV`
the same way libass's own Alignment 5 does; the background box as a real
`background-color` with its own opacity, or — when the box is off — a
cheap eight-direction `text-shadow` standing in for ASS's outline
(`BorderStyle 1`), since CSS has no built-in glyph-stroke renderer to reach
for instead. Font size, margin and outline width are all ASS-space numbers
(relative to the project's own height, the way `PlayResY`/`fontsize`/
`MarginV` all are) run through `caption-preview.js`'s `scaledPx`, which
turns them into real CSS pixels scaled by `#previewStage`'s own measured
height — 0, which is what an unmeasured or not-yet-laid-out box reports,
falls back to treating an ASS unit as one CSS pixel, which is also what
jsdom's own layout-free DOM always reports (see "What is and is not
verified", below, for what that fallback means for this suite's own test
coverage).

It is driven from `drawComposited`, on the same `t` and the same redraw
triggers (`requestPreviewFrame`, the RAF loop `startPreviewLoop` drives) the
video layers already use — not a second render path of its own, since a
caption overlay updating on a different schedule than the video it sits
over would drift out of sync with it the way two independent clocks always
do. Every caption-style control and every caption row edit that did not
already call `requestPreviewFrame`/`scheduleCommandPreview` before this
feature existed now does — reusing that one hook rather than inventing a
parallel one — so a style change reaches the overlay the same way any other
live-preview-affecting field already does: no scrub, no extra trigger
written specifically for captions.

**Animations.** `fade`, `pop` and `slide` are cheap CSS equivalents of
`buildAssFile`'s `\fad`/`\t`/`\move` tags, computed the same way those tags
themselves work: as pure functions of local time within the caption's own
active window (`caption-preview.js`'s `animationState`), not a "just
appeared" trigger replaying a CSS animation. That is what makes a scrub
landing mid-caption give the right instantaneous answer immediately, the
same as a real ASS renderer computing the correct frame for whatever
timestamp it is asked for rather than replaying from a start event. The
three tags' literal millisecond values (120/120, 140, 160) are duplicated as
`FADE_SEC`/`POP_SEC`/`SLIDE_SEC` — `shared/` is main-process-only and never
reaches the renderer, the same reason `timeline-preview.js`'s
`TRANSITION_TYPES` is a duplicate rather than an import — and
`test/caption-preview.test.js` pins them against `buildAssFile`'s own output
so the two cannot quietly drift apart, the same role the `TRANSITION_TYPES`
test already plays for the crossfade list. `slide`'s upward lift is a fixed,
modest distance in `em`, not one derived from `marginV` the way the real
`\move` coordinates are: the real tag always targets a y just above the
bottom edge regardless of which position is actually chosen, which
Alignment then reinterprets around that point, and reproducing that
position-dependent quirk exactly would need testing against a real libass
render this repository's harness cannot run (no ffmpeg here) — so this
approximates "slides up into wherever it already sits" instead.

**Typewriter/karaoke** has two paths, matching `buildAssFile`'s own two
paths through the same animation. For a caption that carries real per-word
timing (`cap.words`, from a transcription — see "Word-level captions and
karaoke", below), `karaokeWordStates` marks a word "spoken" from
`t >= word.start` onward, matching the real `\k` tag's own trigger instant
(a hard, non-reverting switch from `SecondaryColour` to `PrimaryColour`, not
a gradual sweep) rather than the later point its own `\k` duration ends —
the overlay renders one `<span>` per word, coloured accordingly.

A caption with no `words` — hand-typed, imported, or a transcribed row whose
text or timing was hand-edited afterward (`app.js`'s `renderCaptions` drops
`words` the moment a row is touched) — falls back to `buildAssFile`'s own
fallback: an old even-split-by-character `\k` estimate, one tag covering the
whole line with a duration of `dur / characterCount`. `caption-preview.js`'s
`charSplitKaraokeStates` recomputes that exact formula — `dur =
max(0.1, caption.end - caption.start)`, divided by the caption's own text
length counted the same quirky way `buildAssFile` counts it (a `\n` as the
two characters `\N` becomes in the ASS file, not one) — rather than
importing it, the same `shared/`-is-main-process-only reason
`FADE_SEC`/`POP_SEC`/`SLIDE_SEC` are a hand-kept duplicate rather than an
import a few paragraphs up. Each real character is "spoken" once local
elapsed time reaches its own index times that per-character duration, and
the overlay renders one `<span>` per character on the same coloured-spans
path the word case uses. `test/caption-preview.test.js` pins the derived
per-character duration against `buildAssFile`'s own literal `\k` output, the
same role the `FADE_SEC`/`POP_SEC`/`SLIDE_SEC` pin test plays for the entry
animations, so the two cannot silently drift apart.

**The no-WebGL fallback does not show captions either**, and for a
different reason than the clock/trim-loop gap it already declines to close:
the caption overlay itself needs zero WebGL, but it is sized against
`#previewStage`'s own rendered box (`.caption-overlay` in `styles.css`),
and the fallback's plain `<video>` has no equivalent stage wrapper to size
against. Building one just for this fallback — restructuring markup and
CSS that exists only to serve a rare degraded path — would be the same
scope creep "How the composited preview works" already declined for the
timeline clock, for the same underlying reason: keeping a rarely-exercised
path exactly as small and already-understood as it was before this feature
existed.

**What is and is not verified.** `test/caption-preview.test.js` covers
`activeCaptionAt`, `animationState`, `karaokeWordStates`,
`charSplitKaraokeStates` and `scaledPx` as pure functions, mutation-tested by
hand against the code they cover, plus a pin against `buildAssFile`'s real
output for the three entry-animation timings and for the typewriter's
per-word and per-character `\k` values alike.
`test/caption-overlay.test.js` drives the real `app.js` in jsdom — through
the UI exactly the way a person would use it (the ruler, the caption row's
own inputs, the style panel's own fields), never reaching into app.js's
private `state` — to prove the *wiring*: the right caption shows across
start/end boundaries and a gap between two rows, `captionsEnabled` and an
empty caption list both show nothing, style-panel and caption-row edits
reach the overlay without an extra trigger, the background box toggles a
real `background-color`, and typewriter renders spoken/unspoken spans either
way — one per word with real per-word timing, one per character without it.
jsdom's DOM does support real CSS text
properties — `color`, `background-color`, class names, inline style
strings — unlike its faked `<canvas>`, so those assertions mean what they
say. What they do not prove: jsdom has no layout engine at all, so
`#previewStage.clientHeight` is always 0 in every test here, which is
exactly `scaledPx`'s 1:1 fallback path — the size/margin/outline assertions
in `test/caption-overlay.test.js` are checking that fallback arithmetic, not
real proportional scaling against a real rendered stage, and a caption
actually landing at the correct position, size and legibility on screen is
a claim only a real browser can confirm. `test/electron/caption-preview.test.js`
is that confirmation, launching real Electron under Xvfb with Playwright
(see `npm run test:electron`'s own section, above) against a real
ffmpeg-generated clip: a real WebGL context — `--use-angle=swiftshader`
plus `--enable-unsafe-swiftshader`, which recent Chromium requires before it
will hand out software WebGL at all — confirms `scaledPx`'s real branch
(not the 1:1 fallback above) produces the exact predicted pixel size
against `#previewStage`'s actually-measured height; that the overlay hides
and shows across a caption's start/end and the gap between two captions on
the real playhead clock, driven by a real pointerdown on the ruler with the
click's x computed against `#tlInner`'s own measured position rather than
assumed to start at the browser window's left edge; that switching
`position` between `top` and `bottom` moves the rendered box on real screen
coordinates; that a caption with no per-word timing sweeps by real
per-character `<span>`s (`charSplitKaraokeStates`, above) rather than
showing static text; and that the no-WebGL fallback suppresses the overlay
even with an active caption, checked by patching
`HTMLCanvasElement.prototype.getContext` on the page's own `BrowserContext`
before the window's first navigation, since `keyerFor`'s per-pool-entry
caching makes a patch applied after the app's first (real) WebGL attempt a
silent no-op. This lives as a permanent, checked-in file precisely because
that timing quirk — and the `--enable-unsafe-swiftshader` flag itself — are
exactly the kind of thing a manual pre-PR check re-derives correctly once
and then forgets; running it on every change is what a future change to
this overlay gets re-proven against, rather than a re-verification someone
has to remember to redo by hand.

### Track counts are not fixed at their starting numbers

`state.project.tracks` was always a plain array — the builder's `videoTracks`
/ `audioTracks` filters (`canStreamCopy`, `buildExportCommand`) and the
preview's `layersAt` already iterated it rather than reading
`tracks[0]`/`tracks[1]` by name — so nothing in the export or the composited
preview needed to change to support a third video track, or a second audio
one; `test/ffmpeg-render.test.js`, `test/ffmpeg-builder.test.js` and
`test/key-preview.test.js` each carry real multi-track cases (three video
tracks; two audio tracks, including clips split across them) rather than
trusting that the original coverage generalises on its own. What needed
building, for both kinds, was the UI: the timeline header's **+ Video
track** / **+ Audio track** buttons, a remove chip per track head, and
turning "Send to track" from static buttons in `index.html` into
`renderSendButtons()` — one button per current track of either kind,
rebuilt alongside the rest of the timeline on every `renderAll()`, the same
way `renderHeads()` already rebuilds the per-track mute/hide/remove row.

A new video track is always appended directly above the last existing video
track — never in the middle, never below — because that is the one
placement that needs no further decision: it composites over everything
already there the same way Video 2 already composited over Video 1, so
"the newest track wins where it overlaps" stays true without a special
case. A new audio track has no such stakes — `amix` sums its inputs, so two
audio tracks sound identical whichever order they mix in — and is simply
appended at the end of the track list, which both needs no decision either
and keeps every audio track grouped together, below every video track, in
the head list and the send-button row. Either kind's id and number are
picked by scanning every existing track of that kind's id (`v`*N* / `a`*N*)
and name (`Video `*N* / `Audio `*N*) for the highest *N* already in use and
adding one, rather than by counting tracks — counting would hand out a
number still visible on screen if an earlier track with a higher number had
since been removed, and two tracks both reading "Video 3" (or "Audio 2") in
the head list is a worse bug than a gap in the numbering. One function,
`nextTrackNumber(tracks, kind)`, does this scan for both kinds — the two
only ever differed in the id prefix and the capitalised label, both
derivable from `kind` itself, so a shared function stayed simpler than two
copies that would drift apart the next time either changed.

Removing a track is refused, with a toast, while it still has clips on it,
for both kinds — silently discarding footage because someone clicked the
wrong chip is a worse failure than a click that does nothing. Beyond that,
the two kinds diverge. Video is refused again for a project's last
remaining video track, since a project with none has nothing for the
preview or the export to composite; above that floor of one, removing is
unconditional — nothing pins the count at the two the project boots with,
and `canStreamCopy` already treats a single video track as the fast path,
so a project trimmed back down to one is, if anything, the cheaper case to
export. Audio has no floor at all, not even one: a video clip's own synced
sound rides on `clip.hasAudio` on its *video* track regardless of whether
any audio-kind track exists, and `buildExportCommand`'s audio mix walks
every track in the project directly rather than requiring one of kind
`audio` to be present — so a project with zero audio tracks is not silent,
and is not missing anything the preview or export needs the way a project
with zero video tracks would be. It just has nowhere left to put a
standalone music bed or voiceover that isn't attached to a clip's own
video, and **+ Audio track** is always there to add one back. Track
numbers, video or audio, are never renumbered when one is removed:
deleting Video 1 leaves Video 2 exactly "Video 2", the same way deleting a
clip never renumbers the clips after it — a user's name for a track is not
the app's to change out from under them.

The layer pool's own generalisation — `POOL_SIZE = 4` becoming
`videoTrackCount * 2` — is covered above, in "How the composited preview
works". It is sized off video tracks only; audio tracks never touch the
composited canvas or the layer pool at all, so a project's audio track
count has no effect on it.

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

Nothing is currently on this list — every gap named here as this project
went along (a second audio track, captions in the preview, the caption
overlay's real-browser proof, its no-word-timing typewriter fallback) has
been closed. The next reasonable move is whatever the next real gap turns
out to be, not a bullet kept around for its own sake.

## Licence

MIT. It's yours.
