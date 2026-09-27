// WP-BOATS: title shots, fleet data and fleet AI against the real Kodiak heightmap and places.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCtx } from './contract.test.mjs';
import { TITLE_SHOTS, shotAt } from '../src/render/camera/titleShots.js';
import { TENDERS, GROUNDS, FLEET_SEINERS, FERRY, CUTTER } from '../src/entities/boats/fleetData.js';
import { createFleetBoatAI, createShuttleAI } from '../src/entities/boats/fleetAI.js';
import { resolve } from '../src/data/places.js';

const ctx = fakeCtx();
const hm = ctx.heightmap;

test('title cinematic: 5-7 golden-hour or dawn shots of real places, cut in a loop', () => {
  assert.ok(TITLE_SHOTS.length >= 5 && TITLE_SHOTS.length <= 7);
  const total = TITLE_SHOTS.reduce((a, s) => a + s.duration, 0);
  assert.ok(total >= 60 && total <= 110, `loop ${total} s`);
  const ids = new Set();
  for (const s of TITLE_SHOTS) {
    assert.ok(!ids.has(s.id), `unique id ${s.id}`);
    ids.add(s.id);
    assert.ok(s.label && s.duration >= 10 && s.duration <= 16, s.id);
    assert.ok(s.hours >= 20.8 || s.hours <= 6.5, `${s.id} is a golden-hour or dawn shot (${s.hours})`);
    if (s.kind === 'seiner') {
      // The boat runs on autopilot for the shot: deep, open water the whole way.
      const h = (s.seiner.headingDeg * Math.PI) / 180;
      const run = s.duration * 12 * s.seiner.throttle + 40;
      for (let d = 0; d <= run; d += 10) {
        const x = s.seiner.x + Math.sin(h) * d;
        const z = s.seiner.z - Math.cos(h) * d;
        assert.ok(hm.depthAt(x, z) > 4, `${s.id}: water under the seiner ${d} m along its run`);
      }
    } else {
      for (const p of [s.from, s.to]) assert.ok(Math.abs(p.x) < 8000 && Math.abs(p.z) < 8000 && p.h >= 8, `${s.id} camera inside the world`);
    }
  }
  const first = shotAt(TITLE_SHOTS, 0);
  assert.equal(first.index, 0);
  const wrap = shotAt(TITLE_SHOTS, total + 1);
  assert.equal(wrap.index, 0, 'loops');
  assert.equal(shotAt(TITLE_SHOTS, TITLE_SHOTS[0].duration + 0.5).index, 1);
});

test('fleet data: 4-6 tenders on real grounds, eight fleet-board seiners, ferry and cutter stops', async () => {
  assert.ok(TENDERS.length >= 4 && TENDERS.length <= 6);
  const places = resolve(ctx.geo).places;
  const byId = new Map(places.map((p) => [p.id, p]));
  const tenderIds = new Set(TENDERS.map((t) => t.id));
  assert.equal(tenderIds.size, TENDERS.length);
  for (const t of TENDERS) {
    assert.ok(t.name && t.length >= 21 && t.length <= 37, `${t.id}: 70-120 ft`);
    const p = byId.get(t.placeId) ?? ctx.geo.toWorld(t.hint[0], t.hint[1]);
    const w = hm.nearestWater(p.x, p.z, { minShore: 60 });
    assert.ok(w && Math.hypot(w.x - p.x, w.z - p.z) < 2500, `${t.id}: anchorage near ${t.placeId}`);
  }
  for (const [gid, g] of Object.entries(GROUNDS)) assert.ok(tenderIds.has(g.tender), `${gid} delivers to a known tender`);
  assert.equal(FLEET_SEINERS.length, 8);
  for (const s of FLEET_SEINERS) assert.ok(GROUNDS[s.ground], `${s.name} works a known ground`);
  const board = await import('../src/game/data/fleetBoard.js').then((m) => m.FLEET).catch(() => null);
  if (board) assert.deepEqual(FLEET_SEINERS.map((s) => s.name), board.map((b) => b.name), 'same names as the fleet board');
  for (const stop of [...FERRY.stops, ...CUTTER.patrol]) {
    const p = byId.get(stop.placeId) ?? ctx.geo.toWorld(stop.hint[0], stop.hint[1]);
    assert.ok(hm.nearestWater(p.x, p.z, { minShore: 40 }), `${stop.placeId} reachable by water`);
  }
});

// A flat, deep sea with straight-line routing, so the AI can be stepped quickly.
function openSea(fishing = true) {
  return {
    fishing,
    route: (from, to) => ({ status: 'done', path: [from, to] }),
    current: () => ({ x: 0.05, z: 0 }),
    water: () => true,
    player: null,
  };
}

test('fleet seiner AI: searches, lays a round haul with corks, closes, purses, hauls, brails and delivers', () => {
  let seed = 7;
  const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const ai = createFleetBoatAI({
    id: 't',
    name: 'Test',
    spots: [{ x: 0, z: 0 }, { x: 600, z: 200 }, { x: -500, z: 400 }],
    tender: { x: 1200, z: -600, heading: 0.4, beam: 9 },
    anchorage: { x: 1100, z: -500 },
    rng,
  });
  const world = openSea(true);
  const seen = new Set();
  let maxCorks = 0;
  let corksAfterBrail = -1;
  let prev = ai.s.state;
  for (let t = 0; t < 3600; t += 0.25) {
    ai.step(0.25, world);
    seen.add(ai.s.state);
    if (ai.s.state === 'set') maxCorks = Math.max(maxCorks, ai.s.corks.length);
    if (prev === 'brail' && ai.s.state !== 'brail') corksAfterBrail = ai.s.corks.length;
    prev = ai.s.state;
    assert.ok(Number.isFinite(ai.s.x) && Number.isFinite(ai.s.z) && Number.isFinite(ai.s.heading));
  }
  for (const st of ['search', 'set', 'close', 'purse', 'haul', 'brail', 'approach', 'deliver']) assert.ok(seen.has(st), `visited ${st}`);
  assert.ok(maxCorks > 60, `a visible corkline (${maxCorks} corks)`);
  assert.equal(corksAfterBrail, 0, 'net back aboard after brailing');
  // Closed fishery: runs to the anchorage and anchors.
  const closed = openSea(false);
  const b = createFleetBoatAI({ id: 'c', name: 'C', spots: [{ x: 0, z: 0 }], tender: null, anchorage: { x: 300, z: 0 }, rng });
  for (let t = 0; t < 300; t += 0.25) b.step(0.25, closed);
  assert.equal(b.s.state, 'anchor');
  assert.ok(b.s.anchored && Math.hypot(b.s.x - 300, b.s.z) < 25);
});

test('shuttle AI (ferry, cutter) runs its stops in order and dwells', () => {
  const stops = [{ x: 0, z: 0, dwell: 5 }, { x: 800, z: 0, dwell: 5 }, { x: 800, z: 800, dwell: 5 }];
  const ai = createShuttleAI({ id: 'f', name: 'F', stops, speed: 8 });
  const visited = [];
  let last = ai.s.stop;
  for (let t = 0; t < 1200; t += 0.25) {
    ai.step(0.25, openSea());
    if (ai.s.stop !== last) {
      visited.push(ai.s.stop);
      last = ai.s.stop;
    }
  }
  assert.deepEqual(visited.slice(0, 3), [1, 2, 0]);
});
