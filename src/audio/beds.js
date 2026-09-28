// Continuous layers: the sea, wind, rain, settlements, the boats' engines and gear. Each layer is a small node graph
// fed from the shared looping noise/texture buffers. Layers that are often silent (rain, harbour, skiff, hydraulics,
// genset, fleet boats, the bag, streams) are built when they first become audible and torn down after a few quiet
// seconds, so the audio thread only runs what can be heard. Parameters come from params.js via the director.

import { dieselVoice, airCutoff, clamp } from './params.js';

const EPS = 1e-4;

// Smooth parameter writes that skip redundant automation events.
function smooth(param, v, tau, t) {
  if (!Number.isFinite(v)) return;
  const last = param.__k;
  if (last !== undefined && Math.abs(last - v) <= Math.abs(v) * 0.004 + 1e-6) return;
  param.__k = v;
  param.setTargetAtTime(v, t, tau);
}

// A positioned output: level gain → air low-pass → panner → bus.
function emitter(kit, dest, { ref = 10, rolloff = 1 } = {}) {
  const ac = kit.ac;
  const level = kit.gain(0);
  const air = kit.filter('lowpass', 20000, 0.5);
  const p = ac.createPanner();
  p.panningModel = 'equalpower';
  p.distanceModel = 'inverse';
  p.refDistance = ref;
  p.rolloffFactor = rolloff;
  p.maxDistance = 20000;
  kit.chain(level, air, p, dest);
  // Neighbours' positions are trusted only when finite (AudioParams throw on NaN).
  const setPos = p.positionX
    ? (x, y, z) => {
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
        p.positionX.value = x;
        p.positionY.value = y;
        p.positionZ.value = z;
      }
    : (x, y, z) => {
        if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) p.setPosition(x, y, z);
      };
  return {
    level,
    air,
    panner: p,
    setPos,
    // Distance (m) to the listener → air absorption.
    setDistance(d, t) {
      smooth(air.frequency, airCutoff(d), 0.2, t);
    },
    nodes: [level, air, p],
  };
}

// Builds on first need, tears down after `idle` seconds below audibility.
function lazy(build, { idle = 3 } = {}) {
  let inst = null;
  let quiet = 0;
  return {
    get on() {
      return !!inst;
    },
    get inst() {
      return inst;
    },
    // Returns the instance (or null) for this frame's parameter writes.
    need(level, dt) {
      if (level > EPS) {
        quiet = 0;
        if (!inst) inst = build();
      } else if (inst) {
        quiet += dt;
        if (quiet > idle) {
          inst.dispose();
          inst = null;
        }
      }
      return inst;
    },
    dispose() {
      inst?.dispose();
      inst = null;
    },
  };
}

function disposeAll(sources, nodes) {
  for (const s of sources) {
    try {
      s.stop();
    } catch {
      // not started / already stopped
    }
  }
  for (const n of nodes) {
    try {
      n.disconnect();
    } catch {
      // already disconnected
    }
  }
}

// A diesel: the chugging PeriodicWave (one whole four-stroke cycle per period), injector clatter and exhaust noise
// both amplitude-modulated by the firing pulses, turbo whistle and intake hiss. → { input params, set(voice, level) }
function dieselChain(kit, wave, dest, { ref = 20, rolloff = 1, stack = 420 } = {}) {
  const ac = kit.ac;
  const t = ac.currentTime;
  const em = emitter(kit, dest, { ref, rolloff });
  const pre = kit.gain(1);
  const interior = kit.filter('lowpass', 20000, 0.6);
  kit.chain(pre, interior, em.level);

  const osc = kit.osc(wave, 6, t);
  const lp = kit.filter('lowpass', 600, 0.7);
  // Exhaust stack / engine-room resonance: fixed in frequency whatever the rpm.
  const res = kit.filter('peaking', stack, 2.4, 4);
  const body = kit.gain(0);
  kit.chain(osc, lp, res, body, pre);
  // The other bank of cylinders, wandering a hair in and out of step (random, never a steady flanger sweep): the
  // irregular phasing gives the big diesel its lope.
  const osc2 = kit.osc(wave, 6, t);
  const bank = kit.gain(0.35);
  kit.chain(osc2, bank, lp);

  const white = kit.noise('white', t);
  const clatBp = kit.filter('bandpass', 2500, 1.1);
  const clatter = kit.gain(0);
  const clatAm = kit.gain(0);
  kit.chain(white, clatBp, clatter, pre);
  kit.chain(osc, clatAm, clatter.gain);

  const brown = kit.noise('brown', t);
  const exLp = kit.filter('lowpass', 500, 0.8);
  const exhaust = kit.gain(0);
  const exAm = kit.gain(0);
  kit.chain(brown, exLp, exhaust, pre);
  kit.chain(osc, exAm, exhaust.gain);

  const turbo = kit.osc('sine', 2500, t);
  const turboG = kit.gain(0);
  kit.chain(turbo, turboG, pre);
  const hissHp = kit.filter('highpass', 3200, 0.7);
  const hiss = kit.gain(0);
  kit.chain(white, hissHp, hiss, pre);

  const sources = [osc, osc2, white, brown, turbo];
  const nodes = [pre, interior, lp, res, body, bank, clatBp, clatter, clatAm, exLp, exhaust, exAm, turboG, hissHp, hiss, ...em.nodes];
  let wobble = 0;
  return {
    em,
    // v = dieselVoice(); level = overall gain; muffle 0..1 (wheelhouse walls); jitter 0..1 (rough running).
    set(v, level, { muffle = 0, jitter = 0.009 } = {}) {
      const tt = ac.currentTime;
      wobble += (Math.random() - 0.5) * 0.5;
      wobble *= 0.9;
      smooth(osc.frequency, v.cycleHz * (1 + wobble * jitter), 0.06, tt);
      smooth(osc2.frequency, v.cycleHz * (1 - wobble * jitter * 0.7), 0.08, tt);
      smooth(lp.frequency, v.cutoff, 0.1, tt);
      smooth(body.gain, v.body, 0.1, tt);
      smooth(clatter.gain, v.clatter * 0.55, 0.1, tt);
      smooth(clatAm.gain, v.clatter * 0.45, 0.1, tt);
      smooth(clatBp.frequency, v.clatterHz, 0.2, tt);
      smooth(exhaust.gain, v.exhaust * 0.5, 0.1, tt);
      smooth(exAm.gain, v.exhaust * 0.5, 0.1, tt);
      smooth(exLp.frequency, v.exhaustCutoff, 0.1, tt);
      smooth(turbo.frequency, v.turboHz, 0.3, tt);
      smooth(turboG.gain, v.turbo, 0.2, tt);
      smooth(hiss.gain, v.hiss, 0.2, tt);
      smooth(interior.frequency, 20000 * (1 - muffle) + 700 * muffle, 0.15, tt);
      smooth(em.level.gain, level * v.gain, 0.08, tt);
    },
    dispose() {
      disposeAll(sources, nodes);
    },
  };
}

export function createBeds(ac, kit, mixer) {
  const amb = mixer.bus.ambience;
  const world = mixer.bus.world;
  const t0 = ac.currentTime;

  // ---------------------------------------------------------------------------------------------- the sea
  const deepSrc = kit.noise('brownStereo', t0);
  const deepLp = kit.filter('lowpass', 400, 0.5);
  const deep = kit.gain(0);
  kit.chain(deepSrc, deepLp, deep, amb);
  const surfSrc = kit.noise('pinkStereo', t0, undefined, { rate: 0.93 });
  const surfHp = kit.filter('highpass', 220, 0.6);
  const surfLp = kit.filter('lowpass', 2000, 0.5);
  const surf = kit.gain(0);
  kit.chain(surfSrc, surfHp, surfLp, surf, amb);
  const lapSrc = kit.noise('pinkStereo', t0, undefined, { rate: 1.11 });
  const lapBp = kit.filter('bandpass', 1100, 0.45);
  const lapHs = kit.filter('highshelf', 3500, 0.7, -4);
  const lap = kit.gain(0);
  kit.chain(lapSrc, lapBp, lapHs, lap, amb);

  // ---------------------------------------------------------------------------------------------- wind
  const windSrc = kit.noise('pinkStereo', t0, undefined, { rate: 1.07 });
  const windBp = kit.filter('bandpass', 400, 0.6);
  const wind = kit.gain(0);
  kit.chain(windSrc, windBp, wind, amb);
  const buffetSrc = kit.noise('brownStereo', t0, undefined, { rate: 1.3 });
  const buffetLp = kit.filter('lowpass', 160, 0.6);
  const buffet = kit.gain(0);
  kit.chain(buffetSrc, buffetLp, buffet, amb);

  // Rigging whistle (on the boat) and foliage (on foot under spruce/alder) are lazy.
  const whistle = lazy(() => {
    const t = ac.currentTime;
    const src = kit.noise('white', t);
    const bp = kit.filter('bandpass', 800, 28);
    const bp2 = kit.filter('bandpass', 1300, 36);
    const g = kit.gain(0);
    const g2 = kit.gain(0.5);
    const pan = kit.pan(0.3);
    kit.chain(src, bp, g, pan, amb);
    kit.chain(src, bp2, g2, g);
    return {
      set(p, gust) {
        const tt = ac.currentTime;
        smooth(bp.frequency, p.whistleHz, 0.25, tt);
        smooth(bp2.frequency, p.whistleHz * 1.62, 0.25, tt);
        smooth(g.gain, p.whistleGain * (0.4 + gust), 0.2, tt);
        smooth(pan.pan, Math.sin(tt * 0.07) * 0.5, 0.5, tt);
      },
      dispose: () => disposeAll([src], [bp, bp2, g, g2, pan]),
    };
  });
  const foliage = lazy(() => {
    const t = ac.currentTime;
    const src = kit.noise('pinkStereo', t, undefined, { rate: 1.2 });
    const hp = kit.filter('highpass', 1800, 0.5);
    const lp = kit.filter('lowpass', 7000, 0.5);
    const g = kit.gain(0);
    kit.chain(src, hp, lp, g, amb);
    return {
      set(level) {
        smooth(g.gain, level, 0.25, ac.currentTime);
      },
      dispose: () => disposeAll([src], [hp, lp, g]),
    };
  });

  // ---------------------------------------------------------------------------------------------- rain
  const rain = lazy(() => {
    const t = ac.currentTime;
    const src = kit.noise('rain', t);
    const hp = kit.filter('highpass', 400, 0.6);
    const lp = kit.filter('lowpass', 9000, 0.5);
    const g = kit.gain(0);
    kit.chain(src, hp, lp, g, amb);
    const hs = kit.noise('white', t);
    const hhp = kit.filter('highpass', 4200, 0.6);
    const hlp = kit.filter('lowpass', 11000, 0.5);
    const hg = kit.gain(0);
    kit.chain(hs, hhp, hlp, hg, amb);
    // Big drops on the wheelhouse roof / the hood: a darker drum layer.
    const drum = kit.noise('rain', t, undefined, { rate: 0.3 });
    const dlp = kit.filter('lowpass', 1600, 0.5);
    const dg = kit.gain(0);
    kit.chain(drum, dlp, dg, amb);
    return {
      set(p, roof) {
        const tt = ac.currentTime;
        smooth(g.gain, p.patterGain, 0.4, tt);
        smooth(hp.frequency, p.patterHighpass, 0.4, tt);
        smooth(lp.frequency, p.patterCutoff, 0.4, tt);
        smooth(src.playbackRate, p.rate, 0.5, tt);
        smooth(hg.gain, p.hissGain, 0.4, tt);
        smooth(dg.gain, roof * p.patterGain * 1.4, 0.4, tt);
      },
      dispose: () => disposeAll([src, hs, drum], [hp, lp, g, hhp, hlp, hg, dlp, dg]),
    };
  });

  // ---------------------------------------------------------------------------------------------- settlements
  const harbor = lazy(() => {
    const t = ac.currentTime;
    const src = kit.noise('brown', t, undefined, { rate: 0.8 });
    const lp = kit.filter('lowpass', 150, 0.7);
    const g = kit.gain(0);
    kit.chain(src, lp, g, amb);
    // Cannery refrigeration and conveyors: a mains-frequency drone with a slowly beating second compressor.
    const m1 = kit.osc('sawtooth', 60, t);
    const m2 = kit.osc('sawtooth', 60.35, t);
    const mlp = kit.filter('lowpass', 380, 0.8);
    const mg = kit.gain(0);
    const m2g = kit.gain(0.6);
    kit.chain(m1, mlp);
    kit.chain(m2, m2g, mlp);
    kit.chain(mlp, mg, amb);
    return {
      set(hum, machinery) {
        const tt = ac.currentTime;
        smooth(g.gain, hum, 0.6, tt);
        smooth(mg.gain, machinery, 0.6, tt);
      },
      dispose: () => disposeAll([src, m1, m2], [lp, g, mlp, mg, m2g]),
    };
  });

  // ---------------------------------------------------------------------------------------------- the seiner
  const main = dieselChain(kit, 'diesel', world, { ref: 22, rolloff: 1, stack: 380 });
  const genset = lazy(() => {
    const t = ac.currentTime;
    const em = emitter(kit, world, { ref: 10, rolloff: 1.2 });
    const a = kit.osc('sine', 60, t);
    const b = kit.osc('triangle', 120, t);
    const c = kit.osc('sawtooth', 30, t);
    const lp = kit.filter('lowpass', 420, 0.7);
    const bg = kit.gain(0.35);
    const cg = kit.gain(0.25);
    kit.chain(a, lp);
    kit.chain(b, bg, lp);
    kit.chain(c, cg, lp);
    lp.connect(em.level);
    return {
      em,
      set(level) {
        smooth(em.level.gain, level, 0.4, ac.currentTime);
      },
      dispose: () => disposeAll([a, b, c], [lp, bg, cg, ...em.nodes]),
    };
  });
  const hullWash = lazy(() => {
    const t = ac.currentTime;
    const em = emitter(kit, world, { ref: 12, rolloff: 1 });
    const src = kit.noise('pinkStereo', t, undefined, { rate: 0.85 });
    const bp = kit.filter('bandpass', 700, 0.55);
    const low = kit.noise('brownStereo', t);
    const llp = kit.filter('lowpass', 260, 0.6);
    const lg = kit.gain(0.6);
    kit.chain(src, bp, em.level);
    kit.chain(low, llp, lg, em.level);
    return {
      em,
      set(p, surge) {
        const tt = ac.currentTime;
        smooth(bp.frequency, p.centre, 0.3, tt);
        smooth(em.level.gain, p.gain * surge, 0.12, tt);
      },
      dispose: () => disposeAll([src, low], [bp, llp, lg, ...em.nodes]),
    };
  });
  const skiff = lazy(() => dieselChain(kit, 'dieselSkiff', world, { ref: 12, rolloff: 1, stack: 640 }), { idle: 2 });
  const hydraulics = lazy(() => {
    const t = ac.currentTime;
    const em = emitter(kit, world, { ref: 10, rolloff: 1 });
    const w = kit.osc('sawtooth', 200, t);
    const wbp = kit.filter('bandpass', 600, 4);
    const wg = kit.gain(0);
    kit.chain(w, wbp, wg, em.level);
    const w2 = kit.osc('triangle', 600, t);
    const w2g = kit.gain(0);
    kit.chain(w2, w2g, em.level);
    const n = kit.noise('white', t);
    const nbp = kit.filter('bandpass', 2600, 0.9);
    const ng = kit.gain(0);
    kit.chain(n, nbp, ng, em.level);
    const r = kit.noise('brown', t);
    const rlp = kit.filter('lowpass', 170, 0.7);
    const rg = kit.gain(0);
    kit.chain(r, rlp, rg, em.level);
    let ripple = 0;
    return {
      em,
      set(p) {
        const tt = ac.currentTime;
        ripple = ripple * 0.92 + (Math.random() - 0.5) * 0.08;
        const f = p.whineHz * (1 + ripple * 0.02);
        smooth(w.frequency, f, 0.15, tt);
        smooth(wbp.frequency, f * 3, 0.15, tt);
        smooth(w2.frequency, f * 3, 0.15, tt);
        smooth(wg.gain, 0.8, 0.2, tt);
        smooth(w2g.gain, 0.08, 0.2, tt);
        smooth(ng.gain, p.hiss * 0.5, 0.2, tt);
        smooth(rg.gain, p.rumble * 1.6, 0.2, tt);
        smooth(em.level.gain, p.gain, 0.25, tt);
      },
      dispose: () => disposeAll([w, w2, n, r], [wbp, wg, w2g, nbp, ng, rlp, rg, ...em.nodes]),
    };
  });

  // The seine running off the stern pile while setting: web and corkline rushing over the roller into the water.
  const payout = lazy(() => {
    const t = ac.currentTime;
    const em = emitter(kit, world, { ref: 8, rolloff: 1 });
    const src = kit.noise('pinkStereo', t, undefined, { rate: 1.25 });
    const bp = kit.filter('bandpass', 1700, 0.7);
    const am = kit.gain(0.6);
    const rat = kit.noise('pebbles', t, undefined, { rate: 0.5 });
    const rbp = kit.filter('bandpass', 1200, 1.2);
    const rg = kit.gain(0.5);
    const sp = kit.noise('rain', t, undefined, { rate: 0.8 });
    const sbp = kit.filter('highpass', 2500, 0.7);
    const sg = kit.gain(0.35);
    kit.chain(src, bp, am, em.level);
    kit.chain(rat, rbp, rg, em.level);
    kit.chain(sp, sbp, sg, em.level);
    return {
      em,
      set(level, speed) {
        const tt = ac.currentTime;
        smooth(bp.frequency, 1300 + 90 * speed, 0.3, tt);
        smooth(am.gain, 0.45 + 0.4 * Math.random(), 0.06, tt);
        smooth(rat.playbackRate, 0.35 + 0.08 * speed, 0.3, tt);
        smooth(em.level.gain, level, 0.2, tt);
      },
      dispose: () => disposeAll([src, rat, sp], [bp, am, rbp, rg, sbp, sg, ...em.nodes]),
    };
  });

  // Thrashing salmon in the dried-up bag alongside: a boil of small splashes.
  const bag = lazy(() => {
    const t = ac.currentTime;
    const em = emitter(kit, world, { ref: 8, rolloff: 1 });
    const src = kit.noise('rain', t, undefined, { rate: 0.62 });
    const bp = kit.filter('bandpass', 1300, 0.6);
    const am = kit.gain(0.7);
    const slosh = kit.noise('pinkStereo', t, undefined, { rate: 0.7 });
    const sbp = kit.filter('bandpass', 600, 0.8);
    const sg = kit.gain(0.25);
    kit.chain(src, bp, am, em.level);
    kit.chain(slosh, sbp, sg, em.level);
    return {
      em,
      set(level) {
        const tt = ac.currentTime;
        smooth(am.gain, 0.45 + 0.55 * Math.random(), 0.05, tt);
        smooth(sbp.frequency, 450 + 400 * Math.random(), 0.2, tt);
        smooth(em.level.gain, level, 0.3, tt);
      },
      dispose: () => disposeAll([src, slosh], [bp, am, sbp, sg, ...em.nodes]),
    };
  });

  // A salmon stream running into the sea: babble from moving resonances over noise and droplets.
  const stream = lazy(() => {
    const t = ac.currentTime;
    const em = emitter(kit, amb, { ref: 14, rolloff: 1.1 });
    const src = kit.noise('pinkStereo', t, undefined, { rate: 1.1 });
    const drops = kit.noise('rain', t, undefined, { rate: 0.45 });
    const bps = [700, 1300, 2300].map((f) => kit.filter('bandpass', f, 3));
    const gs = bps.map(() => kit.gain(0.3));
    for (let i = 0; i < 3; i++) kit.chain(src, bps[i], gs[i], em.level);
    const dg = kit.gain(0.25);
    const dhp = kit.filter('highpass', 900, 0.7);
    kit.chain(drops, dhp, dg, em.level);
    return {
      em,
      set(level) {
        const tt = ac.currentTime;
        for (let i = 0; i < 3; i++) {
          smooth(bps[i].frequency, [700, 1300, 2300][i] * (0.7 + 0.6 * Math.random()), 0.06, tt);
          smooth(gs[i].gain, 0.15 + 0.35 * Math.random(), 0.05, tt);
        }
        smooth(em.level.gain, level, 0.4, tt);
      },
      dispose: () => disposeAll([src, drops], [...bps, ...gs, dg, dhp, ...em.nodes]),
    };
  });

  // Nearby boats of the fleet (two pooled diesels).
  const fleet = [0, 1].map(() => lazy(() => dieselChain(kit, 'dieselFleet', world, { ref: 20, rolloff: 1, stack: 330 }), { idle: 2 }));

  const allLazy = { whistle, foliage, rain, harbor, genset, hullWash, skiff, hydraulics, payout, bag, stream, fleet0: fleet[0], fleet1: fleet[1] };

  return {
    main,
    genset,
    hullWash,
    skiff,
    hydraulics,
    payout,
    bag,
    stream,
    fleet,
    whistle,
    foliage,
    rain,
    harbor,

    setOcean(p, swell, t = ac.currentTime) {
      smooth(deepLp.frequency, p.deepCutoff, 0.5, t);
      smooth(deep.gain, p.deepGain * swell.deep, 0.18, t);
      smooth(surfLp.frequency, p.surfCutoff, 0.5, t);
      smooth(surf.gain, p.surfGain * swell.surf, 0.18, t);
      smooth(lapBp.frequency, p.lapCentre * (0.85 + 0.3 * (swell.lap ?? 0.5)), 0.12, t);
      smooth(lap.gain, (p.lapGain ?? 0) * (swell.lap ?? 0.5), 0.06, t);
    },
    setWind(p, t = ac.currentTime) {
      smooth(windBp.frequency, p.centre, 0.25, t);
      smooth(windBp.Q, p.q, 0.3, t);
      smooth(wind.gain, p.gain, 0.2, t);
      smooth(buffet.gain, p.gain * 0.9 * clamp((p.centre - 300) / 700, 0, 1), 0.2, t);
    },
    __lapGain: lap,
    active() {
      const out = [];
      for (const [k, v] of Object.entries(allLazy)) if (v.on) out.push(k);
      return out;
    },
    dieselVoice,
    dispose() {
      disposeAll([deepSrc, surfSrc, lapSrc, windSrc, buffetSrc], [deepLp, deep, surfHp, surfLp, surf, lapBp, lapHs, lap, windBp, wind, buffetLp, buffet]);
      main.dispose();
      for (const v of Object.values(allLazy)) v.dispose();
    },
  };
}

export { emitter, lazy, dieselChain, smooth };
