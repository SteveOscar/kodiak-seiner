// WP-OCEAN unit tests: CPU wave model vs the GPU formula, inversion convergence, shelter/depth attenuation,
// stamp queue semantics, LOD grid watertightness, and the system API under Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCtx } from './contract.test.mjs';
import { config } from '../src/core/config.js';
import { createGeo } from '../src/core/geo.js';
import { createRng } from '../src/core/rng.js';
import { computeFetch, directionWeights, FETCH_MAX } from '../src/world/water/fetch.js';
import {
  buildBank,
  createWaveModel,
  seaStateFromWeather,
  smoothSeaState,
  packWaveUniforms,
  MAX_WAVES,
  SURGE_K,
  SURGE_FADE,
  EXPO_SWELL,
  EXPO_WIND,
  EXPO_CHOP,
  INVERT_TOLERANCE,
} from '../src/world/water/waves.js';
import { buildGrid, fadeRangeFor } from '../src/world/water/grid.js';
import { createStampQueue, decayFactor, MAX_RIPPLES, MAX_STAMPS_PER_FRAME } from '../src/world/water/stamps.js';
import { WAVE_COMMON } from '../src/world/water/glsl.js';

const ctx0 = fakeCtx();
const hm = ctx0.heightmap;
const geo = createGeo(config.world.half);
const half = config.world.half;
const fetch = computeFetch({ heightAt: hm.heightAt, half });
const fields = { fetch, hm: { size: hm.size, half, game: hm.game, shore: hm.shore } };

function makeModel(weather, { t = 1234.5, fadeAt = [0, 0], cellsHalf = 64 } = {}) {
  const fade = fadeRangeFor(cellsHalf);
  const model = createWaveModel({ bank: buildBank(createRng(7).fork('waves')), fields, fadeStart: fade.start, fadeEnd: fade.end });
  model.setFadeCentre(fadeAt[0], fadeAt[1]);
  model.update(seaStateFromWeather(weather), t);
  return model;
}

const CALM = { windSpeed: 1, swell: 0.4, windDir: 0.5 };
const MODERATE = { windSpeed: 8, swell: 1.2, windDir: 2.2 };
const STORM = { windSpeed: 17, swell: 3.5, windDir: 3.9 };

// Open water well offshore (Chiniak Bay approaches) and a sheltered fjord head (Uganik Bay).
const OPEN = geo.toWorld(57.74, -152.2);
const OUTSIDE = { x: 7700, z: 7700 };

// First water point within `maxShore` m of the coast walking from `from` toward `to`.
function nearShore(from, to, maxShore = 8) {
  for (let t = 0; t <= 1; t += 0.0005) {
    const x = from.x + (to.x - from.x) * t;
    const z = from.z + (to.z - from.z) * t;
    const d = hm.shoreDistance(x, z);
    if (d > 1 && d < maxShore) return { x, z };
  }
  return null;
}
const BEACH = nearShore(OPEN, geo.toWorld(57.79, -152.407));

// ---------------------------------------------------------------------------------------------------------------
// JS transliteration of the GLSL in glsl.js (kWaveEnv + kWaveDisplace), fed with the packed uniforms exactly as the
// GPU receives them: float32 arrays, phases relative to the grid centre, local coordinates.
function f32(v) {
  return Math.fround(v);
}
function texBilinear(data, N, stride, ch, uvx, uvy) {
  const fx = uvx * N - 0.5;
  const fy = uvy * N - 0.5;
  let x0 = Math.floor(fx);
  let y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  let x1 = x0 + 1;
  let y1 = y0 + 1;
  const c = (i) => Math.min(N - 1, Math.max(0, i));
  x0 = c(x0);
  x1 = c(x1);
  y0 = c(y0);
  y1 = c(y1);
  const at = (x, y) => data[(y * N + x) * stride + ch];
  return (at(x0, y0) * (1 - tx) + at(x1, y0) * tx) * (1 - ty) + (at(x0, y1) * (1 - tx) + at(x1, y1) * tx) * ty;
}
const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const hmTex = (() => {
  const d = new Float32Array(hm.size * hm.size * 2);
  for (let k = 0; k < hm.size * hm.size; k++) {
    d[k * 2] = hm.game[k];
    d[k * 2 + 1] = hm.shore[k];
  }
  return d;
})();
function kExpo(f, f0) {
  return (1 - Math.exp(-f / f0)) / (1 - Math.exp(-FETCH_MAX / f0));
}
function gpuDisplace(model, gridX, gridZ, worldX, worldZ) {
  const A = new Float32Array(MAX_WAVES * 4);
  const B = new Float32Array(MAX_WAVES * 4);
  const C = new Float32Array(MAX_WAVES * 4);
  const count = packWaveUniforms(model, gridX, gridZ, A, B, C);
  const fadeU = [model.state.fadeStart, model.state.fadeEnd, f32(model.state.fadeX - gridX), f32(model.state.fadeZ - gridZ)];
  const lx = f32(worldX - gridX);
  const lz = f32(worldZ - gridZ);
  const wx = lx + gridX;
  const wz = lz + gridZ;
  // kWaveEnv
  const uvx = (wx + half) / (2 * half);
  const uvy = (wz + half) / (2 * half);
  let hr = texBilinear(hmTex, hm.size, 2, 0, uvx, uvy);
  let hg = texBilinear(hmTex, hm.size, 2, 1, uvx, uvy);
  const sw = model.swellW;
  const ww = model.windW;
  let fs = 0;
  let fw = 0;
  for (let ch = 0; ch < 4; ch++) {
    const fa = texBilinear(fetch.a, fetch.N, 4, ch, uvx, uvy);
    const fb = texBilinear(fetch.b, fetch.N, 4, ch, uvx, uvy);
    fs += fa * sw[ch] + fb * sw[ch + 4];
    fw += fa * ww[ch] + fb * ww[ch + 4];
  }
  const over = Math.max(Math.abs(wx), Math.abs(wz)) - half;
  if (over > 0) {
    const o = Math.min(over / 600, 1);
    hr += (-60 - hr) * o;
    hg += (1000 - hg) * o;
    fs += (FETCH_MAX - fs) * o;
    fw += (FETCH_MAX - fw) * o;
  }
  const chopExpo = 0.35 + 0.65 * kExpo(fw, EXPO_CHOP);
  const env = [-hr, hg, kExpo(fs, EXPO_SWELL), kExpo(fw, EXPO_WIND)];
  // kWaveDisplace
  const disp = [0, 0, 0];
  const dist = Math.hypot(lx - fadeU[2], lz - fadeU[3]);
  for (let i = 0; i < MAX_WAVES; i++) {
    if (i >= count) break;
    const a0 = A[i * 4 + 3];
    const lam = B[i * 4 + 1];
    const e = B[i * 4 + 2] * env[2] + B[i * 4 + 3] * env[3] + (1 - B[i * 4 + 2] - B[i * 4 + 3]) * chopExpo;
    let a = a0 * e * smoothstep(0, 1, env[0] / (0.07 * lam + 1));
    a *= 1 - smoothstep(fadeU[0] * lam, fadeU[1] * lam, dist);
    if (a === 0) continue;
    a *= 1 + C[i * 4 + 3] * Math.sin(C[i * 4] * lx + C[i * 4 + 1] * lz - C[i * 4 + 2]);
    const th = A[i * 4] * lx + A[i * 4 + 1] * lz - A[i * 4 + 2];
    const k = (2 * Math.PI) / lam;
    const c = Math.cos(th);
    disp[0] += B[i * 4] * a * (A[i * 4] / k) * c;
    disp[2] += B[i * 4] * a * (A[i * 4 + 1] / k) * c;
    disp[1] += a * Math.sin(th);
  }
  const sww = smoothstep(-4, 3, env[1]) * (1 - smoothstep(18, 60, env[1]));
  if (model.state.surgeAmp > 0 && sww > 0) {
    const fo = 1 - smoothstep(SURGE_FADE[0], SURGE_FADE[1], dist);
    const noise = 1.3 * Math.sin(wx * 0.021 + 1.3 * Math.sin(wz * 0.017)) + 0.9 * Math.sin(wz * 0.031 - 0.8 * Math.sin(wx * 0.013));
    disp[1] += model.state.surgeAmp * (0.25 + 0.75 * env[2]) * sww * fo * Math.sin(env[1] * SURGE_K + model.state.surgePhase + noise);
  }
  return { x: wx + disp[0], y: disp[1], z: wz + disp[2] };
}
// ---------------------------------------------------------------------------------------------------------------

test('fetch fields: open sea is exposed, sheltered water and land are not', () => {
  const w = directionWeights(Math.PI, 2);
  const sample = (p) => {
    const i = Math.floor(((p.x + half) / (2 * half)) * fetch.N);
    const j = Math.floor(((p.z + half) / (2 * half)) * fetch.N);
    const k = (j * fetch.N + i) * 4;
    let s = 0;
    for (let c = 0; c < 4; c++) s += fetch.a[k + c] * w[c] + fetch.b[k + c] * w[c + 4];
    return s;
  };
  assert.ok(sample(OUTSIDE) > 6000, 'outside the island the fetch is long');
  const city = geo.toWorld(57.79, -152.407);
  assert.equal(fetch.land[Math.floor(((city.z + half) / (2 * half)) * fetch.N) * fetch.N + Math.floor(((city.x + half) / (2 * half)) * fetch.N)], 1);
  let sumW = 0;
  for (const v of w) sumW += v;
  assert.ok(Math.abs(sumW - 1) < 1e-6);
});

test('GPU formula (transliterated GLSL + packed uniforms) matches the CPU forward map', () => {
  for (const weather of [CALM, MODERATE, STORM]) {
    const model = makeModel(weather, { fadeAt: [OPEN.x, OPEN.z] });
    const gridX = Math.round(OPEN.x / 2) * 2;
    const gridZ = Math.round(OPEN.z / 2) * 2;
    let max = 0;
    for (let i = 0; i < 400; i++) {
      const x0 = gridX + ((i * 37) % 200) - 100 + 0.25 * (i % 4);
      const z0 = gridZ + ((i * 53) % 200) - 100;
      const g = gpuDisplace(model, gridX, gridZ, x0, z0);
      const c = model.forward(x0, z0);
      max = Math.max(max, Math.abs(g.x - c.x), Math.abs(g.y - c.y), Math.abs(g.z - c.z));
    }
    assert.ok(max < 2e-3, `GPU/CPU forward mismatch ${max} m for ${JSON.stringify(weather)}`);
  }
});

test('GPU formula matches near shore (surge, depth attenuation) and beyond the world edge', () => {
  const model = makeModel(MODERATE, { fadeAt: [0, 0] });
  const pts = [
    [BEACH.x, BEACH.z],
    [OUTSIDE.x + 400, OUTSIDE.z],
    [-8100, 300],
  ];
  for (const [x, z] of pts) {
    model.setFadeCentre(x + 10, z - 20);
    const gx = Math.round(x / 2) * 2;
    const gz = Math.round(z / 2) * 2;
    for (let i = 0; i < 50; i++) {
      const x0 = x + (i % 10) * 3.1;
      const z0 = z + Math.floor(i / 10) * 2.7;
      const g = gpuDisplace(model, gx, gz, x0, z0);
      const c = model.forward(x0, z0);
      assert.ok(Math.abs(g.y - c.y) < 2e-3 && Math.abs(g.x - c.x) < 2e-3, `mismatch at ${x0},${z0}`);
    }
  }
});

test('heightAt inverts the horizontal displacement within 5 mm (calm, moderate, storm)', () => {
  for (const weather of [CALM, MODERATE, STORM]) {
    const model = makeModel(weather, { fadeAt: [OPEN.x, OPEN.z] });
    model.state.exact = true;
    let max = 0;
    for (let i = 0; i < 500; i++) {
      const x0 = OPEN.x + Math.sin(i * 12.9898) * 120;
      const z0 = OPEN.z + Math.cos(i * 78.233) * 120;
      const p = model.forward(x0, z0);
      const h = model.heightAt(p.x, p.z);
      max = Math.max(max, Math.abs(h - p.y));
    }
    assert.ok(max < 0.005, `heightAt error ${max} m for ${JSON.stringify(weather)}`);
  }
});

test('CPU component subset keeps heightAt within 3 cm of the rendered surface', () => {
  for (const weather of [CALM, MODERATE, STORM]) {
    const model = makeModel(weather, { fadeAt: [OPEN.x, OPEN.z] });
    assert.ok(model.act.cpuCount <= model.act.count);
    let max = 0;
    for (let i = 0; i < 500; i++) {
      const x0 = OPEN.x + Math.sin(i * 12.9898) * 120;
      const z0 = OPEN.z + Math.cos(i * 78.233) * 120;
      const p = model.forward(x0, z0);
      max = Math.max(max, Math.abs(model.heightAt(p.x, p.z) - p.y));
    }
    assert.ok(max < 0.03, `subset heightAt error ${max} m for ${JSON.stringify(weather)}`);
  }
});

test('Newton inversion converges: error falls with iterations and 3 are enough in a storm', () => {
  const model = makeModel(STORM, { fadeAt: [OPEN.x, OPEN.z] });
  model.state.exact = true;
  const errs = [0, 0, 0, 0, 0, 0];
  const out = { x: 0, z: 0 };
  for (let i = 0; i < 300; i++) {
    const x0 = OPEN.x + Math.sin(i * 3.1) * 60;
    const z0 = OPEN.z + Math.cos(i * 1.7) * 60;
    const p = model.forward(x0, z0);
    for (const it of [1, 2, 3, 5]) {
      model.invert(p.x, p.z, it, out);
      errs[it] = Math.max(errs[it], Math.hypot(out.x - x0, out.z - z0));
    }
  }
  // Iteration stops at INVERT_TOLERANCE, so more iterations cannot do better than that.
  assert.ok(errs[1] > errs[2] && errs[2] >= errs[3], `not converging: ${errs}`);
  assert.ok(errs[2] < INVERT_TOLERANCE * 1.5, `2 iterations leave ${errs[2]} m`);
  assert.ok(errs[3] < INVERT_TOLERANCE * 1.5, `3 iterations leave ${errs[3]} m`);
});

test('sample() normal matches finite differences of heightAt', () => {
  const model = makeModel(MODERATE, { fadeAt: [OPEN.x, OPEN.z] });
  model.state.exact = true;
  const n = { x: 0, y: 0, z: 0 };
  const e = 0.05;
  for (let i = 0; i < 60; i++) {
    const x = OPEN.x + i * 1.7;
    const z = OPEN.z - i * 0.9;
    model.sample(x, z, n);
    const hx = (model.heightAt(x + e, z) - model.heightAt(x - e, z)) / (2 * e);
    const hz = (model.heightAt(x, z + e) - model.heightAt(x, z - e)) / (2 * e);
    const len = Math.hypot(hx, 1, hz);
    const dot = (-hx * n.x + n.y - hz * n.z) / len;
    assert.ok(dot > 0.999, `normal off by ${Math.acos(Math.min(1, dot))} rad`);
    assert.ok(Math.abs(Math.hypot(n.x, n.y, n.z) - 1) < 1e-9);
  }
});

test('sea state scales from glassy calm to storm', () => {
  const calm = makeModel(CALM, { fadeAt: [OPEN.x, OPEN.z] });
  const storm = makeModel(STORM, { fadeAt: [OPEN.x, OPEN.z] });
  const hsCalm = calm.localHs(OPEN.x, OPEN.z);
  const hsStorm = storm.localHs(OPEN.x, OPEN.z);
  assert.ok(hsCalm < 0.6, `calm Hs ${hsCalm}`);
  assert.ok(hsStorm > 2.5, `storm Hs ${hsStorm}`);
  const s = seaStateFromWeather(STORM);
  assert.ok(s.whitecaps > 0.7 && seaStateFromWeather(CALM).whitecaps === 0);
});

test('waves shrink in shallow water, in sheltered bays and fade with distance from the grid centre', () => {
  const model = makeModel(STORM, { fadeAt: [OPEN.x, OPEN.z] });
  const open = model.localHs(OPEN.x, OPEN.z);
  assert.ok(BEACH, 'found a nearshore point');
  const shoreHs = model.localHs(BEACH.x, BEACH.z);
  assert.ok(shoreHs < open * 0.5, `near shore ${shoreHs} vs open ${open}`);
  // A fjord head: Uganik Bay (west Kodiak).
  const fjord = hm.nearestWater(...Object.values(geo.toWorld(57.78, -153.43)), { minShore: 150 });
  const sheltered = model.localHs(fjord.x, fjord.z);
  assert.ok(sheltered < open * 0.75, `sheltered ${sheltered} vs open ${open}`);
  // Far from the fade centre only the long swell remains in the geometry; beyond ~1 km nothing.
  const far = makeModel(STORM, { fadeAt: [OPEN.x + 3000, OPEN.z] });
  const p = far.forward(OPEN.x, OPEN.z);
  assert.ok(Math.abs(p.y) < 1e-9 && Math.abs(p.x - OPEN.x) < 1e-9);
});

test('velocityAt returns orbital motion consistent with the time derivative of the surface', () => {
  const dt = 0.01;
  const m1 = makeModel(MODERATE, { t: 500, fadeAt: [OPEN.x, OPEN.z] });
  const m2 = makeModel(MODERATE, { t: 500 + dt, fadeAt: [OPEN.x, OPEN.z] });
  m1.state.exact = true;
  const x0 = OPEN.x + 13;
  const z0 = OPEN.z - 7;
  const p1 = m1.forward(x0, z0);
  const p2 = m2.forward(x0, z0);
  const v = m1.velocityAt(p1.x, p1.z);
  assert.ok(Math.abs(v.y - (p2.y - p1.y) / dt) < 0.02, `vy ${v.y} vs ${(p2.y - p1.y) / dt}`);
  assert.ok(Math.abs(v.x - (p2.x - p1.x) / dt) < 0.02);
});

test('sea state smoothing eases amplitudes and turns the wind the short way round', () => {
  const cur = seaStateFromWeather({ windSpeed: 2, windDir: 3.0 });
  const target = seaStateFromWeather({ windSpeed: 12, windDir: -3.0 });
  smoothSeaState(cur, target, 0.5, 2);
  assert.ok(cur.windSpeed > 2 && cur.windSpeed < 12);
  assert.ok(cur.windDir > 3.0, 'wind turned through pi, not through zero');
});

test('stamp queue: level foam, ripple ring buffer, per-frame cap and window', () => {
  const q = createStampQueue({ fieldSize: 1024 });
  q.setCentre(100, 200);
  assert.equal(q.stamp(100, 200, 5, 0.8), true);
  assert.equal(q.stamp(100 + 600, 200, 5, 0.8), false, 'outside the window is ignored');
  for (let i = 0; i < 600; i++) q.stamp(100, 200, 2, 0.5);
  assert.equal(q.callsThisFrame, MAX_STAMPS_PER_FRAME);
  assert.ok(q.dropped > 0);
  assert.ok(q.foamCount <= MAX_STAMPS_PER_FRAME);
  q.endFrame();
  assert.equal(q.foamCount, 0);
  q.stamp(0, 0, 100, 5);
  assert.equal(q.foam[2], 40, 'radius clamped to 40');
  assert.equal(q.foam[3], 1, 'strength clamped to 1');
  q.endFrame();
  q.now = 10;
  for (let i = 0; i < 200; i++) {
    q.stamp(100 + i * 0.1, 200, 1, 1, 'ripple');
    if (i % 100 === 99) q.endFrame();
  }
  assert.equal(q.rippleCount, MAX_RIPPLES);
  let first = null;
  q.forEachRipple((x) => (first ??= x));
  assert.ok(Math.abs(first - (100 + 72 * 0.1)) < 1e-4, 'oldest ripples dropped first');
  q.now = 30;
  assert.equal(q.liveRipples(), 0, 'ripples expire');
  // Foam half-life: 4 s regardless of frame rate.
  const a = decayFactor(1 / 30, 4) ** 120;
  const b = decayFactor(1 / 144, 4) ** 576;
  assert.ok(Math.abs(a - 0.5) < 1e-9 && Math.abs(b - 0.5) < 1e-9);
});

test('LOD grid: valid indices, morphed level boundaries are watertight', () => {
  for (const cellsHalf of [96, 64, 48, 32]) {
    const g = buildGrid({ cellsHalf });
    const nV = g.positions.length / 3;
    for (let i = 0; i < g.indices.length; i++) assert.ok(g.indices[i] < nV);
    // Every triangle faces up (front faces seen from above the sea).
    const P = g.positions;
    for (let t = 0; t < g.indices.length; t += 3) {
      const [a, b, c] = [g.indices[t], g.indices[t + 1], g.indices[t + 2]];
      const ux = P[b * 3] - P[a * 3];
      const uz = P[b * 3 + 2] - P[a * 3 + 2];
      const vx = P[c * 3] - P[a * 3];
      const vz = P[c * 3 + 2] - P[a * 3 + 2];
      assert.ok(uz * vx - ux * vz > 0, `triangle ${t / 3} faces down`);
    }
    assert.ok(g.outerRadius >= 1100, 'displaced rings reach past the surge/wave fades');
    // Morph as the vertex shader does; every vertex on a level's outer boundary must land on the next level's
    // lattice, and the skirt's inner vertices must coincide with the last level's morphed boundary.
    const onLattice = new Set();
    const morph = (x, s, z) => {
      const R = s * cellsHalf;
      const cheb = Math.max(Math.abs(x), Math.abs(z));
      const m = Math.min(1, Math.max(0, (cheb / R - 0.7) / 0.25));
      const fx = (((x / s) * 0.5) % 1 + 1) % 1 * 2;
      const fz = (((z / s) * 0.5) % 1 + 1) % 1 * 2;
      return [x - fx * s * m, z - fz * s * m, cheb >= R - 1e-6];
    };
    for (let v = 0; v < nV; v++) {
      const s = g.positions[v * 3 + 1];
      if (s <= 0) continue;
      const [mx, mz, outer] = morph(g.positions[v * 3], s, g.positions[v * 3 + 2]);
      if (outer) {
        assert.ok(Math.abs(mx / (2 * s) - Math.round(mx / (2 * s))) < 1e-9, 'outer boundary on coarse lattice');
        assert.ok(Math.abs(mz / (2 * s) - Math.round(mz / (2 * s))) < 1e-9);
        onLattice.add(`${mx},${mz}`);
      }
    }
    for (let v = 0; v < nV; v++) {
      if (g.positions[v * 3 + 1] !== -1) continue;
      const x = g.positions[v * 3];
      const z = g.positions[v * 3 + 2];
      if (Math.max(Math.abs(x), Math.abs(z)) === g.outerRadius) assert.ok(onLattice.has(`${x},${z}`), 'skirt meets the last ring');
    }
    assert.equal(g.snap % (2 * g.s0), 0);
  }
});

test('GLSL declares the same constants as the CPU model', () => {
  assert.ok(WAVE_COMMON.includes(`#define MAX_WAVES ${MAX_WAVES}`));
  assert.ok(WAVE_COMMON.includes(String(EXPO_SWELL)) && WAVE_COMMON.includes(String(EXPO_WIND)) && WAVE_COMMON.includes(String(EXPO_CHOP)));
  assert.ok(WAVE_COMMON.includes(`${SURGE_K}`));
});

test('heightAt is fast enough for hundreds of calls per frame', () => {
  const model = makeModel(STORM, { fadeAt: [OPEN.x, OPEN.z] });
  let s = 0;
  for (let i = 0; i < 2000; i++) s += model.heightAt(OPEN.x + i * 0.3, OPEN.z);
  // The machine may be shared with other work, so the cost is judged against a reference kernel timed alongside it
  // (one plain sum of the storm's components, the least any exact query must do), best of several interleaved batches.
  const n = 4000;
  const comps = model.act.count;
  let us = Infinity;
  let refUs = Infinity;
  for (let batch = 0; batch < 12; batch++) {
    let t0 = performance.now();
    for (let i = 0; i < n; i++) s += model.heightAt(OPEN.x + ((i + batch * 7) % 400) * 0.37, OPEN.z + (i % 97) * 0.51);
    us = Math.min(us, ((performance.now() - t0) * 1000) / n);
    t0 = performance.now();
    for (let i = 0; i < n; i++) {
      const x = OPEN.x + (i % 400) * 0.37;
      for (let c = 0; c < comps; c++) s += model.act.amp[c] * Math.sin(model.act.kx[c] * x + model.act.kz[c] * i - model.act.phase[c]);
    }
    refUs = Math.min(refUs, ((performance.now() - t0) * 1000) / n);
  }
  assert.ok(Number.isFinite(s));
  console.log(`heightAt: ${us.toFixed(2)} µs/call (${comps} components, storm), ${(us / refUs).toFixed(1)}x one component sum`);
  // Each Newton step evaluates four sines per component (wave and group envelope) plus the environment lookups, and
  // one or two steps are usual: ~15 component sums. 500 calls stay under a millisecond on an idle M-series core
  // (~1.4 µs/call); the bounds catch a regression to exact mode or extra iterations, not load.
  assert.ok(us / refUs < 30, `heightAt costs ${(us / refUs).toFixed(1)} component sums`);
  assert.ok(us < 60, `heightAt ${us.toFixed(2)} µs/call even under load`);
});

test('water system constructs under Node with the full API and occluder handling', async () => {
  const ctx = fakeCtx();
  const { STUBS } = await import('../src/systems/stubs.js');
  ctx.systems.sky = STUBS.sky(ctx);
  const { create } = await import('../src/world/water.js');
  const { missingMembers } = await import('../src/systems/contract.js');
  const water = await create(ctx);
  assert.deepEqual(missingMembers('water', water), []);
  ctx.time.elapsed = 12;
  water.update(0.016);
  const p = ctx.geo.toWorld(57.74, -152.2);
  const h = water.heightAt(p.x, p.z);
  assert.ok(Number.isFinite(h) && Math.abs(h) < 3);
  const s = water.sample(p.x, p.z);
  assert.ok(Number.isFinite(s.height) && s.normal.y > 0.5);
  const v = water.velocityAt(p.x, p.z);
  assert.ok(Number.isFinite(v.x) && Number.isFinite(v.y));
  assert.equal(typeof water.stamp(p.x, p.z, 3, 1), 'boolean');
  const THREE = ctx.THREE;
  const occ = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  occ.visible = false;
  water.addOccluder(occ);
  assert.equal(occ.visible, true);
  assert.equal(occ.renderOrder, 900);
  assert.equal(occ.material.colorWrite, false);
  assert.equal(occ.material.depthWrite, true);
  assert.equal(occ.castShadow, false);
  assert.equal(occ.layers.mask, 1);
  water.removeOccluder(occ);
  assert.equal(occ.visible, false);
  assert.equal(water.mesh.renderOrder, 0);
  assert.equal(water.mesh.material.transparent, true);
  assert.equal(water.mesh.material.depthWrite, true);
  assert.equal(water.mesh.material.fog, true);
  water.reset();
  assert.equal(water.serialize(), undefined);
  assert.ok(ctx.uniforms.uWaveState.value.x > 0);
});
