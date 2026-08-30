/*
 * templates.js
 * ---------------------------------------------------------------------------
 * A template is a rhythm, not a look. Each one is a list of slots: how long a
 * clip runs, how fast it plays, how it enters and leaves. You drop clips in
 * top-to-bottom and the timing builds itself.
 *
 * They are named after the structural ideas they borrow their proportions
 * from, because that is genuinely where the ratios come from — not decoration.
 *
 * `dur` is in seconds unless `beats` is set, in which case it is measured in
 * beats and resolved against the project BPM at apply time.
 */

const TEMPLATES = [
  {
    id: 'golden-section',
    name: 'Golden Section',
    note: 'Each shot runs 1.618x the one before it. Slow build, natural swell. Good for a vlog intro.',
    tag: 'vlog',
    slots: [
      { dur: 1.2, speed: 1, fadeIn: 0.3, fadeOut: 0.15 },
      { dur: 1.94, speed: 1, fadeIn: 0.15, fadeOut: 0.15 },
      { dur: 3.14, speed: 1, fadeIn: 0.15, fadeOut: 0.15 },
      { dur: 5.09, speed: 1, fadeIn: 0.15, fadeOut: 0.4 }
    ]
  },
  {
    id: 'brutalist',
    name: 'Brutalist Slab',
    note: 'Equal, heavy, no transitions. Every shot the same weight. Hard cuts only.',
    tag: 'ootd',
    slots: [
      { dur: 2.0, speed: 1, fadeIn: 0, fadeOut: 0 },
      { dur: 2.0, speed: 1, fadeIn: 0, fadeOut: 0 },
      { dur: 2.0, speed: 1, fadeIn: 0, fadeOut: 0 },
      { dur: 2.0, speed: 1, fadeIn: 0, fadeOut: 0 },
      { dur: 2.0, speed: 1, fadeIn: 0, fadeOut: 0 }
    ]
  },
  {
    id: 'bauhaus-grid',
    name: 'Bauhaus Grid',
    note: 'Strict four-beat cells. Cuts land exactly on the beat, so set your BPM first.',
    tag: 'ootd',
    beatBased: true,
    slots: [
      { beats: 4, speed: 1, fadeIn: 0, fadeOut: 0 },
      { beats: 4, speed: 1, fadeIn: 0, fadeOut: 0 },
      { beats: 4, speed: 1, fadeIn: 0, fadeOut: 0 },
      { beats: 4, speed: 1, fadeIn: 0, fadeOut: 0 },
      { beats: 4, speed: 1, fadeIn: 0, fadeOut: 0 },
      { beats: 4, speed: 1, fadeIn: 0, fadeOut: 0 }
    ]
  },
  {
    id: 'cantilever',
    name: 'Cantilever',
    note: 'One long anchor shot, then three short ones jutting off it. Establish, then detail.',
    tag: 'vlog',
    slots: [
      { dur: 6.0, speed: 1, fadeIn: 0.4, fadeOut: 0.2 },
      { dur: 1.2, speed: 1, fadeIn: 0.1, fadeOut: 0.1 },
      { dur: 1.2, speed: 1, fadeIn: 0.1, fadeOut: 0.1 },
      { dur: 1.2, speed: 1, fadeIn: 0.1, fadeOut: 0.35 }
    ]
  },
  {
    id: 'fibonacci-spiral',
    name: 'Fibonacci Spiral',
    note: 'Tightens as it goes: long, long, shorter, shorter, snap. Builds tension into a punchline.',
    tag: 'vlog',
    slots: [
      { dur: 4.0, speed: 1, fadeIn: 0.3, fadeOut: 0.1 },
      { dur: 2.5, speed: 1, fadeIn: 0.1, fadeOut: 0.1 },
      { dur: 1.5, speed: 1, fadeIn: 0.08, fadeOut: 0.08 },
      { dur: 1.0, speed: 1.25, fadeIn: 0.06, fadeOut: 0.06 },
      { dur: 0.6, speed: 1.5, fadeIn: 0, fadeOut: 0 },
      { dur: 0.4, speed: 2, fadeIn: 0, fadeOut: 0.2 }
    ]
  },
  {
    id: 'barcelona-pavilion',
    name: 'Barcelona Pavilion',
    note: 'Open, unhurried, everything crossfades into everything. No hard edges anywhere.',
    tag: 'vlog',
    overlap: 0.6,
    slots: [
      { dur: 3.5, speed: 1, fadeIn: 0.6, fadeOut: 0.6, transitionType: 'dissolve' },
      { dur: 3.5, speed: 1, fadeIn: 0.6, fadeOut: 0.6, transitionType: 'dissolve' },
      { dur: 3.5, speed: 1, fadeIn: 0.6, fadeOut: 0.6, transitionType: 'dissolve' },
      { dur: 3.5, speed: 1, fadeIn: 0.6, fadeOut: 0.6, transitionType: 'dissolve' }
    ]
  },
  {
    id: 'ramp-flywheel',
    name: 'Flywheel Ramp',
    note: 'Speed climbs across the sequence then drops back. The velocity edit, in one click.',
    tag: 'ootd',
    slots: [
      { dur: 1.6, speed: 0.5, fadeIn: 0.2, fadeOut: 0 },
      { dur: 1.2, speed: 1, fadeIn: 0, fadeOut: 0 },
      { dur: 0.9, speed: 1.75, fadeIn: 0, fadeOut: 0 },
      { dur: 0.7, speed: 2.5, fadeIn: 0, fadeOut: 0 },
      { dur: 1.4, speed: 0.6, fadeIn: 0, fadeOut: 0.3 }
    ]
  },
  {
    id: 'outfit-turn',
    name: 'Outfit Turn',
    note: 'Full shot, slow detail, snap back to full. Built for one outfit, three angles.',
    tag: 'ootd',
    slots: [
      { dur: 2.2, speed: 1, fadeIn: 0.25, fadeOut: 0 },
      { dur: 2.0, speed: 0.5, fadeIn: 0, fadeOut: 0 },
      { dur: 1.0, speed: 1.6, fadeIn: 0, fadeOut: 0.25 }
    ]
  }
];

/**
 * Pour clips into a template's slots.
 * Clips beyond the slot count get the last slot's shape, so a template never
 * silently drops footage.
 */
function applyTemplate(template, clips, bpm) {
  const beatSec = 60 / (bpm || 120);
  const overlap = template.overlap || 0;
  let cursor = 0;

  return clips.map((clip, i) => {
    const slot = template.slots[Math.min(i, template.slots.length - 1)];
    const wanted = slot.beats ? slot.beats * beatSec : slot.dur;
    const available = Math.max(0.1, clip.sourceDuration || (clip.outSec - clip.inSec));

    // Slot length is what we want; source length is what we have. Take the
    // smaller, adjusted for speed, so we never ask for frames that don't exist.
    const speed = slot.speed || 1;
    const sourceNeeded = Math.min(available, wanted * speed);

    const next = {
      ...clip,
      startSec: Math.max(0, cursor),
      inSec: clip.inSec || 0,
      outSec: (clip.inSec || 0) + sourceNeeded,
      speed,
      fadeIn: slot.fadeIn || 0,
      fadeOut: slot.fadeOut || 0,
      transitionType: slot.transitionType || 'fade'
    };

    cursor += (sourceNeeded / speed) - overlap;
    return next;
  });
}

if (typeof module !== 'undefined') module.exports = { TEMPLATES, applyTemplate };
