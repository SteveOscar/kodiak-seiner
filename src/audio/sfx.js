// One-shot recipes. Each is (kit, out, t, p) → end time: it schedules its sources at audio time `t` into `out` and
// stops every source it created by the returned time. `p.rate` (default 1) scales pitch where it makes sense.
// Positioning, distance, voice limits and volume are the caller's job (see engine.js).

import { pad, pluck, bell } from './instruments.js';
import { footstepRecipe, gullCall, radioTiming, splashPlan, stingerFor, discoveryChord, TUNING, clamp } from './params.js';

const rr = (a, b) => a + (b - a) * Math.random();
const rate = (p) => (p && p.rate > 0 ? p.rate : 1);

// ------------------------------------------------------------------------------------------------------- water

// One water impact from a splash plan: band-passed body, spray hiss, an optional flat slap, bubble blips and spray
// droplets falling back.
export function waterHit(kit, out, t, h, k = 1) {
  const s = h.strength;
  const dec = Math.max(0.03, h.decay);
  const end = t + dec + 0.45;
  const n = kit.noise('white', t, end);
  const bp = kit.filter('bandpass', h.bodyHz * k * 1.3, 0.9);
  bp.frequency.setValueAtTime(h.bodyHz * k * 1.3, t);
  bp.frequency.exponentialRampToValueAtTime(Math.max(80, h.bodyHz * k * 0.55), t + dec);
  const g = kit.gain(0);
  kit.perc(g.gain, t, 0.003, s * 0.62, dec);
  kit.chain(n, bp, g, out);
  const hp = kit.filter('highpass', 3800, 0.7);
  const g2 = kit.gain(0);
  kit.perc(g2.gain, t, 0.002, s * 0.18, dec * 0.7);
  n.connect(hp);
  kit.chain(hp, g2, out);
  if (h.slap > 0) {
    // A body landing flat: a hollow thump (not for the skittering tail-walk) and a wet crack.
    if (h.kind !== 'walk') {
      const th = kit.osc('sine', 150 * k, t, t + 0.3);
      th.frequency.exponentialRampToValueAtTime(62 * k, t + 0.12);
      const tg = kit.gain(0);
      kit.perc(tg.gain, t, 0.002, s * h.slap * 0.45, 0.16);
      kit.chain(th, tg, out);
    }
    const lp = kit.filter('lowpass', 1500, 0.7);
    const cg = kit.gain(0);
    kit.perc(cg.gain, t, 0.0008, s * h.slap * 0.7, 0.06);
    n.connect(lp);
    kit.chain(lp, cg, out);
  }
  for (let i = 0; i < h.bubbles; i++) {
    const bt = t + 0.015 + Math.random() * dec * 0.9;
    const f0 = rr(520, 1250) * k * (h.bodyHz < 900 ? 0.65 : 1);
    const o = kit.osc('sine', f0, bt, bt + 0.1);
    o.frequency.exponentialRampToValueAtTime(f0 * 1.8, bt + 0.07);
    const bg = kit.gain(0);
    kit.perc(bg.gain, bt, 0.002, s * 0.16, 0.08);
    kit.chain(o, bg, out);
  }
  if (h.kind !== 'walk') {
    const d = kit.noise('rain', t + 0.07, end, { rate: 1.15 });
    const dh = kit.filter('highpass', 1800);
    const dg = kit.gain(0);
    kit.perc(dg.gain, t + 0.07, 0.03, s * 0.18, clamp(dec * 3, 0.15, 0.4));
    kit.chain(d, dh, dg, out);
  }
  return end;
}

// A fish jump: p = { species, size, style } (the fish:jump payload) or p.plan (a precomputed splashPlan).
export function fishJump(kit, out, t, p) {
  const plan = p.plan ?? splashPlan(p);
  const k = rate(p);
  let end = t;
  for (const h of plan) end = Math.max(end, waterHit(kit, out, t + h.t, h, k));
  return end;
}

// A generic splash: p.size 0.3 (drop) .. 3 (skiff hitting the water).
export function splash(kit, out, t, p) {
  const size = clamp(p.size ?? 1, 0.2, 4);
  const h = { t: 0, kind: 'entry', strength: clamp(0.35 + 0.3 * size, 0.2, 1.2), bodyHz: 1500 / Math.sqrt(size), decay: 0.08 + 0.12 * size, slap: size > 1.5 ? 0.7 : 0.15, bubbles: Math.round(1 + size) };
  let end = waterHit(kit, out, t, h, rate(p));
  if (size > 1.5) {
    // Big displacement: a slosh that rolls on after the hit.
    const n = kit.noise('pinkStereo', t, t + 1.6);
    const bp = kit.filter('bandpass', 700, 0.7);
    bp.frequency.setValueAtTime(1100, t);
    bp.frequency.exponentialRampToValueAtTime(420, t + 1.2);
    const g = kit.gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.35 * size * 0.4, t + 0.12);
    g.gain.setTargetAtTime(0, t + 0.2, 0.3);
    kit.chain(n, bp, g, out);
    end = Math.max(end, t + 1.6);
  }
  return end;
}

// A breaking wave on the beach: rising curl, the crash, the foam hiss running up and a pebble backwash.
// p = { level, gravel 0..1 }
export function surfBreak(kit, out, t, p) {
  const L = p.level ?? 0.5;
  const g0 = clamp(p.gravel ?? 0.5, 0, 1);
  const crash = t + rr(0.8, 1.3);
  const end = t + 7;
  const n = kit.noise('pinkStereo', t, end, { rate: rr(0.9, 1.1) });
  const bp = kit.filter('bandpass', 380, 0.5);
  bp.frequency.setValueAtTime(380, t);
  bp.frequency.exponentialRampToValueAtTime(2200, crash);
  bp.frequency.exponentialRampToValueAtTime(850, crash + 3);
  const g = kit.gain(0);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(L * 0.2, crash - 0.3);
  g.gain.linearRampToValueAtTime(L, crash);
  g.gain.setTargetAtTime(L * 0.4, crash + 0.05, 0.45);
  g.gain.setTargetAtTime(0, crash + 1.6, 1.1);
  kit.chain(n, bp, g, out);
  const b = kit.noise('brownStereo', crash - 0.05, crash + 1.5);
  const lp = kit.filter('lowpass', 320, 0.7);
  const bg = kit.gain(0);
  kit.perc(bg.gain, crash - 0.02, 0.03, L * 0.6, 1.1);
  kit.chain(b, lp, bg, out);
  if (g0 > 0.05) {
    const pb = kit.noise('pebbles', crash + 1.2, end, { rate: rr(0.85, 1.15) });
    const pf = kit.filter('bandpass', 3800, 0.6);
    const pg = kit.gain(0);
    pg.gain.setValueAtTime(0, crash + 1.2);
    pg.gain.linearRampToValueAtTime(L * g0 * 0.9, crash + 2.1);
    pg.gain.setTargetAtTime(0, crash + 2.4, 0.8);
    kit.chain(pb, pf, pg, out);
  }
  return end;
}

// Waves slapping the hull. p = { strength, soft (lapping at anchor) }
export function hullSlap(kit, out, t, p) {
  const s = clamp(p.strength ?? 0.5, 0.05, 1.2);
  const soft = !!p.soft;
  const end = t + 0.9;
  const n = kit.noise('pink', t, end);
  const lp = kit.filter('lowpass', soft ? 650 : 400, 0.9);
  const g = kit.gain(0);
  kit.perc(g.gain, t, 0.004, s * 0.9, soft ? 0.14 : 0.22);
  kit.chain(n, lp, g, out);
  const bp = kit.filter('bandpass', soft ? 1900 : 1300, 1.1);
  const g2 = kit.gain(0);
  kit.perc(g2.gain, t, 0.001, s * (soft ? 0.3 : 0.45), 0.04);
  n.connect(bp);
  kit.chain(bp, g2, out);
  const sl = kit.filter('bandpass', 850, 0.8);
  const g3 = kit.gain(0);
  g3.gain.setValueAtTime(0, t);
  g3.gain.linearRampToValueAtTime(s * 0.22, t + 0.08);
  g3.gain.setTargetAtTime(0, t + 0.1, 0.14);
  n.connect(sl);
  kit.chain(sl, g3, out);
  if (!soft) {
    const o = kit.osc('sine', 88 * rate(p), t, t + 0.3);
    const og = kit.gain(0);
    kit.perc(og.gain, t, 0.003, s * 0.45, 0.16);
    kit.chain(o, og, out);
  }
  return end;
}

// ------------------------------------------------------------------------------------------------------- birds

// Glaucous-winged gull: raspy "kyow" notes — a saw with a yelping rise-and-fall contour, a little FM rasp and
// beak/throat formants; each note swells fast and fades as the pitch drops. p = { call: gullCall(), excited }
export function gull(kit, out, t, p) {
  const c = p.call ?? gullCall(Math.random, !!p.excited);
  const P = c.pitch * rate(p);
  const hp = kit.filter('highpass', 700, 0.7);
  const f1 = kit.filter('peaking', 2400, 2.5, 8);
  const f2 = kit.filter('peaking', 3700, 3, 5);
  const lp = kit.filter('lowpass', 7500, 0.7);
  kit.chain(hp, f1, f2, lp, out);
  let tt = t;
  let end = t;
  const note = (dur, c0, c1, c2, pk, vel, rasp) => {
    const e = tt + dur + 0.07;
    const car = kit.osc('sawtooth', P * c0, tt, e);
    car.frequency.setValueAtTime(P * c0, tt);
    car.frequency.exponentialRampToValueAtTime(P * c1, tt + dur * pk);
    car.frequency.exponentialRampToValueAtTime(P * c2, tt + dur);
    const mod = kit.osc('sine', rr(55, 85), tt, e);
    const dev = kit.gain(P * rasp * 0.45);
    kit.chain(mod, dev, car.frequency);
    // A soft second voice a fifth down: the syrinx's two sides beating against each other.
    const sub = kit.osc('triangle', P * c0 * 0.667, tt, e);
    sub.frequency.setValueAtTime(P * c0 * 0.667, tt);
    sub.frequency.exponentialRampToValueAtTime(P * c1 * 0.667, tt + dur * pk);
    sub.frequency.exponentialRampToValueAtTime(P * c2 * 0.667, tt + dur);
    const sg = kit.gain(0.18);
    const env = kit.gain(0);
    env.gain.setValueAtTime(0, tt);
    env.gain.linearRampToValueAtTime(vel, tt + Math.min(0.012, dur * 0.2));
    env.gain.setTargetAtTime(vel * 0.7, tt + 0.015, dur * 0.35);
    env.gain.setTargetAtTime(0, tt + dur * 0.72, dur * 0.07);
    kit.chain(car, env, hp);
    kit.chain(sub, sg, env);
    end = Math.max(end, e);
  };
  if (c.type === 'long') {
    note(0.34, 0.88, 1.28, 0.74, 0.3, 0.26, c.rasp);
    tt += 0.34 + rr(0.08, 0.13);
    for (let i = 1; i < c.notes; i++) {
      const d = Math.max(0.12, 0.2 - i * 0.012);
      const k = 1 - i * 0.025;
      note(d, 0.95 * k, 1.2 * k, 0.8 * k, 0.28, 0.23 * (1 - i * 0.06), c.rasp);
      tt += d + rr(0.06, 0.11);
    }
  } else if (c.type === 'kek') {
    for (let i = 0; i < c.notes; i++) {
      note(0.07, 0.96, 1.1, 0.9, 0.35, 0.2 * (1 - i * 0.05), c.rasp * 1.3);
      tt += 0.07 + rr(0.045, 0.075);
    }
  } else {
    // Mew: one plaintive, drawn-out descending note.
    note(0.58, 1.1, 1.32, 0.72, 0.16, 0.2, c.rasp * 0.6);
  }
  return end;
}

// Bald eagle: thin, high "kleee" then a chittering run of "kik-ik-ik" notes (surprisingly feeble for the bird).
export function eagle(kit, out, t, p) {
  const P = rr(2850, 3300) * rate(p);
  const hp = kit.filter('highpass', 1500, 0.7);
  hp.connect(out);
  let tt = t;
  let end = t;
  const note = (dur, c0, c1, vel) => {
    const e = tt + dur * 2.6 + 0.02;
    const a = kit.osc('sine', P * c0, tt, e);
    const b = kit.osc('triangle', P * c0, tt, e);
    for (const o of [a, b]) {
      o.frequency.setValueAtTime(P * c0, tt);
      o.frequency.linearRampToValueAtTime(P * c1, tt + dur);
    }
    const mod = kit.osc('sine', 34, tt, e);
    const dev = kit.gain(70);
    mod.connect(dev);
    dev.connect(a.frequency);
    dev.connect(b.frequency);
    const bg = kit.gain(0.3);
    const env = kit.gain(0);
    env.gain.setValueAtTime(0, tt);
    env.gain.linearRampToValueAtTime(vel, tt + 0.01);
    env.gain.setTargetAtTime(0, tt + dur * 0.6, dur * 0.25);
    a.connect(env);
    kit.chain(b, bg, env);
    env.connect(hp);
    end = Math.max(end, e);
  };
  note(0.2, 0.86, 1.04, 0.12);
  tt += 0.28;
  const n = 4 + Math.floor(Math.random() * 4);
  for (let i = 0; i < n; i++) {
    note(0.05, 1.03 - i * 0.02, 0.96 - i * 0.02, 0.1 * (1 - i * 0.06));
    tt += rr(0.085, 0.11);
  }
  return end;
}

// ------------------------------------------------------------------------------------------------ big animals

// Humpback blow: the explosive exhale ("pfoosh") with a chest resonance and spray falling back, then the inhale.
export function whaleBlow(kit, out, t, p) {
  const s = clamp(p.strength ?? 1, 0.2, 1.5);
  const n = kit.noise('pink', t, t + 3.2);
  const lp = kit.filter('lowpass', 2600, 0.6);
  lp.frequency.setValueAtTime(2800, t);
  lp.frequency.exponentialRampToValueAtTime(650, t + 1.6);
  const g = kit.gain(0);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(s * 0.75, t + 0.06);
  g.gain.setTargetAtTime(s * 0.32, t + 0.08, 0.22);
  g.gain.setTargetAtTime(0, t + 0.75, 0.35);
  kit.chain(n, lp, g, out);
  const bp = kit.filter('bandpass', 170, 1.3);
  const g2 = kit.gain(0);
  kit.perc(g2.gain, t, 0.04, s * 1.1, 1.2);
  n.connect(bp);
  kit.chain(bp, g2, out);
  const w = kit.osc('sine', 72, t, t + 0.7);
  w.frequency.exponentialRampToValueAtTime(42, t + 0.45);
  const wg = kit.gain(0);
  kit.perc(wg.gain, t, 0.01, s * 0.45, 0.45);
  kit.chain(w, wg, out);
  const sp = kit.noise('rain', t + 0.35, t + 2.2);
  const sh = kit.filter('highpass', 1500);
  const sg = kit.gain(0);
  kit.perc(sg.gain, t + 0.35, 0.25, s * 0.12, 1.4);
  kit.chain(sp, sh, sg, out);
  const ti = t + rr(1.8, 2.3);
  const n2 = kit.noise('pink', ti, ti + 1);
  const ib = kit.filter('bandpass', 1100, 1.2);
  const ig = kit.gain(0);
  ig.gain.setValueAtTime(0, ti);
  ig.gain.linearRampToValueAtTime(s * 0.26, ti + 0.24);
  ig.gain.setTargetAtTime(0, ti + 0.3, 0.1);
  kit.chain(n2, ib, ig, out);
  return Math.max(ti + 1, t + 3.2);
}

// A breach: the crash of 30 tonnes landing, a long roar of white water.
export function breach(kit, out, t, p) {
  const s = clamp(p.strength ?? 1, 0.3, 1.5);
  let end = splash(kit, out, t, { size: 3.5 });
  const n = kit.noise('brownStereo', t, t + 3.5);
  const lp = kit.filter('lowpass', 600, 0.6);
  const g = kit.gain(0);
  kit.perc(g.gain, t, 0.02, s * 0.9, 2.6);
  kit.chain(n, lp, g, out);
  end = Math.max(end, t + 3.5);
  return end;
}

// Brown bear huffs and jaw pops. p = { huffs, intensity, pops }
export function bearHuff(kit, out, t, p) {
  const I = clamp(p.intensity ?? 0.7, 0.1, 1.3);
  const huffs = p.huffs ?? 2 + Math.floor(Math.random() * 2);
  let tt = t;
  for (let i = 0; i < huffs; i++) {
    const e = tt + 0.5;
    const b = kit.noise('brown', tt, e);
    const bp = kit.filter('bandpass', rr(270, 340), 1.3);
    const lp = kit.filter('lowpass', 1400, 0.7);
    const g = kit.gain(0);
    kit.perc(g.gain, tt, 0.015, I * 0.9, 0.3);
    kit.chain(b, bp, lp, g, out);
    const w = kit.noise('pink', tt, e);
    const wb = kit.filter('bandpass', 1100, 2);
    const wg = kit.gain(0);
    kit.perc(wg.gain, tt, 0.01, I * 0.2, 0.15);
    kit.chain(w, wb, wg, out);
    tt += rr(0.32, 0.45);
  }
  const pops = p.pops ?? (I > 0.6 ? 3 : 0);
  if (pops) {
    const src = kit.noise('white', tt, tt + pops * 0.13 + 0.1);
    for (let i = 0; i < pops; i++) {
      const bp = kit.filter('bandpass', 1900, 4);
      const g = kit.gain(0);
      kit.perc(g.gain, tt + i * 0.12, 0.0008, I * 0.55, 0.02);
      src.connect(bp);
      kit.chain(bp, g, out);
    }
    tt += pops * 0.13;
  }
  return tt + 0.3;
}

// Bluff charge: paws thudding faster and faster across gravel, then a loud woof and jaw pops.
export function bearCharge(kit, out, t, p) {
  let tt = t;
  const gravel = kit.noise('white', t, t + 2.4);
  for (let i = 0; i < 7; i++) {
    const o = kit.osc('sine', 62, tt, tt + 0.25);
    const g = kit.gain(0);
    kit.perc(g.gain, tt, 0.004, 0.7, 0.16);
    kit.chain(o, g, out);
    const bp = kit.filter('bandpass', 2600, 1.2);
    const gg = kit.gain(0);
    kit.perc(gg.gain, tt, 0.002, 0.18, 0.06);
    gravel.connect(bp);
    kit.chain(bp, gg, out);
    tt += Math.max(0.15, 0.3 - i * 0.025);
  }
  const saw = kit.osc('sawtooth', 92, tt, tt + 0.6);
  saw.frequency.exponentialRampToValueAtTime(70, tt + 0.4);
  const lp = kit.filter('lowpass', 650, 0.8);
  const sg = kit.gain(0);
  kit.perc(sg.gain, tt, 0.02, 0.45, 0.4);
  kit.chain(saw, lp, sg, out);
  return bearHuff(kit, out, tt, { huffs: 2, intensity: 1.1, pops: 3 });
}

// Steller sea lion: a deep, rough, lion-like roar (bulls) or a higher belching bark (cows, juveniles). A glottal saw
// with a rise-and-fall contour, pulsed by a fast square (the growl), through two throat formants. p = { bull }
export function sealion(kit, out, t, p) {
  const bull = !!p.bull;
  const f0 = (bull ? rr(78, 104) : rr(125, 185)) * rate(p);
  const dur = bull ? rr(0.9, 1.7) : rr(0.35, 0.9);
  const end = t + dur + 0.35;
  const src = kit.osc('sawtooth', f0, t, end);
  src.frequency.setValueAtTime(f0 * 0.82, t);
  src.frequency.linearRampToValueAtTime(f0 * 1.1, t + dur * 0.3);
  src.frequency.linearRampToValueAtTime(f0 * 0.78, t + dur);
  const am = kit.gain(0.5);
  const lfo = kit.osc('square', rr(24, 36), t, end);
  const ld = kit.gain(bull ? 0.5 : 0.35);
  kit.chain(lfo, ld, am.gain);
  const f1 = kit.filter('bandpass', bull ? 420 : 620, 2.5);
  const f2 = kit.filter('bandpass', bull ? 1050 : 1450, 3.5);
  const g2 = kit.gain(0.5);
  const lp = kit.filter('lowpass', 2400, 0.7);
  const env = kit.gain(0);
  kit.ahr(env.gain, t, bull ? 0.09 : 0.04, bull ? 0.9 : 0.7, Math.max(0.05, dur - 0.2), 0.25);
  kit.chain(src, am);
  am.connect(f1);
  kit.chain(am, f2, g2);
  f1.connect(lp);
  g2.connect(lp);
  kit.chain(lp, env, out);
  const br = kit.noise('pink', t, end);
  const bb = kit.filter('bandpass', 700, 1.2);
  const bg = kit.gain(0);
  kit.ahr(bg.gain, t, 0.05, 0.12, Math.max(0.05, dur - 0.15), 0.2);
  kit.chain(br, bb, bg, out);
  return end;
}

// A school spooked at the surface: a rushing boil of small splashes as it dives. p = { size }
export function boil(kit, out, t, p) {
  const s = clamp(p.size ?? 1, 0.3, 2);
  const dur = 1.1 + 0.5 * s;
  const end = t + dur + 0.3;
  const n = kit.noise('rain', t, end, { rate: 0.7 });
  const bp = kit.filter('bandpass', 1500, 0.7);
  const g = kit.gain(0);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.5 * s, t + 0.12);
  g.gain.setTargetAtTime(0, t + 0.3, dur / 3);
  kit.chain(n, bp, g, out);
  const k = 2 + Math.round(3 * s);
  let e = end;
  for (let i = 0; i < k; i++) {
    const tt = t + Math.random() * dur * 0.6;
    e = Math.max(e, waterHit(kit, out, tt, { kind: 'entry', strength: 0.18 + 0.12 * Math.random(), bodyHz: 1500 + 500 * Math.random(), decay: 0.07, slap: 0.1, bubbles: 1 }));
  }
  return e;
}

// A heavy steel clunk: a winch clutch dropping in, the skiff end made fast, a shackle on the rail.
export function clunk(kit, out, t, p) {
  const k = rate(p);
  const s = clamp(p.strength ?? 0.6, 0.1, 1.2);
  for (const [f, a, d] of [[210, 0.45, 0.25], [575, 0.2, 0.18], [1340, 0.08, 0.1]]) {
    const o = kit.osc('sine', f * k, t, t + d + 0.05);
    const g = kit.gain(0);
    kit.perc(g.gain, t, 0.001, a * s, d);
    kit.chain(o, g, out);
  }
  const n = kit.noise('white', t, t + 0.12);
  const bp = kit.filter('bandpass', 1800, 1.4);
  const ng = kit.gain(0);
  kit.perc(ng.gain, t, 0.0005, 0.25 * s, 0.03);
  kit.chain(n, bp, ng, out);
  if (p.hiss) {
    const h = kit.noise('white', t + 0.05, t + 0.9);
    const hb = kit.filter('bandpass', 3000, 0.9);
    const hg = kit.gain(0);
    kit.ahr(hg.gain, t + 0.05, 0.05, 0.06 * s, 0.3, 0.3);
    kit.chain(h, hb, hg, out);
    return t + 0.95;
  }
  return t + 0.35;
}

// ------------------------------------------------------------------------------------------------- footsteps

export function footstep(kit, out, t, p) {
  const r = footstepRecipe(p.surface, p.run);
  const k = rate(p);
  const G = r.gain;
  const end = t + 0.4;
  const th = kit.osc('sine', r.thudHz * k, t, t + 0.15);
  th.frequency.exponentialRampToValueAtTime(r.thudHz * k * 0.65, t + 0.06);
  const tg = kit.gain(0);
  kit.perc(tg.gain, t, 0.003, r.thud * G, 0.08);
  kit.chain(th, tg, out);
  const src = kit.noise('white', t, end);
  const body = kit.filter('lowpass', 420, 0.7);
  const bg = kit.gain(0);
  kit.perc(bg.gain, t, 0.004, r.thud * G * 0.5, 0.06);
  src.connect(body);
  kit.chain(body, bg, out);
  for (let i = 0; i < r.grains; i++) {
    const gt = t + Math.random() * r.spread;
    const bp = kit.filter('bandpass', r.grainHz * rr(0.7, 1.3) * k, r.grainQ);
    const g = kit.gain(0);
    kit.perc(g.gain, gt, 0.0008, r.grain * G * rr(0.4, 1), rr(0.008, 0.028));
    src.connect(bp);
    kit.chain(bp, g, out);
  }
  if (r.swish > 0) {
    const bp = kit.filter('bandpass', r.swishHz, 0.8);
    const g = kit.gain(0);
    kit.perc(g.gain, t, 0.02, r.swish * G, 0.13);
    src.connect(bp);
    kit.chain(bp, g, out);
  }
  if (r.ping > 0) {
    for (const [m, a] of [[1, 1], [2.71, 0.35]]) {
      const o = kit.osc('sine', r.pingHz * m * k, t, t + 0.2);
      const g = kit.gain(0);
      kit.perc(g.gain, t, 0.001, r.ping * G * a, r.surface === 'skiff' ? 0.16 : 0.06);
      kit.chain(o, g, out);
    }
  }
  if (r.slosh > 0) {
    const n = kit.noise('pink', t, t + 0.5);
    const bp = kit.filter('bandpass', 550, 1);
    bp.frequency.setValueAtTime(500, t);
    bp.frequency.exponentialRampToValueAtTime(1150, t + 0.12);
    bp.frequency.exponentialRampToValueAtTime(600, t + 0.35);
    const g = kit.gain(0);
    kit.perc(g.gain, t, 0.03, r.slosh * G, 0.3);
    kit.chain(n, bp, g, out);
    const e2 = waterHit(kit, out, t + 0.05, { kind: 'walk', strength: 0.12, bodyHz: 1400, decay: 0.05, slap: 0, bubbles: 2 }, k);
    return Math.max(end + 0.1, e2);
  }
  return end + 0.1;
}

// ---------------------------------------------------------------------------------------------------- the boat

// Twin-tone air horn with the pitch sag of a horn coming up to pressure. p = { dur }
export function horn(kit, out, t, p) {
  const f0 = 148 * rate(p);
  const dur = p.dur ?? 1.6;
  const end = t + dur + 0.6;
  const sum = kit.gain(1);
  for (const [m, a] of [[1, 0.5], [1.25, 0.38]]) {
    const o = kit.osc('sawtooth', f0 * m * 0.92, t, end);
    o.frequency.setValueAtTime(f0 * m * 0.92, t);
    o.frequency.exponentialRampToValueAtTime(f0 * m, t + 0.13);
    o.frequency.setValueAtTime(f0 * m, t + dur);
    o.frequency.exponentialRampToValueAtTime(f0 * m * 0.95, t + dur + 0.3);
    const g = kit.gain(a);
    kit.chain(o, g, sum);
  }
  const pk = kit.filter('peaking', 480, 1.2, 7);
  const lp = kit.filter('lowpass', 1900, 0.8);
  const env = kit.gain(0);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(0.5, t + 0.07);
  env.gain.setValueAtTime(0.5, t + dur);
  env.gain.setTargetAtTime(0, t + dur, 0.07);
  kit.chain(sum, pk, lp, env, out);
  const air = kit.noise('pink', t, end);
  const ab = kit.filter('bandpass', f0 * 7, 1.4);
  const ag = kit.gain(0);
  kit.ahr(ag.gain, t, 0.03, 0.05, dur - 0.05, 0.2);
  kit.chain(air, ab, ag, out);
  return end;
}

// Anchor chain: 'drop' runs out fast off the gypsy with the brake released; 'haul' comes in clank by clank.
export function anchorChain(kit, out, t, p) {
  const haul = p.mode === 'haul';
  const dur = haul ? 3.6 : 3;
  const end = t + dur + 0.4;
  const clank = (tt, base, vel, dec) => {
    for (const [m, a] of [[1, 1], [2.76, 0.45]]) {
      const o = kit.osc('sine', base * m, tt, tt + dec + 0.02);
      const g = kit.gain(0);
      kit.perc(g.gain, tt, 0.001, vel * a, dec);
      kit.chain(o, g, out);
    }
  };
  // Brake / pawl.
  clank(t, 520, 0.35, 0.3);
  const tick = kit.noise('white', t, end);
  let tt = t + 0.12;
  let i = 0;
  while (tt < t + dur) {
    const u = (tt - t) / dur;
    clank(tt, rr(950, 1500), (haul ? 0.14 : 0.12) * (0.6 + 0.4 * Math.random()), rr(0.04, 0.08));
    if (i % 2 === 0) {
      const bp = kit.filter('bandpass', 4200, 1.5);
      const g = kit.gain(0);
      kit.perc(g.gain, tt, 0.0005, 0.12, 0.01);
      tick.connect(bp);
      kit.chain(bp, g, out);
    }
    tt += haul ? rr(0.19, 0.24) : 0.045 + 0.09 * Math.abs(u - 0.45) * 1.6;
    i++;
  }
  const r = kit.noise('brown', t, end);
  const rb = kit.filter('bandpass', haul ? 150 : 210, 0.8);
  const rg = kit.gain(0);
  kit.ahr(rg.gain, t + 0.1, 0.2, haul ? 0.25 : 0.4, dur - 0.5, 0.3);
  kit.chain(r, rb, rg, out);
  if (haul) {
    const m = kit.osc('sawtooth', 96, t, end);
    const lp = kit.filter('lowpass', 520, 0.7);
    const mg = kit.gain(0);
    kit.ahr(mg.gain, t, 0.3, 0.06, dur - 0.5, 0.3);
    kit.chain(m, lp, mg, out);
  }
  return end;
}

// Grounding (gravel/rock under the keel) or a boat-to-boat bump. p = { kind, strength }
export function collision(kit, out, t, p) {
  const s = clamp(p.strength ?? 0.5, 0.1, 1.2);
  if (p.kind === 'boat') {
    const o = kit.osc('sine', 98, t, t + 0.5);
    o.frequency.exponentialRampToValueAtTime(62, t + 0.25);
    const g = kit.gain(0);
    kit.perc(g.gain, t, 0.003, 0.8 * s, 0.3);
    kit.chain(o, g, out);
    const n = kit.noise('pink', t, t + 0.5);
    const bp = kit.filter('bandpass', 420, 2);
    const ng = kit.gain(0);
    kit.perc(ng.gain, t, 0.002, 0.5 * s, 0.14);
    kit.chain(n, bp, ng, out);
    // Fender squeak.
    const q = kit.osc('sine', 520, t + 0.06, t + 0.45);
    q.frequency.linearRampToValueAtTime(760, t + 0.35);
    const vib = kit.osc('sine', 19, t + 0.06, t + 0.45);
    const vd = kit.gain(40);
    kit.chain(vib, vd, q.frequency);
    const qg = kit.gain(0);
    kit.perc(qg.gain, t + 0.06, 0.03, 0.08 * s, 0.3);
    kit.chain(q, qg, out);
    return t + 0.7;
  }
  const dur = 0.35 + 0.9 * s;
  const end = t + dur + 0.8;
  const sub = kit.osc('sine', 62, t, t + 0.9);
  sub.frequency.exponentialRampToValueAtTime(30, t + 0.6);
  const sg = kit.gain(0);
  kit.perc(sg.gain, t, 0.006, 0.9 * s, 0.7);
  kit.chain(sub, sg, out);
  const b = kit.noise('brown', t, end);
  const blp = kit.filter('lowpass', 280, 0.7);
  const bg = kit.gain(0);
  kit.perc(bg.gain, t, 0.008, 0.8 * s, 0.5);
  kit.chain(b, blp, bg, out);
  const sc = kit.noise('pink', t, end);
  const sbp = kit.filter('bandpass', 700, 0.9);
  const jit = kit.gain(0);
  kit.jitter(jit.gain, t, dur, 0.15, 0.55 * s, 28);
  kit.chain(sc, sbp, jit, out);
  const pb = kit.noise('pebbles', t, end);
  const pbp = kit.filter('bandpass', 2600, 0.6);
  const pg = kit.gain(0);
  kit.perc(pg.gain, t, 0.02, 0.5 * s, dur);
  kit.chain(pb, pbp, pg, out);
  if (s > 0.35) {
    const gr = kit.osc('sawtooth', 70, t + 0.05, end);
    gr.frequency.linearRampToValueAtTime(54, t + 1.1);
    const glp = kit.filter('lowpass', 380, 0.9);
    const gg = kit.gain(0);
    kit.ahr(gg.gain, t + 0.05, 0.08, 0.14 * s, 0.35, 0.5);
    kit.chain(gr, glp, gg, out);
  }
  return end;
}

// The skiff released off the stern ramp: pelican hook clank and a rumble down the roller.
export function skiffRelease(kit, out, t, p) {
  const end = t + 1.6;
  for (const [f, a] of [[640, 0.3], [1770, 0.15], [3300, 0.06]]) {
    const o = kit.osc('sine', f * rate(p), t, t + 0.4);
    const g = kit.gain(0);
    kit.perc(g.gain, t, 0.001, a, 0.3);
    kit.chain(o, g, out);
  }
  const n = kit.noise('brown', t + 0.05, end);
  const bp = kit.filter('bandpass', 110, 1);
  const am = kit.gain(0.5);
  const lfo = kit.osc('sine', 13, t + 0.05, end);
  const ld = kit.gain(0.4);
  kit.chain(lfo, ld, am.gain);
  const g = kit.gain(0);
  g.gain.setValueAtTime(0, t + 0.05);
  g.gain.linearRampToValueAtTime(0.7, t + 0.9);
  g.gain.setTargetAtTime(0, t + 1.1, 0.1);
  kit.chain(n, bp, am, g, out);
  return end;
}

// Starter motor cranking the main engine.
export function starter(kit, out, t, p) {
  const dur = p.dur ?? 0.9;
  const end = t + dur + 0.1;
  const m = kit.osc('sawtooth', 75, t, end);
  m.frequency.linearRampToValueAtTime(140, t + dur);
  const lp = kit.filter('lowpass', 1100, 0.8);
  const g = kit.gain(0);
  kit.ahr(g.gain, t, 0.04, 0.14, dur - 0.1, 0.06);
  kit.chain(m, lp, g, out);
  const w = kit.osc('sine', 880, t, end);
  w.frequency.linearRampToValueAtTime(1350, t + dur);
  const wg = kit.gain(0);
  kit.ahr(wg.gain, t, 0.05, 0.02, dur - 0.1, 0.05);
  kit.chain(w, wg, out);
  const n = kit.noise('white', t, end);
  const bp = kit.filter('bandpass', 2500, 1.5);
  const am = kit.gain(0);
  const sq = kit.osc('square', 28, t, end);
  sq.frequency.linearRampToValueAtTime(46, t + dur);
  const sd = kit.gain(0.05);
  kit.chain(sq, sd, am.gain);
  kit.chain(n, bp, am, out);
  return end;
}

// ------------------------------------------------------------------------------------------------- fishing gear

// A cork (or a ring) clacking through the power block or over the stern roller.
export function cork(kit, out, t, p) {
  const f = rr(650, 950) * rate(p);
  const o = kit.osc('sine', f, t, t + 0.08);
  const g = kit.gain(0);
  kit.perc(g.gain, t, 0.001, 0.16, 0.04);
  kit.chain(o, g, out);
  const n = kit.noise('white', t, t + 0.05);
  const bp = kit.filter('bandpass', 2200, 2);
  const ng = kit.gain(0);
  kit.perc(ng.gain, t, 0.0005, 0.12, 0.008);
  kit.chain(n, bp, ng, out);
  let end = t + 0.4;
  if (p.drip !== false && Math.random() < 0.5) end = Math.max(end, waterHit(kit, out, t + rr(0.05, 0.25), { kind: 'walk', strength: 0.05, bodyHz: 2200, decay: 0.03, slap: 0, bubbles: 1 }));
  return end;
}

// Purse rings coming aboard: heavy steel clanks and the purse line rumble.
export function ringsUp(kit, out, t, p) {
  let tt = t;
  for (let i = 0; i < 10; i++) {
    const base = rr(360, 460) * rate(p);
    for (const [m, a] of [[1, 0.26], [2.76, 0.12], [5.66, 0.05]]) {
      const o = kit.osc('sine', base * m, tt, tt + 0.35);
      const g = kit.gain(0);
      kit.perc(g.gain, tt, 0.001, a, rr(0.15, 0.3));
      kit.chain(o, g, out);
    }
    tt += rr(0.08, 0.22);
  }
  const r = kit.noise('brown', t, tt + 0.4);
  const bp = kit.filter('bandpass', 180, 0.8);
  const g = kit.gain(0);
  kit.ahr(g.gain, t, 0.1, 0.3, tt - t - 0.2, 0.3);
  kit.chain(r, bp, g, out);
  return tt + 0.5;
}

// Leads hung up on rock: the net strains, the block groans, a line twangs.
export function snag(kit, out, t, p) {
  const end = t + 1.8;
  const c = kit.osc('sawtooth', 38, t, end);
  const fm = kit.osc('sine', 7, t, end);
  const fd = kit.gain(6);
  kit.chain(fm, fd, c.frequency);
  const bp = kit.filter('bandpass', 320, 4);
  const g = kit.gain(0);
  kit.ahr(g.gain, t, 0.15, 0.5, 0.45, 0.4);
  kit.chain(c, bp, g, out);
  for (const [f, a, d] of [[190, 0.3, 0.8], [551, 0.1, 0.35]]) {
    const o = kit.osc('sine', f * 1.08, t + 0.5, end);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.6);
    const og = kit.gain(0);
    kit.perc(og.gain, t + 0.5, 0.002, a, d);
    kit.chain(o, og, out);
  }
  const b = kit.noise('brown', t, end);
  const lp = kit.filter('lowpass', 150, 0.7);
  const bg = kit.gain(0);
  kit.ahr(bg.gain, t, 0.2, 0.35, 0.5, 0.5);
  kit.chain(b, lp, bg, out);
  return end;
}

// The brailer dipping into the bag: a big wet scoop and water pouring off the bag as it lifts.
export function brailDip(kit, out, t, p) {
  let end = splash(kit, out, t, { size: 2.2 });
  const n = kit.noise('pink', t + 0.35, t + 1.8);
  const bp = kit.filter('bandpass', 1500, 0.7);
  const g = kit.gain(0);
  kit.ahr(g.gain, t + 0.35, 0.1, 0.22, 0.35, 0.6);
  kit.chain(n, bp, g, out);
  return Math.max(end, t + 1.8);
}

// The brailer dumping into the hatch: salmon thumping into the hold and a gush of water.
export function brailDump(kit, out, t, p) {
  const count = p.count ?? 12;
  const src = kit.noise('pink', t, t + 1.4);
  for (let i = 0; i < count; i++) {
    const tt = t + Math.pow(Math.random(), 0.7) * 0.7;
    const o = kit.osc('sine', rr(85, 150), tt, tt + 0.15);
    const g = kit.gain(0);
    kit.perc(g.gain, tt, 0.002, rr(0.12, 0.25), 0.09);
    kit.chain(o, g, out);
    const lp = kit.filter('lowpass', rr(600, 1100), 0.8);
    const ng = kit.gain(0);
    kit.perc(ng.gain, tt, 0.001, rr(0.1, 0.22), 0.05);
    src.connect(lp);
    kit.chain(lp, ng, out);
  }
  const bp = kit.filter('bandpass', 1600, 0.7);
  const wg = kit.gain(0);
  kit.ahr(wg.gain, t, 0.05, 0.2, 0.25, 0.6);
  src.connect(bp);
  kit.chain(bp, wg, out);
  return t + 1.4;
}

// ------------------------------------------------------------------------------------------------ environment

// Thunder: a crack if close, then a long rolling rumble. p = { distance, intensity }
export function thunder(kit, out, t, p) {
  const d = p.distance ?? 2500;
  const I = clamp(p.intensity ?? 0.8, 0.2, 1.2);
  const close = d < 1400;
  const dur = 3.5 + Math.random() * 3 + Math.min(3, d / 1500);
  const end = t + dur + 0.5;
  const n = kit.noise('brownStereo', t, end);
  const lp = kit.filter('lowpass', close ? 900 : 380, 0.6);
  const roll = kit.gain(0);
  const pts = 48;
  const c = new Float32Array(pts);
  let v = 0.8;
  for (let i = 0; i < pts; i++) {
    const u = i / (pts - 1);
    if (Math.random() < 0.2) v = Math.max(v, 0.45 + 0.55 * Math.random());
    v *= 0.84;
    // Rolls of rumble riding a long decay, then a gentle fade to nothing (no cut-off tail).
    c[i] = (0.1 + v) * Math.exp(-u * 2.6) * (u < 0.03 ? u / 0.03 : 1) * Math.min(1, (1 - u) * 6) * I;
  }
  c[pts - 1] = 0;
  roll.gain.setValueCurveAtTime(c, t, dur);
  kit.chain(n, lp, roll, out);
  if (close) {
    const w = kit.noise('white', t, t + 0.5);
    const hp = kit.filter('highpass', 1200, 0.7);
    const wg = kit.gain(0);
    kit.perc(wg.gain, t, 0.002, 0.45 * I, 0.3);
    kit.chain(w, hp, wg, out);
  }
  return end;
}

// Lighthouse diaphone in fog: a long low "beee" dropping to a grunt.
export function foghorn(kit, out, t, p) {
  const f = 176 * rate(p);
  const end = t + 3.3;
  const o = kit.osc('sawtooth', f, t, end);
  o.frequency.setValueAtTime(f * 0.97, t);
  o.frequency.linearRampToValueAtTime(f, t + 0.3);
  o.frequency.setValueAtTime(f, t + 2.2);
  o.frequency.exponentialRampToValueAtTime(f * 0.8, t + 2.6);
  const lp = kit.filter('lowpass', 850, 0.9);
  const g = kit.gain(0);
  kit.ahr(g.gain, t, 0.25, 0.5, 2.3, 0.45);
  kit.chain(o, lp, g, out);
  return end;
}

// Halyards slapping aluminium masts in the harbour.
export function clink(kit, out, t, p) {
  const n = 1 + Math.floor(Math.random() * 3);
  let tt = t;
  for (let i = 0; i < n; i++) {
    const f = rr(1100, 1500) * rate(p);
    for (const [m, a, d] of [[1, 0.12, 0.3], [2.76, 0.06, 0.14], [5.4, 0.03, 0.07]]) {
      const o = kit.osc('sine', f * m, tt, tt + d + 0.02);
      const g = kit.gain(0);
      kit.perc(g.gain, tt, 0.001, a * (1 - i * 0.2), d);
      kit.chain(o, g, out);
    }
    tt += rr(0.07, 0.18);
  }
  return tt + 0.35;
}

// ---------------------------------------------------------------------------------------------------- feedback

export function uiClick(kit, out, t, p) {
  const k = rate(p);
  const o = kit.osc('sine', 1650 * k, t, t + 0.06);
  const g = kit.gain(0);
  kit.perc(g.gain, t, 0.001, 0.14, 0.03);
  kit.chain(o, g, out);
  const n = kit.noise('white', t, t + 0.03);
  const bp = kit.filter('bandpass', 3200 * k, 2);
  const ng = kit.gain(0);
  kit.perc(ng.gain, t, 0.0005, 0.1, 0.008);
  kit.chain(n, bp, ng, out);
  return t + 0.08;
}

// Panel open/close: a soft two-note wooden tick and a whisper of paper (charts, logbook).
export function uiPanel(kit, out, t, p) {
  const k = rate(p);
  const notes = p.close ? [1320, 880] : [880, 1320];
  notes.forEach((f, i) => {
    const tt = t + i * 0.045;
    const o = kit.osc('sine', f * k, tt, tt + 0.08);
    const g = kit.gain(0);
    kit.perc(g.gain, tt, 0.001, 0.09, 0.05);
    kit.chain(o, g, out);
  });
  const n = kit.noise('pink', t, t + 0.3);
  const bp = kit.filter('bandpass', 2600, 0.6);
  const g = kit.gain(0);
  kit.jitter(g.gain, t, 0.22, 0, 0.1, 12);
  kit.chain(n, bp, g, out);
  return t + 0.32;
}

export function uiToast(kit, out, t, p) {
  const k = rate(p);
  const o = kit.osc('sine', 1175 * k, t, t + 0.5);
  const o2 = kit.osc('sine', 1175 * k * 3.01, t, t + 0.2);
  const g = kit.gain(0);
  kit.perc(g.gain, t, 0.002, 0.07, 0.4);
  const g2 = kit.gain(0);
  kit.perc(g2.gain, t, 0.001, 0.015, 0.12);
  kit.chain(o, g, out);
  kit.chain(o2, g2, out);
  return t + 0.5;
}

// A sighting logged in the binoculars: a pencil-light rising blip.
export function uiBlip(kit, out, t, p) {
  const k = rate(p);
  [1320, 1760].forEach((f, i) => {
    const tt = t + i * 0.06;
    const o = kit.osc('triangle', f * k, tt, tt + 0.2);
    const g = kit.gain(0);
    kit.perc(g.gain, tt, 0.002, 0.07, 0.15);
    kit.chain(o, g, out);
  });
  return t + 0.3;
}

// VHF: squelch opening, static and a muffled voice for as long as the caption types, then the squelch tail.
// p = { text, channel }
export function radio(kit, out, t, p) {
  const { voice } = radioTiming(p.text);
  const T = TUNING.radio;
  const end = t + voice + 0.55;
  const hp = kit.filter('highpass', 380, 0.7);
  const lp = kit.filter('lowpass', 2900, 0.7);
  const grit = kit.shaper(kit.curves.grit);
  kit.chain(hp, lp, grit, out);
  const w = kit.noise('white', t, end);
  const sq = kit.gain(0);
  sq.gain.setValueAtTime(0, t);
  sq.gain.linearRampToValueAtTime(T.squelch, t + 0.004);
  sq.gain.setValueAtTime(T.squelch, t + 0.07);
  sq.gain.setTargetAtTime(0, t + 0.07, 0.03);
  kit.chain(w, sq, hp);
  const bb = kit.filter('bandpass', 1600, 0.4);
  const bed = kit.gain(0);
  bed.gain.setValueAtTime(0, t + 0.05);
  bed.gain.linearRampToValueAtTime(T.bed, t + 0.1);
  bed.gain.setValueAtTime(T.bed, t + voice + 0.1);
  bed.gain.linearRampToValueAtTime(0, t + voice + 0.14);
  w.connect(bb);
  kit.chain(bb, bed, hp);
  const cr = kit.noise('crackle', t + 0.05, end);
  const cb = kit.filter('bandpass', 2400, 0.8);
  const cg = kit.gain(0);
  cg.gain.setValueAtTime(0, t + 0.05);
  cg.gain.linearRampToValueAtTime(T.bed * 5, t + 0.1);
  cg.gain.setValueAtTime(T.bed * 5, t + voice + 0.1);
  cg.gain.linearRampToValueAtTime(0, t + voice + 0.14);
  kit.chain(cr, cb, cg, hp);
  // Muffled voice: a glottal saw with a falling intonation through two moving formants, gated into syllables.
  if (T.voice > 0) {
    const t0 = t + 0.14;
    const t1 = t + 0.1 + voice;
    const glot = kit.osc('sawtooth', rr(105, 135), t0, t1 + 0.1);
    const breath = kit.noise('pink', t0, t1 + 0.1);
    const bg = kit.gain(0.35);
    const f1 = kit.filter('bandpass', 600, 4);
    const f2 = kit.filter('bandpass', 1400, 5);
    const syl = kit.gain(0);
    const mix = kit.gain(1);
    kit.chain(glot, mix);
    kit.chain(breath, bg, mix);
    mix.connect(f1);
    mix.connect(f2);
    f1.connect(syl);
    f2.connect(syl);
    syl.connect(hp);
    let tt = t0;
    let word = 0;
    const base = glot.frequency.value;
    while (tt < t1 - 0.1) {
      const sd = rr(0.08, 0.2);
      f1.frequency.setTargetAtTime(rr(380, 850), tt, 0.02);
      f2.frequency.setTargetAtTime(rr(1000, 2200), tt, 0.02);
      glot.frequency.setTargetAtTime(base * (1.1 - 0.25 * ((tt - t0) / Math.max(0.3, t1 - t0))) * rr(0.94, 1.08), tt, 0.04);
      syl.gain.setTargetAtTime(T.voice * rr(0.55, 1), tt, 0.012);
      syl.gain.setTargetAtTime(0, tt + sd * 0.78, 0.02);
      tt += sd + rr(0.02, 0.06);
      if (++word > 2 + Math.random() * 4) {
        word = 0;
        tt += rr(0.12, 0.28);
      }
    }
    syl.gain.setTargetAtTime(0, t1, 0.02);
  }
  const tail = kit.gain(0);
  const tb = kit.filter('bandpass', 2000, 0.6);
  tail.gain.setValueAtTime(0, t + voice + 0.12);
  tail.gain.linearRampToValueAtTime(T.squelch * 0.85, t + voice + 0.125);
  tail.gain.setTargetAtTime(0, t + voice + 0.14, 0.05);
  w.connect(tb);
  kit.chain(tb, tail, hp);
  return end;
}

// Fish ticket: the register's ratchet and drawer, the bell, a scatter of coins.
export function cashRegister(kit, out, t, p) {
  const n = kit.noise('white', t, t + 0.5);
  for (let i = 0; i < 4; i++) {
    const bp = kit.filter('bandpass', 2600, 3);
    const g = kit.gain(0);
    kit.perc(g.gain, t + i * 0.032, 0.0006, 0.3, 0.012);
    n.connect(bp);
    kit.chain(bp, g, out);
  }
  const d = kit.noise('pink', t + 0.1, t + 0.45);
  const db = kit.filter('bandpass', 1300, 1);
  const dg = kit.gain(0);
  dg.gain.setValueAtTime(0, t + 0.1);
  dg.gain.linearRampToValueAtTime(0.1, t + 0.2);
  dg.gain.linearRampToValueAtTime(0, t + 0.33);
  kit.chain(d, db, dg, out);
  const th = kit.osc('sine', 170, t + 0.33, t + 0.5);
  const tg = kit.gain(0);
  kit.perc(tg.gain, t + 0.33, 0.002, 0.2, 0.1);
  kit.chain(th, tg, out);
  let end = bell(kit, out, t + 0.15, 2637, { vel: 0.26, decay: 1.7, ratio: 1.41, index: 2.4 });
  bell(kit, out, t + 0.15, 3951, { vel: 0.07, decay: 1.1, ratio: 2.0, index: 1 });
  for (let i = 0; i < 7; i++) {
    const tt = t + 0.3 + Math.random() * 0.55;
    const o = kit.osc('sine', rr(4500, 7500), tt, tt + 0.14);
    const g = kit.gain(0);
    kit.perc(g.gain, tt, 0.001, 0.035, rr(0.05, 0.12));
    kit.chain(o, g, out);
  }
  return Math.max(end, t + 1.9);
}

// Discovery: a warm pad chord with a gentle rising arpeggio. p = { kind, memorial, root }
export function discovery(kit, out, t, p) {
  const chord = p.chord ?? discoveryChord(p);
  if (!chord) return t;
  const root = p.root ?? 62;
  let end = pad(kit, out, t, chord.notes.map((n) => root + n), { dur: 2.2, vel: 0.62, attack: 0.45, release: 2.8, cutoff: 1900 });
  chord.arp.forEach((n, i) => {
    end = Math.max(end, pluck(kit, out, t + 0.3 + i * 0.24, root + n, { vel: 0.32, decay: 2.2, bright: 0.8, pan: (i - 1) * 0.3 }));
  });
  return end;
}

// Set complete by rating (see stingerFor). p = { rating, cited, root }
export function stinger(kit, out, t, p) {
  const s = p.plan ?? stingerFor(p.rating, p.cited);
  const root = p.root ?? 62;
  const beat = 0.3;
  let end = t;
  s.plucks.forEach(([n, b], i) => {
    end = Math.max(end, pluck(kit, out, t + b * beat * 2, root + n, { vel: 0.42 * s.level, decay: 1.8 + 0.4 * s.bright, bright: 0.5 + 0.6 * s.bright, pan: ((i % 3) - 1) * 0.25 }));
  });
  end = Math.max(end, pad(kit, out, t + 0.05, s.pad.map((n) => root + n), { dur: 1.6 + s.bright, vel: 0.5 * s.level, attack: 0.3, release: 2.5, cutoff: 700 + 1500 * s.bright }));
  if (s.shimmer) {
    [24, 28, 31, 36].forEach((n, i) => {
      end = Math.max(end, bell(kit, out, t + 0.9 + i * 0.1, 440 * Math.pow(2, (root + n - 69) / 12), { vel: 0.045, decay: 1.6, ratio: 3.01, index: 0.6, pan: (i - 1.5) * 0.3 }));
    });
  }
  return end;
}

// Named one-shots: recipe, priority, bus ('world' | 'ui'), distance model (ref, rolloff), level, audibility range.
export const SOUNDS = {
  'fish-jump': { fn: fishJump, priority: 4, bus: 'world', ref: 10, rolloff: 0.9, level: 1.1, range: 520 },
  splash: { fn: splash, priority: 4, bus: 'world', ref: 6, rolloff: 0.9, level: 0.7, range: 500 },
  'surf-break': { fn: surfBreak, priority: 3, bus: 'ambience', level: 1 },
  'hull-slap': { fn: hullSlap, priority: 2, bus: 'world', ref: 8, rolloff: 1, level: 0.9, range: 250 },
  gull: { fn: gull, priority: 3, bus: 'world', ref: 10, rolloff: 1, level: 0.75, range: 400 },
  eagle: { fn: eagle, priority: 3, bus: 'world', ref: 14, rolloff: 1, level: 0.8, range: 500 },
  'whale-blow': { fn: whaleBlow, priority: 5, bus: 'world', ref: 40, rolloff: 0.8, level: 1, range: 2600 },
  breach: { fn: breach, priority: 5, bus: 'world', ref: 50, rolloff: 0.8, level: 0.7, range: 3500 },
  'bear-huff': { fn: bearHuff, priority: 7, bus: 'world', ref: 10, rolloff: 1, level: 1, range: 500 },
  'bear-charge': { fn: bearCharge, priority: 7, bus: 'world', ref: 10, rolloff: 1, level: 1, range: 500 },
  sealion: { fn: sealion, priority: 3, bus: 'world', ref: 25, rolloff: 0.9, level: 0.8, range: 1600 },
  boil: { fn: boil, priority: 4, bus: 'world', ref: 10, rolloff: 1, level: 0.8, range: 300 },
  clunk: { fn: clunk, priority: 7, bus: 'world', ref: 10, rolloff: 1, level: 1, range: 300 },
  footstep: { fn: footstep, priority: 6, bus: 'world', ref: 4, rolloff: 1, level: 1, range: 60 },
  horn: { fn: horn, priority: 9, bus: 'world', ref: 30, rolloff: 0.8, level: 0.75, range: 6000 },
  'anchor-chain': { fn: anchorChain, priority: 8, bus: 'world', ref: 14, rolloff: 1, level: 1, range: 500 },
  collision: { fn: collision, priority: 9, bus: 'world', ref: 18, rolloff: 1, level: 0.7, range: 800 },
  'skiff-release': { fn: skiffRelease, priority: 7, bus: 'world', ref: 14, rolloff: 1, level: 1, range: 500 },
  starter: { fn: starter, priority: 7, bus: 'world', ref: 16, rolloff: 1, level: 1, range: 300 },
  cork: { fn: cork, priority: 2, bus: 'world', ref: 8, rolloff: 1, level: 0.8, range: 200 },
  'rings-up': { fn: ringsUp, priority: 7, bus: 'world', ref: 14, rolloff: 1, level: 1, range: 500 },
  snag: { fn: snag, priority: 8, bus: 'world', ref: 16, rolloff: 1, level: 1, range: 500 },
  'brail-dip': { fn: brailDip, priority: 6, bus: 'world', ref: 12, rolloff: 1, level: 0.65, range: 500 },
  'brail-dump': { fn: brailDump, priority: 6, bus: 'world', ref: 12, rolloff: 1, level: 1, range: 400 },
  thunder: { fn: thunder, priority: 8, bus: 'ambience', level: 1 },
  foghorn: { fn: foghorn, priority: 5, bus: 'world', ref: 60, rolloff: 0.7, level: 1, range: 5000 },
  clink: { fn: clink, priority: 1, bus: 'world', ref: 12, rolloff: 1, level: 0.8, range: 500 },
  'ui-click': { fn: uiClick, priority: 10, bus: 'ui', level: 1 },
  'ui-open': { fn: uiPanel, priority: 10, bus: 'ui', level: 1 },
  'ui-close': { fn: (k, o, t, p) => uiPanel(k, o, t, { ...p, close: true }), priority: 10, bus: 'ui', level: 1 },
  'ui-toast': { fn: uiToast, priority: 10, bus: 'ui', level: 1 },
  'ui-blip': { fn: uiBlip, priority: 10, bus: 'ui', level: 1 },
  radio: { fn: radio, priority: 9, bus: 'ui', level: 1 },
  'cash-register': { fn: cashRegister, priority: 9, bus: 'ui', level: 1 },
  discovery: { fn: discovery, priority: 9, bus: 'ui', level: 1, reverb: true },
  stinger: { fn: stinger, priority: 9, bus: 'ui', level: 1, reverb: true },
};
