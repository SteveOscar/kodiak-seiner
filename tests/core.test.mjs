// Core module tests. Run all unit tests with: npm test  (node --test tests/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { config } from '../src/core/config.js';
import { createGeo } from '../src/core/geo.js';
import { createClock } from '../src/core/clock.js';
import { createEvents } from '../src/core/events.js';
import { createHeightmap } from '../src/world/heightmap.js';

const png = PNG.sync.read(readFileSync(new URL('../public/terrain/kodiak_height.png', import.meta.url)));
const meta = JSON.parse(readFileSync(new URL('../public/terrain/kodiak_meta.json', import.meta.url), 'utf8'));
export const hm = createHeightmap({ size: png.width, pixels: png.data, meta, config });
const geo = createGeo(config.world.half);

test('geo round-trips lat/lon', () => {
  const w = geo.toWorld(57.79, -152.407);
  const ll = geo.toLatLon(w.x, w.z);
  assert.ok(Math.abs(ll.lat - 57.79) < 1e-9 && Math.abs(ll.lon + 152.407) < 1e-9);
});

test('heightmap: Kodiak city is land, Shelikof Strait is deep water', () => {
  const city = geo.toWorld(57.79, -152.407);
  assert.ok(hm.heightAt(city.x, city.z) > 0);
  const shelikof = geo.toWorld(58.0, -154.0);
  assert.ok(hm.heightAt(shelikof.x, shelikof.z) < -20);
});

test('heightmap: nearestWater finds open water near Kodiak', () => {
  const city = geo.toWorld(57.79, -152.407);
  const w = hm.nearestWater(city.x, city.z, { minShore: 60 });
  assert.ok(w && hm.shoreDistance(w.x, w.z) >= 59 && hm.heightAt(w.x, w.z) < 0);
});

test('clock advances, wraps days and emits hour events', () => {
  const events = createEvents();
  const hours = [];
  let days = 0;
  events.on('time:hour', (e) => hours.push(e.hour));
  events.on('time:day', () => days++);
  const clock = createClock(config, events);
  clock.set(22.5, 0);
  clock.advance(3);
  assert.equal(clock.day, 1);
  assert.ok(Math.abs(clock.hours - 1.5) < 1e-9);
  assert.deepEqual(hours, [23, 0, 1]);
  assert.equal(days, 1);
  assert.equal(clock.date(0).label, 'Jul 6');
  assert.equal(clock.date(26).label, 'Aug 1');
});
