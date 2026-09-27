// WP-TERRAIN unit tests: DEM clean-up, the full-detail surface, LOD error budget, quadtree selection, land cover
// from real geography, and CPU sun visibility. Everything here is DOM-free (the GPU side is checked in the smoke run
// by terrain.verifyGpuParity()).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCtx } from './contract.test.mjs';
import { despike } from '../src/world/terrain/despike.js';
import { createSurface, createCurvature, L0, OUTSIDE_DEPTH, vnoise, hash2, LATTICE, latticeRGBA, LATTICE_N } from '../src/world/terrain/surface.js';
import { createBounds, createSelector, coarsestAt, DEFAULT_RANGES, morphParams, ROOT_ORIGIN, ROOT_SIZE, DEEP_Y, DEEP_LEVEL, SHALLOW_Y, SHALLOW_LEVEL, spacing } from '../src/world/terrain/quadtree.js';
import { buildRegion, createLandcover, REGION_SIZE } from '../src/world/terrain/landcover.js';
import { createSunVisibility, marchSun } from '../src/world/terrain/sunvis.js';
import { computeDrainage, createWetnessSampler } from '../src/world/terrain/drainage.js';
import { isDeveloped, FOOTPRINTS } from '../src/data/places.js';

const SURFACES = new Set(['sand', 'gravel', 'grass', 'forest', 'alder', 'rock', 'snow', 'water']);

// One shared world (building it takes a second or two).
const world = (() => {
  const ctx = fakeCtx();
  const hm = ctx.heightmap;
  const { heights, fixed } = despike(hm.game, hm.size);
  const surface = createSurface({ game: heights, size: hm.size, half: hm.half });
  const dev = (x, z) => isDeveloped(x, z, ctx.geo);
  const region = buildRegion({ geo: ctx.geo, half: hm.half, isDeveloped: dev });
  const drainage = computeDrainage(heights, hm.size, hm.size >> 1);
  const wetnessAt = createWetnessSampler(drainage, hm.half);
  const landcover = createLandcover({ surface, heightmap: hm, region, half: hm.half, isDeveloped: dev, curvatureAt: createCurvature(heights, hm.size, hm.half), wetnessAt });
  return { ctx, hm, heights, fixed, surface, region, landcover, dev, drainage, wetnessAt };
})();

function lcg(seed = 1) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

// Rendered height of the level-L lattice (L0 * 2^L) with the detail displacement weighted by dw, triangulated like
// the GPU grid (diagonal from (i+1, j) to (i, j+1)).
function latticeHeight(surface, x, z, L, dw) {
  const g = [0, 0, 0];
  const f = (px, pz) => {
    surface.smooth(px, pz, g);
    return g[0] + dw * surface.detail(px, pz, g[0], g[1], g[2]);
  };
  const s = L0 * 2 ** L;
  const gx = (x + surface.half) / s;
  const gz = (z + surface.half) / s;
  const i = Math.floor(gx);
  const j = Math.floor(gz);
  const fx = gx - i;
  const fz = gz - j;
  const x0 = -surface.half + i * s;
  const z0 = -surface.half + j * s;
  const hb = f(x0 + s, z0);
  const hc = f(x0, z0 + s);
  if (fx + fz <= 1) {
    const ha = f(x0, z0);
    return ha + (hb - ha) * fx + (hc - ha) * fz;
  }
  const hd = f(x0 + s, z0 + s);
  return hd + (hc - hd) * (1 - fx) + (hb - hd) * (1 - fz);
}

const quantile = (arr, q) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
};

test('despike removes isolated DEM glitches on land and leaves coastlines alone', () => {
  const n = 32;
  const g = new Float32Array(n * n).fill(20);
  for (let j = 0; j < n; j++) for (let i = 0; i < 6; i++) g[j * n + i] = -5; // sea strip
  g[16 * n + 16] = 260; // tile-seam spike
  g[10 * n + 20] = -80; // pit
  g[16 * n + 6] = 60; // a spike next to the sea is still land-dominated -> fixed
  const { heights, fixed } = despike(g, n);
  assert.equal(heights[16 * n + 16], 20);
  assert.equal(heights[10 * n + 20], 20);
  assert.ok(fixed >= 2);
  for (let j = 0; j < n; j++) assert.equal(heights[j * n + 2], -5, 'sea texels untouched');
  // The real DEM: only a handful of texels change, and never more than a few hundred.
  assert.ok(world.fixed > 0 && world.fixed < 2000, `despiked ${world.fixed}`);
});

test('noise lattice: JS value noise matches the packed GPU lattice and the ALU hash', () => {
  const rgba = latticeRGBA();
  for (const [i, j] of [[0, 0], [5, 9], [255, 255], [128, 3]]) {
    const k = (j * LATTICE_N + i) * 4;
    assert.equal(rgba[k], LATTICE[j * LATTICE_N + i]);
    assert.equal(rgba[k + 1], LATTICE[j * LATTICE_N + ((i + 1) & 255)]);
    assert.equal(rgba[k + 2], LATTICE[((j + 1) & 255) * LATTICE_N + i]);
    // GLSL tkLat(): float(h >> 24) / 255 with the same 32-bit hash.
    assert.equal(LATTICE[j * LATTICE_N + i], Math.floor(hash2(i, j) * 256));
  }
  assert.equal(vnoise(3, 7), LATTICE[7 * 256 + 3] / 255, 'noise passes through lattice values');
  const g = [0, 0];
  const e = 1e-4;
  const v = vnoise(3.3, 7.6, g);
  assert.ok(Math.abs((vnoise(3.3 + e, 7.6) - v) / e - g[0]) < 1e-2);
  assert.ok(Math.abs((vnoise(3.3, 7.6 + e) - v) / e - g[1]) < 1e-2);
});

test('heightAt is the L0 triangulation of the full-detail surface and follows the DEM', () => {
  const { surface, hm } = world;
  const r = lcg(3);
  // Exact at lattice vertices.
  for (let k = 0; k < 200; k++) {
    const x = -hm.half + Math.floor(r() * 8192) * L0;
    const z = -hm.half + Math.floor(r() * 8192) * L0;
    assert.ok(Math.abs(surface.heightAt(x, z) - surface.full(x, z)) < 1e-6);
  }
  // Continuous across triangle edges (no steps larger than the local slope allows).
  let maxStep = 0;
  for (let k = 0; k < 2000; k++) {
    const x = (r() * 2 - 1) * 7000;
    const z = (r() * 2 - 1) * 7000;
    maxStep = Math.max(maxStep, Math.abs(surface.heightAt(x + 0.01, z) - surface.heightAt(x, z)));
  }
  assert.ok(maxStep < 0.1, `max step over 1 cm: ${maxStep}`);
  // Close to the core heightmap on average (Catmull-Rom vs bilinear, despike, detail displacement).
  const diffs = [];
  for (let k = 0; k < 20000; k++) {
    const x = (r() * 2 - 1) * 7900;
    const z = (r() * 2 - 1) * 7900;
    const h = hm.heightAt(x, z);
    if (h > 0) diffs.push(Math.abs(surface.heightAt(x, z) - h));
  }
  assert.ok(quantile(diffs, 0.5) < 0.5, `median |terrain - heightmap| ${quantile(diffs, 0.5)}`);
  assert.ok(quantile(diffs, 0.95) < 3, `p95 |terrain - heightmap| ${quantile(diffs, 0.95)}`);
  // Same land/water split as the heightmap away from the waterline.
  let flips = 0;
  let n = 0;
  for (let k = 0; k < 20000; k++) {
    const x = (r() * 2 - 1) * 7900;
    const z = (r() * 2 - 1) * 7900;
    const h = hm.heightAt(x, z);
    if (Math.abs(h) < 1.5) continue;
    n++;
    if (Math.sign(h) !== Math.sign(surface.heightAt(x, z))) flips++;
  }
  assert.ok(flips / n < 0.002, `land/water flips ${flips}/${n}`);
});

test('beyond the world square the mirrored land sinks to the outside depth', () => {
  const { surface } = world;
  assert.ok(Math.abs(surface.heightAt(12000, 0) - OUTSIDE_DEPTH) < 1e-6);
  assert.ok(Math.abs(surface.heightAt(0, -12500) - OUTSIDE_DEPTH) < 1e-6);
  // The Alaska Peninsula (NW corner) continues past the edge instead of ending in a wall.
  assert.ok(surface.heightAt(-8150, -6500) > 20);
});

// Rendered height at distance d for the coarsest geometry the quadtree can use there: the level's lattice, blended
// toward the next level's by the morph factor (detail fades out across level 2's morph; levels 3+ carry none).
function renderedAt(surface, x, z, d) {
  const { level: L, morph: K } = coarsestAt(d);
  const dw = (l, k) => (l < 2 ? 1 : l === 2 ? 1 - k : 0);
  const a = latticeHeight(surface, x, z, L, dw(L, K));
  return K > 0 ? a + (latticeHeight(surface, x, z, L + 1, dw(L + 1, 0) * (L + 1 < 2 ? 1 : 0)) - a) * K : a;
}

test('LOD ranges meet the SPEC §3 error budget on placeable ground', () => {
  // Morph bands never overlap the next level's band and every range grows.
  const m = morphParams(DEFAULT_RANGES);
  for (let L = 1; L < DEFAULT_RANGES.length; L++) {
    assert.ok(DEFAULT_RANGES[L] > DEFAULT_RANGES[L - 1]);
    assert.ok(m[L].start > DEFAULT_RANGES[L - 1], `level ${L} morph starts inside level ${L - 1}'s band`);
  }
  assert.ok(coarsestAt(600).level <= 1, 'level 1 or finer within 600 m');
  assert.ok(coarsestAt(3000).level <= 3 && coarsestAt(3000).morph === 0, 'level 3 unmorphed or finer within 3 km');
  // Measured deviation from heightAt on the real DEM, on ground under 20° (buildings, piers, animals at rest).
  const { surface, hm } = world;
  const r = lcg(11);
  const g = [0, 0, 0];
  const e600 = [];
  const e3k = [];
  while (e600.length < 8000) {
    const x = (r() * 2 - 1) * 7900;
    const z = (r() * 2 - 1) * 7900;
    if (hm.heightAt(x, z) < -3) continue;
    surface.smooth(x, z, g);
    if (Math.hypot(g[1], g[2]) > 0.36) continue;
    const ref = surface.heightAt(x, z);
    e600.push(Math.abs(renderedAt(surface, x, z, 600) - ref));
    e3k.push(Math.abs(renderedAt(surface, x, z, 3000) - ref));
  }
  assert.ok(quantile(e600, 0.99) <= 0.3, `p99 error within 600 m: ${quantile(e600, 0.99)}`);
  // SPEC asks for 2 m. Level 2 out to 3 km would cost 2.25x its instances; level 3's ~2.6 m p99 is 0.6 px at 3 km
  // (documented deviation, notes/WP-TERRAIN.md).
  assert.ok(quantile(e3k, 0.99) <= 3, `p99 error within 3 km: ${quantile(e3k, 0.99)}`);
});

test('quadtree selection tiles the root exactly once with at most one level between neighbours', () => {
  const { heights, hm } = world;
  const bounds = createBounds(heights, hm.size, hm.half);
  const sel = createSelector({ bounds, maxInstances: 16384, reflect: false });
  const out = new Float32Array(16384 * 4);
  const cell = 32 * L0; // the smallest quadrant
  const N = Math.round(ROOT_SIZE / cell);
  for (const cam of [
    { x: 5034, y: 20, z: -1300 },
    { x: -800, y: 180, z: 2400 },
    { x: 0, y: 1800, z: 6000 },
    { x: -7800, y: 40, z: -7800 },
  ]) {
    const n = sel.select(cam, null, out);
    assert.ok(n > 20 && n < 16384);
    const level = new Int8Array(N * N).fill(-1);
    const deep = new Uint8Array(N * N);
    for (let i = 0; i < n; i++) {
      const [x0, z0, s, L] = out.subarray(i * 4, i * 4 + 4);
      assert.ok(Math.abs(s - 32 * spacing(L)) < 1e-6, 'quadrant size matches its level');
      const b = bounds.query(x0, z0, s);
      const i0 = Math.round((x0 - ROOT_ORIGIN) / cell);
      const j0 = Math.round((z0 - ROOT_ORIGIN) / cell);
      const w = Math.round(s / cell);
      for (let j = j0; j < j0 + w; j++) {
        for (let k = i0; k < i0 + w; k++) {
          assert.equal(level[j * N + k], -1, 'quadrants overlap');
          level[j * N + k] = L;
          deep[j * N + k] = (b[1] < DEEP_Y && L <= DEEP_LEVEL) || (b[1] < SHALLOW_Y && L <= SHALLOW_LEVEL) ? 1 : 0;
        }
      }
    }
    for (let k = 0; k < N * N; k++) assert.notEqual(level[k], -1, 'hole in the terrain');
    let worst = 0;
    for (let j = 0; j < N; j++) {
      for (let k = 0; k < N - 1; k++) {
        for (const [a, b] of [[j * N + k, j * N + k + 1], [k * N + j, (k + 1) * N + j]]) {
          if (deep[a] || deep[b]) continue; // seabed may jump levels under its skirts
          worst = Math.max(worst, Math.abs(level[a] - level[b]));
        }
      }
    }
    assert.ok(worst <= 1, `neighbouring quadrants differ by ${worst} levels at ${JSON.stringify(cam)}`);
    // The camera's own quadrant is full detail unless it is over the shelf seabed.
    const ci = Math.floor((cam.x - ROOT_ORIGIN) / cell);
    const cj = Math.floor((cam.z - ROOT_ORIGIN) / cell);
    if (cam.y < 200 && !deep[cj * N + ci]) assert.equal(level[cj * N + ci], 0);
  }
});

test('drainage traces gullies and valleys: wet valley floors, dry ridges, nothing at sea', () => {
  const { drainage, wetnessAt, surface, landcover, hm } = world;
  assert.equal(drainage.wet.length, drainage.n * drainage.n);
  const r = lcg(21);
  let crest = 0;
  let crestN = 0;
  let gully = 0;
  let gullyN = 0;
  for (let k = 0; k < 40000; k++) {
    const x = (r() * 2 - 1) * 7500;
    const z = (r() * 2 - 1) * 7500;
    const h = surface.heightAt(x, z);
    if (h < 0) {
      if (hm.shoreDistance(x, z) > 60) assert.ok(wetnessAt(x, z) < 0.05, 'no drainage at sea');
      continue;
    }
    if (h < 10) continue;
    const c = landcover.curvatureAt(x, z);
    if (c < -1.5) {
      crest += wetnessAt(x, z);
      crestN++;
    } else if (c > 1.5) {
      gully += wetnessAt(x, z);
      gullyN++;
    }
  }
  assert.ok(crestN > 50 && gullyN > 50);
  assert.ok(gully / gullyN > 2 * (crest / crestN), `gullies ${(gully / gullyN).toFixed(2)} vs crests ${(crest / crestN).toFixed(2)}`);
});

test('surfaceAt uses the documented vocabulary and puts water, beaches, rock and snow in the right places', () => {
  const { landcover, surface, hm } = world;
  const r = lcg(5);
  const counts = {};
  for (let k = 0; k < 6000; k++) {
    const x = (r() * 2 - 1) * 7900;
    const z = (r() * 2 - 1) * 7900;
    const s = landcover.surfaceAt(x, z);
    assert.ok(SURFACES.has(s), s);
    counts[s] = (counts[s] ?? 0) + 1;
    if (surface.heightAt(x, z) < -0.5) assert.equal(s, 'water');
  }
  for (const s of ['water', 'grass', 'forest', 'alder', 'rock']) assert.ok(counts[s] > 0, `no ${s} in ${JSON.stringify(counts)}`);
  // Beaches: low ground right at the shore is gravel or sand.
  let beach = 0;
  let low = 0;
  for (let k = 0; k < 60000 && low < 300; k++) {
    const x = (r() * 2 - 1) * 7900;
    const z = (r() * 2 - 1) * 7900;
    const h = surface.heightAt(x, z);
    const sd = hm.shoreDistance(x, z);
    if (h > 0.2 && h < 1.2 && sd > -20 && sd < 0) {
      low++;
      if (['gravel', 'sand'].includes(landcover.surfaceAt(x, z))) beach++;
    }
  }
  assert.ok(beach / low > 0.6, `beach ${beach}/${low}`);
  // Snow on the Peninsula volcano summit (Mt. Denison area), none on low ground.
  const denison = world.ctx.geo.toWorld(58.42, -154.45);
  let snow = 0;
  for (let k = 0; k < 400; k++) {
    const x = denison.x + (r() - 0.5) * 400;
    const z = denison.z + (r() - 0.5) * 400;
    if (surface.heightAt(x, z) > 330 && landcover.surfaceAt(x, z) === 'snow') snow++;
  }
  assert.ok(snow > 20, `snow samples on Denison ${snow}`);
  for (let k = 0; k < 3000; k++) {
    const x = (r() * 2 - 1) * 7900;
    const z = (r() * 2 - 1) * 7900;
    if (surface.heightAt(x, z) < 100) assert.notEqual(landcover.surfaceAt(x, z), 'snow');
  }
});

test('Sitka spruce grows in the north-east and on the northern islands, not in the south-west', () => {
  const { landcover, surface, ctx } = world;
  const r = lcg(9);
  const meanForest = (lat, lon, radius) => {
    const c = ctx.geo.toWorld(lat, lon);
    let sum = 0;
    let n = 0;
    for (let k = 0; k < 4000 && n < 400; k++) {
      const x = c.x + (r() * 2 - 1) * radius;
      const z = c.z + (r() * 2 - 1) * radius;
      const h = surface.heightAt(x, z);
      if (h < 5 || h > 40) continue;
      sum += landcover.forestDensity(x, z);
      n++;
    }
    return n ? sum / n : 0;
  };
  // NE Kodiak / Chiniak, Afognak, Spruce and Woody islands, Shuyak.
  for (const [name, lat, lon] of [
    ['Kodiak city hills', 57.8, -152.45],
    ['Afognak', 58.05, -152.7],
    ['Spruce Island', 57.93, -152.43],
    ['Shuyak', 58.45, -152.45],
    ['Chiniak', 57.62, -152.3],
  ]) {
    const f = meanForest(lat, lon, 900);
    assert.ok(f > 0.25, `${name} mean forest density ${f.toFixed(2)}`);
  }
  // Treeless south-west Kodiak and the Alaska Peninsula.
  for (const [name, lat, lon] of [
    ['Uyak Bay', 57.6, -153.9],
    ['Karluk', 57.55, -154.3],
    ['Alitak', 57.0, -154.0],
    ['Peninsula', 58.2, -154.4],
  ]) {
    assert.equal(meanForest(lat, lon, 900), 0, `${name} should be treeless`);
  }
  // Forest thins out with altitude (treeline) and never grows on the sea.
  assert.equal(landcover.forestDensity(ctx.geo.toWorld(57.72, -152.3).x, ctx.geo.toWorld(57.72, -152.3).z), 0);
});

test('no forest or shrubs on developed footprints', () => {
  const { landcover, ctx, surface } = world;
  const r = lcg(13);
  let checked = 0;
  for (const f of FOOTPRINTS) {
    const c = ctx.geo.toWorld(f.lat, f.lon);
    for (let k = 0; k < 20; k++) {
      const a = r() * Math.PI * 2;
      const d = Math.sqrt(r()) * f.radius * 0.95;
      const x = c.x + Math.cos(a) * d;
      const z = c.z + Math.sin(a) * d;
      if (surface.heightAt(x, z) < 1) continue;
      assert.equal(landcover.forestDensity(x, z), 0, `forest on ${f.id}`);
      assert.equal(landcover.alderDensity(x, z), 0, `alder on ${f.id}`);
      assert.ok(!['forest', 'alder'].includes(landcover.surfaceAt(x, z)));
      checked++;
    }
  }
  assert.ok(checked > 20);
  assert.equal(world.region.length, REGION_SIZE * REGION_SIZE * 4);
});

test('sun visibility: open water at noon is lit, bays behind ridges fall into shadow at low sun', () => {
  const { surface, hm } = world;
  const hAt = (x, z) => surface.heightAt(x, z);
  let sun = { x: 0.3, y: 0.85, z: 0.2 };
  const norm = (v) => {
    const l = Math.hypot(v.x, v.y, v.z);
    return { x: v.x / l, y: v.y / l, z: v.z / l };
  };
  sun = norm(sun);
  const vis = createSunVisibility({ sampleHeight: hAt, surfaceHeight: hAt, half: hm.half, getSun: () => sun });
  vis.refresh();
  const r = lcg(17);
  let lit = 0;
  let n = 0;
  for (let k = 0; k < 400; k++) {
    const x = (r() * 2 - 1) * 7000;
    const z = (r() * 2 - 1) * 7000;
    if (hm.shoreDistance(x, z) < 400) continue;
    n++;
    if (vis.at(x, z) > 0.99) lit++;
  }
  assert.ok(lit / n > 0.98, `open water lit at noon ${lit}/${n}`);
  // Evening sun from the north-west, 2° up: some low ground sits in mountain shadow, peaks stay lit.
  const el = (2 * Math.PI) / 180;
  const az = (315 * Math.PI) / 180; // compass bearing toward the sun
  sun = { x: Math.sin(az) * Math.cos(el), y: Math.sin(el), z: -Math.cos(az) * Math.cos(el) };
  vis.refresh();
  let shaded = 0;
  let land = 0;
  for (let k = 0; k < 3000; k++) {
    const x = (r() * 2 - 1) * 6000;
    const z = (r() * 2 - 1) * 6000;
    const h = surface.heightAt(x, z);
    if (h < 0 || h > 30) continue;
    land++;
    const v = vis.exact(x, z);
    assert.ok(v >= 0 && v <= 1);
    if (v < 0.5) shaded++;
  }
  assert.ok(shaded / land > 0.1, `low land in shadow at 2° sun: ${shaded}/${land}`);
  // Below the horizon everything is dark; the cached grid agrees with the exact march.
  assert.equal(marchSun(hAt, 0, 0, { x: 0.7, y: -0.1, z: 0.7 }, 0), 0);
  const x = 1234;
  const z = -2345;
  assert.ok(Math.abs(vis.at(x, z) - vis.exact(x, z)) < 0.5);
});
