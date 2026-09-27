// WP-RULES: save round-trip through a ctx.game-like snapshot/load, autosave triggers, Free Explore, settings;
// fast travel routes and costs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/core/config.js';
import { createSaveManager, mergeSettings, isValidSave, DEFAULT_SETTINGS, SAVE_KEY, EXPLORE_KEY, SETTINGS_KEY } from '../src/game/save.js';
import { createRoutePlanner } from '../src/game/data/route.js';
import { fuelBurnPerHour } from '../src/game/data/market.js';
import { NO_ROUTE_FACTOR, TRAVEL_LOAD, durationLabel } from '../src/game/travel.js';
import { makeWorld, memoryStorage, defaultPlaces } from './rules-helpers.test.mjs';

test('save: career round-trip through snapshot/load restores economy, discovery, season, clock', async () => {
  const w = await makeWorld();
  const { ctx, economy, discovery, season } = w;
  ctx.clock.set(20, 3);
  ctx.systems.seiner.setMooring({ kind: 'dock', placeId: 'kodiak' });
  economy.addCash(12000, 'test');
  economy.buy('purseWinch');
  economy.addCatch({ pink: 2000, chum: 100 });
  economy.useFuel(444, 'test');
  discovery.addSighting({ schoolId: 'stub-school', species: 'pink', heading: 0 });
  ctx.events.emit('wildlife:sighted', { kind: 'eagle', x: 0, z: 0 });
  season.fleetBoard();
  const r = season.save.saveNow('test');
  assert.equal(r.ok, true);
  const stored = JSON.parse(w.storage.getItem(SAVE_KEY));
  assert.equal(stored.version, 1);
  assert.equal(stored.saveFormat, 1);
  assert.equal(stored.meta.day, 3);
  assert.ok(stored.systems.economy && stored.systems.discovery && stored.systems.season);
  const before = { eco: JSON.stringify(economy.serialize()), disc: JSON.stringify(discovery.serialize()), season: JSON.stringify(season.serialize()) };
  // Wreck the state, then Continue.
  ctx.game.start({ newGame: true });
  assert.equal(economy.cash, 2500);
  assert.equal(season.save.hasSave(), true);
  assert.equal(season.save.loadSave(), true);
  assert.equal(ctx.state.mode, 'play');
  assert.equal(ctx.clock.day, 3);
  assert.equal(ctx.clock.hours, 20);
  assert.equal(JSON.stringify(economy.serialize()), before.eco);
  assert.equal(JSON.stringify(discovery.serialize()), before.disc);
  assert.equal(JSON.stringify(season.serialize()), before.season);
  assert.equal(economy.modifiers.purseRate, 1.35);
  assert.deepEqual(season.save.saveInfo().date, 'Jul 9');
});

test('save: no write when snapshot() is null (mid-set, ashore)', async () => {
  const w = await makeWorld();
  w.ctx.systems.fishing.state = 'pursing';
  assert.equal(w.season.save.saveNow('x').ok, false);
  assert.equal(w.storage.getItem(SAVE_KEY), null);
  w.ctx.systems.fishing.state = 'idle';
  w.ctx.state.control = 'foot';
  assert.equal(w.season.save.saveNow('x').ok, false);
});

test('save: autosave on delivery, purchase, tie-up (next frame) and on game:toTitle (immediately)', async () => {
  const w = await makeWorld();
  const { ctx, economy } = w;
  const saves = [];
  ctx.events.on('game:saved', (e) => saves.push(e.reason));
  economy.addCatch({ pink: 100 });
  economy.deliver(ctx.systems.fleet.tenders[0]);
  assert.equal(w.storage.getItem(SAVE_KEY), null, 'deferred to the frame');
  w.step(0.1);
  assert.deepEqual(saves, ['delivery']);
  ctx.systems.seiner.setMooring({ kind: 'dock', placeId: 'kodiak' });
  w.step(0.1);
  economy.addCash(10000, 'test');
  economy.buy('sonar');
  w.step(0.1);
  assert.deepEqual(saves, ['delivery', 'tie-up', 'purchase']);
  ctx.game.toTitle();
  assert.deepEqual(saves.slice(-1), ['title']);
  // Title mode: snapshot is null, nothing more is written.
  ctx.events.emit('economy:delivered', {});
  w.step(0.1);
  assert.equal(saves.length, 4);
});

test('save: Free Explore keeps only discovery, under its own key', async () => {
  const w = await makeWorld({ freeExplore: true });
  const { ctx, discovery } = w;
  const saves = [];
  ctx.events.on('game:saved', (e) => saves.push(e));
  ctx.events.emit('wildlife:sighted', { kind: 'orca', x: 0, z: 0 });
  ctx.systems.seiner.setMooring({ kind: 'dock', placeId: 'kodiak' });
  w.step(0.1);
  assert.equal(saves[0].explore, true);
  assert.equal(w.storage.getItem(SAVE_KEY), null, 'career save untouched');
  const ex = JSON.parse(w.storage.getItem(EXPLORE_KEY));
  assert.ok(ex.discovery.sightings.some((s) => s.kind === 'orca'));
  // A new Free Explore session restores the log.
  ctx.game.start({ newGame: true, freeExplore: true });
  assert.ok(discovery.wildlifeSeen().some((s) => s.kind === 'orca'));
  // A career game starts clean.
  ctx.game.start({ newGame: true, freeExplore: false });
  assert.equal(discovery.wildlifeSeen().length, 0);
});

test('save: versioned — wrong version or explore snapshots are not Continue-able', () => {
  assert.equal(isValidSave({ version: 1, systems: {}, clock: { day: 0, hours: 5 } }), true);
  assert.equal(isValidSave({ version: 2, systems: {}, clock: {} }), false);
  assert.equal(isValidSave({ version: 1, systems: {}, clock: {}, freeExplore: true }), false);
  assert.equal(isValidSave(null), false);
  const s = memoryStorage();
  s.setItem(SAVE_KEY, '{not json');
  const m = createSaveManager(null, s);
  assert.equal(m.hasSave(), false);
  assert.equal(m.loadSave(), false);
});

test('settings: defaults, merge, clamp, reload flag, live apply', async () => {
  const s = mergeSettings(null);
  assert.deepEqual(s, { ...DEFAULT_SETTINGS, volumes: { ...DEFAULT_SETTINGS.volumes } });
  const m = mergeSettings({ quality: 'low', volumes: { music: 0.2 } }, { volumes: { sfx: 3 }, timeSpeed: 99, invertY: 1 });
  assert.equal(m.quality, 'low');
  assert.equal(m.volumes.music, 0.2);
  assert.equal(m.volumes.sfx, 1);
  assert.equal(m.timeSpeed, 8);
  assert.equal(m.invertY, true);
  const w = await makeWorld();
  const vols = [];
  w.ctx.systems.audio.setVolumes = (v) => vols.push(v);
  const r = w.season.save.setSettings({ timeSpeed: 2, volumes: { master: 0.5 } });
  assert.equal(r.reload, false);
  assert.equal(w.ctx.clock.scale, 2);
  assert.equal(vols[0].master, 0.5);
  assert.equal(JSON.parse(w.storage.getItem(SETTINGS_KEY)).timeSpeed, 2);
  assert.equal(w.season.save.setSettings({ quality: 'ultra' }).reload, true);
  assert.equal(w.season.save.getSettings().quality, 'ultra');
});

// ---- fast travel ----

test('route planner: water routes around land, never shorter than the straight line', async () => {
  const w = await makeWorld();
  const hm = w.ctx.heightmap;
  const rp = createRoutePlanner(hm, { half: config.world.half, boundary: config.world.boundary });
  const sp = w.ctx.systems.places.spawn;
  const target = hm.nearestWater(sp.x + 2500, sp.z + 3000, { minShore: 60 });
  const r = rp.route(sp.x, sp.z, target.x, target.z);
  assert.equal(r.reachable, true);
  assert.ok(r.distance >= r.straight - 1);
  assert.ok(r.path.length >= 2);
  for (let i = 1; i < r.path.length - 1; i++) assert.ok(hm.shoreDistance(r.path[i].x, r.path[i].z) > 0, 'waypoints in water');
  // Shelikof Strait: at the current DEM resolution there is no water path from the Kodiak city side; if the terrain
  // ever opens Kupreanof Strait the route must still be at least the straight line.
  const shelikof = w.ctx.geo.toWorld(58.0, -154.0);
  const far = rp.route(sp.x, sp.z, shelikof.x, shelikof.z);
  if (far.reachable) assert.ok(far.distance >= far.straight - 1);
});

test('fast travel: preview cost = chart nm ÷ cruising knots; fuel at 60% load; go() moves time, fuel and boat', async () => {
  const w = await makeWorld();
  const { ctx, economy } = w;
  const travel = w.season.travel;
  const tender = ctx.systems.fleet.tenders[0];
  const sp = ctx.systems.places.spawn;
  ctx.systems.seiner.setPose(sp.x + 1500, sp.z + 2500, 0);
  ctx.clock.set(12, 1);
  const p = travel.preview(tender);
  assert.equal(p.ok, true, p.reason);
  const knots = ctx.geo.toKnots(0.7 * ctx.systems.seiner.maxSpeed);
  assert.ok(Math.abs(p.hours - ctx.geo.toNauticalMiles(p.distance) / knots) < 0.01);
  assert.equal(p.gallons, Math.ceil(p.hours * fuelBurnPerHour(TRAVEL_LOAD, config.economy)));
  assert.ok(p.route.length >= 2);
  const fuel0 = economy.fuel;
  const t0 = ctx.clock.day * 24 + ctx.clock.hours;
  const tele = [];
  ctx.events.on('boat:teleport', (e) => tele.push(e.reason));
  const g = travel.go(tender);
  assert.equal(g.ok, true);
  assert.deepEqual(tele, ['travel']);
  assert.ok(Math.abs(ctx.clock.day * 24 + ctx.clock.hours - t0 - p.hours) < 1e-6);
  assert.equal(economy.fuel, fuel0 - p.gallons);
  const s = ctx.systems.seiner.position;
  assert.ok(Math.hypot(s.x - tender.position.x, s.z - tender.position.z) < 150, 'alongside the tender');
  // Close enough to deliver straight away.
  economy.addCatch({ pink: 100 });
  w.step(0.1);
  assert.ok(w.offer('deliver'));
});

test('fast travel: to a harbour arrives tied up; refused mid-set, ashore, skiff out, low fuel', async () => {
  const w = await makeWorld();
  const { ctx, economy } = w;
  const travel = w.season.travel;
  const sp = ctx.systems.places.spawn;
  ctx.systems.seiner.setPose(sp.x + 1500, sp.z + 2500, 0);
  const targets = travel.targets();
  assert.ok(targets.some((t) => t.kind === 'place' && t.placeId === 'kodiak'));
  assert.ok(targets.some((t) => t.kind === 'tender'));
  ctx.systems.fishing.state = 'setting';
  assert.equal(travel.preview('kodiak').ok, false);
  ctx.systems.fishing.state = 'idle';
  ctx.systems.skiff.state = 'holding';
  assert.equal(travel.preview('kodiak').ok, false);
  ctx.systems.skiff.state = 'stowed';
  ctx.state.control = 'foot';
  assert.match(travel.preview('kodiak').reason, /aboard/);
  ctx.state.control = 'boat';
  economy.useFuel(economy.fuel - 1, 'test');
  assert.match(travel.preview('kodiak').reason, /Not enough fuel/);
  economy.refuel({ kind: 'town', id: 'kodiak' });
  const r = travel.go('kodiak');
  assert.equal(r.ok, true);
  assert.deepEqual(ctx.systems.seiner.mooring, { kind: 'dock', placeId: 'kodiak' });
  assert.equal(travel.preview('kodiak').ok, false, 'already here');
  // Unconnected waters cost the straight line × NO_ROUTE_FACTOR.
  const west = ctx.heightmap.nearestWater(...Object.values(ctx.geo.toWorld(57.55, -154.1)), { minShore: 60 });
  const wp = await makeWorld({ places: { list: [...defaultPlaces(ctx).list, { id: 'westport', name: 'West Port', kind: 'village', x: west.x, z: west.z, radius: 200, services: ['fuel'] }] } });
  wp.ctx.systems.seiner.setPose(sp.x, sp.z, 0);
  wp.discovery.discover('westport');
  const pv = wp.season.travel.preview('westport');
  const straight = Math.hypot(west.x - sp.x, west.z - sp.z);
  if (!pv.reachable) assert.ok(Math.abs(pv.distance - straight * NO_ROUTE_FACTOR) < 250);
  else assert.ok(pv.distance >= straight - 1);
  assert.ok(pv.hours > 6, `crossing to the Shelikof side takes real time: ${pv.hours}`);
  assert.equal(durationLabel(9.5), '9 h 30 min');
});

test('save: an autosave requested from the chart (fast travel to a dock) waits until play resumes', async () => {
  const w = await makeWorld();
  const { ctx } = w;
  ctx.game.setMode('map');
  ctx.systems.seiner.setMooring({ kind: 'dock', placeId: 'kodiak' });
  w.step(0.1);
  assert.equal(w.storage.getItem('kodiak-seiner:save'), null);
  ctx.game.setMode('play');
  w.step(0.1);
  assert.ok(w.storage.getItem('kodiak-seiner:save'));
});
