// WP-RULES: discovery rules, intel, sightings, perches, progress, persistence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/core/config.js';
import { discoveryBonus, hotspotText, runTimingText, wildlifeKind, notableSpecies } from '../src/game/data/intel.js';
import { dateOf } from '../src/game/data/calendar.js';
import { makeWorld } from './rules-helpers.test.mjs';

function world(ctxPlaces) {
  return makeWorld({ places: ctxPlaces });
}

// Synthetic places laid out around open water near the spawn.
async function testWorld() {
  const w0 = await makeWorld();
  const sp = w0.ctx.systems.places.spawn;
  const hm = w0.ctx.heightmap;
  const water = (dx, dz) => hm.nearestWater(sp.x + dx, sp.z + dz, { minShore: 60 });
  const a = water(1500, 0);
  const b = water(-1500, 1500);
  const c = water(0, 2500);
  const d = water(2500, 2500);
  const list = [
    { id: 'kodiak', name: 'City of Kodiak', kind: 'town', x: sp.x, z: sp.z, radius: 400, services: ['sell', 'fuel', 'upgrades', 'rest'] },
    { id: 'cape-test', name: 'Cape Test', kind: 'cape', x: a.x, z: a.z, radius: 200 },
    { id: 'test-bay', name: 'Test Bay', kind: 'bay', x: b.x, z: b.z, radius: 300 },
    { id: 'awauq', name: "Awa'uq (Refuge Rock)", kind: 'history', x: c.x, z: c.z, radius: 150, memorial: true },
    { id: 'test-peak', name: 'Test Peak', kind: 'peak', x: d.x, z: d.z, radius: 120, onFoot: true },
  ];
  const m = hm.nearestWater(sp.x - 1500, sp.z + 1500, { minShore: 250 });
  const streams = [{ id: 'test-creek', name: 'Test Creek', species: ['sockeye', 'pink', 'coho'], x: m.x, z: m.z, closedRadius: 200 }];
  const w = await world({ list, streams, spawn: sp });
  return { w, list, streams };
}

test('intel rules: bonuses by kind, memorial none, hot-spot and run-timing text', () => {
  assert.equal(discoveryBonus({ kind: 'cape' }), 25);
  assert.equal(discoveryBonus({ kind: 'bay' }), 25);
  assert.equal(discoveryBonus({ kind: 'village' }), 50);
  assert.equal(discoveryBonus({ kind: 'peak' }), 100);
  assert.equal(discoveryBonus({ kind: 'history', memorial: true }), 0);
  for (const k of ['town', 'village', 'cape', 'bay', 'strait', 'island', 'river', 'lake', 'peak', 'lighthouse', 'wildlife', 'history', 'viewpoint', 'hatchery', 'harbor', 'cannery', 'landmark']) {
    const b = discoveryBonus({ kind: k });
    assert.ok(b >= 25 && b <= 100, k);
  }
  assert.match(hotspotText('cape', 'Cape Ugat', ['pink']), /Cape Ugat/);
  assert.match(hotspotText('cape', 'Cape Ugat', ['pink'], 'x'), /humpies|Humpies/);
  const rt = runTimingText(['sockeye', 'pink'], config.fish.runs, (d) => dateOf(config, d));
  assert.match(rt, /Reds peak Jul 6–21, done by Aug 20/);
  assert.match(rt, /Humpies peak Jul 26–Aug 10/);
  assert.equal(wildlifeKind('Humpback').kind, 'humpback');
  assert.equal(wildlifeKind('sea_lion').kind, 'sealion');
  assert.deepEqual(notableSpecies({ pink: 0.7, chum: 0.2, sockeye: 0.05 }, ['sockeye']), ['pink', 'sockeye', 'chum']);
  assert.deepEqual(notableSpecies(null, []), ['pink']);
  assert.match(hotspotText('bay', 'Uyak Bay', ['chum', 'pink'], 'b'), /Uyak Bay/);
  for (let i = 0; i < 20; i++) assert.doesNotMatch(hotspotText('bay', 'X Bay', ['coho', 'pink'], `k${i}`), /V-wakes/, 'only dogs fin');
});

test('discovery: entering a radius discovers with toast, event and a $25–$100 token', async () => {
  const { w, list } = await testWorld();
  const { ctx, discovery } = w;
  assert.equal(discovery.isDiscovered('kodiak'), true, 'home port known');
  const got = [];
  ctx.events.on('place:discovered', (e) => got.push(e));
  const enters = [];
  ctx.events.on('place:enter', (e) => enters.push(e.id));
  const cape = list.find((p) => p.id === 'cape-test');
  const cash = w.economy.cash;
  ctx.systems.seiner.setPose(cape.x + 50, cape.z, 0);
  w.step(0.25);
  assert.ok(discovery.isDiscovered('cape-test'));
  assert.ok(enters.includes('cape-test'));
  assert.equal(got.length, 1);
  assert.deepEqual([got[0].id, got[0].kind, got[0].memorial, got[0].bonus], ['cape-test', 'cape', false, 25]);
  assert.equal(w.economy.cash, cash + 25);
  assert.ok(w.toasts.some((t) => /Discovered Cape Test · \+\$25/.test(t.text)));
  // A hot-spot note on the chart for the cape.
  const note = discovery.intel.find((i) => i.placeId === 'cape-test');
  assert.ok(note && note.kind === 'hotspot' && Number.isFinite(note.x));
  assert.match(note.text, /Cape Test/);
  // Leaving emits place:leave once past the hysteresis.
  const leaves = [];
  ctx.events.on('place:leave', (e) => leaves.push(e.id));
  ctx.systems.seiner.setPose(cape.x + 600, cape.z, 0);
  w.step(0.25);
  assert.deepEqual(leaves, ['cape-test']);
  w.step(0.25);
  assert.equal(got.length, 1, 'no repeat discovery');
});

test('discovery: onFoot places only on foot; memorials are quiet', async () => {
  const { w, list } = await testWorld();
  const { ctx, discovery } = w;
  const peak = list.find((p) => p.id === 'test-peak');
  ctx.systems.seiner.setPose(peak.x, peak.z, 0);
  w.step(0.25);
  assert.equal(discovery.isDiscovered('test-peak'), false, 'not from the boat');
  ctx.state.control = 'foot';
  ctx.systems.player.active = true;
  ctx.systems.player.position.set(peak.x + 10, 50, peak.z);
  w.step(0.25);
  assert.equal(discovery.isDiscovered('test-peak'), true);
  ctx.state.control = 'boat';
  ctx.systems.player.active = false;
  const mem = list.find((p) => p.id === 'awauq');
  const events = [];
  ctx.events.on('place:discovered', (e) => events.push(e));
  const cash = w.economy.cash;
  const toasts = w.toasts.length;
  ctx.systems.seiner.setPose(mem.x, mem.z, 0);
  w.step(0.25);
  assert.equal(discovery.isDiscovered('awauq'), true);
  assert.equal(events[0].memorial, true);
  assert.equal(events[0].bonus, 0);
  assert.equal(w.economy.cash, cash, 'no bonus');
  assert.equal(w.toasts.length, toasts, 'no toast');
  assert.ok(discovery.cards().some((c) => c.id === 'awauq' && c.memorial));
  assert.equal(discovery.intel.filter((i) => i.placeId === 'awauq').length, 0);
});

test('discovery: streams add a run-timing card and a hot spot outside the markers', async () => {
  const { w, streams } = await testWorld();
  const { ctx, discovery } = w;
  const s = streams[0];
  ctx.systems.seiner.setPose(s.x + 400, s.z, 0);
  w.step(0.25);
  assert.ok(discovery.isDiscovered('stream:test-creek'));
  const run = discovery.intel.find((i) => i.streamId === 'test-creek' && i.kind === 'run');
  const hot = discovery.intel.find((i) => i.streamId === 'test-creek' && i.kind === 'hotspot');
  assert.match(run.text, /Reds peak Jul 6–21/);
  assert.match(run.text, /Closed waters 200 m/);
  assert.ok(Math.hypot(hot.x - s.x, hot.z - s.z) > 150, 'hot spot sits outside the closed waters');
  assert.ok(hot.tide === null || ['flood', 'ebb', 'slack'].includes(hot.tide));
});

test('discovery: free explore gives no cash', async () => {
  const { w, list } = await testWorld();
  w.ctx.game.start({ newGame: true, freeExplore: true });
  const cape = list.find((p) => p.id === 'cape-test');
  const cash = w.economy.cash;
  w.ctx.systems.seiner.setPose(cape.x, cape.z, 0);
  w.step(0.25);
  assert.ok(w.discovery.isDiscovered('cape-test'));
  assert.equal(w.economy.cash, cash);
});

test('sightings: binocular marks merge per school; wildlife first sightings toast once', async () => {
  const w = await makeWorld();
  const { ctx, discovery } = w;
  const school = ctx.systems.fish.schools[0];
  const marks = [];
  ctx.events.on('discovery:sighting', (e) => marks.push(e));
  const r = discovery.addSighting({ schoolId: school.id, species: 'pink', heading: 1 });
  assert.equal(r.x, school.position.x);
  assert.equal(r.source, 'binoculars');
  discovery.addSighting({ schoolId: school.id, species: 'pink', heading: 1.1 });
  assert.equal(discovery.recentSightings().length, 1, 'same school merges');
  assert.equal(marks.length, 2);
  ctx.events.emit('wildlife:sighted', { kind: 'humpback', x: 1, z: 2, first: true });
  ctx.events.emit('wildlife:sighted', { kind: 'whale', x: 1, z: 2, first: false });
  ctx.events.emit('wildlife:sighted', { kind: 'bear', x: 1, z: 2, first: true });
  assert.equal(w.toasts.filter((t) => /First sighting/.test(t.text)).length, 2);
  assert.deepEqual(discovery.progress().wildlife, [2, 11]);
  assert.ok(discovery.sightings instanceof Set);
  // Old fish marks fade off the chart.
  ctx.clock.set(ctx.clock.hours + 4, ctx.clock.day);
  assert.equal(discovery.recentSightings().length, 0);
});

test('perch: jumpers in line of sight of the summit show on the chart for the rest of the day', async () => {
  const w0 = await makeWorld();
  const hm = w0.ctx.heightmap;
  // Find a high summit near the spawn and water in view of it.
  const sp = w0.ctx.systems.places.spawn;
  let best = null;
  for (let dx = -3000; dx <= 3000; dx += 100) {
    for (let dz = -3000; dz <= 3000; dz += 100) {
      const h = hm.heightAt(sp.x + dx, sp.z + dz);
      if (!best || h > best.h) best = { x: sp.x + dx, z: sp.z + dz, h };
    }
  }
  const w = await makeWorld({ places: { list: [{ id: 'summit', name: 'Summit', kind: 'peak', x: best.x, z: best.z, radius: 80, onFoot: true }], spawn: sp } });
  const { ctx, discovery } = w;
  assert.equal(discovery.addPerch('summit'), true);
  assert.ok(w.toasts.some((t) => /Spotting from Summit/.test(t.text)));
  const sea = hm.nearestWater(best.x, best.z, { minShore: 100 });
  const before = discovery.recentSightings().length;
  ctx.events.emit('fish:jump', { x: sea.x, y: 0, z: sea.z, species: 'pink', schoolId: 'sx', heading: 0 });
  const seen = discovery.recentSightings().filter((s) => s.source === 'perch').length;
  // Far out of range never marks.
  ctx.events.emit('fish:jump', { x: best.x + 5000, y: 0, z: best.z, species: 'pink', schoolId: 'far', heading: 0 });
  assert.equal(discovery.recentSightings().filter((s) => s.schoolId === 'far').length, 0);
  assert.ok(seen >= before, 'visible jumps may mark');
  // Tomorrow the perch has expired.
  ctx.clock.set(10, ctx.clock.day + 1);
  assert.equal(discovery.activePerches().length, 0);
});

test('discovery: progress, cards, serialize/restore', async () => {
  const { w, list } = await testWorld();
  const { ctx, discovery } = w;
  for (const id of ['cape-test', 'test-bay']) {
    const p = list.find((q) => q.id === id);
    ctx.systems.seiner.setPose(p.x, p.z, 0);
    w.step(0.25);
  }
  const pr = discovery.progress();
  assert.deepEqual(pr.places, [3, 4], 'kodiak + cape + bay of 4 non-memorial places');
  assert.ok(pr.intel >= 2);
  const cards = discovery.cards();
  assert.ok(cards.find((c) => c.id === 'test-bay').intel.length >= 1);
  const snap = JSON.parse(JSON.stringify(discovery.serialize()));
  discovery.reset();
  assert.deepEqual(discovery.progress().places, [1, 4]);
  discovery.restore(snap);
  assert.deepEqual(JSON.parse(JSON.stringify(discovery.serialize())), snap);
  assert.equal(discovery.isDiscovered('test-bay'), true);
});

test('spotter plane: marks schools on the chart and calls the biggest on the radio', async () => {
  const w = await makeWorld();
  const { ctx, economy, discovery } = w;
  ctx.clock.set(12, 1);
  economy.buy('spotter');
  ctx.clock.set(9, 2);
  for (let i = 0; i < 210; i++) w.step(0.1);
  const marks = discovery.recentSightings().filter((s) => s.source === 'spotter');
  assert.ok(marks.length >= 1);
  for (let i = 0; i < 900 && !w.radio.some((m) => /Two-Seven Kilo/.test(m.from)); i++) w.step(0.1);
  const call = w.radio.find((m) => /Two-Seven Kilo/.test(m.from));
  assert.ok(call, 'spotter radios');
  assert.match(call.text, /humpies/);
});
