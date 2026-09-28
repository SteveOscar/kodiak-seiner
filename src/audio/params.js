// Pure mappings from game state to sound parameters (no WebAudio, no DOM). Every level here is a linear gain before
// the channel volumes; the mixer's glue compressor and limiter sit after them. Tunables live in TUNING so a listening
// pass can adjust the mix in one place.

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => (g > 0 ? 20 * Math.log10(g) : -Infinity);
export const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

export const TUNING = {
  bus: { ambience: 1.3, sfx: 1.0, music: 0.5, ui: 0.8 },
  ocean: { deep: 0.2, surf: 0.09, wash: 0.5, lap: 0.11 },
  wind: { gain: 0.2, whistle: 0.018 },
  rain: { patter: 0.3, hiss: 0.05 },
  harbor: { hum: 0.035, clinkRate: 0.2 },
  engine: { main: 0.38, skiff: 0.4, fleet: 0.4, genset: 0.07 },
  hydraulics: 0.12,
  hullWash: 0.16,
  trim: 1.6, // make-up gain into the limiter
  maxVoices: 28,
  speedOfSound: 343,
  radio: { squelch: 0.17, bed: 0.022, voice: 0.045 },
};

export const VOLUME_KEYS = ['master', 'music', 'sfx', 'ambience'];
export const DEFAULT_VOLUMES = { master: 0.8, music: 0.6, sfx: 0.9, ambience: 0.8 };

// Slider 0..1 → gain. Squared so half-way reads as roughly half as loud.
export function volumeCurve(v) {
  const x = clamp(Number(v) || 0, 0, 1);
  return x <= 0.001 ? 0 : x * x;
}

// Merges a partial volumes patch; ignores unknown keys and non-finite values.
export function mergeVolumes(current, patch) {
  const out = { ...DEFAULT_VOLUMES, ...(current ?? {}) };
  if (patch && typeof patch === 'object') {
    for (const k of VOLUME_KEYS) {
      const v = Number(patch[k]);
      if (patch[k] !== undefined && patch[k] !== null && Number.isFinite(v)) out[k] = clamp(v, 0, 1);
    }
  }
  return out;
}

// Air absorption as a low-pass cutoff (Hz): distant blows, horns and thunder lose their top.
export function airCutoff(d) {
  return clamp(20000 * Math.exp(-Math.max(0, d) / 700), 700, 20000);
}

// Seconds of sound travel (capped); splashes more than ~60 m off are heard after they are seen.
export function travelDelay(d, min = 60, cap = 6) {
  return d <= min ? 0 : Math.min(cap, (d - min) / TUNING.speedOfSound);
}

// --------------------------------------------------------------------------------------------- ambience beds

// shoreDist: signed metres at the listener (+ offshore); camHeight: metres above the sea; hs: significant wave height
// (m); interior 0..1 (in the wheelhouse).
export function oceanParams({ shoreDist = 1000, camHeight = 10, hs = 0.6, windSpeed = 6, interior = 0 } = {}) {
  const off = Math.max(0, shoreDist);
  const near = Math.exp(-off / 220);
  const inland = shoreDist < 0 ? Math.exp(shoreDist / 260) : 1;
  const high = 1 / (1 + Math.max(0, camHeight - 12) / 70);
  const sea = clamp(0.35 + hs * 0.5, 0.3, 1.6);
  const chop = smoothstep(3, 16, windSpeed);
  const room = 1 - 0.45 * interior;
  const T = TUNING.ocean;
  return {
    deepGain: T.deep * sea * high * inland * room,
    deepCutoff: (260 + 260 * near + 90 * Math.min(2, hs)) * (1 - 0.3 * interior),
    surfGain: T.surf * sea * (0.35 + 1.15 * near + 0.5 * chop) * high * inland * (1 - 0.65 * interior),
    surfCutoff: (900 + 2600 * near + 900 * chop) * (1 - 0.55 * interior),
    swellDepth: 0.22 + 0.22 * Math.min(1, hs),
    swellHz: 1 / clamp(7 + hs * 1.6, 7, 12),
    washLevel: T.wash * smoothstep(380, 25, shoreDist) * sea * high * (shoreDist < 0 ? Math.exp(shoreDist / 120) : 1) * (1 - 0.6 * interior),
    // Wavelets slopping and crests spilling close by: the mid/high texture that says "water" on small speakers.
    lapGain: T.lap * clamp(0.45 + 0.35 * hs + 0.6 * chop, 0.3, 1.6) * Math.pow(high, 1.5) * inland * (1 - 0.7 * interior),
    lapCentre: (800 + 900 * chop + 500 * near) * (1 - 0.4 * interior),
    lapRate: 0.7 + 0.5 * Math.min(2, hs) + 0.8 * chop,
    near,
  };
}

// Lapping: a train of soft sloshes (Poisson onsets at `rate` per second; each swells in ~0.1 s and ebbs over ~0.5 s).
// st = { env, target, next } is updated in place; returns a gain envelope ~0.2..1.2.
export function lapStep(st, dt, rate, r = Math.random) {
  st.next = (st.next ?? 0) - dt;
  if (st.next <= 0) {
    st.next = 0.08 - Math.log(1 - Math.min(0.999, r())) / Math.max(0.05, rate);
    st.target = Math.max(st.target ?? 0, 0.35 + 0.65 * r());
  }
  st.target = (st.target ?? 0) * Math.exp(-dt / 0.25);
  const env = st.env ?? 0;
  const k = st.target > env ? 1 - Math.exp(-dt / 0.08) : 1 - Math.exp(-dt / 0.45);
  st.env = env + (st.target - env) * k;
  return clamp(0.2 + st.env, 0, 1.2);
}

// Surf breaks arrive every 6–11 s on a gently shelving Kodiak beach; bigger seas break less often but harder.
export function washInterval(hs, r = 0.5) {
  return 6 + Math.min(3, hs * 1.2) + r * 3;
}

// gust: 0..1 slowly wandering value (see gustStep).
export function windParams({ windSpeed = 6, gust = 0.5, camHeight = 10, interior = 0, onFoot = false } = {}) {
  const w = Math.max(0, windSpeed) * (0.75 + 0.5 * gust);
  const level = Math.pow(smoothstep(1, 22, w), 1.25);
  const up = 1 + Math.min(1.3, Math.max(0, camHeight - 20) / 160);
  const T = TUNING.wind;
  return {
    gain: T.gain * level * up * (1 - 0.72 * interior),
    centre: 260 + 34 * w + 160 * gust + (onFoot ? 80 : 0),
    q: 0.55 + 0.6 * gust,
    whistleGain: onFoot ? 0 : T.whistle * smoothstep(8, 20, w) * (1 - 0.4 * interior),
    whistleHz: 640 + 48 * w + 260 * gust,
  };
}

// A bounded random walk with inertia: gusts build over 1–3 s and fall away.
export function gustStep(g, dt, r) {
  const target = g.target ?? 0.5;
  let v = (g.v ?? 0) + (target - (g.value ?? 0.5)) * dt * 1.4;
  v *= Math.exp(-dt * 1.6);
  let value = clamp((g.value ?? 0.5) + v * dt, 0, 1);
  let t = (g.timer ?? 0) - dt;
  let nextTarget = target;
  if (t <= 0) {
    t = 1 + r * 3;
    nextTarget = clamp(0.5 + (r - 0.5) * 1.4 + (r > 0.85 ? 0.3 : 0), 0, 1);
  }
  return { value, v, target: nextTarget, timer: t };
}

export function rainParams({ rain = 0, interior = 0 } = {}) {
  const r = clamp(rain, 0, 1);
  const T = TUNING.rain;
  return {
    patterGain: T.patter * Math.pow(r, 0.8) * (1 + 0.25 * interior),
    patterCutoff: lerp(9000, 1700, interior),
    patterHighpass: lerp(420, 140, interior),
    hissGain: T.hiss * Math.pow(r, 1.2) * (1 - 0.6 * interior),
    rate: 0.85 + 0.3 * r,
  };
}

// ----------------------------------------------------------------------------------------------------- engines

export const DIESELS = {
  // 58' limit seiner: a big six at 650–1800 rpm, heavy flywheel.
  main: { cylinders: 6, idleRpm: 650, maxRpm: 1800, spoolUp: 1.4, spoolDown: 1.9, ref: 22, gain: 1, turbo: 1 },
  // Seine skiff: a big inboard diesel revved hard, lighter and quicker.
  skiff: { cylinders: 6, idleRpm: 750, maxRpm: 2500, spoolUp: 0.55, spoolDown: 0.8, ref: 12, gain: 1, turbo: 0.25 },
  fleet: { cylinders: 6, idleRpm: 700, maxRpm: 1750, spoolUp: 1.6, spoolDown: 2, ref: 20, gain: 1, turbo: 0.6 },
};

export function newEngineState() {
  return { phase: 'off', rpm: 0, load: 0, on: 0, crank: 0 };
}

// Advances an engine: 'off' → 'cranking' (starter, ~0.8 s) → 'running'; a stop runs the rpm down through slow chugs.
// input: { throttle -1..1, load 0..1, running bool, demand 0..1 (hydraulics hold the rpm up) }.
// Returns the event that happened this step ('start' | 'catch' | 'stop' | null).
export function engineStep(st, { throttle = 0, load = 0, running = true, demand = 0 } = {}, cfg = DIESELS.main, dt = 0) {
  let ev = null;
  if (running && st.phase === 'off') {
    st.phase = st.rpm > cfg.idleRpm * 0.5 ? 'running' : 'cranking';
    st.crank = 0;
    ev = st.phase === 'cranking' ? 'start' : null;
  } else if (!running && st.phase !== 'off') {
    st.phase = 'off';
    ev = 'stop';
  }
  const lever = clamp(Math.abs(throttle), 0, 1);
  let target = 0;
  if (st.phase === 'cranking') {
    st.crank += dt;
    target = 160;
    if (st.crank > 0.85) {
      st.phase = 'running';
      ev = 'catch';
      st.rpm = Math.max(st.rpm, cfg.idleRpm * 0.7);
    }
  }
  if (st.phase === 'running') {
    const drive = clamp(Math.max(lever * 0.88 + load * 0.12, demand), 0, 1);
    target = cfg.idleRpm + (cfg.maxRpm - cfg.idleRpm) * drive;
    target *= 1 - 0.035 * clamp(load - lever, 0, 1); // lugging under load droops a little
  }
  const tau = target > st.rpm ? (st.phase === 'cranking' ? 0.08 : cfg.spoolUp) : st.phase === 'off' ? 0.7 : cfg.spoolDown;
  if (dt > 0) st.rpm += (target - st.rpm) * (1 - Math.exp(-dt / tau));
  if (st.phase === 'off' && st.rpm < 40) st.rpm = 0;
  if (dt > 0) {
    st.load += (clamp(load, 0, 1) - st.load) * (1 - Math.exp(-dt / 0.35));
    const onTarget = st.phase === 'off' ? (st.rpm > 60 ? 0.6 : 0) : 1;
    st.on += (onTarget - st.on) * (1 - Math.exp(-dt / (st.phase === 'off' ? 0.6 : 0.25)));
  }
  return ev;
}

// Engine sound parameters from its state: cycle frequency drives the chugging PeriodicWave (one whole four-stroke
// cycle per period), the rest shape the layers.
export function dieselVoice(st, cfg = DIESELS.main) {
  const rpm = Math.max(0, st.rpm);
  const r = clamp((rpm - cfg.idleRpm) / (cfg.maxRpm - cfg.idleRpm), 0, 1);
  const load = clamp(st.load, 0, 1);
  const on = clamp(st.on, 0, 1);
  const cranking = st.phase === 'cranking';
  return {
    cycleHz: Math.max(0.5, rpm / 120),
    firingHz: Math.max(1, (rpm / 120) * cfg.cylinders),
    gain: on * (cranking ? 0.25 : 0.52 + 0.2 * r + 0.22 * load),
    cutoff: 320 + 1000 * r + 900 * load,
    body: on * (0.55 + 0.25 * load),
    clatter: on * (cranking ? 0.05 : 0.2 * (1 - 0.55 * r) * (1 - 0.3 * load)),
    clatterHz: 2300 + 900 * r,
    exhaust: on * (0.05 + 0.3 * load + 0.12 * r),
    exhaustCutoff: 380 + 700 * r + 500 * load,
    turboHz: 1900 + 3400 * r,
    turbo: on * 0.006 * r * (0.3 + load) * (cfg.turbo ?? 1),
    hiss: on * 0.035 * r * (0.4 + load),
  };
}

// Skiff engine effort when the skiff system doesn't publish one.
export function skiffEffortFor(state) {
  switch (state) {
    case 'released':
      return 0.75;
    case 'holding':
      return 0.35;
    case 'towing':
    case 'towingOff':
      return 0.85;
    case 'closing':
      return 0.8;
    case 'returning':
    case 'ferry':
      return 0.6;
    default:
      return null; // stowed / tied: engine off
  }
}

// Hydraulics: the pump is driven off the main engine (gear whine at 9 teeth × shaft rate), loaded by the purse winch
// or the power block. rate 0..1+ is how hard the gear is working.
export function hydraulicParams({ mode = null, rate = 0, engineRpm = 1200 } = {}) {
  if (!mode) return { gain: 0, whineHz: 180, hiss: 0, rumble: 0, corkRate: 0 };
  const w = clamp(rate, 0, 1.4);
  const shaft = Math.max(600, engineRpm) / 60;
  const T = TUNING.hydraulics;
  return {
    gain: T * (0.35 + 0.65 * Math.min(1, w)),
    whineHz: shaft * 9 * (1.02 - 0.06 * Math.min(1, w)),
    hiss: 0.25 + 0.5 * Math.min(1, w),
    rumble: mode === 'purse' ? 0.4 + 0.4 * Math.min(1, w) : 0.12,
    corkRate: mode === 'haul' ? 1.6 + 2.2 * w : mode === 'pay' ? 1.2 * w : 0,
  };
}

// Bow wave and wake rush, heard from the hull when the boat has way on.
export function hullWashParams(speed = 0) {
  const s = Math.abs(speed);
  return {
    gain: TUNING.hullWash * Math.pow(smoothstep(0.4, 11, s), 0.9),
    centre: 500 + 90 * s,
  };
}

// --------------------------------------------------------------------------------------------------- one-shots

const FISH_LEN = { pink: 0.5, chum: 0.72, sockeye: 0.6, coho: 0.65, king: 0.9 };

// A fish jump as a list of hits relative to the fish:jump event (which fires at launch).
// → [{ t, kind: 'exit'|'entry'|'walk'|'swirl'|'slap', strength, bodyHz, decay, slap, bubbles }]
export function splashPlan({ species = 'pink', size, style } = {}, r = Math.random) {
  const len = Number.isFinite(size) && size > 0 ? size : FISH_LEN[species] ?? 0.6;
  const k = clamp(len / 0.6, 0.5, 2);
  const st = style ?? { pink: 'popcorn', sockeye: 'leap', chum: 'flop', coho: 'tailwalk', king: 'roll' }[species] ?? 'popcorn';
  const body = (base) => base / Math.sqrt(k);
  const hits = [];
  const hit = (t, kind, strength, bodyHz, decay, slap = 0, bubbles = 1) =>
    hits.push({ t, kind, strength: strength * Math.sqrt(k), bodyHz: body(bodyHz), decay: decay * Math.sqrt(k), slap, bubbles });
  switch (st) {
    case 'popcorn': {
      const dur = 0.42 + 0.14 * r();
      hit(0.04, 'exit', 0.18, 1900, 0.05, 0, 1);
      hit(dur, 'entry', 0.42, 1600, 0.11, 0.1, 2);
      if (r() < 0.4) hit(dur + 0.22 + 0.2 * r(), 'entry', 0.25, 1800, 0.08, 0, 1);
      break;
    }
    case 'leap':
      hit(0.06, 'exit', 0.2, 1500, 0.06, 0, 1);
      hit(0.78 + 0.14 * r(), 'entry', 0.36, 1250, 0.1, 0, 3); // clean head-first: little splash, a deep plunk
      break;
    case 'flop':
      hit(0.06, 'exit', 0.3, 1200, 0.08, 0, 1);
      hit(0.66 + 0.12 * r(), 'slap', 1.0, 750, 0.22, 1, 2); // falls flat on its side
      break;
    case 'tailwalk': {
      hit(0.07, 'exit', 0.28, 1400, 0.07, 0, 1);
      let t = 0.85 + 0.12 * r();
      hit(t, 'entry', 0.5, 1150, 0.13, 0.35, 2);
      const walks = 4 + Math.floor(r() * 6);
      for (let i = 0; i < walks; i++) hit(t + 0.05 + i * 0.075, 'walk', 0.22 * (1 - i * 0.05), 1700 + 400 * r(), 0.045, 0.2, 0);
      t += 0.05 + walks * 0.075 + 0.55 + 0.2 * r();
      hit(t, 'entry', 0.45, 1200, 0.12, 0.3, 2);
      break;
    }
    case 'roll':
      hit(0.4, 'swirl', 0.3, 520, 0.3, 0, 2);
      hit(0.95 + 0.2 * r(), 'swirl', 0.42, 460, 0.35, 0.15, 3);
      break;
    case 'thrash':
    default: {
      const n = 2 + Math.floor(r() * 3);
      for (let i = 0; i < n; i++) hit(i * (0.06 + 0.08 * r()), 'slap', 0.3 + 0.2 * r(), 1300 + 500 * r(), 0.06, 0.6, 1);
      break;
    }
  }
  return hits;
}

// Footstep recipes by terrain surface (terrain.surfaceAt + 'water' wading + 'skiff' deck).
export const FOOTSTEPS = {
  gravel: { thudHz: 140, thud: 0.25, grains: 14, grainHz: 3200, grainQ: 1.6, grain: 0.45, spread: 0.09, swish: 0.14, swishHz: 2600, ping: 0, slosh: 0 },
  sand: { thudHz: 110, thud: 0.3, grains: 4, grainHz: 1500, grainQ: 0.8, grain: 0.14, spread: 0.06, swish: 0.22, swishHz: 1100, ping: 0, slosh: 0 },
  grass: { thudHz: 120, thud: 0.3, grains: 0, grainHz: 0, grainQ: 1, grain: 0, spread: 0, swish: 0.24, swishHz: 4200, ping: 0, slosh: 0 },
  forest: { thudHz: 100, thud: 0.4, grains: 3, grainHz: 2600, grainQ: 4, grain: 0.35, spread: 0.1, swish: 0.1, swishHz: 2600, ping: 0, slosh: 0 },
  alder: { thudHz: 115, thud: 0.3, grains: 1, grainHz: 2800, grainQ: 3, grain: 0.2, spread: 0.05, swish: 0.3, swishHz: 3600, ping: 0, slosh: 0 },
  rock: { thudHz: 170, thud: 0.28, grains: 4, grainHz: 2400, grainQ: 2, grain: 0.4, spread: 0.03, swish: 0.08, swishHz: 3200, ping: 0.1, pingHz: 820, slosh: 0 },
  snow: { thudHz: 95, thud: 0.25, grains: 12, grainHz: 1700, grainQ: 1.2, grain: 0.3, spread: 0.12, swish: 0.12, swishHz: 1500, ping: 0, slosh: 0 },
  water: { thudHz: 90, thud: 0.15, grains: 0, grainHz: 0, grainQ: 1, grain: 0, spread: 0, swish: 0, ping: 0, slosh: 0.5 },
  skiff: { thudHz: 190, thud: 0.35, grains: 1, grainHz: 2400, grainQ: 2, grain: 0.15, spread: 0.01, swish: 0, ping: 0.22, pingHz: 410, slosh: 0 },
};

export function footstepRecipe(surface, run = false) {
  const base = FOOTSTEPS[surface] ?? FOOTSTEPS.gravel;
  const k = run ? 1.35 : 1;
  return { ...base, surface: FOOTSTEPS[surface] ? surface : 'gravel', thud: base.thud * k, grain: base.grain * k, swish: (base.swish ?? 0) * k, spread: base.spread * (run ? 0.75 : 1), gain: run ? 0.5 : 0.38 };
}

// Mean seconds between gull calls near the listener.
export function gullInterval({ near = 0, working = 0, swarm = false, harbor = 0, daylight = 1 } = {}) {
  const day = 0.25 + 0.75 * clamp(daylight, 0, 1);
  const rate = (0.04 + 0.08 * Math.sqrt(near) + 0.3 * working + (swarm ? 1.2 : 0) + 0.12 * harbor) * day;
  return 1 / Math.max(0.01, rate);
}

// Gull call type and shape; `excited` (working birds, the bag) favours kek-kek bursts.
export function gullCall(r = Math.random, excited = false) {
  const x = r();
  const type = excited ? (x < 0.45 ? 'kek' : x < 0.8 ? 'long' : 'mew') : x < 0.5 ? 'long' : x < 0.75 ? 'mew' : 'kek';
  const pitch = 820 + 380 * r();
  const notes = type === 'long' ? 3 + Math.floor(r() * 4) : type === 'kek' ? 3 + Math.floor(r() * 4) : 1;
  return { type, pitch, notes, rasp: 0.18 + 0.2 * r() };
}

// VHF: the "voice" lasts as long as the caption types out (UI typewriter at 42 cps).
export function radioTiming(text, cps = 42) {
  const n = String(text ?? '').length;
  const voice = clamp(n / cps, 0.6, 9);
  return { voice, total: voice + 0.45, duck: voice + 1.2 };
}

// Set-complete stinger: semitone offsets from the key root; plucks are [semitone, beat].
export function stingerFor(rating, cited = false) {
  if (cited) return { name: 'cited', plucks: [[-5, 0], [-6, 0.5]], pad: [-12, -5, 1], bright: 0.2, level: 0.6, cue: null };
  switch (rating) {
    case 'plugged':
      return { name: 'plugged', plucks: [[0, 0], [7, 0.33], [12, 0.66], [16, 1], [19, 1.33], [24, 1.66]], pad: [-12, 0, 4, 7, 14], bright: 1, level: 1, shimmer: true, cue: 'triumph' };
    case 'good':
      return { name: 'good', plucks: [[0, 0], [4, 0.33], [7, 0.66], [12, 1]], pad: [-12, 0, 7, 16], bright: 0.8, level: 0.85, cue: null };
    case 'fair':
      return { name: 'fair', plucks: [[7, 0], [9, 0.4], [4, 0.8]], pad: [-12, 0, 7], bright: 0.55, level: 0.7, cue: null };
    case 'water haul':
    default:
      return { name: 'water haul', plucks: [[7, 0], [2, 0.6]], pad: [-12, -5], bright: 0.3, level: 0.55, cue: null };
  }
}

// Discovery chord: none for memorial places; open voicings for high/wild places, a reflective minor colour for history.
export function discoveryChord({ kind, memorial } = {}) {
  if (memorial) return null;
  if (kind === 'peak' || kind === 'viewpoint' || kind === 'lake') return { name: 'open', notes: [-12, -5, 2, 7, 14], arp: [7, 14, 19] };
  if (kind === 'history') return { name: 'reflective', notes: [-12, -5, 3, 7, 14], arp: [3, 7, 14] };
  if (kind === 'wildlife' || kind === 'stream' || kind === 'river') return { name: 'bright', notes: [-12, 0, 4, 9, 16], arp: [9, 16, 21] };
  return { name: 'warm', notes: [-12, -5, 4, 7, 14], arp: [4, 11, 16] };
}

const WORKING_STATES = new Set(['setting', 'holding', 'closing', 'pursing', 'hauling', 'brailing']);

// Which generative piece should be playing. dawnDay: the day whose dawn piece already played.
export function musicCue({ mode, hours = 12, day = 0, fishing = 'idle', dawnDay = -1, triumphUntil = -1, now = 0, current = null } = {}) {
  if (mode === 'title') return 'title';
  if (mode === 'loading') return null;
  if (mode === 'cutscene') return current;
  if (now < triumphUntil) return 'triumph';
  if (WORKING_STATES.has(fishing)) return null;
  if (current === 'dawn') return 'dawn';
  if (hours >= 4.3 && hours < 7.5 && dawnDay !== day && (mode === 'play' || mode === 'paused')) return 'dawn';
  return null;
}
