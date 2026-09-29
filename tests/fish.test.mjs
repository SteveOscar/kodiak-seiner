// WP-FISH: school simulation, spooking, the open-period guarantee, the tutorial school, queries and the system API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCtx } from './contract.test.mjs';
import { STUBS } from '../src/systems/stubs.js';
import { REQUIRED } from '../src/systems/contract.js';
import { createFishSim, GUARANTEE, CRUISE_MIN_DEPTH } from '../src/entities/fish/sim.js';
import { createWorldAdapter } from '../src/entities/fish/world.js';
import { create as createFish } from '../src/entities/fish.js';
import { catchTotal, SPECIES, targetPopulation, runIntensity } from '../src/entities/fish/species.js';

function setup({ day = 0, hours = 9 } = {}) {
  const ctx = fakeCtx();
  for (const n of ['season', 'places', 'seiner', 'skiff', 'net']) ctx.systems[n] = STUBS[n](ctx);
  const sp = ctx.systems.places.spawn;
  ctx.systems.seiner.setPose(sp.x, sp.z, sp.heading);
  ctx.clock.set(hours, day);
  const world = createWorldAdapter(ctx);
  world.inView = () => false;
  world.boats = () => [];
  const events = [];
  for (const name of ['fish:jump', 'fish:spooked', 'fishing:escape']) ctx.events.on(name, (e) => events.push({ name, ...e }));
  const sim = createFishSim({ config: ctx.config, rng: ctx.rng.fork('fish'), world });
  return { ctx, world, sim, events, spawn: sp };
}

function run(sim, ctx, seconds, dt = 1 / 30, each) {
  for (let t = 0; t < seconds; t += dt) {
    ctx.clock.advance(dt / 60);
    sim.update(dt);
    each?.(t);
  }
}

// Open water well away from shore near the spawn (east of Kodiak city).
function openWater(ctx, dx = 900, dz = 300) {
  const sp = ctx.systems.places.spawn;
  return ctx.heightmap.nearestWater(sp.x + dx, sp.z + dz, { minShore: 250 });
}

test('population: 12–25 run-driven schools in the water, valid mixes', () => {
  const { ctx, sim } = setup();
  run(sim, ctx, 6);
  const live = sim.schools.filter((s) => ['migrating', 'milling', 'spooked', 'sounding'].includes(s.state));
  assert.ok(live.length >= 12 && live.length <= 27, `live schools ${live.length}`);
  assert.equal(targetPopulation(0, ctx.config.fish.runs) >= 12, true);
  for (const s of sim.schools) {
    assert.ok(Number.isFinite(s.position.x) && Number.isFinite(s.position.z));
    assert.ok(ctx.heightmap.depthAt(s.position.x, s.position.z) > 0.5, `${s.id} not in water`);
    assert.equal(catchTotal(s.mix), s.count);
    assert.ok(['pink', 'chum', 'sockeye', 'coho'].includes(s.species));
    assert.ok(s.position.y <= 0 && Math.abs(s.position.y + s.depth) < 1e-9);
    assert.ok(s.radius > 3 && s.radius < 40);
  }
  // Run timing matters: no coho on day 0 (coho run starts day 35).
  assert.equal(runIntensity(0, ctx.config.fish.runs.coho), 0);
  assert.ok(!sim.schools.some((s) => s.species === 'coho'));
});

test('free schools cruise at least CRUISE_MIN_DEPTH deep where the water allows (shadows under the surface)', () => {
  const { ctx, sim } = setup();
  run(sim, ctx, 2);
  // Shallow-spawning species (pink/coho 1–4 m in config) included: a milling school too (milling swims shallower).
  const w = openWater(ctx);
  const a = sim.spawnSchool({ x: w.x, z: w.z, species: 'pink', count: 3000, milling: true, spookable: false });
  const b = sim.spawnSchool({ x: w.x + 80, z: w.z, species: 'coho', count: 600, spookable: false });
  run(sim, ctx, 40);
  for (const s of [a, b, ...sim.schools.filter((q) => ['migrating', 'milling', 'spooked'].includes(q.state))]) {
    const wd = ctx.heightmap.depthAt(s.position.x, s.position.z);
    if (wd < CRUISE_MIN_DEPTH + 1.5) continue;
    assert.ok(s.depth >= CRUISE_MIN_DEPTH - 0.05, `${s.id} ${s.species} ${s.state} at ${s.depth.toFixed(2)} m in ${wd.toFixed(1)} m of water`);
  }
});

test('schools migrate: they move, stay off the beach and follow the coast', () => {
  const { ctx, sim } = setup();
  run(sim, ctx, 2);
  const start = new Map(sim.schools.map((s) => [s.id, { x: s.position.x, z: s.position.z }]));
  let minShore = Infinity;
  run(sim, ctx, 90, 1 / 20, () => {
    for (const s of sim.schools) minShore = Math.min(minShore, ctx.heightmap.shoreDistance(s.position.x, s.position.z));
  });
  let moved = 0;
  for (const s of sim.schools) {
    const p = start.get(s.id);
    if (p && Math.hypot(s.position.x - p.x, s.position.z - p.z) > 15) moved++;
  }
  assert.ok(moved >= 5, `moved ${moved}`);
  assert.ok(minShore > 5, `a school touched the beach (${minShore.toFixed(1)} m)`);
});

test('tutorial school: pink, milling, a quarter mile (380–420 m) from the spawn, jumpRate ×3, never spooks', () => {
  const { ctx, sim, spawn } = setup();
  const s = sim.spawnTutorial(spawn.x, spawn.z, spawn.heading);
  const d = Math.hypot(s.position.x - spawn.x, s.position.z - spawn.z);
  assert.ok(d >= 380 && d <= 420, `distance ${d}`);
  // Deep enough that the base seine's first circle does not touch bottom ('Leads on bottom' through the whole set).
  const need = ctx.config.net.depth + 4;
  assert.ok(ctx.heightmap.depthAt(s.position.x, s.position.z) >= need, `centre depth ${ctx.heightmap.depthAt(s.position.x, s.position.z)}`);
  let shallowest = Infinity;
  for (const r of [20, 40, 60]) {
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * 2 * Math.PI;
      shallowest = Math.min(shallowest, ctx.heightmap.depthAt(s.position.x + Math.cos(a) * r, s.position.z + Math.sin(a) * r));
    }
  }
  assert.ok(shallowest >= need, `shallowest within 60 m ${shallowest.toFixed(1)} m (need ${need})`);
  assert.equal(s.species, 'pink');
  assert.equal(s.state, 'milling');
  const [lo, hi] = ctx.config.fish.species.pink.jumpsPerMin;
  assert.ok(s.jumpRate >= 3 * lo && s.jumpRate <= 3 * hi, `jumpRate ${s.jumpRate}`);
  assert.equal(s.spookable, false);
  assert.equal(sim.spook(s, s.position.x, s.position.z), false);
  sim.onHorn(s.position.x + 5, s.position.z);
  sim.onSkiffSplash(s.position.x, s.position.z);
  run(sim, ctx, 60);
  assert.equal(s.state, 'milling');
  const d2 = Math.hypot(s.position.x - spawn.x, s.position.z - spawn.z);
  assert.ok(d2 > 350 && d2 < 450, `drifted to ${d2}`);
  assert.ok(ctx.heightmap.depthAt(s.position.x, s.position.z) >= ctx.config.net.depth, 'drifted into shallow water');
});

test('open-period guarantee: ≥ 2 catchable schools within 1.5 km, spawned ≥ 600 m away and out of view', () => {
  const spots = [
    [900, 300],
    [2500, -1500],
    [-1200, 2600],
    [1800, 2400],
  ];
  for (const [dx, dz] of spots) {
    const { ctx, sim, world } = setup();
    const w = openWater(ctx, dx, dz);
    assert.ok(w, 'no water');
    ctx.systems.seiner.setPose(w.x, w.z, 0);
    // The camera sees everything east of the seiner.
    world.inView = (x) => x > w.x;
    sim.reset();
    run(sim, ctx, 5);
    const f = world.focus();
    let n = 0;
    for (const s of sim.schools) if (sim.catchable(s, f.x, f.z)) n++;
    assert.ok(n >= GUARANTEE.count, `only ${n} catchable at ${dx},${dz}`);
    for (const g of sim.lastGuaranteeSpawns) {
      const d = Math.hypot(g.x - g.fx, g.z - g.fz);
      assert.ok(d >= 600 && d <= 1500, `guarantee spawn at ${d}`);
      assert.equal(g.inView, false, 'guarantee spawn was in view');
      assert.ok(!ctx.systems.season.isClosedWater(g.x, g.z));
      assert.ok(ctx.heightmap.depthAt(g.x, g.z) >= 8);
    }
  }
});

test('guarantee is only enforced during an open period', () => {
  const { ctx, sim, world } = setup({ day: 1, hours: 12 });
  const w = openWater(ctx, 2500, -1500);
  ctx.systems.seiner.setPose(w.x, w.z, 0);
  assert.equal(world.openerActive(w.x, w.z), false);
  sim.reset();
  run(sim, ctx, 3);
  assert.equal(sim.stats.guaranteeSpawns, 0);
});

function lone(sim, species, x, z, opts = {}) {
  const s = sim.spawnSchool({ x, z, species, count: 2000, ...opts });
  s.radius = 15;
  return s;
}

test('spooking: fast boats within 40 m, hull crossings above 2 m/s; paying out at 7 m/s outside never spooks', () => {
  const { ctx, sim, world } = setup();
  const w = openWater(ctx);
  const boats = [];
  world.boats = () => boats;
  const s = lone(sim, 'pink', w.x, w.z);
  const at = (edge, speed) => {
    boats.length = 0;
    boats.push({ x: s.position.x + s.radius + edge, z: s.position.z, speed, fx: 0, fz: -1, half: 8.85 });
  };
  const step = (secs = 0.5) => run(sim, ctx, secs);
  // Paying out at 7 m/s, 12 m outside the school: fine.
  at(12, 7);
  step();
  assert.notEqual(s.state, 'spooked');
  // 9 m/s within 40 m: spooked.
  at(30, 9);
  step();
  assert.equal(s.state, 'spooked');
  const t = sim.now;
  // A hull crossing the school at 3 m/s spooks (after the 3 s debounce); at 1.5 m/s it does not.
  boats.length = 0;
  run(sim, ctx, 40);
  assert.notEqual(s.state, 'spooked');
  s.spooks = 0;
  boats.push({ x: s.position.x, z: s.position.z, speed: 1.5, fx: 0, fz: -1, half: 8.85 });
  step();
  assert.notEqual(s.state, 'spooked');
  boats[0].speed = 3;
  boats[0].x = s.position.x;
  boats[0].z = s.position.z;
  step();
  assert.equal(s.state, 'spooked');
  assert.ok(sim.now > t);
});

test('spooking: horn within 150 m and the skiff splash within 20 m', () => {
  const { ctx, sim } = setup();
  const w = openWater(ctx);
  const a = lone(sim, 'pink', w.x, w.z);
  const b = lone(sim, 'pink', w.x + 600, w.z);
  sim.onHorn(a.position.x + a.radius + 140, a.position.z);
  assert.equal(a.state, 'spooked');
  sim.onHorn(b.position.x + b.radius + 170, b.position.z);
  assert.notEqual(b.state, 'spooked');
  sim.onSkiffSplash(b.position.x + b.radius + 30, b.position.z);
  assert.notEqual(b.state, 'spooked');
  sim.onSkiffSplash(b.position.x + b.radius + 15, b.position.z);
  assert.equal(b.state, 'spooked');
  void ctx;
});

test('repeated spooks make chum and sockeye sound; pinks just scatter', () => {
  const { ctx, sim } = setup();
  const w = openWater(ctx);
  for (const [species, sounds] of [
    ['chum', true],
    ['sockeye', true],
    ['pink', false],
    ['coho', false],
  ]) {
    const s = lone(sim, species, w.x, w.z);
    for (let i = 0; i < 3; i++) {
      sim.spook(s, s.position.x + 30, s.position.z);
      run(sim, ctx, 4);
    }
    assert.equal(s.state === 'sounding', sounds, `${species}: ${s.state}`);
    if (sounds) {
      run(sim, ctx, 20);
      assert.ok(s.depth > 8, `${species} sounded only to ${s.depth}`);
    }
  }
});

test('queries: nearestSchool, schoolsWithin, schoolsInside, sonarReturns (depth, no species)', () => {
  const { ctx, sim } = setup();
  const w = openWater(ctx);
  const s = lone(sim, 'chum', w.x, w.z);
  const n = sim.nearestSchool(w.x + 3, w.z + 3, 50);
  assert.equal(n.school, s);
  assert.ok(Math.abs(n.distance - Math.hypot(3, 3)) < 1e-6);
  assert.equal(sim.nearestSchool(w.x, w.z + 5000, 10), null);
  assert.ok(sim.schoolsWithin(w.x, w.z, 5).includes(s));
  const square = [
    { x: w.x - 20, z: w.z - 20 },
    { x: w.x + 20, z: w.z - 20 },
    { x: w.x + 20, z: w.z + 20 },
    { x: w.x - 20, z: w.z + 20 },
  ];
  assert.ok(sim.schoolsInside(square).includes(s));
  assert.deepEqual(sim.schoolsInside(null), []);
  const marks = sim.sonarReturns(w.x, w.z, 150);
  assert.ok(marks.length >= 2);
  for (const m of marks) {
    assert.deepEqual(Object.keys(m).sort(), ['depth', 'strength', 'x', 'z']);
    assert.ok(Math.hypot(m.x - w.x, m.z - w.z) <= 150);
    assert.ok(m.depth > 0 && m.strength > 0 && m.strength <= 1);
  }
  assert.equal(sim.sonarReturns(w.x + 4000, w.z, 150).filter((m) => Math.hypot(m.x - w.x, m.z - w.z) < 20).length, 0);
  s.state = 'captured';
  assert.ok(!sim.schoolsWithin(w.x, w.z, 5).includes(s));
});

test('jumps: fish:jump events point within ±25° of the school velocity', () => {
  const { ctx, sim, events } = setup();
  const w = openWater(ctx);
  const s = lone(sim, 'pink', w.x, w.z, { jumpRateMul: 20 });
  let checked = 0;
  ctx.events.on('fish:jump', (e) => {
    const sc = sim.schools.find((q) => q.id === e.schoolId);
    if (!sc || e.style === 'thrash') return;
    const d = Math.atan2(Math.sin(e.heading - sc.heading), Math.cos(e.heading - sc.heading));
    assert.ok(Math.abs(d) <= (25 * Math.PI) / 180 + 1e-9, `jump off by ${((d * 180) / Math.PI).toFixed(1)}°`);
    checked++;
  });
  run(sim, ctx, 30);
  assert.ok(checked > 30, `checked ${checked}`);
  const mine = events.filter((e) => e.name === 'fish:jump' && e.schoolId === s.id);
  assert.ok(mine.length > 20);
  for (const e of mine.slice(0, 5)) for (const k of ['x', 'y', 'z', 'species', 'size', 'schoolId', 'heading', 'style']) assert.ok(k in e, k);
});

test('slack water: schools mill and jump more', () => {
  const { ctx, sim } = setup();
  // Find an hour near slack.
  let h = 9;
  for (let t = 9; t < 22; t += 0.05) {
    const st = ctx.tide.state(t);
    if (st.hoursToSlack < 0.3) {
      h = t;
      break;
    }
  }
  ctx.clock.set(h, 0);
  run(sim, ctx, 3);
  assert.equal(sim.slack, true);
  const milling = sim.schools.filter((s) => s.state === 'milling').length;
  assert.ok(milling >= sim.schools.length * 0.6, `milling ${milling}/${sim.schools.length}`);
});

test('system: contract members, tutorial on new game, reseed on time:skip, horn spooks, no throw with stubs', async () => {
  const ctx = fakeCtx();
  for (const n of Object.keys(STUBS)) if (n !== 'fish') ctx.systems[n] = STUBS[n](ctx);
  const sp = ctx.systems.places.spawn;
  ctx.systems.seiner.setPose(sp.x, sp.z, sp.heading);
  ctx.clock.set(9, 0);
  const fish = await createFish(ctx);
  ctx.systems.fish = fish;
  for (const k of REQUIRED.fish) assert.ok(k in fish, `missing ${k}`);
  fish.reset();
  ctx.events.emit('game:start', { newGame: true, freeExplore: false });
  const tut = fish.schools.find((s) => s.tutorial);
  assert.ok(tut, 'tutorial school');
  for (let i = 0; i < 120; i++) fish.update(1 / 30);
  assert.ok(fish.schools.length >= 12);
  const ds = fish.debugState();
  assert.ok(ds.tutorial && ds.schools >= 12);
  JSON.stringify(ds);
  const before = new Set(fish.schools.map((s) => s.id));
  ctx.clock.skip(8, 'sleep');
  assert.ok(!fish.schools.some((s) => before.has(s.id)), 'time:skip re-seeds');
  for (let i = 0; i < 30; i++) fish.update(1 / 30);
  // Horn near a fresh spookable school.
  const w = ctx.heightmap.nearestWater(sp.x + 900, sp.z + 300, { minShore: 250 });
  const s = fish.spawnSchool({ x: w.x, z: w.z, species: 'pink', count: 3000 });
  ctx.systems.seiner.setPose(w.x + 60, w.z, 0);
  ctx.systems.seiner.horn();
  assert.equal(s.state, 'spooked');
  assert.deepEqual(Object.keys(fish.harvest()).sort(), [...SPECIES].sort());
  assert.equal(fish.serialize(), undefined);
});
