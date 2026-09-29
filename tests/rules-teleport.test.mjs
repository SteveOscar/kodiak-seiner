// Free Explore teleport (src/game/travel.js): instant, free, to any place or open-water point.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './rules-helpers.test.mjs';
import { resolve } from '../src/data/places.js';
import { createGeo } from '../src/core/geo.js';
import { config } from '../src/core/config.js';

const R = resolve(createGeo(config.world.half));
const realPlaces = { list: R.places, streams: R.streams, districts: R.districts, closedAreas: R.closedAreas };

test('teleport is only available in Free Explore', async () => {
  const w = await makeWorld({ places: realPlaces, freeExplore: false });
  const travel = w.season.travel;
  assert.equal(travel.canTeleport().ok, false);
  assert.equal(travel.teleport('karluk').ok, false);
});

test('every non-memorial place has an open-water arrival outside no-approach zones', async () => {
  const w = await makeWorld({ places: realPlaces, freeExplore: true });
  const { heightmap } = w.ctx;
  const targets = w.season.travel.teleportTargets();
  const placeTargets = targets.filter((t) => t.kind === 'place');
  assert.equal(placeTargets.length, R.places.filter((p) => !p.memorial).length);
  assert.ok(!targets.some((t) => t.placeId && R.places.find((p) => p.id === t.placeId)?.memorial));
  for (const t of targets) {
    assert.ok(heightmap.shoreDistance(t.x, t.z) >= 30, `${t.id} arrives too close to shore`);
    assert.ok(heightmap.heightAt(t.x, t.z) < -config.boat.groundingDepth, `${t.id} arrives aground`);
    assert.ok(Number.isFinite(t.heading) && typeof t.districtName === 'string', `${t.id} pose/district`);
    for (const a of R.closedAreas) assert.ok(Math.hypot(t.x - a.x, t.z - a.z) >= a.radius, `${t.id} inside ${a.id}`);
  }
});

test('teleport moves the boat instantly without advancing the clock', async () => {
  const w = await makeWorld({ places: realPlaces, freeExplore: true });
  const { ctx } = w;
  const events = [];
  ctx.events.on('boat:teleport', (e) => events.push(e));
  const before = { day: ctx.clock.day, hours: ctx.clock.hours };
  const r = w.season.travel.teleport('karluk');
  assert.ok(r.ok, r.reason);
  const karluk = R.places.find((p) => p.id === 'karluk');
  assert.ok(Math.hypot(ctx.systems.seiner.position.x - r.x, ctx.systems.seiner.position.z - r.z) < 1);
  assert.ok(Math.hypot(r.x - karluk.x, r.z - karluk.z) < 2500, 'arrives near Karluk');
  assert.equal(events.at(-1).reason, 'explore');
  assert.deepEqual({ day: ctx.clock.day, hours: ctx.clock.hours }, before);
});

test('teleport to a chart point on land lands in the nearest open water', async () => {
  const w = await makeWorld({ places: realPlaces, freeExplore: true });
  const koniag = R.places.find((p) => p.kind === 'peak') ?? R.places[0];
  const r = w.season.travel.teleport({ x: koniag.x, z: koniag.z });
  assert.ok(r.ok, r.reason);
  assert.ok(w.ctx.heightmap.shoreDistance(r.x, r.z) >= 30);
});

test('teleport to a point beyond the chart edge stays inside the world boundary in deep water', async () => {
  const w = await makeWorld({ places: realPlaces, freeExplore: true });
  const { heightmap } = w.ctx;
  for (const [x, z] of [[-8350, -5000], [8400, -5800], [0, 8600], [-9000, 9000]]) {
    const r = w.season.travel.teleport({ x, z });
    assert.ok(r.ok, r.reason);
    assert.ok(Math.abs(r.x) <= config.world.boundary && Math.abs(r.z) <= config.world.boundary, `inside boundary for ${x},${z}`);
    assert.ok(heightmap.heightAt(r.x, r.z) < -config.boat.groundingDepth, `deep water for ${x},${z}`);
  }
});
