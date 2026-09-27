// Every stub satisfies the required API (src/systems/contract.js) and constructs under Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { PNG } from 'pngjs';
import { config, QUALITY } from '../src/core/config.js';
import { createGeo } from '../src/core/geo.js';
import { createClock } from '../src/core/clock.js';
import { createEvents } from '../src/core/events.js';
import { createRng } from '../src/core/rng.js';
import { createUniforms } from '../src/core/uniforms.js';
import { createTide } from '../src/core/tide.js';
import { createHeightmap } from '../src/world/heightmap.js';
import { STUBS } from '../src/systems/stubs.js';
import { REQUIRED, missingMembers } from '../src/systems/contract.js';
import { SYSTEMS } from '../src/systems/registry.js';

const png = PNG.sync.read(readFileSync(new URL('../public/terrain/kodiak_height.png', import.meta.url)));
const meta = JSON.parse(readFileSync(new URL('../public/terrain/kodiak_meta.json', import.meta.url), 'utf8'));

// A Node-side ctx good enough to construct every stub (no renderer, no DOM).
export function fakeCtx() {
  const events = createEvents();
  const clock = createClock(config, events);
  const heightmap = createHeightmap({ size: png.width, pixels: png.data, meta, config });
  const systems = {};
  const ctx = {
    THREE,
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    pipeline: { beforeRender() {}, afterRender() {}, onResize() {}, render() {}, frame() {} },
    config,
    quality: QUALITY.high,
    events,
    input: { action: () => false, pressed: () => false, axis: () => 0, mouse: { dx: 0, dy: 0, wheel: 0, buttons: 0 } },
    interact: { offer() {}, current: {} },
    clock,
    geo: createGeo(config.world.half),
    rng: createRng(1),
    uniforms: createUniforms(),
    heightmap,
    systems,
    state: { mode: 'play', control: 'boat', freeExplore: false },
    flags: {},
    time: { elapsed: 0, dt: 0, realDt: 0, frame: 0 },
    debug: { cameraOverride: null, weatherPinned: false },
  };
  ctx.tide = createTide(clock, heightmap, () => systems.sky?.weather);
  return ctx;
}

test('registry, stubs and contract cover the same systems', () => {
  const names = SYSTEMS.map((s) => s.name).sort();
  assert.deepEqual(Object.keys(STUBS).sort(), names);
  assert.deepEqual(Object.keys(REQUIRED).sort(), names);
});

test('every stub constructs under Node and satisfies the contract', () => {
  const ctx = fakeCtx();
  for (const { name } of SYSTEMS) {
    const sys = STUBS[name](ctx);
    ctx.systems[name] = sys;
    assert.deepEqual(missingMembers(name, sys), [], `${name} stub missing members`);
  }
  for (const { name } of SYSTEMS) ctx.systems[name].update?.(0.016);
  for (const { name } of SYSTEMS) ctx.systems[name].lateUpdate?.(0.016);
});

test('economy stub addCatch returns accepted/overflow and respects capacity', () => {
  const ctx = fakeCtx();
  const eco = STUBS.economy(ctx);
  const r = eco.addCatch({ pink: 20000, chum: 0, sockeye: 0, coho: 0, king: 0 });
  assert.equal(r.accepted.pink + r.overflow.pink, 20000);
  assert.ok(eco.holdLbs() <= eco.capacityLbs);
});

test('rng forks are independent per salt', () => {
  const rng = createRng(7);
  assert.notEqual(rng.fork('fish').next(), rng.fork('wildlife').next());
  assert.equal(createRng(7).fork('fish').next(), createRng(7).fork('fish').next());
});

test('tide cycles through flood, slack and ebb', () => {
  const ctx = fakeCtx();
  const stages = new Set();
  for (let h = 0; h < 13; h += 0.25) stages.add(ctx.tide.state(h).stage);
  assert.deepEqual([...stages].sort(), ['ebb', 'flood', 'slack']);
  const c = ctx.tide.currentAt(5170, -1115);
  assert.ok(Number.isFinite(c.x) && Number.isFinite(c.z));
});
