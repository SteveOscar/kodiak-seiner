// Generative maritime/folk music, pure (no WebAudio): a lilting 6/8 over a modal drone, slow pad chords, a sparse
// plucked motif that follows the harmony and, for the title and a big set, a tin-whistle line. The player
// (music.js) schedules the events this returns one bar at a time.

export const SCALES = {
  ionian: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
};

// Melodic pools (semitones over the root): pentatonic-leaning so any note sits well over the drone.
const POOLS = {
  dorian: [0, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 7, 9, 10],
  ionian: [0, 2, 4, 7, 9],
  aeolian: [0, 3, 5, 7, 10],
};

export const MOODS = {
  // D Dorian, unhurried, the full ensemble. Plays for as long as the title is up.
  title: {
    root: 50, scale: 'dorian', bar: 3.9, grid: 6, chordBars: 2, bars: Infinity, pluck: 0.5, whistle: 0.55, drone: 1, pad: 1,
    progressions: [[0, 6, 3, 0], [0, 2, 6, 3], [0, 3, 0, 6], [5, 6, 0, 0]], fadeIn: 5, fadeOut: 5,
  },
  // G Mixolydian at first light: drone, pads and a few plucks; about 80 s.
  dawn: {
    root: 55, scale: 'mixolydian', bar: 4.4, grid: 6, chordBars: 2, bars: 18, pluck: 0.3, whistle: 0, drone: 0.9, pad: 0.85,
    progressions: [[0, 6, 3, 0], [0, 3, 6, 0], [0, 4, 3, 0]], fadeIn: 8, fadeOut: 8,
  },
  // D major after a plugged set: brighter, busier, about 35 s.
  triumph: {
    root: 50, scale: 'ionian', bar: 3.3, grid: 6, chordBars: 1, bars: 10, pluck: 0.7, whistle: 0.7, drone: 0.7, pad: 0.9,
    progressions: [[0, 3, 4, 0], [0, 5, 3, 4], [0, 4, 5, 3]], fadeIn: 1.5, fadeOut: 6,
  },
};

const RHYTHM = [0.95, 0.15, 0.45, 0.75, 0.2, 0.4]; // 6/8: strong 1, medium 4

export function noteOf(root, scale, degree) {
  const s = SCALES[scale];
  const o = Math.floor(degree / s.length);
  return root + s[((degree % s.length) + s.length) % s.length] + 12 * o;
}

// Pitch classes (semitones over root, 0..11) of the triad (+ 9th) on a scale degree.
export function chordTones(scale, degree, add9 = false) {
  const s = SCALES[scale];
  const degs = [degree, degree + 2, degree + 4];
  if (add9) degs.push(degree + 8);
  return degs.map((d) => s[((d % 7) + 7) % 7] % 12);
}

// Places pitch classes (over root) inside [lo, lo + 12).
function voice(root, pcs, lo) {
  return pcs.map((pc) => {
    let m = root + pc;
    while (m < lo) m += 12;
    while (m >= lo + 12) m -= 12;
    return m;
  }).sort((a, b) => a - b);
}

function nearestPoolIndex(pool, root, target) {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < pool.length * 3; i++) {
    const m = root + pool[i % pool.length] + 12 * Math.floor(i / pool.length);
    const d = Math.abs(m - target);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

function poolNote(pool, root, i) {
  const n = pool.length;
  const k = Math.max(0, i);
  return root + pool[k % n] + 12 * Math.floor(k / n);
}

export function createComposer(moodName, rnd = Math.random) {
  const mood = MOODS[moodName] ?? MOODS.title;
  const pool = POOLS[mood.scale];
  const eighth = mood.bar / mood.grid;
  let bar = 0;
  let progression = mood.progressions[0];
  let motif = null;
  let whistlePhrase = false;
  let whistleDeg = 0;

  function newMotif() {
    const hits = [];
    for (let s = 0; s < mood.grid; s++) if (rnd() < RHYTHM[s] * (0.55 + mood.pluck)) hits.push(s);
    if (!hits.includes(0)) hits.unshift(0);
    const contour = [0];
    for (let i = 1; i < hits.length; i++) contour.push(contour[i - 1] + [-2, -1, -1, 1, 1, 2, 0][Math.floor(rnd() * 7)]);
    return { hits, contour };
  }

  function chordAt(b) {
    const idx = Math.floor((b % (progression.length * mood.chordBars)) / mood.chordBars);
    return progression[idx];
  }

  return {
    mood,
    name: moodName,
    get bar() {
      return bar;
    },
    get done() {
      return bar >= mood.bars;
    },
    nextBar() {
      const events = [];
      const phraseLen = progression.length * mood.chordBars;
      const inPhrase = bar % phraseLen;
      if (inPhrase === 0) {
        progression = mood.progressions[Math.floor(rnd() * mood.progressions.length)];
        if (bar === 0) progression = mood.progressions[0];
        motif = newMotif();
        whistlePhrase = bar > 0 && rnd() < mood.whistle;
      }
      const finalBars = Number.isFinite(mood.bars) ? mood.bars - bar : Infinity;
      const degree = finalBars <= 2 ? 0 : chordAt(bar);
      const lastBar = finalBars === 1;

      // Drone: root and fifth, re-struck under every phrase so an endless piece never runs out.
      if (mood.drone > 0 && inPhrase === 0) {
        const len = Math.min(phraseLen, Number.isFinite(finalBars) ? finalBars : phraseLen);
        events.push({ t: 0, type: 'drone', midi: [mood.root - 12, mood.root - 5], dur: len * mood.bar + 3, vel: 0.5 * mood.drone });
      }

      // Pads on each chord change.
      if (mood.pad > 0 && (inPhrase % mood.chordBars === 0 || finalBars === 2)) {
        const pcs = chordTones(mood.scale, degree, rnd() < 0.5);
        const upper = voice(mood.root, pcs, mood.root + 3);
        const bass = noteOf(mood.root - 12, mood.scale, degree);
        const bars = lastBar ? 1 : Math.min(mood.chordBars, finalBars);
        events.push({ t: 0, type: 'pad', midi: [bass, ...upper], dur: bars * mood.bar + (lastBar ? 2 : 0.6), vel: 0.55 * mood.pad });
      }

      // Plucked motif following the harmony; the fourth bar of a phrase answers or rests.
      const quiet = whistlePhrase ? 0.55 : 1;
      if (motif && mood.pluck > 0 && !lastBar) {
        const chordPcs = chordTones(mood.scale, degree);
        const target = voice(mood.root, chordPcs, mood.root + 12)[Math.floor(rnd() * chordPcs.length)];
        const start = nearestPoolIndex(pool, mood.root, target);
        const pos = inPhrase % 4;
        let hits = motif.hits;
        if (pos === 3) hits = rnd() < 0.4 ? [] : hits.slice(0, 2);
        for (let i = 0; i < hits.length; i++) {
          if (rnd() > quiet) continue;
          let step = motif.contour[i];
          if (pos === 2 && i === hits.length - 1) step += rnd() < 0.5 ? 1 : -1;
          const midi = poolNote(pool, mood.root, start + step);
          const accent = hits[i] === 0 ? 1 : hits[i] === 3 ? 0.85 : 0.65;
          events.push({ t: hits[i] * eighth, type: 'pluck', midi, dur: 1.6, vel: 0.5 * accent * (0.85 + 0.3 * rnd()) });
        }
      }
      if (lastBar && mood.pluck > 0) {
        events.push({ t: 0, type: 'pluck', midi: mood.root + 12, dur: 2.5, vel: 0.45 });
        events.push({ t: eighth * 3, type: 'pluck', midi: mood.root + 7, dur: 3, vel: 0.35 });
      }

      // Tin whistle: long stepwise notes, landing on a chord tone at the end of the phrase.
      if (whistlePhrase && !lastBar) {
        if (inPhrase === 0) whistleDeg = 14 + [0, 2, 4][Math.floor(rnd() * 3)];
        const pattern = rnd() < 0.5 ? [[0, 3], [3, 3]] : [[0, 2], [2, 1], [3, 3]];
        for (const [at, len] of pattern) {
          if (inPhrase === phraseLen - 1 && at > 0) break;
          whistleDeg += [-2, -1, -1, 0, 1, 1, 2][Math.floor(rnd() * 7)];
          whistleDeg = Math.max(12, Math.min(20, whistleDeg));
          if (inPhrase === phraseLen - 1) whistleDeg = 14; // home
          const midi = noteOf(mood.root, mood.scale, whistleDeg);
          events.push({ t: at * eighth, type: 'whistle', midi, dur: len * eighth * (inPhrase === phraseLen - 1 ? 2 : 1), vel: 0.32 });
        }
      }

      events.sort((a, b) => a.t - b.t);
      const out = { index: bar, duration: mood.bar, degree, events };
      bar++;
      return out;
    },
  };
}
