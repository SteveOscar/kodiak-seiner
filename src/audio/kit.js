// Context-bound building blocks shared by every recipe: procedural noise/texture buffers (generated once per sample
// rate and reused by every source), periodic waves, the reverb impulse, and terse node helpers. Works with an
// AudioContext or an OfflineAudioContext (QA renders).

import {
  rand,
  fillWhite,
  fillPink,
  fillBrown,
  fillDrops,
  seamless,
  normalize,
  removeDC,
  impulseResponse,
  dieselCycle,
  harmonicsOf,
  stringHarmonics,
  padHarmonics,
  softClipCurve,
  gritCurve,
} from './dsp.js';

const shared = new Map(); // sampleRate → { buffers data, waves data }

function makeBuffer(ac, channels) {
  const buf = ac.createBuffer(channels.length, channels[0].length, ac.sampleRate);
  channels.forEach((ch, i) => buf.copyToChannel ? buf.copyToChannel(ch, i) : buf.getChannelData(i).set(ch));
  return buf;
}

// Raw sample data, generated once per sample rate (~1.5 M samples, ~20 ms).
function sharedData(sr) {
  if (shared.has(sr)) return shared.get(sr);
  const r = rand(1985);
  const xf = Math.floor(sr * 0.08);
  const gen = (seconds, fill, peak = 0.9) => {
    const a = new Float32Array(Math.floor(seconds * sr) + xf);
    fill(a, r);
    removeDC(a);
    return normalize(seamless(a, xf), peak);
  };
  const drops = (seconds, opts) => {
    const a = new Float32Array(Math.floor(seconds * sr));
    fillDrops(a, sr, r, opts);
    return normalize(a, 0.9);
  };
  const data = {
    white: [gen(2.1, fillWhite)],
    pink: [gen(5.3, fillPink)],
    brown: [gen(6.7, fillBrown)],
    pinkStereo: [gen(7.3, fillPink), gen(7.3, fillPink)],
    brownStereo: [gen(8.9, fillBrown), gen(8.9, fillBrown)],
    rain: [drops(3.7, { rate: 900 }), drops(3.7, { rate: 900 })],
    pebbles: [drops(2.9, { rate: 260, fMin: 2500, fMax: 7000, dMin: 0.001, dMax: 0.003 })],
    crackle: [drops(2.3, { rate: 70, fMin: 1500, fMax: 5000, dMin: 0.0005, dMax: 0.002 })],
    ir: impulseResponse(sr, 3.4, r, { decay: 3.0, predelay: 0.018, bright: 0.7, dark: 0.08 }),
    irSmall: impulseResponse(sr, 1.2, r, { decay: 0.9, predelay: 0.006, bright: 0.8, dark: 0.2 }),
    waves: {
      diesel: harmonicsOf(dieselCycle(4096, { pulses: 6, rnd: rand(58), jitter: 0.02, spread: 0.2, ring: 5.5 }), 220),
      dieselSkiff: harmonicsOf(dieselCycle(4096, { pulses: 6, rnd: rand(22), jitter: 0.012, spread: 0.12, ring: 7, width: 0.35 }), 220),
      dieselFleet: harmonicsOf(dieselCycle(4096, { pulses: 6, rnd: rand(91), jitter: 0.025, spread: 0.25, ring: 5 }), 200),
      string: stringHarmonics(40, { pos: 0.17, bright: 0.93 }),
      pad: padHarmonics(28),
    },
    softClip: softClipCurve(2048, 0.8, 0.985),
    grit: gritCurve(1024, 3),
  };
  shared.set(sr, data);
  return data;
}

export function createKit(ac) {
  const d = sharedData(ac.sampleRate);
  const buf = {};
  for (const k of ['white', 'pink', 'brown', 'pinkStereo', 'brownStereo', 'rain', 'pebbles', 'crackle', 'ir', 'irSmall']) buf[k] = makeBuffer(ac, d[k]);
  const waves = {};
  for (const [k, w] of Object.entries(d.waves)) waves[k] = ac.createPeriodicWave(w.real, w.imag, { disableNormalization: false });

  const kit = {
    ac,
    buf,
    waves,
    curves: { softClip: d.softClip, grit: d.grit },
    rnd: Math.random,

    gain(v = 0) {
      const g = ac.createGain();
      g.gain.value = v;
      return g;
    },
    filter(type, freq, Q = 0.707, gainDb = 0) {
      const f = ac.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = Q;
      if (gainDb) f.gain.value = gainDb;
      return f;
    },
    osc(type, freq, t, stop) {
      const o = ac.createOscillator();
      if (type in waves) o.setPeriodicWave(waves[type]);
      else o.type = type;
      o.frequency.value = freq;
      o.start(t);
      if (stop !== undefined) o.stop(stop);
      return o;
    },
    // Looping buffer source started at a random offset.
    noise(name, t, stop, { rate = 1, loop = true, offset } = {}) {
      const s = ac.createBufferSource();
      s.buffer = buf[name];
      s.loop = loop;
      s.playbackRate.value = rate;
      const off = offset ?? Math.random() * s.buffer.duration * 0.9;
      s.start(t, off);
      if (stop !== undefined) s.stop(stop);
      return s;
    },
    pan(v = 0) {
      if (ac.createStereoPanner) {
        const p = ac.createStereoPanner();
        p.pan.value = Math.max(-1, Math.min(1, v));
        return p;
      }
      return kit.gain(1);
    },
    shaper(curve) {
      const w = ac.createWaveShaper();
      w.curve = curve;
      return w;
    },
    // Connects a → b → c …; returns the last node.
    chain(...nodes) {
      for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
      return nodes[nodes.length - 1];
    },
    // Percussive envelope on a gain param: linear attack to `peak`, exponential decay (to −60 dB after `decay` s).
    perc(param, t, attack, peak, decay) {
      param.setValueAtTime(0, t);
      param.linearRampToValueAtTime(peak, t + Math.max(0.0005, attack));
      param.setTargetAtTime(0, t + attack, Math.max(0.001, decay / 6.9));
      return t + attack + decay;
    },
    // Attack / hold / release envelope.
    ahr(param, t, attack, peak, hold, release) {
      param.setValueAtTime(0, t);
      param.linearRampToValueAtTime(peak, t + Math.max(0.001, attack));
      param.setValueAtTime(peak, t + attack + hold);
      param.setTargetAtTime(0, t + attack + hold, Math.max(0.002, release / 5));
      return t + attack + hold + release;
    },
    // Random value curve (0..1 scaled into [lo, hi]) for jittery scrapes and gusts.
    jitter(param, t, dur, lo, hi, points = 24) {
      const c = new Float32Array(points);
      for (let i = 0; i < points; i++) c[i] = lo + (hi - lo) * Math.random();
      c[0] = lo;
      c[points - 1] = 0;
      param.setValueCurveAtTime(c, t, Math.max(0.01, dur));
    },
  };
  return kit;
}
