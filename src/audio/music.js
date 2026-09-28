// Generative music player: schedules the composer's bars a little ahead of the audio clock into its own fade gain on
// the music bus, crossfading between cues ('title', 'dawn', 'triumph' or silence). Pieces are sparse and soft; the
// mixer ducks the whole bus under radio calls.

import { createComposer, MOODS } from './composer.js';
import { pad, pluck, whistle, drone } from './instruments.js';

const LOOKAHEAD = 1.4; // seconds of music scheduled ahead of the clock

export function createMusic(ac, kit, dest) {
  let piece = null; // { name, composer, gain, nextBar, stopAt }
  const fading = []; // pieces fading out: { gain, until }
  let barsPlayed = 0;

  function startPiece(name) {
    const mood = MOODS[name];
    if (!mood) return null;
    const t = ac.currentTime + 0.08;
    const gain = kit.gain(0);
    gain.connect(dest);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(1, t + mood.fadeIn);
    return { name, composer: createComposer(name), gain, nextBar: t + 0.1, mood, ended: false };
  }

  function fadeOut(p, seconds) {
    if (!p) return;
    const t = ac.currentTime;
    p.gain.gain.cancelScheduledValues(t);
    p.gain.gain.setTargetAtTime(0, t, Math.max(0.05, seconds / 4));
    fading.push({ gain: p.gain, until: t + seconds + 6 });
  }

  function schedule(p) {
    while (!p.composer.done && p.nextBar < ac.currentTime + LOOKAHEAD) {
      const bar = p.composer.nextBar();
      const t0 = Math.max(p.nextBar, ac.currentTime + 0.02);
      for (const e of bar.events) {
        const t = t0 + e.t;
        switch (e.type) {
          case 'pad':
            pad(kit, p.gain, t, e.midi, { dur: e.dur, vel: e.vel, attack: Math.min(1.8, e.dur * 0.35), release: 3, cutoff: 1250 });
            break;
          case 'drone':
            drone(kit, p.gain, t, e.midi, { dur: e.dur, vel: e.vel });
            break;
          case 'pluck':
            pluck(kit, p.gain, t, e.midi, { vel: e.vel, decay: e.dur, bright: 0.85, pan: (Math.random() - 0.5) * 0.5 });
            break;
          case 'whistle':
            whistle(kit, p.gain, t, e.midi, { dur: e.dur, vel: e.vel });
            break;
          default:
            break;
        }
      }
      p.nextBar += bar.duration;
      barsPlayed++;
    }
    if (p.composer.done && !p.ended) {
      p.ended = true;
      // The final bar's tails ring out, then the gain fades.
      const t = Math.max(ac.currentTime, p.nextBar);
      p.gain.gain.setTargetAtTime(0, t + 1, p.mood.fadeOut / 4);
      fading.push({ gain: p.gain, until: t + p.mood.fadeOut + 8 });
      p.stopAt = t + 2;
    }
  }

  return {
    get cue() {
      return piece?.name ?? null;
    },
    get bar() {
      return piece?.composer.bar ?? 0;
    },
    // True once a finite piece has played through (the director then stops asking for it).
    get finished() {
      return !!piece?.ended && ac.currentTime > (piece.stopAt ?? 0);
    },
    setCue(name) {
      if ((piece?.name ?? null) === (name ?? null)) return;
      if (piece && !piece.ended) fadeOut(piece, piece.mood.fadeOut);
      piece = name ? startPiece(name) : null;
    },
    tick() {
      if (piece && !piece.ended) schedule(piece);
      for (let i = fading.length - 1; i >= 0; i--) {
        if (ac.currentTime > fading[i].until) {
          try {
            fading[i].gain.disconnect();
          } catch {
            // already gone
          }
          fading.splice(i, 1);
        }
      }
    },
    stop(seconds = 1.5) {
      if (piece) fadeOut(piece, seconds);
      piece = null;
    },
    stats() {
      return { cue: piece?.name ?? null, bar: piece?.composer.bar ?? 0, ended: !!piece?.ended, fading: fading.length, barsPlayed };
    },
  };
}
