// WP-FISH: fish vs the purse seine — escape maths, capture targets (clean / sloppy / water haul), deflection along
// the web, milling in a hook, running for the gap, the bag. Uses a scripted fake net with the documented net API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCtx } from './contract.test.mjs';
import { STUBS } from '../src/systems/stubs.js';
import { createFishSim } from '../src/entities/fish/sim.js';
import { createWorldAdapter } from '../src/entities/fish/world.js';
import { leadlineEscapeRate, harvestCounts, encloseSchool, applyEscape, LAMBDA0, PURSED } from '../src/entities/fish/netModel.js';
import { pointInPolygon, discInsideFraction, fitEllipse, polygonArea } from '../src/entities/fish/geom.js';
import { createRng } from '../src/core/rng.js';

function fakeNet() {
  return {
    state: 'stowed',
    pursed: 0,
    hauled: 0,
    bottomContact: 0,
    depth: 16,
    hole: false,
    poly: null,
    gapV: null,
    polygon() {
      return this.poly;
    },
    gap() {
      return this.gapV;
    },
    containsPoint(x, z) {
      return !!this.poly && pointInPolygon(x, z, this.poly);
    },
  };
}

const circle = (cx, cz, r, n = 36) => Array.from({ length: n }, (_, i) => ({ x: cx + Math.cos((i / n) * 2 * Math.PI) * r, z: cz + Math.sin((i / n) * 2 * Math.PI) * r }));

function setup() {
  const ctx = fakeCtx();
  for (const n of ['season', 'places', 'seiner']) ctx.systems[n] = STUBS[n](ctx);
  const sp = ctx.systems.places.spawn;
  ctx.clock.set(9, 1); // closed day: no guarantee spawns wandering into the test net
  const w = ctx.heightmap.nearestWater(sp.x + 900, sp.z + 300, { minShore: 300 });
  ctx.systems.seiner.setPose(w.x + 400, w.z, 0);
  const world = createWorldAdapter(ctx);
  world.inView = () => false;
  world.boats = () => [];
  const net = fakeNet();
  world.net = () => net;
  const escapes = [];
  ctx.events.on('fishing:escape', (e) => escapes.push(e));
  const sim = createFishSim({ config: ctx.config, rng: ctx.rng.fork('fish'), world });
  sim.update(1 / 30); // seed the population first
  // Keep the run population away from the test water.
  for (const s of [...sim.schools]) if (Math.hypot(s.position.x - w.x, s.position.z - w.z) < 400) s.state = 'gone';
  sim.update(1 / 30);
  return { ctx, sim, net, w, escapes };
}

function run(sim, ctx, seconds, each, dt = 1 / 30) {
  for (let t = 0; t < seconds; t += dt) {
    each?.(t);
    ctx.clock.advance(dt / 60);
    sim.update(dt);
  }
}

// A scripted set around a school: close-up, a wait before pursing, pursing, hauling to a small bag, harvest.
function scriptedSet({ species, closedFor, purseFor, haulFor = 30, school: opts = {}, net: netOpts = {}, during }) {
  const env = setup();
  const { ctx, sim, net, w } = env;
  const s = sim.spawnSchool({ x: w.x, z: w.z, species, count: 4000, spookable: false, ...opts });
  s.radius = 14;
  const initial = s.count;
  Object.assign(net, netOpts);
  net.poly = circle(w.x, w.z, 60);
  net.state = 'closed';
  run(sim, ctx, closedFor, (t) => during?.(env, s, 'closed', t));
  net.state = 'pursing';
  run(sim, ctx, purseFor, (t) => {
    net.pursed = Math.min(1, t / purseFor);
    during?.(env, s, 'pursing', t);
  });
  net.pursed = 1;
  net.state = 'hauling';
  run(sim, ctx, haulFor, (t) => {
    net.hauled = Math.min(0.9, (0.9 * t) / haulFor);
    net.poly = circle(w.x + 30 * net.hauled, w.z, 60 * (1 - 0.85 * net.hauled));
  });
  net.state = 'brailing';
  sim.update(1 / 30);
  const got = sim.harvest();
  return { ...env, school: s, initial, got, frac: got[species] / initial };
}

test('leadline escape rate: falls as the net is pursed, scales with species, sealed by a smooth bottom', () => {
  const r = (o) => leadlineEscapeRate({ fishDepth: 3, netDepth: 16, ...o });
  assert.equal(r({ pursed: 0 }), LAMBDA0);
  assert.ok(r({ pursed: 0 }) > r({ pursed: 0.5 }) && r({ pursed: 0.5 }) > r({ pursed: 0.9 }) && r({ pursed: 0.9 }) > 0);
  assert.equal(r({ pursed: PURSED }), 0);
  assert.equal(r({ pursed: 1 }), 0);
  assert.ok(Math.abs(r({ leadlineEscape: 2 }) - 2 * LAMBDA0) < 1e-12);
  assert.ok(Math.abs(r({ bottomContact: 1, smoothBottom: true }) - 0.2 * LAMBDA0) < 1e-12);
  assert.ok(Math.abs(r({ bottomContact: 0.5, smoothBottom: true }) - 0.6 * LAMBDA0) < 1e-12);
  assert.equal(r({ bottomContact: 1, smoothBottom: false }), LAMBDA0);
  assert.ok(r({ sounding: true }) >= 8 * LAMBDA0 - 1e-12);
  assert.ok(r({ fishDepth: 15 }) > LAMBDA0, 'fish deep near the leadline escape faster');
  assert.ok(r({ hole: true }) > LAMBDA0);
  assert.ok(r({ pursed: 1, hole: true }) > 0, 'a snag hole leaks until hauled');
});

test('escape bookkeeping conserves fish', () => {
  const rng = createRng(3);
  const rec = encloseSchool({ pink: 1000, chum: 100, sockeye: 0, coho: 0, king: 2 }, 1, rng);
  const live0 = rec.live.pink;
  for (let i = 0; i < 300; i++) applyEscape(rec, 0.1, () => LAMBDA0);
  assert.ok(Math.abs(rec.live.pink + rec.esc.pink - live0) < 1e-6);
  const h = harvestCounts(rec, fakeCtx().config.fish.species);
  assert.ok(h.pink <= Math.round(1000 * 0.85));
});

const CLEAN = { closedFor: 10, purseFor: 20 };
const SLOPPY = { closedFor: 55, purseFor: 40 };

for (const species of ['pink', 'chum', 'sockeye', 'coho']) {
  test(`capture targets for ${species}: clean set in the species range, sloppy set 15–40%`, () => {
    const cfg = fakeCtx().config.fish.species[species].capture;
    const clean = scriptedSet({ species, ...CLEAN });
    assert.ok(clean.frac >= cfg[0] - 0.01 && clean.frac <= cfg[1] + 1e-9, `clean ${species} ${clean.frac.toFixed(3)} not in ${cfg}`);
    const sloppy = scriptedSet({ species, ...SLOPPY });
    assert.ok(sloppy.frac >= 0.15 - 0.01 && sloppy.frac <= 0.4 + 0.005, `sloppy ${species} ${sloppy.frac.toFixed(3)}`);
    assert.ok(sloppy.frac < clean.frac);
    // Everything that did not come aboard was reported as escaped.
    const esc = clean.escapes.filter((e) => e.schoolId === clean.school.id && e.species === species).reduce((a, e) => a + e.count, 0);
    assert.ok(Math.abs(esc + clean.got[species] - clean.initial) <= 6, `escaped ${esc} + caught ${clean.got[species]} vs ${clean.initial}`);
    assert.equal(clean.school.state, 'captured');
  });
}

test('water haul: a school outside at close-up is not caught; a school that sounds in the net escapes', () => {
  const env = setup();
  const { ctx, sim, net, w } = env;
  const s = sim.spawnSchool({ x: w.x + 130, z: w.z, species: 'pink', count: 3000, spookable: false });
  net.poly = circle(w.x, w.z, 60);
  net.state = 'closed';
  run(sim, ctx, 10);
  net.state = 'pursing';
  run(sim, ctx, 20, (t) => (net.pursed = t / 20));
  net.state = 'hauling';
  run(sim, ctx, 5, (t) => (net.hauled = t / 10));
  const got = sim.harvest();
  assert.equal(got.pink, 0);
  assert.notEqual(s.state, 'captured');

  const sounded = scriptedSet({
    species: 'chum',
    ...CLEAN,
    school: { spookable: true },
    during: (e, sc, phase, t) => {
      if (phase === 'closed' && (Math.abs(t - 1) < 0.02 || Math.abs(t - 5) < 0.02)) e.sim.spook(sc, sc.position.x + 5, sc.position.z);
    },
  });
  assert.ok(sounded.frac < 0.1, `sounded chum still caught ${sounded.frac}`);
});

test('smooth bottom contact helps; a snag hole costs fish', () => {
  const base = scriptedSet({ species: 'sockeye', ...SLOPPY });
  const sealed = scriptedSet({ species: 'sockeye', ...SLOPPY, net: { bottomContact: 1 } });
  const holed = scriptedSet({ species: 'sockeye', ...SLOPPY, net: { hole: true } });
  assert.ok(sealed.frac > base.frac + 0.1, `sealed ${sealed.frac} vs ${base.frac}`);
  assert.ok(holed.frac < base.frac, `holed ${holed.frac} vs ${base.frac}`);
});

test('a school half outside the corkline at close-up splits: only the inside part is caught', () => {
  const env = setup();
  const { ctx, sim, net, w } = env;
  const s = sim.spawnSchool({ x: w.x + 60, z: w.z, species: 'pink', count: 4000, spookable: false });
  s.radius = 20;
  const before = new Set(sim.schools.map((q) => q.id));
  net.poly = circle(w.x, w.z, 60);
  net.state = 'closed';
  run(sim, ctx, 1);
  assert.ok(s.net, 'enclosed');
  const inside = s.net.enclosed.pink;
  assert.ok(inside > 800 && inside < 3200, `enclosed ${inside}`);
  const sib = sim.schools.find((q) => !before.has(q.id) && q.species === 'pink' && Math.hypot(q.position.x - w.x, q.position.z - w.z) < 140);
  assert.ok(sib, 'the outside part carries on as its own school');
  assert.ok(Math.abs(sib.count + inside - 4000) < 10, `split ${sib.count} + ${inside}`);
  assert.ok(!pointInPolygon(sib.position.x, sib.position.z, net.poly));
});

test('open net: fish meeting the web are deflected along it; in the hook they mill; near the gap they run for it', () => {
  const env = setup();
  const { ctx, sim, net, w, escapes } = env;
  // A U of web open to the north: gap edge B → A.
  const A = { x: w.x - 50, z: w.z - 70 };
  const B = { x: w.x + 50, z: w.z - 70 };
  net.poly = [A, { x: w.x - 50, z: w.z + 60 }, { x: w.x + 50, z: w.z + 60 }, B];
  net.gapV = { a: A, b: B, width: 100 };
  net.state = 'out';
  // Outside, south of the web, swimming north into it.
  const out = sim.spawnSchool({ x: w.x + 5, z: w.z + 76, species: 'pink', count: 2000, spookable: false });
  out.radius = 12;
  // Inside, deep in the bight.
  const hook = sim.spawnSchool({ x: w.x, z: w.z + 35, species: 'pink', count: 2000, spookable: false });
  hook.radius = 10;
  // Inside, right by the gap.
  const leaver = sim.spawnSchool({ x: w.x, z: w.z - 58, species: 'pink', count: 2000, spookable: false });
  leaver.radius = 8;
  let crossed = false;
  run(sim, ctx, 25, () => {
    out.state = 'spooked';
    out.stateUntil = sim.now + 20;
    out.fleeX = 0;
    out.fleeZ = -1;
    if (pointInPolygon(out.position.x, out.position.z, net.poly)) crossed = true;
  });
  assert.equal(crossed, false, 'went through the web');
  assert.ok(Math.abs(out.position.z - (w.z + 60)) < 20, 'pressed against the web');
  assert.ok(Math.abs(out.position.x - (w.x + 5)) > 10, 'slid along the web');
  assert.equal(hook.state, 'milling');
  assert.ok(pointInPolygon(hook.position.x, hook.position.z, net.poly), 'hook school stayed in the bight');
  assert.ok(!pointInPolygon(leaver.position.x, leaver.position.z, net.poly), 'gap school got out');
  assert.ok(escapes.some((e) => e.schoolId === leaver.id && e.viaGap), 'fishing:escape for the gap');
});

test('the bag: trapped fish follow the shrinking net and are harvested once', () => {
  const r = scriptedSet({ species: 'pink', ...CLEAN });
  assert.ok(r.got.pink > 0);
  assert.equal(r.school.bag, true);
  const again = r.sim.harvest();
  assert.equal(again.pink, 0, 'harvest marks schools captured');
  // After stowing the net the captured school is cleared.
  r.net.state = 'stowed';
  r.net.poly = null;
  run(r.sim, r.ctx, 2);
  assert.ok(!r.sim.schools.includes(r.school));
});

test('abort: stowing a closed net without brailing releases the fish (fishing:escape)', () => {
  const env = setup();
  const { ctx, sim, net, w, escapes } = env;
  const s = sim.spawnSchool({ x: w.x, z: w.z, species: 'chum', count: 900, spookable: false });
  net.poly = circle(w.x, w.z, 60);
  net.state = 'closed';
  run(sim, ctx, 3);
  net.state = 'stowed';
  net.poly = null;
  run(sim, ctx, 1);
  assert.equal(s.net, null);
  assert.ok(['spooked', 'migrating'].includes(s.state));
  assert.ok(escapes.some((e) => e.schoolId === s.id && e.released));
});

test('geometry helpers', () => {
  const c = circle(0, 0, 10, 64);
  assert.ok(Math.abs(polygonArea(c) - Math.PI * 100) < 2);
  assert.ok(Math.abs(discInsideFraction(0, 0, 5, c) - 1) < 1e-9);
  assert.equal(discInsideFraction(100, 0, 5, c), 0);
  const f = discInsideFraction(10, 0, 5, c);
  assert.ok(f > 0.3 && f < 0.7);
  const e = fitEllipse(c.map((p) => ({ x: p.x * 2, z: p.z })));
  assert.ok(Math.abs(e.a / e.b - 2) < 0.1 && Math.abs(Math.cos(e.angle)) > 0.99);
});
