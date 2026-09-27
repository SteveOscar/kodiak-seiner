// Sea-surface wave model (pure; no THREE, no DOM). The GPU shaders in glsl.js mirror every formula in this file
// line for line: change one side, change the other (tests/ocean.test.mjs guards the CPU side).
//
// Surface = sum of Gerstner (trochoidal) waves over the undisplaced grid point x0:
//   theta_i = k_i . x0 - phase_i                     phase_i = omega_i t - phi_i  (mod 2 pi, double precision)
//   P.xz    = x0 + sum q_i a_i d_i cos(theta_i)      d_i = unit travel direction, q_i = crest sharpness
//   P.y     = sum a_i sin(theta_i) + surge(x0)
//   a_i     = A_i * exposure_class(x0) * depthAtten(depth(x0), lambda_i) * distFade(|x0 - fadeCentre|, lambda_i)
//             * (1 + g_i sin(kappa_i . x0 - psi_i))   wave-group envelope: short crests for the wind sea, sets
//                                                     in the swell (psi_i = psi0_i + Omega_i t, group velocity)
// A fixed bank of components (fixed wavelengths, directions and phases, so weather changes never scramble the
// phases); the weather only changes amplitudes. heightAt(x, z) inverts the horizontal displacement with Newton
// iterations (the 2x2 Jacobian is needed for the normal anyway).

import { FETCH_MAX, OUTSIDE_BLEND, OUTSIDE_DEPTH, OUTSIDE_SHORE, directionWeights } from './fetch.js';

export const G = 9.81;
export const TAU = Math.PI * 2;
export const MAX_WAVES = 28;
export const MIN_AMP = 0.003; // components below this (m, open-ocean amplitude) are dropped on both CPU and GPU
export const MAX_SHARPNESS = 0.9; // sum of q k a over all components (< 1 keeps the surface from looping)
// CPU queries skip the smallest components as long as their summed open-ocean amplitude stays below this (m), which
// bounds |heightAt - rendered| well inside the 5 cm contract while roughly halving the cost in a storm.
export const CPU_TOLERANCE = 0.012;
// Horizontal residual (m) at which heightAt stops iterating. Surface slopes stay below ~0.5, so the height error it
// allows is under 2 mm.
export const INVERT_TOLERANCE = 0.004;

// Classes: 0 swell, 1 wind sea, 2 chop.
// Swell: long Gulf of Alaska swell arriving from the south-west (travel headings toward the NE).
const SWELL = [
  // lambda m, travel heading deg, relative energy
  [230, 40, 1.0],
  [165, 53, 0.55],
  [118, 31, 0.3],
  [84, 47, 0.16],
];
export const SWELL_FROM = (220 * Math.PI) / 180; // compass heading the swell comes from
// Wind sea: two wavelength groups, 12 directions each (30 degrees apart, the short group offset by 15 degrees), so
// any wind direction excites ~5 components per group with a broad cos^1.5 spread: short-crested, irregular seas.
const WIND_LONG = [46, 39, 52, 42, 49, 37, 44, 55, 41, 50, 38, 47];
const WIND_SHORT = [19, 23, 17.5, 21, 25, 18, 22.5, 20, 16.5, 24, 19.5, 26];
const WIND_JITTER = [0, 5, -4, 7, -6, 3, -7, 4, -2, 6, -5, 2];
const WIND_SPREAD = 1.5;
const CHOP = [
  [7.3, 15],
  [9.1, 105],
  [6.2, 195],
  [8.4, 285],
  [5.4, 60],
];

// Shore surge: slow wash that runs up and down the beaches (vertical only).
export const SURGE_K = TAU / 26; // rad per metre of shore distance (breaker spacing)
export const SURGE_OMEGA = TAU / 8.5; // rad/s

// Exposure curves: fetch (m) -> 0..1 amplitude factor, normalised so open ocean = 1.
export const EXPO_SWELL = 2200;
export const EXPO_WIND = 1400;
export const EXPO_CHOP = 400;

export const smoothstep = (a, b, x) => {
  let t = (x - a) / (b - a);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
};
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const finite = (v, d) => (Number.isFinite(v) ? v : d);

export function expoCurve(f, f0) {
  return (1 - Math.exp(-f / f0)) / (1 - Math.exp(-FETCH_MAX / f0));
}

export function depthAtten(depth, lambda) {
  return smoothstep(0, 1, depth / (0.07 * lambda + 1));
}

export function distFade(d, lambda, fadeStart, fadeEnd) {
  return 1 - smoothstep(fadeStart * lambda, fadeEnd * lambda, d);
}

// Deterministic smooth variation along the shore for the surge phase (GLSL: surgeNoise()).
export function surgeNoise(x, z) {
  return 1.3 * Math.sin(x * 0.021 + 1.3 * Math.sin(z * 0.017)) + 0.9 * Math.sin(z * 0.031 - 0.8 * Math.sin(x * 0.013));
}

export function surgeWindow(shore) {
  return smoothstep(-4, 3, shore) * (1 - smoothstep(18, 60, shore));
}

// The surge is geometry too, so it must be gone where the flat skirt starts (grid.js maxRadius).
export const SURGE_FADE = [900, 1100];

// The fixed component bank. rng: { next() } (seeded), used only for phases.
export function buildBank(rng) {
  const bank = [];
  const add = (lambda, headingDeg, cls, energy) => {
    const h = (headingDeg * Math.PI) / 180;
    const k = TAU / lambda;
    const dx = Math.sin(h);
    const dz = -Math.cos(h);
    const omega = Math.sqrt(G * k);
    const phi = rng.next() * TAU;
    // Envelope: across the crest (short crests) plus along the travel direction (groups moving at c/2).
    const across = cls === 0 ? 0 : 0.26;
    const along = cls === 0 ? 0.11 : 0.1;
    const g = cls === 0 ? 0.3 : 0.6;
    const side = rng.next() < 0.5 ? -1 : 1;
    const ekx = k * (across * -dz * side + along * dx);
    const ekz = k * (across * dx * side + along * dz);
    bank.push({
      lambda, heading: h, cls, energy, k, dx, dz, kx: k * dx, kz: k * dz, omega, phi,
      g, ekx, ekz, eOmega: along * 0.5 * omega, epsi: rng.next() * TAU, norm: 1 / Math.sqrt(1 + (g * g) / 2),
    });
  };
  for (const [l, h, e] of SWELL) add(l, h, 0, e);
  for (let j = 0; j < 12; j++) add(WIND_LONG[j], j * 30 + WIND_JITTER[j], 1, 1);
  for (let j = 0; j < 12; j++) add(WIND_SHORT[j], j * 30 + 15 - WIND_JITTER[(j + 5) % 12], 1, 1);
  for (const [l, h] of CHOP) add(l, h, 2, 1);
  return bank;
}

// Weather (sky.weather) -> target sea state. `swell` is read as significant swell height in metres.
export function seaStateFromWeather(w = {}) {
  const U = clamp(finite(w.windSpeed, 5), 0, 30);
  const swellHs = clamp(finite(w.swell, 0.6), 0, 5);
  return {
    swellHs,
    windSpeed: U,
    windDir: finite(w.windDir, 0.8),
    windHs: Math.min(4.2, 0.016 * U * U),
    longShare: 0.85 * smoothstep(3, 12, U),
    chopAmp: (0.004 + 0.0042 * U) * smoothstep(0.8, 3.5, U),
    choppiness: 1 + 0.6 * smoothstep(5, 15, U),
    whitecaps: smoothstep(4.5, 12, U),
    detail: 0.04 + 0.96 * smoothstep(0.7, 8, U),
    rain: clamp(finite(w.rain, 0), 0, 1),
  };
}

// Frame-rate independent smoothing of a sea state toward a target (angles take the short way round). Waves build
// and decay over tens of seconds, so gusts barely move them; capillary detail and rain respond within a second or two.
const FAST_KEYS = { detail: 1.5, rain: 1.5 };
export function smoothSeaState(cur, target, dt, tau = 8) {
  const d = Math.max(0, dt);
  for (const key of Object.keys(target)) {
    const f = 1 - Math.exp(-d / (FAST_KEYS[key] ?? tau));
    if (key === 'windDir') {
      let d = target.windDir - cur.windDir;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      cur.windDir += d * f;
    } else cur[key] += (target[key] - cur[key]) * f;
  }
  return cur;
}

// fields: { fetch: computeFetch() result, hm: { size, half, game: Float32Array, shore: Float32Array } }
// grid: { fadeStart, fadeEnd } in wavelengths (from the mesh density).
export function createWaveModel({ bank, fields, fadeStart = 2.5, fadeEnd = 4.2 }) {
  const n = MAX_WAVES;
  const act = {
    count: 0,
    idx: new Int32Array(n),
    kx: new Float64Array(n),
    kz: new Float64Array(n),
    dx: new Float64Array(n),
    dz: new Float64Array(n),
    k: new Float64Array(n),
    omega: new Float64Array(n),
    phase: new Float64Array(n), // omega t - phi, mod 2 pi
    amp: new Float64Array(n), // open-ocean amplitude A_i (m)
    q: new Float64Array(n),
    lambda: new Float64Array(n),
    ws: new Float64Array(n), // class one-hots
    ww: new Float64Array(n),
    wc: new Float64Array(n),
    g: new Float64Array(n), // envelope gain, wavenumber, phase (mod 2 pi), angular speed
    ekx: new Float64Array(n),
    ekz: new Float64Array(n),
    eph: new Float64Array(n),
    eOmega: new Float64Array(n),
    all: Int32Array.from({ length: n }, (_, i) => i),
    cpu: new Int32Array(n), // indices used by CPU queries (largest first)
    cpuCount: 0,
  };
  const swellW = directionWeights(SWELL_FROM, 1.5);
  const windW = new Float32Array(8);
  const st = {
    exact: false, // true: CPU queries use every component (verification)
    time: 0,
    fadeX: 0,
    fadeZ: 0,
    fadeStart,
    fadeEnd,
    surgeAmp: 0,
    surgePhase: 0,
    sea: null,
  };

  // Scratch outputs of sampleEnv/evaluate (no allocation in the hot path).
  const env = { depth: 0, shore: 0, es: 0, ew: 0, ec: 0 };
  const ev = { dx: 0, dz: 0, h: 0, jxx: 0, jxz: 0, jzx: 0, jzz: 0, hx: 0, hz: 0, vx: 0, vy: 0, vz: 0 };
  const attn = new Float64Array(n);

  const F = fields.fetch;
  const FN = F.N;
  const FH = F.half;
  const HM = fields.hm;
  const HN = HM.size;
  const HH = HM.half;

  // Bilinear, texel centres at (i + 0.5) / N, clamp-to-edge: identical to GPU LinearFilter sampling.
  function sampleEnv(x, z) {
    // Heightmap: depth and shore distance.
    let fx = ((x + HH) / (2 * HH)) * HN - 0.5;
    let fz = ((z + HH) / (2 * HH)) * HN - 0.5;
    let x0 = Math.floor(fx);
    let z0 = Math.floor(fz);
    let tx = fx - x0;
    let tz = fz - z0;
    let x1 = x0 + 1;
    let z1 = z0 + 1;
    const hmax = HN - 1;
    x0 = x0 < 0 ? 0 : x0 > hmax ? hmax : x0;
    x1 = x1 < 0 ? 0 : x1 > hmax ? hmax : x1;
    z0 = z0 < 0 ? 0 : z0 > hmax ? hmax : z0;
    z1 = z1 < 0 ? 0 : z1 > hmax ? hmax : z1;
    let a = z0 * HN + x0;
    let b = z0 * HN + x1;
    let c = z1 * HN + x0;
    let d = z1 * HN + x1;
    const g = HM.game;
    const s = HM.shore;
    let height = (g[a] * (1 - tx) + g[b] * tx) * (1 - tz) + (g[c] * (1 - tx) + g[d] * tx) * tz;
    let shore = (s[a] * (1 - tx) + s[b] * tx) * (1 - tz) + (s[c] * (1 - tx) + s[d] * tx) * tz;

    // Fetch: 8 directions.
    fx = ((x + FH) / (2 * FH)) * FN - 0.5;
    fz = ((z + FH) / (2 * FH)) * FN - 0.5;
    x0 = Math.floor(fx);
    z0 = Math.floor(fz);
    tx = fx - x0;
    tz = fz - z0;
    x1 = x0 + 1;
    z1 = z0 + 1;
    const fmax = FN - 1;
    x0 = x0 < 0 ? 0 : x0 > fmax ? fmax : x0;
    x1 = x1 < 0 ? 0 : x1 > fmax ? fmax : x1;
    z0 = z0 < 0 ? 0 : z0 > fmax ? fmax : z0;
    z1 = z1 < 0 ? 0 : z1 > fmax ? fmax : z1;
    a = (z0 * FN + x0) * 4;
    b = (z0 * FN + x1) * 4;
    c = (z1 * FN + x0) * 4;
    d = (z1 * FN + x1) * 4;
    const w00 = (1 - tx) * (1 - tz);
    const w10 = tx * (1 - tz);
    const w01 = (1 - tx) * tz;
    const w11 = tx * tz;
    const A = F.a;
    const B = F.b;
    let fs = 0;
    let fw = 0;
    for (let ch = 0; ch < 4; ch++) {
      const va = A[a + ch] * w00 + A[b + ch] * w10 + A[c + ch] * w01 + A[d + ch] * w11;
      const vb = B[a + ch] * w00 + B[b + ch] * w10 + B[c + ch] * w01 + B[d + ch] * w11;
      fs += va * swellW[ch] + vb * swellW[ch + 4];
      fw += va * windW[ch] + vb * windW[ch + 4];
    }

    // Beyond the world edge the fields fade to open ocean.
    const over = Math.max(Math.abs(x), Math.abs(z)) - HH;
    if (over > 0) {
      const o = over / OUTSIDE_BLEND < 1 ? over / OUTSIDE_BLEND : 1;
      height += (-OUTSIDE_DEPTH - height) * o;
      shore += (OUTSIDE_SHORE - shore) * o;
      fs += (FETCH_MAX - fs) * o;
      fw += (FETCH_MAX - fw) * o;
    }
    env.depth = -height;
    env.shore = shore;
    env.es = expoCurve(fs, EXPO_SWELL);
    env.ew = expoCurve(fw, EXPO_WIND);
    env.ec = 0.35 + 0.65 * expoCurve(fw, EXPO_CHOP);
    return env;
  }

  // Per-component attenuated amplitude at x0 given env (already sampled there).
  let list = act.all;
  let listN = 0;
  function useList(exact) {
    list = exact || st.exact ? act.all : act.cpu;
    listN = exact || st.exact ? act.count : act.cpuCount;
  }

  function attenuate(x, z, useFade) {
    const depth = env.depth;
    const ddx = x - st.fadeX;
    const ddz = z - st.fadeZ;
    const dist = Math.sqrt(ddx * ddx + ddz * ddz);
    for (let j = 0; j < listN; j++) {
      const i = list[j];
      const lam = act.lambda[i];
      const e = act.ws[i] * env.es + act.ww[i] * env.ew + act.wc[i] * env.ec;
      let a = act.amp[i] * e * depthAtten(depth, lam);
      if (useFade) a *= distFade(dist, lam, st.fadeStart, st.fadeEnd);
      attn[i] = a;
    }
  }

  // Displacement and derivatives at undisplaced x0 using attn[] (attenuated amplitude without the envelope).
  function evaluate(x, z, wantVelocity) {
    let dx = 0;
    let dz = 0;
    let h = 0;
    let jxx = 0;
    let jxz = 0;
    let jzx = 0;
    let jzz = 0;
    let hx = 0;
    let hz = 0;
    let vx = 0;
    let vy = 0;
    let vz = 0;
    for (let j = 0; j < listN; j++) {
      const i = list[j];
      const a0 = attn[i];
      if (a0 === 0) continue;
      const g = act.g[i];
      const ekx = act.ekx[i];
      const ekz = act.ekz[i];
      const ph = ekx * x + ekz * z - act.eph[i];
      const es = Math.sin(ph);
      const ec = Math.cos(ph);
      const a = a0 * (1 + g * es);
      const ax = a0 * g * ec * ekx; // da/dx0
      const az = a0 * g * ec * ekz; // da/dz0
      const kx = act.kx[i];
      const kz = act.kz[i];
      const th = kx * x + kz * z - act.phase[i];
      const s = Math.sin(th);
      const c = Math.cos(th);
      const q = act.q[i];
      const ddx = act.dx[i];
      const ddz = act.dz[i];
      dx += q * a * ddx * c;
      dz += q * a * ddz * c;
      h += a * s;
      const qs = q * a * s;
      const qc = q * c;
      jxx += -qs * ddx * kx + qc * ddx * ax;
      jxz += -qs * ddx * kz + qc * ddx * az;
      jzx += -qs * ddz * kx + qc * ddz * ax;
      jzz += -qs * ddz * kz + qc * ddz * az;
      hx += a * kx * c + ax * s;
      hz += a * kz * c + az * s;
      if (wantVelocity) {
        const w = act.omega[i];
        const at = -a0 * g * ec * act.eOmega[i]; // da/dt
        vx += q * ddx * (a * w * s + at * c);
        vz += q * ddz * (a * w * s + at * c);
        vy += -a * w * c + at * s;
      }
    }
    ev.dx = dx;
    ev.dz = dz;
    ev.h = h;
    ev.jxx = jxx;
    ev.jxz = jxz;
    ev.jzx = jzx;
    ev.jzz = jzz;
    ev.hx = hx;
    ev.hz = hz;
    ev.vx = vx;
    ev.vy = vy;
    ev.vz = vz;
    return ev;
  }

  function surgeAt(x, z) {
    if (st.surgeAmp <= 0) return 0;
    const w = surgeWindow(env.shore);
    if (w <= 0) return 0;
    const dist = Math.hypot(x - st.fadeX, z - st.fadeZ);
    const f = 1 - smoothstep(SURGE_FADE[0], SURGE_FADE[1], dist);
    if (f <= 0) return 0;
    return st.surgeAmp * (0.25 + 0.75 * env.es) * w * f * Math.sin(env.shore * SURGE_K + st.surgePhase + surgeNoise(x, z));
  }

  const model = {
    bank,
    act,
    state: st,
    env,
    ev,
    swellW,
    windW,

    // Rebuild the active component list for a sea state at time t (seconds). Call once per frame.
    update(sea, t) {
      st.time = t;
      st.sea = sea;
      directionWeights(sea.windDir + Math.PI, 2, windW);
      const swellNorm = SWELL.reduce((s, c) => s + c[2], 0);
      // Wind groups: amplitude weight cos^2 of the angle to the wind, normalised per group so sum a^2 = Hs^2/8 * share.
      let sumL = 0;
      let sumS = 0;
      for (const c of bank) {
        if (c.cls !== 1) continue;
        const cc = Math.cos(c.heading - sea.windDir);
        const w = cc > 0 ? Math.pow(cc, WIND_SPREAD) : 0;
        if (c.lambda > 30) sumL += w * w;
        else sumS += w * w;
      }
      const baseW = sea.windHs / (2 * Math.SQRT2);
      let count = 0;
      let sharp = 0;
      for (let bi = 0; bi < bank.length && count < MAX_WAVES; bi++) {
        const c = bank[bi];
        let a = 0;
        if (c.cls === 0) {
          a = (sea.swellHs / (2 * Math.SQRT2)) * Math.sqrt(c.energy / swellNorm);
        } else if (c.cls === 1) {
          const cc = Math.cos(c.heading - sea.windDir);
          const w = cc > 0 ? Math.pow(cc, WIND_SPREAD) : 0;
          const long = c.lambda > 30;
          const share = long ? sea.longShare : 1 - sea.longShare;
          const norm = Math.sqrt(long ? sumL : sumS) || 1;
          a = baseW * Math.sqrt(share) * (w / norm);
        } else {
          const cc = Math.cos(c.heading - sea.windDir);
          a = sea.chopAmp * (0.35 + 0.65 * (cc > 0 ? cc * cc : 0));
        }
        if (a < MIN_AMP) continue;
        act.idx[count] = bi;
        act.kx[count] = c.kx;
        act.kz[count] = c.kz;
        act.dx[count] = c.dx;
        act.dz[count] = c.dz;
        act.k[count] = c.k;
        act.omega[count] = c.omega;
        let ph = (c.omega * t - c.phi) % TAU;
        if (ph < 0) ph += TAU;
        act.phase[count] = ph;
        act.amp[count] = a * c.norm;
        act.g[count] = c.g;
        act.ekx[count] = c.ekx;
        act.ekz[count] = c.ekz;
        act.eOmega[count] = c.eOmega;
        let eph = (c.epsi + c.eOmega * t) % TAU;
        if (eph < 0) eph += TAU;
        act.eph[count] = eph;
        act.q[count] = sea.choppiness;
        act.lambda[count] = c.lambda;
        act.ws[count] = c.cls === 0 ? 1 : 0;
        act.ww[count] = c.cls === 1 ? 1 : 0;
        act.wc[count] = c.cls === 2 ? 1 : 0;
        sharp += sea.choppiness * c.k * a * c.norm * (1 + c.g);
        count++;
      }
      act.count = count;
      if (sharp > MAX_SHARPNESS) {
        const s = MAX_SHARPNESS / sharp;
        for (let i = 0; i < count; i++) act.q[i] *= s;
      }
      // CPU subset: drop the smallest components while their summed amplitude stays within CPU_TOLERANCE.
      for (let i = 0; i < count; i++) order[i] = i;
      const ord = order.subarray(0, count).sort((p, q) => act.amp[q] - act.amp[p]);
      let keep = count;
      let skipped = 0;
      const peak = (i) => act.amp[i] * (1 + act.g[i]);
      while (keep > 0 && skipped + peak(ord[keep - 1]) <= CPU_TOLERANCE) skipped += peak(ord[--keep]);
      for (let j = 0; j < keep; j++) act.cpu[j] = ord[j];
      act.cpuCount = keep;
      st.surgeAmp = 0.05 + 0.1 * Math.min(2.5, sea.swellHs + 0.5 * sea.windHs);
      st.surgePhase = (SURGE_OMEGA * t) % TAU;
    },

    setFadeCentre(x, z) {
      st.fadeX = x;
      st.fadeZ = z;
    },

    sampleEnv,

    // Forward map (what the vertex shader does): undisplaced x0 -> displaced surface point.
    forward(x0, z0, out = { x: 0, y: 0, z: 0 }) {
      useList(true);
      sampleEnv(x0, z0);
      attenuate(x0, z0, true);
      evaluate(x0, z0, false);
      out.x = x0 + ev.dx;
      out.z = z0 + ev.dz;
      out.y = ev.h + surgeAt(x0, z0);
      return out;
    },

    // Finds x0 with x0 + D(x0) = (x, z) by Newton iteration (the 2x2 Jacobian is needed for normals anyway), stopping
    // once the horizontal residual is below INVERT_TOLERANCE: one step in calm water, usually two in a storm. Leaves
    // env/attn/ev evaluated at the solution; `out` receives x0.
    invert(x, z, iterations = 3, out = { x: 0, z: 0 }) {
      useList(false);
      let px = x;
      let pz = z;
      sampleEnv(x, z);
      attenuate(x, z, true);
      for (let it = 0; it < iterations; it++) {
        evaluate(px, pz, false);
        const rx = px + ev.dx - x;
        const rz = pz + ev.dz - z;
        if (rx * rx + rz * rz < INVERT_TOLERANCE * INVERT_TOLERANCE) {
          out.x = px;
          out.z = pz;
          return out;
        }
        const a = 1 + ev.jxx;
        const b = ev.jxz;
        const c = ev.jzx;
        const d = 1 + ev.jzz;
        const det = a * d - b * c;
        if (det > 0.15) {
          px -= (d * rx - b * rz) / det;
          pz -= (a * rz - c * rx) / det;
        } else {
          px = x - ev.dx;
          pz = z - ev.dz;
        }
        // Attenuation varies over tens of metres: refreshing it once, after the first (largest) step, is enough.
        if (it === 0) {
          sampleEnv(px, pz);
          attenuate(px, pz, true);
        }
      }
      evaluate(px, pz, false);
      out.x = px;
      out.z = pz;
      return out;
    },

    // Height of the rendered surface at world (x, z).
    heightAt(x, z) {
      if (act.count === 0 && st.surgeAmp <= 0) return 0;
      model.invert(x, z, 3, scratchXZ);
      return ev.h + surgeAt(scratchXZ.x, scratchXZ.z);
    },

    // Height + unit normal (nx, ny, nz written into outN, a {x,y,z} or THREE.Vector3).
    sample(x, z, outN) {
      model.invert(x, z, 3, scratchXZ);
      const height = ev.h + surgeAt(scratchXZ.x, scratchXZ.z);
      // Tangents dP/dx0 = (1 + jxx, hx, jzx), dP/dz0 = (jxz, hz, 1 + jzz); normal = dP/dz0 x dP/dx0.
      const ax = 1 + ev.jxx;
      const ay = ev.hx;
      const az = ev.jzx;
      const bx = ev.jxz;
      const by = ev.hz;
      const bz = 1 + ev.jzz;
      let nx = by * az - bz * ay;
      let ny = bz * ax - bx * az;
      let nz = bx * ay - by * ax;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      if (outN) {
        outN.x = nx;
        outN.y = ny;
        outN.z = nz;
      }
      return height;
    },

    // Orbital velocity of the surface particle at world (x, z) (m/s).
    velocityAt(x, z, out = { x: 0, y: 0, z: 0 }) {
      model.invert(x, z, 3, scratchXZ);
      evaluate(scratchXZ.x, scratchXZ.z, true);
      out.x = ev.vx;
      out.y = ev.vy;
      out.z = ev.vz;
      return out;
    },

    // Significant height (m) of the local sea at world (x, z) including shelter and depth (for audio/spray/debug).
    localHs(x, z) {
      useList(true);
      sampleEnv(x, z);
      attenuate(x, z, false);
      let s = 0;
      for (let i = 0; i < act.count; i++) s += attn[i] * attn[i] * (1 + (act.g[i] * act.g[i]) / 2);
      return 2 * Math.SQRT2 * Math.sqrt(s);
    },
  };
  const scratchXZ = { x: 0, z: 0 };
  const order = new Int32Array(n);
  return model;
}

// Packs the active components as the shaders receive them (uWaveA/uWaveB/uWaveC), shortest wavelength first (the
// fragment shader stops at the first component the vertex lattice resolves), with phases relative to the grid
// centre (cx, cz) so the GPU only ever sees small local coordinates. Returns the component count.
const packOrder = new Int32Array(MAX_WAVES);
export function packWaveUniforms(model, cx, cz, A, B, C) {
  const act = model.act;
  const n = act.count;
  for (let j = 0; j < n; j++) {
    let p = j;
    while (p > 0 && act.lambda[packOrder[p - 1]] > act.lambda[j]) {
      packOrder[p] = packOrder[p - 1];
      p--;
    }
    packOrder[p] = j;
  }
  for (let slot = 0; slot < MAX_WAVES; slot++) {
    const o = slot * 4;
    if (slot < n) {
      const i = packOrder[slot];
      let p = (act.phase[i] - (act.kx[i] * cx + act.kz[i] * cz)) % TAU;
      if (p < 0) p += TAU;
      let ep = (act.eph[i] - (act.ekx[i] * cx + act.ekz[i] * cz)) % TAU;
      if (ep < 0) ep += TAU;
      C[o] = act.ekx[i];
      C[o + 1] = act.ekz[i];
      C[o + 2] = ep;
      C[o + 3] = act.g[i];
      A[o] = act.kx[i];
      A[o + 1] = act.kz[i];
      A[o + 2] = p;
      A[o + 3] = act.amp[i];
      B[o] = act.q[i];
      B[o + 1] = act.lambda[i];
      B[o + 2] = act.ws[i];
      B[o + 3] = act.ww[i];
    } else {
      A[o] = A[o + 1] = A[o + 2] = A[o + 3] = 0;
      C[o] = C[o + 1] = C[o + 2] = C[o + 3] = 0;
      B[o] = 0;
      B[o + 1] = 1;
      B[o + 2] = B[o + 3] = 0;
    }
  }
  return act.count;
}
