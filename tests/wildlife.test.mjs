// WP-WILDLIFE: site finding, pure behaviour logic, geometry, and the system constructed and run under Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { fakeCtx } from './contract.test.mjs';
import { STUBS } from '../src/systems/stubs.js';
import { SYSTEMS } from '../src/systems/registry.js';
import { missingMembers } from '../src/systems/contract.js';
import { resolve } from '../src/data/places.js';
import { findSites } from '../src/entities/wildlife/sites.js';
import { composeMatrix, wrapAngle, headingOf } from '../src/entities/wildlife/math.js';
import { createEncounter, stepEncounter, ENCOUNTER, planFlocks, planBears, seenWell } from '../src/entities/wildlife/behaviour.js';
import { buildBird, buildHumpback, buildOrca, buildQuadruped, buildSeaLion, buildSeal, buildOtter, buildSnag, QUADS } from '../src/entities/wildlife/shapes.js';

const ctx0 = fakeCtx();
const R = resolve(ctx0.geo);
const sites = findSites({ heightmap: ctx0.heightmap, places: R.places, streams: R.streams, closedAreas: R.closedAreas, rng: ctx0.rng.fork('wildlife').fork('sites') });

test('sites: every stream mouth has a bear site with wading shallows next to it', () => {
  const streamSites = sites.bearSites.filter((s) => s.streamId);
  assert.equal(streamSites.length, R.streams.length);
  for (const s of streamSites) {
    assert.ok(s.wade, `${s.id} has a wade point`);
    assert.ok(ctx0.heightmap.heightAt(s.wade.x, s.wade.z) < 0, `${s.id} wade point is in the water`);
    assert.ok(Math.hypot(s.wade.x - s.x, s.wade.z - s.z) < 270, `${s.id} wade point is near the mouth`);
  }
  const karluk = sites.bearSites.find((s) => s.streamId === 'karluk');
  assert.ok(karluk.path.length >= 3, 'Karluk has a beach path');
  assert.ok(sites.bearSites.some((s) => s.id === 'omalley'), "O'Malley River site");
});

test('sites: the Marmot rookery lies inside its closed-area buffer, on land', () => {
  const rook = sites.haulouts.find((h) => h.kind === 'rookery');
  assert.ok(rook, 'rookery haulout exists');
  const area = R.closedAreas.find((c) => c.id === 'marmot-rookery');
  assert.ok(rook.slots.length >= 20, 'rookery has room for a colony');
  for (const s of rook.slots) {
    assert.ok(Math.hypot(s.x - area.x, s.z - area.z) < area.radius, 'slot inside the buffer');
    assert.ok(ctx0.heightmap.heightAt(s.x, s.z) > 0, 'slot on land');
  }
});

test('sites: whales in deep water, otters in the nearshore shallows, goats high up', () => {
  assert.ok(sites.whaleRanges.length >= 6);
  for (const r of sites.whaleRanges) assert.ok(ctx0.heightmap.depthAt(r.x, r.z) >= 18, `${r.id} deep`);
  assert.ok(sites.otterBeds.length >= 8);
  for (const o of sites.otterBeds) {
    const d = ctx0.heightmap.depthAt(o.x, o.z);
    assert.ok(d >= 2.5 && d <= 14.5, `otter bed depth ${d}`);
  }
  for (const g of sites.goatCliffs) assert.ok(ctx0.heightmap.heightAt(g.x, g.z) > 110);
  assert.ok(sites.cliffs.length >= 15 && sites.beaches.length >= 20 && sites.snags.length >= 5);
});

test('sites: deterministic for the same DEM', () => {
  const again = findSites({ heightmap: ctx0.heightmap, places: R.places, streams: R.streams, closedAreas: R.closedAreas, rng: ctx0.rng.fork('wildlife').fork('sites') });
  assert.deepEqual(
    again.haulouts.map((h) => [h.id, h.slots.length]),
    sites.haulouts.map((h) => [h.id, h.slots.length]),
  );
  assert.deepEqual(again.bearSites.map((b) => b.wade && [+b.wade.x.toFixed(2), +b.wade.z.toFixed(2)]), sites.bearSites.map((b) => b.wade && [+b.wade.x.toFixed(2), +b.wade.z.toFixed(2)]));
});

test('composeMatrix matches three.js YXZ Euler with heading convention', () => {
  const out = new Float32Array(16);
  const o = new THREE.Object3D();
  for (const [h, p, r, s] of [[0.3, 0.2, -0.4, 1.5], [-2.1, -0.7, 1.1, 0.8], [Math.PI, 0, 0, 1]]) {
    composeMatrix(out, 0, 1, 2, 3, h, p, r, s);
    o.position.set(1, 2, 3);
    o.rotation.set(p, -h, r, 'YXZ');
    o.scale.setScalar(s);
    o.updateMatrix();
    for (let i = 0; i < 16; i++) assert.ok(Math.abs(out[i] - o.matrix.elements[i]) < 1e-5, `element ${i}`);
  }
  // Heading h faces (sin h, -cos h): the model's -z axis maps there.
  composeMatrix(out, 0, 0, 0, 0, Math.PI / 2, 0, 0, 1);
  const fwd = new THREE.Vector3(0, 0, -1).applyMatrix4(new THREE.Matrix4().fromArray(out));
  assert.ok(Math.abs(fwd.x - 1) < 1e-6 && Math.abs(fwd.z) < 1e-6);
  assert.ok(Math.abs(headingOf(1, 0) - Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(wrapAngle(3 * Math.PI) - Math.PI) < 1e-9);
});

test('bear encounter: watch within 30 m, bluff charge at 10 m, retreat, cooldown', () => {
  const e = createEncounter();
  const step = (dist, dt = 0.1, t = 0, onFoot = true) => stepEncounter(e, { dist, onFoot, dt, time: t });
  assert.equal(step(60), null);
  assert.equal(step(29), 'watch');
  assert.equal(step(20), null);
  assert.equal(step(9), 'charge');
  let change = null;
  for (let i = 0; i < 40 && !change; i++) change = step(5);
  assert.equal(change, 'retreat');
  change = null;
  let t = 0;
  for (let i = 0; i < 400 && !change; i++) change = step(50, 0.1, (t += 0.1));
  assert.equal(change, 'none');
  assert.equal(step(20, 0.1, t + 1), null, 'no re-engagement during cooldown');
  assert.equal(step(20, 0.1, t + ENCOUNTER.cooldown + 1), 'watch');
  // Backing off ends a watch with a retreat.
  assert.equal(step(ENCOUNTER.releaseDist + 5, 0.1, t + 40), 'retreat');
  // Going back aboard ends it too.
  const e2 = createEncounter();
  stepEncounter(e2, { dist: 25, onFoot: true, dt: 0.1, time: 0 });
  assert.equal(stepEncounter(e2, { dist: 25, onFoot: false, dt: 0.1, time: 0.1 }), 'retreat');
});

test('working flocks: about 30% are over bait over time', () => {
  let bait = 0;
  let total = 0;
  for (let k = 0; k < 400; k++) {
    const schools = Array.from({ length: 6 }, (_, i) => ({ id: `s${k}-${i}`, state: 'milling' }));
    const p = planFlocks(schools, { salt: k, maxSchoolFlocks: 5 });
    bait += p.baitCount;
    total += p.baitCount + p.schoolIds.length;
  }
  const frac = bait / total;
  assert.ok(frac > 0.25 && frac < 0.35, `bait fraction ${frac}`);
  assert.deepEqual(planFlocks([{ id: 'x', state: 'captured' }]).schoolIds, []);
});

test('bear plan: a sow with cubs always at the Karluk River mouth', () => {
  const groups = planBears(sites.bearSites, ctx0.rng.fork('wildlife'));
  const k = groups.filter((g) => g.siteId === 'stream-karluk');
  assert.ok(k.some((g) => g.type === 'family' && g.cubs >= 2 && g.cubs <= 3));
  assert.ok(groups.filter((g) => g.siteId === 'omalley').length >= 3);
  assert.ok(groups.length >= 12);
});

test('sightings: ~150 m by eye, much further through binoculars', () => {
  const ps = (fov) => 360 / Math.tan(((fov / 2) * Math.PI) / 180);
  assert.ok(seenWell({ size: 2, dist: 120, projScale: ps(55), offAxisDeg: 5, fovDeg: 55 }));
  assert.ok(!seenWell({ size: 2, dist: 400, projScale: ps(55), offAxisDeg: 5, fovDeg: 55 }));
  assert.ok(seenWell({ size: 2, dist: 500, projScale: ps(12), offAxisDeg: 2, fovDeg: 12 }));
  assert.ok(!seenWell({ size: 2, dist: 100, projScale: ps(55), offAxisDeg: 40, fovDeg: 55 }), 'off to the side is not seen well');
});

test('geometry: every model builds with finite attributes, rig channels and sane size', () => {
  const geos = [
    ...['gull', 'eagle', 'puffin', 'cormorant'].flatMap((k) => ['fly', 'perch', 'sit'].map((pose) => buildBird(k, { pose }))),
    buildBird('cormorant', { pose: 'spread' }),
    buildHumpback(),
    buildHumpback({ lod: 1 }),
    buildOrca(),
    buildOrca({ male: false }),
    buildSeaLion(),
    buildSeaLion({ bull: true }),
    buildSeal(),
    buildOtter(),
    buildSnag(),
    ...Object.keys(QUADS).map((k) => buildQuadruped(k)),
  ];
  for (const g of geos) {
    for (const name of ['position', 'normal', 'color', 'aRig', 'aPivot']) {
      const a = g.attributes[name];
      assert.ok(a, `${g.userData.kind} ${name}`);
      for (const v of a.array) assert.ok(Number.isFinite(v), `${g.userData.kind} ${name} finite`);
    }
    assert.ok(g.index.count / 3 < 3000, `${g.userData.kind} triangle budget`);
  }
  const hb = buildHumpback().boundingBox;
  assert.ok(hb.max.z - hb.min.z > 13 && hb.max.z - hb.min.z < 16.5, 'humpback ~14 m');
  const eagle = buildBird('eagle', { pose: 'fly' }).boundingBox;
  assert.ok(eagle.max.x - eagle.min.x > 1.9 && eagle.max.x - eagle.min.x < 2.5, 'eagle wingspan ~2.1 m');
  const boar = buildQuadruped('boar').boundingBox;
  assert.ok(boar.max.y > 1.3 && boar.max.y < 1.8 && boar.min.y > -0.1, 'boar stands ~1.4 m at the shoulder');
  const perched = buildBird('eagle', { pose: 'perch' }).boundingBox;
  assert.ok(perched.min.y > -0.5 && perched.max.y > 0.6, 'perched eagle stands on its feet');
});

// ---- the whole system under Node
async function makeSystem() {
  const ctx = fakeCtx();
  for (const { name } of SYSTEMS) if (name !== 'wildlife') ctx.systems[name] = STUBS[name](ctx);
  const avatar = { x: 0, y: 0, z: 0, heading: 0, object3d: null, control: 'boat' };
  ctx.game = { avatar: () => ({ ...avatar, control: ctx.state.control }) };
  ctx.renderer = { domElement: { clientHeight: 720 } };
  const mod = await import('../src/entities/wildlife.js');
  const sys = await mod.create(ctx);
  ctx.systems.wildlife = sys;
  return { ctx, sys, avatar };
}

test('system: constructs under Node, satisfies the contract and runs', async () => {
  const { ctx, sys } = await makeSystem();
  assert.deepEqual(missingMembers('wildlife', sys), []);
  const s0 = ctx.systems.seiner;
  s0.setPose(s0.position.x, s0.position.z, 0);
  for (let i = 0; i < 120; i++) {
    ctx.time.elapsed += 1 / 30;
    sys.update(1 / 30);
  }
  assert.ok(sys.bears.length >= 15, 'bears placed');
  assert.ok(sys.whales.length >= 8, 'whales placed');
  assert.ok(sys.birds.length >= 5, 'birds active around the seiner');
  for (const b of [...sys.bears, ...sys.whales, ...sys.birds]) {
    assert.ok(typeof b.id === 'string' && typeof b.kind === 'string' && typeof b.state === 'string');
    assert.ok(Number.isFinite(b.position.x) && Number.isFinite(b.position.y) && Number.isFinite(b.heading));
  }
  const nb = sys.nearestBear(0, 0);
  assert.ok(nb && nb.bear && Number.isFinite(nb.distance));
  const st = sys.debugState();
  assert.doesNotThrow(() => JSON.stringify(st));
  assert.equal(sys.serialize(), undefined);
  sys.reset();
  sys.update(0);
});

test('system: placement is deterministic for a seed', async () => {
  const a = await makeSystem();
  const b = await makeSystem();
  assert.deepEqual(
    a.sys.bears.map((x) => [x.id, +x.position.x.toFixed(3), +x.position.z.toFixed(3)]),
    b.sys.bears.map((x) => [x.id, +x.position.x.toFixed(3), +x.position.z.toFixed(3)]),
  );
  assert.deepEqual(
    a.sys.whales.map((x) => [x.id, +x.position.x.toFixed(3)]),
    b.sys.whales.map((x) => [x.id, +x.position.x.toFixed(3)]),
  );
});

test('system: a person ashore near a bear gets watch, then a bluff charge, then retreat', async () => {
  const { ctx, sys, avatar } = await makeSystem();
  const events = [];
  ctx.events.on('bear:encounter', (e) => events.push(e));
  const bear = sys.bears.find((b) => b.age === 'sow' || b.age === 'boar');
  // Bring the camera there so the bear is simulated.
  ctx.camera.position.set(bear.position.x, 20, bear.position.z + 40);
  ctx.state.control = 'foot';
  const step = (n) => {
    for (let i = 0; i < n; i++) {
      ctx.time.elapsed += 1 / 30;
      sys.update(1 / 30);
    }
  };
  avatar.x = bear.position.x + 25;
  avatar.z = bear.position.z;
  step(10);
  assert.equal(events[0]?.stage, 'watch');
  assert.equal(events[0].bearId, events[0].bearId);
  const id = events[0].bearId;
  const b = sys.bears.find((x) => x.id === id);
  avatar.x = b.position.x + 8;
  avatar.z = b.position.z;
  step(5);
  assert.equal(events[1]?.stage, 'charge');
  step(120);
  assert.equal(events[2]?.stage, 'retreat');
  assert.ok(Math.hypot(b.position.x - avatar.x, b.position.z - avatar.z) > 2.5, 'the bluff charge stops short');
  assert.ok(events.every((e) => e.bearId === id && Number.isFinite(e.x) && Number.isFinite(e.z)));
});
