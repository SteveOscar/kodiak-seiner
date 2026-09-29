// WP-TERRAIN colliders and driftwood placement: terrain.collidersNear(x, z, radius) returns exactly the solid props the
// vegetation layers render (spruce trunks, boulders, driftwood), queries are cheap, and driftwood only lies on gravel
// and sand near the waterline, never on developed ground (QA [35]).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGeo } from '../src/core/geo.js';
import { config } from '../src/core/config.js';
import { despike } from '../src/world/terrain/despike.js';
import { createSurface, createCurvature } from '../src/world/terrain/surface.js';
import { buildRegion, createLandcover } from '../src/world/terrain/landcover.js';
import { computeDrainage, createWetnessSampler } from '../src/world/terrain/drainage.js';
import { createPlacement, TREE_CELL, BOULDER_CELL, DRIFT_CELL, DRIFT_SHORE } from '../src/world/terrain/vegetation/placement.js';
import { createTerrainColliders, trunkRadius } from '../src/world/terrain/colliders.js';
import { isDeveloped } from '../src/data/places.js';
import { createHeightmap } from '../src/world/heightmap.js';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const png = PNG.sync.read(readFileSync(new URL('../public/terrain/kodiak_height.png', import.meta.url)));
const meta = JSON.parse(readFileSync(new URL('../public/terrain/kodiak_meta.json', import.meta.url), 'utf8'));
const hm = createHeightmap({ size: png.width, pixels: png.data, meta, config });
const geo = createGeo(config.world.half);
const { heights } = despike(hm.game, hm.size);
const surface = createSurface({ game: heights, size: hm.size, half: hm.half });
const dev = (x, z) => isDeveloped(x, z, geo);
const region = buildRegion({ geo, half: hm.half, isDeveloped: dev });
const drainage = computeDrainage(heights, hm.size, hm.size >> 1);
const landcover = createLandcover({ surface, heightmap: hm, region, half: hm.half, isDeveloped: dev, curvatureAt: createCurvature(heights, hm.size, hm.half), wetnessAt: createWetnessSampler(drainage, hm.half) });
const texel = (2 * hm.half) / hm.size;
const SEED = 424242;
const placement = createPlacement({ surface, landcover, heightmap: hm, demAt: (x, z) => surface.heightAt(x, z), texel, isDeveloped: dev, seed: SEED, q: 1 });
const colliders = createTerrainColliders({ placement, seed: SEED });

// What the vegetation layers render in a square: every placement cell whose instance lands inside it.
function rendered(x0, z0, size) {
  const out = { spruce: [], boulders: [], drift: [] };
  const run = (cell, fn, list) => {
    for (let iz = Math.floor(z0 / cell) - 1; iz <= Math.floor((z0 + size) / cell); iz++) {
      for (let ix = Math.floor(x0 / cell) - 1; ix <= Math.floor((x0 + size) / cell); ix++) {
        fn(ix, iz, (x, y, z, s, c, sn, t, aux, sx, sy, sz) => {
          if (x >= x0 && x < x0 + size && z >= z0 && z < z0 + size) list.push({ x, y, z, s, c, sn, aux, sx, sy, sz });
        });
      }
    }
  };
  run(TREE_CELL, (ix, iz, push) => placement.spruceAt(ix, iz, push, true), out.spruce);
  run(BOULDER_CELL, placement.boulderAt, out.boulders);
  run(DRIFT_CELL, placement.driftAt, out.drift);
  return out;
}

// Kodiak's spruce slopes behind the town, and a driftwood beach (found by search so the test follows the DEM).
const FOREST = { x: 5200, z: -1560, size: 160 };
const BEACH = (() => {
  for (let z = -3000; z <= 3000; z += 160) {
    for (let x = -4000; x <= 6000; x += 160) {
      const r = rendered(x, z, 160);
      if (r.drift.length >= 6 && r.boulders.length >= 3) return { x, z, size: 160 };
    }
  }
  return null;
})();

test('every rendered trunk, boulder and log has its collider, across tile seams', () => {
  assert.ok(BEACH, 'a beach with driftwood and boulders exists');
  for (const area of [FOREST, BEACH]) {
    const r = rendered(area.x, area.z, area.size);
    const cs = colliders.near(area.x + area.size / 2, area.z + area.size / 2, area.size);
    const match = (p, pred) => cs.some((c) => Math.abs(c.x - p.x) < 1e-9 && Math.abs(c.z - p.z) < 1e-9 && pred(c));
    for (const t of r.spruce) assert.ok(match(t, (c) => c.kind === 'circle' && c.r === trunkRadius(t.s) && Math.abs(c.y1 - c.y0 - t.s) < 1e-9), 'spruce trunk');
    for (const b of r.boulders) assert.ok(match(b, (c) => c.kind === 'circle' && c.y1 > b.y && c.y0 < b.y + 0.01), 'boulder');
    for (const d of r.drift) {
      assert.ok(match(d, (c) => c.kind === 'box' && Math.abs(c.hx - d.s / 2) < 1e-9 && Math.abs(Math.cos(c.rot) - d.c) < 1e-9 && Math.abs(Math.sin(c.rot) - d.sn) < 1e-9), 'driftwood box along the log (rot = yaw)');
    }
    if (area === FOREST) assert.ok(r.spruce.length > 50, `forest trees ${r.spruce.length}`);
  }
});

test('collider sizes follow the rendered instances', () => {
  const r = rendered(BEACH.x, BEACH.z, BEACH.size);
  const cs = colliders.near(BEACH.x + 80, BEACH.z + 80, 160);
  for (const b of r.boulders) {
    const c = cs.find((k) => k.x === b.x && k.z === b.z);
    assert.ok(c.r > 0.5 * b.s * Math.min(b.sx, b.sz) && c.r < 1.3 * b.s * Math.max(b.sx, b.sz), 'boulder radius ~ instance scale');
  }
  for (const d of r.drift) {
    const c = cs.find((k) => k.kind === 'box' && k.x === d.x && k.z === d.z);
    const rad = d.s * 0.035 * d.sz;
    assert.ok(c.hz > rad * 0.9 && c.hz < rad * 2, `log half-width ${c.hz.toFixed(2)} ~ its radius ${rad.toFixed(2)}`);
    assert.ok(c.y0 < d.y - rad * 0.8 && c.y1 > d.y + rad * 0.8, 'log vertical extent');
  }
  const trees = colliders.near(FOREST.x + 80, FOREST.z + 80, 80).filter((c) => c.kind === 'circle' && c.y1 - c.y0 > 4);
  for (const t of trees) assert.ok(t.r >= 0.15 && t.r <= 0.4);
});

test('queries over warm tiles cost microseconds; a cold tile a fraction of a millisecond', () => {
  const warm = createTerrainColliders({ placement, seed: SEED });
  const t0 = performance.now();
  warm.warm(FOREST.x, FOREST.z, 64, Infinity);
  const st = warm.stats();
  assert.ok(st.tiles > 0 && (performance.now() - t0) / st.tiles < 5, `ms per tile ${((performance.now() - t0) / st.tiles).toFixed(2)}`);
  const out = [];
  const n = 20000;
  let hits = 0;
  const t1 = performance.now();
  for (let i = 0; i < n; i++) hits += warm.near(FOREST.x - 30 + (i % 100) * 0.6, FOREST.z - 30 + Math.floor(i / 100) * 0.3, 2.5, out).length;
  const us = ((performance.now() - t1) / n) * 1000;
  assert.ok(hits > 100, `hits ${hits}`);
  assert.ok(us < 25, `${us.toFixed(2)} us per query`);
  assert.equal(warm.stats().built, st.built, 'no tile rebuilt while querying warm ground');
});

test('driftwood lies only on sand/gravel near the waterline, never on developed ground (QA [35])', () => {
  let logs = 0;
  const bad = [];
  // a sparse sweep: every 3rd row of 6 m cells across the island
  for (let iz = Math.floor(-6000 / DRIFT_CELL); iz < 6000 / DRIFT_CELL; iz += 3) {
    for (let ix = Math.floor(-7000 / DRIFT_CELL); ix < Math.floor(7000 / DRIFT_CELL); ix++) {
      placement.driftAt(ix, iz, (x, y, zz, len, c, s) => {
        logs++;
        const surf = landcover.surfaceAt(x, zz);
        const sd = hm.shoreDistance(x, zz);
        const ends = [[x + (c * len) / 2, zz + (s * len) / 2], [x - (c * len) / 2, zz - (s * len) / 2]];
        if (!(surf === 'sand' || surf === 'gravel') || sd < -DRIFT_SHORE || sd > 1.5 || dev(x, zz) || ends.some(([ex, ez]) => dev(ex, ez))) bad.push({ x, z: zz, surf, sd });
      });
    }
  }
  assert.ok(logs > 400, `driftwood still dresses the beaches (${logs} in the sweep)`);
  assert.deepEqual(bad.slice(0, 5), [], `${bad.length} logs off the beach or on developed ground`);
});

test('no driftwood on the town slope below Holy Resurrection Cathedral', () => {
  // The QA shot looked down the channel head beach toward the cathedral: the grass there must stay clear.
  const logs = [];
  for (let iz = Math.floor(-1300 / DRIFT_CELL); iz < Math.floor(-1100 / DRIFT_CELL); iz++) {
    for (let ix = Math.floor(5000 / DRIFT_CELL); ix < Math.floor(5250 / DRIFT_CELL); ix++) {
      placement.driftAt(ix, iz, (x, y, z) => logs.push({ x, z, surf: landcover.surfaceAt(x, z) }));
    }
  }
  assert.deepEqual(logs.filter((l) => l.surf !== 'sand' && l.surf !== 'gravel'), []);
  assert.ok(logs.length <= 8, `${logs.length} logs around the channel head`);
});
