// WP-PLACES: data validation against the game heightmap, the places API, and the on-foot reachability rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { config } from '../src/core/config.js';
import { createGeo } from '../src/core/geo.js';
import { createHeightmap } from '../src/world/heightmap.js';
import { PLACES, STREAMS, DISTRICTS, FOOTPRINTS, CLOSED_AREAS, SPAWN, resolve, isDeveloped, pointInPolygon } from '../src/data/places.js';
import { createPlacesApi } from '../src/world/places/api.js';
import { findFootPath, footSpeed, segmentSlope } from '../src/world/places/walk.js';

const png = PNG.sync.read(readFileSync(new URL('../public/terrain/kodiak_height.png', import.meta.url)));
const meta = JSON.parse(readFileSync(new URL('../public/terrain/kodiak_meta.json', import.meta.url), 'utf8'));
const hm = createHeightmap({ size: png.width, pixels: png.data, meta, config });
const geo = createGeo(config.world.half);
const R = resolve(geo);
const api = createPlacesApi({ geo, heightmap: hm });
const B = config.world.boundary;
const GROUNDING = config.boat.groundingDepth;

const KINDS = ['town', 'village', 'harbor', 'cannery', 'hatchery', 'landmark', 'cape', 'bay', 'strait', 'island', 'river', 'lake', 'peak', 'lighthouse', 'wildlife', 'history', 'viewpoint'];
const LAND = ['town', 'village', 'hatchery', 'landmark', 'cape', 'island', 'lake', 'peak', 'lighthouse', 'wildlife', 'history', 'viewpoint'];
const WATER = ['bay', 'strait'];
const SPECIES = ['pink', 'chum', 'sockeye', 'coho', 'king'];

// Navigable water (deeper than grounding + margin, inside the soft boundary), labelled into connected components.
const NAV = (() => {
  const N = 1024;
  const cell = (2 * config.world.half) / N;
  const comp = new Int32Array(N * N).fill(-1);
  const size = [];
  const ok = (i, j) => {
    const x = -config.world.half + (i + 0.5) * cell;
    const z = -config.world.half + (j + 0.5) * cell;
    return Math.abs(x) <= B && Math.abs(z) <= B && hm.heightAt(x, z) < -(GROUNDING + 0.1);
  };
  let c = 0;
  for (let s = 0; s < N * N; s++) {
    if (comp[s] >= 0 || !ok(s % N, (s / N) | 0)) continue;
    const q = [s];
    comp[s] = c;
    for (let h = 0; h < q.length; h++) {
      const k = q[h];
      const i = k % N;
      const j = (k / N) | 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const a = i + di;
        const b = j + dj;
        if (a < 0 || b < 0 || a >= N || b >= N) continue;
        const t = b * N + a;
        if (comp[t] < 0 && ok(a, b)) {
          comp[t] = c;
          q.push(t);
        }
      }
    }
    size.push(q.length * cell * cell);
    c++;
  }
  const at = (x, z) => {
    const i = Math.floor((x + config.world.half) / cell);
    const j = Math.floor((z + config.world.half) / cell);
    return i < 0 || j < 0 || i >= N || j >= N ? -1 : comp[j * N + i];
  };
  return { at, size };
})();

const sentences = (s) => s.split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/).filter(Boolean).length;

test('place data: count, ids, kinds, fields and blurbs', () => {
  assert.ok(PLACES.length >= 60 && PLACES.length <= 90, `60-90 places, got ${PLACES.length}`);
  const ids = new Set();
  for (const p of PLACES) {
    assert.ok(!ids.has(p.id), `duplicate id ${p.id}`);
    ids.add(p.id);
    assert.ok(KINDS.includes(p.kind), `${p.id}: kind ${p.kind}`);
    assert.ok(typeof p.name === 'string' && p.name.length > 2, `${p.id}: name`);
    assert.ok(Number.isFinite(p.lat) && Number.isFinite(p.lon), `${p.id}: lat/lon`);
    assert.ok(p.radius >= 80 && p.radius <= 1600, `${p.id}: radius ${p.radius}`);
    assert.ok(p.blurb && sentences(p.blurb) >= 1 && sentences(p.blurb) <= 3, `${p.id}: blurb must be 1-3 sentences (${sentences(p.blurb)})`);
    assert.ok(p.blurb.length <= 420, `${p.id}: blurb length ${p.blurb.length}`);
    for (const s of p.services ?? []) assert.ok(['sell', 'fuel', 'upgrades', 'ice', 'rest'].includes(s), `${p.id}: service ${s}`);
    if (p.services?.length) assert.ok(p.dock, `${p.id}: places with services need a dock`);
    if (p.onFoot) assert.ok(p.landing, `${p.id}: onFoot needs a landing`);
    if (p.kind === 'lighthouse') assert.ok(p.light?.period > 0 && p.light?.color, `${p.id}: light characteristic`);
  }
  // required content
  for (const id of ['kodiak', 'ouzinkie', 'port-lions', 'old-harbor', 'larsen-bay', 'akhiok', 'karluk', 'kitoi-bay-hatchery', 'pillar-creek-hatchery', 'larsen-bay-cannery', 'alitak-cannery', 'uganik-cannery', 'uscg-base', 'pacific-spaceport', 'fort-abercrombie', 'three-saints-bay', 'awauq', 'marmot-island', 'omalley-river', 'holy-resurrection']) {
    assert.ok(ids.has(id), `missing ${id}`);
  }
  const awauq = PLACES.find((p) => p.id === 'awauq');
  assert.equal(awauq.memorial, true);
  assert.ok(!awauq.onFoot && !awauq.landing, "Awa'uq: no landing");
  assert.equal(PLACES.filter((p) => p.memorial).length, 1);
  // Kodiak is the full-service port
  assert.deepEqual([...PLACES.find((p) => p.id === 'kodiak').services].sort(), ['fuel', 'ice', 'rest', 'sell', 'upgrades']);
});

test('land places stand on land; water places sit in water', () => {
  for (const p of R.places) {
    const h = hm.heightAt(p.x, p.z);
    if (LAND.includes(p.kind)) assert.ok(h > 0, `${p.id} (${p.kind}) should be on land, h=${h.toFixed(2)}`);
    if (WATER.includes(p.kind)) {
      assert.ok(h < -0.25, `${p.id} (${p.kind}) should be in water, h=${h.toFixed(2)}`);
      if (p.kind === 'strait') assert.ok(h < -2.5, `${p.id} strait depth ${(-h).toFixed(1)}`);
    }
    if (p.kind === 'harbor') assert.ok(hm.shoreDistance(p.x, p.z) > 0, `${p.id} harbour point in the water`);
    if (p.kind === 'cannery') assert.ok(Math.abs(hm.shoreDistance(p.x, p.z)) < 45, `${p.id} cannery at the shore`);
    if (p.kind === 'river') assert.ok(Math.abs(hm.shoreDistance(p.x, p.z)) < 20, `${p.id} river place at the coast`);
    if (p.kind === 'peak') {
      for (let a = 0; a < 8; a++) {
        const q = hm.heightAt(p.x + Math.cos(a) * 60, p.z + Math.sin(a) * 60);
        assert.ok(q <= h + 1, `${p.id} should be a local summit`);
      }
    }
  }
});

test('docks are navigable, connected water; east-side ports are reachable from the spawn', () => {
  const spawnComp = NAV.at(api.spawn.x, api.spawn.z);
  assert.ok(spawnComp >= 0, 'spawn in navigable water');
  for (const p of R.places.filter((q) => q.dock)) {
    const d = p.dock;
    const depth = -hm.heightAt(d.x, d.z);
    assert.ok(depth >= GROUNDING + 0.1, `${p.id} dock depth ${depth.toFixed(2)}`);
    assert.ok(hm.shoreDistance(d.x, d.z) >= 15, `${p.id} dock too close to shore`);
    assert.ok(Math.abs(d.x) <= B && Math.abs(d.z) <= B, `${p.id} dock inside the boundary`);
    assert.ok(Number.isFinite(d.heading), `${p.id} dock heading`);
    const c = NAV.at(d.x, d.z);
    assert.ok(c >= 0 && NAV.size[c] > 0.15e6, `${p.id} dock in a navigable water body (${c >= 0 ? (NAV.size[c] / 1e6).toFixed(2) : 0} km²)`);
    assert.ok(Math.hypot(d.x - p.x, d.z - p.z) < 700, `${p.id} dock near its place`);
  }
  for (const id of ['kodiak', 'ouzinkie', 'port-lions', 'old-harbor', 'kitoi-bay-hatchery']) {
    const d = api.get(id).dock;
    assert.equal(NAV.at(d.x, d.z), spawnComp, `${id} dock reachable by water from the spawn`);
  }
});

test('spawn: open water in the St. Paul Harbor approaches', () => {
  const s = api.spawn;
  assert.ok(-hm.heightAt(s.x, s.z) >= 8, 'spawn depth');
  assert.ok(hm.shoreDistance(s.x, s.z) >= 100, 'spawn well offshore');
  assert.equal(api.districtAt(s.x, s.z), 'Northeast Kodiak');
  const k = api.get('kodiak');
  assert.ok(Math.hypot(s.x - k.x, s.z - k.z) < 700, 'spawn near Kodiak');
  assert.ok(Math.abs(s.heading - (SPAWN.heading * Math.PI) / 180) < 1e-9);
});

test('streams: species, closed radius, mouths at the sea coast', () => {
  assert.ok(STREAMS.length >= 12);
  const ids = new Set();
  for (const s of R.streams) {
    assert.ok(!ids.has(s.id), `dup stream ${s.id}`);
    ids.add(s.id);
    assert.ok(s.closedRadius >= 150 && s.closedRadius <= 350, `${s.id} closedRadius`);
    assert.ok(s.species.length && s.species.every((k) => SPECIES.includes(k)), `${s.id} species`);
    assert.ok(Math.abs(hm.shoreDistance(s.x, s.z)) <= 15, `${s.id} mouth at the coast (sd ${hm.shoreDistance(s.x, s.z).toFixed(0)})`);
    const g = hm.shoreGradient(s.x, s.z);
    let wet = false;
    for (let d = 2; d <= 30 && !wet; d += 2) wet = hm.heightAt(s.x + g.x * d, s.z + g.z * d) < 0;
    assert.ok(wet, `${s.id} water just offshore of the mouth`);
    if (s.placeId) assert.ok(api.get(s.placeId), `${s.id} placeId ${s.placeId}`);
  }
  for (const id of ['karluk', 'ayakulik', 'dog-salmon', 'upper-station', 'buskin', 'kitoi', 'telrod']) assert.ok(ids.has(id), `stream ${id}`);
  assert.ok(STREAMS.find((s) => s.id === 'karluk').species.includes('sockeye'));
});

test('closed areas: Marmot Island rookery buffer', () => {
  const m = R.closedAreas.find((c) => c.id === 'marmot-rookery');
  assert.ok(m, 'marmot rookery');
  assert.ok(m.radius >= 440 && m.radius <= 500, 'about 3 nm at game scale');
  assert.ok(/sea lion/i.test(m.name + m.reason));
  const isl = api.get('marmot-island');
  assert.ok(Math.hypot(isl.x - m.x, isl.z - m.z) < m.radius, 'rookery place inside the buffer');
  // the buffer must leave room to watch from outside it inside the world boundary
  assert.ok(m.x - m.radius < B - 100, 'water outside the buffer within the boundary');
  assert.equal(api.closedAt(m.x, m.z)?.id, 'marmot-rookery');
  const k = R.streams.find((s) => s.id === 'karluk');
  assert.equal(api.closedAt(k.x, k.z)?.kind, 'stream');
});

test('districts: seven coarse polygons following 5 AAC 18.200', () => {
  assert.equal(DISTRICTS.length, 7);
  for (const d of R.districts) {
    assert.ok(d.polygon.length >= 3, d.id);
    assert.ok(pointInPolygon(d.label.x, d.label.z, d.polygon), `${d.id} label inside its polygon`);
    assert.ok(hm.heightAt(d.label.x, d.label.z) < 0, `${d.id} label on water`);
  }
  const at = (id) => {
    const p = api.get(id);
    return api.districtAt(p.x, p.z);
  };
  assert.equal(at('kodiak'), 'Northeast Kodiak');
  assert.equal(at('ouzinkie'), 'Northwest Kodiak');
  assert.equal(at('port-lions'), 'Northwest Kodiak');
  assert.equal(at('larsen-bay'), 'Northwest Kodiak');
  assert.equal(at('karluk'), 'Southwest Kodiak');
  assert.equal(at('akhiok'), 'Alitak');
  assert.equal(at('old-harbor'), 'Eastside Kodiak');
  assert.equal(at('kitoi-bay-hatchery'), 'Afognak');
  const pen = geo.toWorld(58.3, -154.6);
  assert.equal(api.districtAt(pen.x, pen.z), 'Mainland');
  // every place resolves a district id
  for (const p of R.places) assert.ok(DISTRICTS.some((d) => d.id === p.district), `${p.id} district`);
});

test('footprints mark developed ground around settlements, not the open sea', () => {
  assert.ok(FOOTPRINTS.length >= 10);
  for (const id of ['kodiak', 'ouzinkie', 'old-harbor', 'akhiok']) {
    const p = api.get(id);
    let near = false;
    for (const f of R.footprints) if (Math.hypot(f.x - p.x, f.z - p.z) < 200) near = true;
    assert.ok(near, `${id} has a footprint nearby`);
  }
  assert.ok(!isDeveloped(api.spawn.x, api.spawn.z, geo));
  assert.ok(!isDeveloped(0, 0, geo));
  for (const f of R.footprints) assert.ok(f.radius > 0 && f.radius < 200, `${f.id} radius`);
});

test('footprints cover every built structure, and the layout ignores the game seed', async () => {
  const { buildLayoutHeadless } = await import('../src/world/places/genFootprints.mjs');
  const a = await buildLayoutHeadless();
  const sites = a.sys.layout.sites;
  assert.ok(sites.length > 300, `sites ${sites.length}`);
  const missed = sites.filter((s) => !isDeveloped(s.x, s.z, geo));
  assert.deepEqual(missed, [], `${missed.length} structure sites outside FOOTPRINTS: run node src/world/places/genFootprints.mjs`);
  // same layout with a different game seed
  const { fakeCtx } = await import('./contract.test.mjs');
  const { create } = await import('../src/world/places.js');
  const { createRng } = await import('../src/core/rng.js');
  const ctx = fakeCtx();
  ctx.rng = createRng(424242);
  const b = await create(ctx);
  assert.equal(b.layout.sites.length, sites.length);
  for (let i = 0; i < sites.length; i += 17) assert.ok(Math.abs(b.layout.sites[i].x - sites[i].x) < 1e-6 && Math.abs(b.layout.sites[i].z - sites[i].z) < 1e-6);
});

test('places API: get, nearest, within, filters', () => {
  const k = api.get('kodiak');
  assert.equal(api.get('nope'), null);
  assert.equal(api.nearest(k.x + 5, k.z + 5, 'town').place.id, 'kodiak');
  const lights = api.within(k.x, k.z, 3000, 'lighthouse');
  assert.ok(lights.length >= 2 && lights.every((p) => p.kind === 'lighthouse'));
  const w = api.within(k.x, k.z, 1500);
  for (let i = 1; i < w.length; i++) assert.ok(Math.hypot(w[i].x - k.x, w[i].z - k.z) >= Math.hypot(w[i - 1].x - k.x, w[i - 1].z - k.z));
  assert.ok(api.nearest(k.x, k.z, (p) => p.kind === 'cannery'));
  assert.equal(api.placeAt(k.x, k.z, 'town')?.id, 'kodiak');
  assert.ok(api.nearestStream(k.x, k.z).stream.id);
});

test('on-foot rules: speed curve and slope measure', () => {
  assert.equal(footSpeed(20), 1);
  assert.equal(footSpeed(35), 1);
  assert.ok(footSpeed(42) < 1 && footSpeed(42) > 0.3);
  assert.equal(footSpeed(55), 0.3);
  assert.equal(footSpeed(60), 0);
  const ramp = (x) => x * Math.tan((40 * Math.PI) / 180);
  assert.ok(Math.abs(segmentSlope((x) => ramp(x), 0, 0, 10, 0) - 40) < 0.5);
});

test('onFoot places are reachable from their landing beach', () => {
  const onFoot = R.places.filter((p) => p.onFoot);
  assert.ok(onFoot.length >= 8, 'several on-foot destinations');
  for (const p of onFoot) {
    const l = p.landing;
    const h = hm.heightAt(l.x, l.z);
    assert.ok(h > 0.1 && h < 5, `${p.id} landing on the beach (h ${h.toFixed(2)})`);
    // anchoring water within ~150 m of the landing
    let wet = false;
    for (let a = 0; a < 16 && !wet; a++) {
      for (let r = 20; r <= 150 && !wet; r += 10) wet = hm.heightAt(l.x + Math.cos(a * 0.39) * r, l.z + Math.sin(a * 0.39) * r) < -(GROUNDING + 0.4);
    }
    assert.ok(wet, `${p.id} landing near navigable water`);
    const path = findFootPath(hm.heightAt, l, p, { cell: 8, margin: 300 });
    assert.ok(path.ok, `${p.id} reachable on foot from its landing`);
    assert.ok(path.maxSlope <= 58.5, `${p.id} path slope ${path.maxSlope.toFixed(1)}`);
  }
});

test('places.create builds under Node with the fake ctx', async () => {
  const { fakeCtx } = await import('./contract.test.mjs');
  const { create } = await import('../src/world/places.js');
  const { missingMembers } = await import('../src/systems/contract.js');
  const ctx = fakeCtx();
  const sys = await create(ctx);
  assert.deepEqual(missingMembers('places', sys), []);
  const d = sys.debugState();
  assert.deepEqual(d.failures, []);
  assert.ok(d.triangles > 20000 && d.triangles < 400000, `triangles ${d.triangles}`);
  assert.ok(d.glows > 100 && d.turbines === 6);
  sys.update(0.016);
  sys.update(0.016);
  assert.equal(sys.serialize(), undefined);
  sys.reset();
});
