// Musical voices shared by the generative music and the feedback stingers. Each schedules itself at `t` into `dest`
// and returns the time it ends (all its sources are stopped by then).

import { midiToHz } from './params.js';

// Warm pad: two detuned soft saws per note under a slowly opening low-pass.
export function pad(kit, dest, t, midis, { dur = 4, vel = 0.5, attack = 1.4, release = 2.4, cutoff = 1300, detune = 7 } = {}) {
  const end = t + dur + release;
  const lp = kit.filter('lowpass', cutoff * 0.5, 0.35);
  lp.frequency.setValueAtTime(cutoff * 0.45, t);
  lp.frequency.linearRampToValueAtTime(cutoff, t + attack * 1.6);
  lp.frequency.setTargetAtTime(cutoff * 0.55, t + dur, release / 3);
  const env = kit.gain(0);
  const per = 1 / Math.sqrt(midis.length * 2);
  for (const m of midis) {
    const f = midiToHz(m);
    for (const d of [-detune, detune]) {
      const o = kit.osc('pad', f, t, end + 0.05);
      o.detune.value = d + (Math.random() - 0.5) * 3;
      const g = kit.gain(per * (m < 48 ? 0.8 : 1));
      kit.chain(o, g, lp);
    }
  }
  kit.chain(lp, env, dest);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(vel * 0.22, t + attack);
  env.gain.setValueAtTime(vel * 0.22, t + Math.max(attack, dur));
  env.gain.setTargetAtTime(0, t + Math.max(attack, dur), release / 5);
  return end + 0.05;
}

// Plucked string (koto/harp-like): harmonic-rich wave with a closing filter and an exponential decay.
export function pluck(kit, dest, t, midi, { vel = 0.5, decay = 1.6, bright = 1, pan = 0 } = {}) {
  const f = midiToHz(midi);
  const end = t + decay + 0.05;
  const o = kit.osc('string', f, t, end);
  const o2 = kit.osc('sine', f * 2, t, end);
  o2.detune.value = 4;
  const g2 = kit.gain(0.08);
  const lp = kit.filter('lowpass', Math.min(15000, f * 12 * bright), 0.9);
  lp.frequency.setValueAtTime(Math.min(15000, f * 12 * bright), t);
  lp.frequency.setTargetAtTime(Math.max(300, f * 2.4), t + 0.005, 0.16 + 0.1 * bright);
  const env = kit.gain(0);
  kit.perc(env.gain, t, 0.003, vel * 0.32, decay);
  kit.chain(o, lp);
  kit.chain(o2, g2, lp);
  kit.chain(lp, env, kit.pan(pan), dest);
  return end;
}

// Tin whistle: breathy sine with a delayed vibrato and an occasional "cut" grace note from above.
export function whistle(kit, dest, t, midi, { dur = 1, vel = 0.3, cut = Math.random() < 0.3 } = {}) {
  const f = midiToHz(midi);
  const end = t + dur + 0.2;
  const o = kit.osc('sine', f, t, end);
  const o2 = kit.osc('triangle', f * 2, t, end);
  if (cut) {
    o.frequency.setValueAtTime(f * 1.12, t);
    o.frequency.setValueAtTime(f, t + 0.045);
    o2.frequency.setValueAtTime(f * 2.24, t);
    o2.frequency.setValueAtTime(f * 2, t + 0.045);
  }
  const lfo = kit.osc('sine', 5.2 + Math.random() * 0.6, t, end);
  const depth = kit.gain(0);
  depth.gain.setValueAtTime(0, t);
  depth.gain.linearRampToValueAtTime(0, t + Math.min(0.35, dur * 0.4));
  depth.gain.linearRampToValueAtTime(f * 0.011, t + Math.min(0.8, dur * 0.8));
  kit.chain(lfo, depth, o.frequency);
  const g2 = kit.gain(0.05);
  const breath = kit.noise('white', t, end);
  const bp = kit.filter('bandpass', f, 9);
  const bg = kit.gain(0.12);
  const env = kit.gain(0);
  kit.ahr(env.gain, t, 0.05, vel * 0.2, Math.max(0.05, dur - 0.05), 0.15);
  kit.chain(o, env);
  kit.chain(o2, g2, env);
  kit.chain(breath, bp, bg, env);
  env.connect(dest);
  return end;
}

// Soft drone: triangle + octave sine through a dark filter, breathing slowly.
export function drone(kit, dest, t, midis, { dur = 20, vel = 0.5, attack = 3.5, release = 3.5 } = {}) {
  const end = t + dur + release;
  const lp = kit.filter('lowpass', 520, 0.5);
  const trem = kit.gain(1);
  const lfo = kit.osc('sine', 0.13 + Math.random() * 0.05, t, end);
  const lfoDepth = kit.gain(0.18);
  kit.chain(lfo, lfoDepth, trem.gain);
  for (const m of midis) {
    const f = midiToHz(m);
    const a = kit.osc('triangle', f, t, end);
    const b = kit.osc('sine', f * 2, t, end);
    b.detune.value = 3;
    const gb = kit.gain(0.25);
    kit.chain(a, lp);
    kit.chain(b, gb, lp);
  }
  const env = kit.gain(0);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(vel * 0.16, t + attack);
  env.gain.setValueAtTime(vel * 0.16, t + Math.max(attack, dur));
  env.gain.setTargetAtTime(0, t + Math.max(attack, dur), release / 5);
  kit.chain(lp, trem, env, dest);
  return end;
}

// FM bell (cash register, shimmer): inharmonic modulator ratio, index decaying faster than the tone.
export function bell(kit, dest, t, freq, { vel = 0.3, decay = 1.4, ratio = 1.41, index = 2.2, pan = 0 } = {}) {
  const end = t + decay + 0.05;
  const car = kit.osc('sine', freq, t, end);
  const mod = kit.osc('sine', freq * ratio, t, end);
  const idx = kit.gain(0);
  idx.gain.setValueAtTime(freq * ratio * index, t);
  idx.gain.setTargetAtTime(freq * ratio * index * 0.08, t, decay / 5);
  kit.chain(mod, idx, car.frequency);
  const env = kit.gain(0);
  kit.perc(env.gain, t, 0.002, vel, decay);
  kit.chain(car, env, kit.pan(pan), dest);
  return end;
}
